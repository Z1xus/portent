import { z } from "zod";
import type { ManifestSignal } from "../config/manifest.ts";
import { fetchJson } from "../http.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type TruthSocialSignal = Extract<ManifestSignal, { readonly type: "truthsocial.accountStatuses" }>;

const AccountStatusSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  content: z.string().default(""),
  url: z.string().optional().nullable(),
}).passthrough();

const AccountStatusesSchema = z.array(AccountStatusSchema);

export async function* streamTruthSocialStatuses(
  signal: TruthSocialSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  const stateKey = stateKeyFor(signal);
  while (!context.abortSignal.aborted) {
    const statuses = await fetchTruthSocialStatuses(signal, context);
    const lastSeen = await context.state?.getLastSeen(stateKey);
    const unseen = lastSeen
      ? statuses.filter((status) => compareStatusIds(status.id, lastSeen) > 0)
      : statuses;

    if (!lastSeen && signal.startFromLatest) {
      const latest = statuses[0]?.id;
      if (latest) {
        await context.state?.setLastSeen(stateKey, latest);
      }
    } else {
      for (const event of statusesToEvents(unseen, signal)) {
        yield event;
      }
      const latest = statuses[0]?.id;
      if (latest) {
        await context.state?.setLastSeen(stateKey, latest);
      }
    }

    await sleep(signal.pollMs, context.abortSignal);
  }
}

export async function readTruthSocialSnapshot(
  signal: TruthSocialSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  return statusesToEvents(await fetchTruthSocialStatuses(signal, context), signal);
}

async function fetchTruthSocialStatuses(
  signal: TruthSocialSignal,
  context: SignalContext,
): Promise<readonly z.output<typeof AccountStatusSchema>[]> {
  const baseUrl = trimTrailingSlash(signal.baseUrl ?? context.env.truthSocial.baseUrl);
  const url = new URL(`${baseUrl}/api/v1/accounts/${encodeURIComponent(signal.accountId)}/statuses`);
  url.searchParams.set("limit", String(signal.limit));
  url.searchParams.set("exclude_replies", String(signal.excludeReplies));
  url.searchParams.set("exclude_reblogs", String(signal.excludeReblogs));
  return fetchJson(context.fetcher, url.toString(), AccountStatusesSchema, {
    timeoutMs: signal.request.timeoutMs,
    retry: signal.request.retry,
    signal: context.abortSignal,
  });
}

function statusesToEvents(
  statuses: readonly z.output<typeof AccountStatusSchema>[],
  signal: TruthSocialSignal,
): readonly SignalEvent[] {
  return statuses
    .slice()
    .reverse()
    .map((status) => {
      const event: SignalEvent = {
        id: asSignalEventId(`truthsocial:${signal.accountId}:${status.id}`),
        source: signal.type,
        occurredAt: parseDate(status.created_at),
        text: stripHtml(status.content),
        data: {
          accountId: signal.accountId,
          statusId: status.id,
          contentHtml: status.content,
        },
        ...(status.url ? { url: status.url } : {}),
      };
      return event;
    });
}

function stateKeyFor(signal: TruthSocialSignal): string {
  return `${signal.type}:${signal.baseUrl ?? "default"}:${signal.accountId}`;
}

function parseDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function compareStatusIds(left: string, right: string): number {
  const leftBigInt = tryBigInt(left);
  const rightBigInt = tryBigInt(right);
  if (leftBigInt !== undefined && rightBigInt !== undefined) {
    return leftBigInt > rightBigInt ? 1 : leftBigInt < rightBigInt ? -1 : 0;
  }
  return left.localeCompare(right);
}

function tryBigInt(value: string): bigint | undefined {
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .trim();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
