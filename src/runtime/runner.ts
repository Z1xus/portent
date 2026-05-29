import { evaluateCondition } from "../conditions.ts";
import type { RuntimeEnv } from "../config/env.ts";
import type { Manifest } from "../config/manifest.ts";
import type { Fetcher } from "../http.ts";
import { stableJsonStringify } from "../json-path.ts";
import {
  effectiveMarketStartAt,
  effectiveMarketStopAt,
  GammaMarketResolver,
  isBeforeMarketStart,
  isMarketTargetLive,
  isPastMarketStop,
  type MarketTarget,
} from "../markets/polymarket.ts";
import type { Notifier } from "../notifications/telegram.ts";
import { setLongTimeout, sleep, type LongTimeout } from "../sleep.ts";
import { streamSignal, type SignalContext, type SignalEvent } from "../signals/index.ts";
import type { TradingClient } from "../trading/polymarket.ts";
import { formatUnknownError } from "../types.ts";
import type { JsonStateStore } from "./state.ts";
import type { RuntimeStatusTracker } from "./status.ts";

export interface RuntimeOptions {
  readonly env: RuntimeEnv;
  readonly manifests: readonly Manifest[];
  readonly state: JsonStateStore;
  readonly notifier: Notifier;
  readonly trading: TradingClient;
  readonly marketResolver: GammaMarketResolver;
  readonly abortSignal: AbortSignal;
  readonly fetcher?: Fetcher;
  readonly status?: RuntimeStatusTracker;
}

export async function runRuntime(options: RuntimeOptions): Promise<void> {
  const enabled = options.manifests.filter((manifest) => manifest.enabled);
  options.status?.setManifests(options.manifests);
  await safeNotify(options.notifier, { type: "startup", manifestCount: options.manifests.length, enabledCount: enabled.length });
  for (const manifest of options.manifests) {
    await safeNotify(options.notifier, { type: manifest.enabled ? "manifestArmed" : "manifestDisabled", manifest });
  }
  const tasks = [
    ...groupManifestsBySignal(enabled).map((group) => runManifestGroup(group, options)),
    runHeartbeat(options),
  ];
  await Promise.all(tasks);
}

interface ManifestGroup {
  readonly key: string;
  readonly signal: Manifest["signal"];
  readonly manifests: readonly Manifest[];
}

function groupManifestsBySignal(manifests: readonly Manifest[]): readonly ManifestGroup[] {
  const groups = new Map<string, Manifest[]>();
  for (const manifest of manifests) {
    const key = stableJsonStringify(manifest.signal);
    const group = groups.get(key);
    if (group) {
      group.push(manifest);
    } else {
      groups.set(key, [manifest]);
    }
  }
  return Array.from(groups.values(), (group) => ({
    key: stableJsonStringify(group[0]?.signal ?? unreachableEmptyGroup()),
    signal: group[0]?.signal ?? unreachableEmptyGroup(),
    manifests: group,
  }));
}

async function runManifestGroup(group: ManifestGroup, options: RuntimeOptions): Promise<void> {
  while (!options.abortSignal.aborted) {
    let scopedAbort: ScopedAbort | undefined;
    try {
      options.status?.groupStarted(group.key, group.manifests, group.signal.type, `${conditionCount(group.manifests)} condition(s)`);
      const timing = await resolveGroupTiming(group.manifests, options);
      if (timing.activeManifests.length === 0) {
        return;
      }
      if (isBeforeMarketStart(timing.startAt)) {
        await sleep(Math.max(0, timing.startAt.getTime() - Date.now()), options.abortSignal);
        continue;
      }
      scopedAbort = createScopedAbort(options.abortSignal, timing.stopAt);
      const signalContext: SignalContext = {
        env: options.env,
        fetcher: options.fetcher ?? fetch,
        state: options.state,
        abortSignal: scopedAbort.signal,
      };
      for await (const event of streamSignal(group.signal, signalContext)) {
        if (scopedAbort.signal.aborted || options.abortSignal.aborted) {
          return;
        }
        options.status?.signalEvent(group.key, event);
        await handleGroupSignalEvent(group, timing.activeManifests, event, options);
      }
    } catch (error) {
      if (!options.abortSignal.aborted) {
        options.status?.groupError(group.key, error);
        await safeNotify(options.notifier, { type: "recoverableError", error });
        await sleep(15_000, options.abortSignal);
      }
    } finally {
      scopedAbort?.dispose();
    }
  }
}

async function handleGroupSignalEvent(
  group: ManifestGroup,
  manifests: readonly Manifest[],
  event: SignalEvent,
  options: RuntimeOptions,
): Promise<void> {
  let matched = false;
  for (const manifest of orderedManifests(manifests)) {
    const condition = evaluateCondition(manifest.condition, event);
    if (!condition.matched) {
      continue;
    }
    matched = true;
    await handleMatchedManifest(manifest, event, options, condition.reason);
  }
  if (matched) {
    options.status?.conditionMatched(group.key);
  }
}

