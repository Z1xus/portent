import { createHash } from "node:crypto";
import type { ManifestSignal } from "../config/manifest.ts";
import { fetchJsonRaw } from "../http.ts";
import { firstJsonValue, normalizeJsonData, selectJsonValues, stableJsonStringify } from "../json-path.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import { resolveConfiguredHeaders } from "./http-auth.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type HttpPollSignal = Extract<ManifestSignal, { readonly type: "http.poll" }>;

export async function* streamHttpPoll(
  signal: HttpPollSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  const stateKey = `http.poll:first:${signal.url}:${signal.eventsPath}`;
  while (!context.abortSignal.aborted) {
    const events = await readHttpPollSnapshot(signal, context);
    const firstPollSeen = await context.state?.getLastSeen(stateKey);
    if (signal.startFromLatest && !firstPollSeen) {
      await context.state?.setLastSeen(stateKey, new Date().toISOString());
    } else {
      for (const event of events) {
        yield event;
      }
    }
    await sleep(signal.pollMs, context.abortSignal);
  }
}

export async function readHttpPollSnapshot(
  signal: HttpPollSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  const response = await fetchJsonRaw(context.fetcher, signal.url, {
    method: signal.method,
    headers: resolveConfiguredHeaders(signal),
    body: signal.body,
    timeoutMs: signal.request.timeoutMs,
    retry: signal.request.retry,
    signal: context.abortSignal,
  });
  const selectedEvents = selectJsonValues(response, signal.eventsPath);
  const eventValues = selectedEvents.length > 0 ? selectedEvents : [response];
  return eventValues.map((eventValue, index) => eventFromValue(signal, eventValue, index));
}

function eventFromValue(signal: HttpPollSignal, value: unknown, index: number): SignalEvent {
  const dataValue = firstJsonValue(value, signal.dataPath) ?? value;
  const eventIdValue = signal.eventIdPath ? firstJsonValue(value, signal.eventIdPath) : undefined;
  const textValue = signal.textPath ? firstJsonValue(value, signal.textPath) : undefined;
  return {
    id: asSignalEventId(`http:${hash(eventIdValue ?? dataValue)}:${index}`),
    source: signal.type,
    occurredAt: new Date(),
    data: normalizeJsonData(dataValue),
    ...(typeof textValue === "string" ? { text: textValue } : {}),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex").slice(0, 16);
}