async function handleMatchedManifest(
  manifest: Manifest,
  event: SignalEvent,
  options: RuntimeOptions,
  conditionReason: string,
): Promise<void> {
  const reservation = options.state.reserveExecution(manifest, event);
  if (!reservation.allowed) {
    if (shouldNotifySkippedReservation(reservation.reason)) {
      await safeNotify(options.notifier, { type: "orderSkipped", manifest, reason: reservation.reason });
    }
    return;
  }

  let target: MarketTarget;
  try {
    const targets = await options.marketResolver.resolveAll(manifest);
    const freshStopAt = effectiveMarketStopAt(targets);
    if (isPastMarketStop(freshStopAt)) {
      reservation.release();
      await safeNotify(options.notifier, { type: "manifestExpired", manifest, stopAt: freshStopAt });
      return;
    }
    const freshStartAt = effectiveMarketStartAt(targets);
    if (isBeforeMarketStart(freshStartAt)) {
      reservation.release();
      await safeNotify(options.notifier, { type: "orderSkipped", manifest, reason: `market has not started; startAt=${freshStartAt.toISOString()}` });
      return;
    }
    target = await selectMarketTarget(manifest, targets, options.trading);
  } catch (error) {
    reservation.release();
    await safeNotify(options.notifier, { type: "orderFailed", manifest, error });
    return;
  }

  try {
    await safeNotify(options.notifier, { type: "conditionMatched", manifest, reason: conditionReason });
    const submission = await options.trading.submitOrder(manifest, target, event);
    await reservation.commit(submission);
    await safeNotify(options.notifier, { type: "orderSubmitted", manifest, submission });
  } catch (error) {
    reservation.release();
    await safeNotify(options.notifier, { type: "orderFailed", manifest, error });
  }
}

function shouldNotifySkippedReservation(reason: string): boolean {
  return !(
    reason.includes("was already executed")
    || reason.includes("order.once already executed")
    || reason.includes("repeat cooldown active")
  );
}

function orderedManifests(manifests: readonly Manifest[]): readonly Manifest[] {
  return manifests.slice().sort((left, right) => {
    const priority = (left.budget?.priority ?? 100) - (right.budget?.priority ?? 100);
    return priority === 0 ? String(left.id).localeCompare(String(right.id)) : priority;
  });
}

function conditionCount(manifests: readonly Manifest[]): number {
  return new Set(manifests.map((manifest) => stableJsonStringify(manifest.condition))).size;
}

async function resolveGroupTiming(
  manifests: readonly Manifest[],
  options: RuntimeOptions,
): Promise<{ readonly activeManifests: readonly Manifest[]; readonly startAt?: Date; readonly stopAt?: Date }> {
  const active: Manifest[] = [];
  const startDates: Date[] = [];
  const stopDates: Date[] = [];
  for (const manifest of manifests) {
    const targets = await options.marketResolver.resolveAll(manifest);
    const stopAt = effectiveMarketStopAt(targets);
    if (isPastMarketStop(stopAt)) {
      await safeNotify(options.notifier, { type: "manifestExpired", manifest, stopAt });
      continue;
    }
    const startAt = effectiveMarketStartAt(targets);
    if (startAt) {
      startDates.push(startAt);
    }
    if (stopAt) {
      stopDates.push(stopAt);
    }
    active.push(manifest);
  }
  return {
    activeManifests: active,
    ...(startDates.length > 0 ? { startAt: new Date(Math.min(...startDates.map((date) => date.getTime()))) } : {}),
    ...(stopDates.length > 0 && stopDates.length === active.length ? { stopAt: new Date(Math.max(...stopDates.map((date) => date.getTime()))) } : {}),
  };
}

export async function selectMarketTarget(
  manifest: Manifest,
  targets: readonly MarketTarget[],
  trading: TradingClient,
): Promise<MarketTarget> {
  const liveTargets = targets.filter((target) => isMarketTargetLive(target));
  if (liveTargets.length === 0) {
    throw new Error(`Manifest ${manifest.id} has no live market targets.`);
  }
  switch (manifest.marketSelection.mode) {
    case "first":
      return liveTargets[0] ?? unreachableNoTarget(manifest);
    case "lowestBestAsk": {
      const quoted = await Promise.all(liveTargets.map(async (target) => ({
        target,
        preflight: await trading.resolvePreflight(target, manifest),
      })));
      const eligible = quoted
        .filter((item) => item.preflight.bestAsk !== undefined && item.preflight.bestAsk <= manifest.order.maxPrice)
        .sort((left, right) => (left.preflight.bestAsk ?? Number.POSITIVE_INFINITY) - (right.preflight.bestAsk ?? Number.POSITIVE_INFINITY));
      return eligible[0]?.target ?? unreachableNoTarget(manifest, "No market target has bestAsk at or below maxPrice.");
    }
  }
}

function unreachableNoTarget(manifest: Manifest, reason = "No market target selected."): never {
  throw new Error(`Manifest ${manifest.id}: ${reason}`);
}

function unreachableEmptyGroup(): never {
  throw new Error("Internal error: manifest group is empty.");
}

interface ScopedAbort {
  readonly signal: AbortSignal;
  dispose(): void;
}

function createScopedAbort(parentSignal: AbortSignal, stopAt: Date | undefined): ScopedAbort {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const stopAtIso = stopAt?.toISOString();
  const msUntilStop = stopAt ? Math.max(0, stopAt.getTime() - Date.now()) : undefined;
  const timeout: LongTimeout | undefined = msUntilStop === undefined
    ? undefined
    : setLongTimeout(() => controller.abort(new Error(`Market stopAt reached: ${stopAtIso}`)), msUntilStop);
  return {
    signal: controller.signal,
    dispose: () => {
      parentSignal.removeEventListener("abort", abortFromParent);
      if (timeout) {
        timeout.clear();
      }
    },
  };
}

async function runHeartbeat(options: RuntimeOptions): Promise<void> {
  while (!options.abortSignal.aborted) {
    await sleep(300_000, options.abortSignal);
    if (options.abortSignal.aborted) {
      return;
    }
    try {
      await options.trading.heartbeat();
    } catch (error) {
      await safeNotify(options.notifier, { type: "recoverableError", error });
    }
  }
}

async function safeNotify(notifier: Notifier, event: Parameters<Notifier["notify"]>[0]): Promise<void> {
  try {
    await notifier.notify(event);
  } catch (error) {
    console.error(`Notification failed: ${formatUnknownError(error)}`);
  }
}
