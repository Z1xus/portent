import { z } from "zod";
import type { ManifestSignal } from "../config/manifest.ts";
import { fetchJson, HttpError } from "../http.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type XFilteredStreamSignal = Extract<ManifestSignal, { readonly type: "x.filteredStream" }>;
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

const XRulesResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    value: z.string(),
    tag: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const XRuleUpdateResponseSchema = z.object({}).passthrough();

const XStreamLineSchema = z.object({
  data: z.object({
    id: z.string(),
    text: z.string(),
  }).passthrough(),
  matching_rules: z.array(z.object({
    id: z.string(),
    tag: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export async function* streamXFilteredStream(
  signal: XFilteredStreamSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  const bearerToken = context.env.x.bearerToken;
  if (!bearerToken) {
    throw new Error("X_BEARER_TOKEN is required for x.filteredStream signals.");
  }

  await ensureRules(signal, context, bearerToken);

  while (!context.abortSignal.aborted) {
    try {
      for await (const event of consumeStream(signal, context, bearerToken)) {
        yield event;
      }
    } catch (error) {
      if (context.abortSignal.aborted) {
        return;
      }
      if (error instanceof HttpError && error.status === 429) {
        await sleep(Math.max(signal.reconnectMs, 60_000), context.abortSignal);
      } else {
        await sleep(signal.reconnectMs, context.abortSignal);
      }
    }
  }
}

export async function readXSnapshot(signal: XFilteredStreamSignal): Promise<readonly SignalEvent[]> {
  throw new Error(`Signal ${signal.type} is streaming-only; use the continuous runtime for live posts.`);
}

async function ensureRules(
  signal: XFilteredStreamSignal,
  context: SignalContext,
  bearerToken: string,
): Promise<void> {
  const rulesUrl = rulesUrlFor(signal.streamUrl);
  const existing = await fetchJson(context.fetcher, rulesUrl, XRulesResponseSchema, {
    headers: authHeaders(bearerToken),
    timeoutMs: signal.request.timeoutMs,
    retry: signal.request.retry,
    signal: context.abortSignal,
  });
  const existingRules = existing.data ?? [];
  const desiredTags = new Set(signal.rules.map((rule) => rule.tag));
  const staleRuleIds = existingRules
    .filter((rule) => rule.tag !== undefined && desiredTags.has(rule.tag))
    .filter((rule) => !signal.rules.some((desired) => desired.tag === rule.tag && desired.value === rule.value))
    .map((rule) => rule.id);
  const missingRules = signal.rules.filter((desired) => !existingRules.some((rule) => rule.tag === desired.tag && rule.value === desired.value));

  if (staleRuleIds.length > 0) {
    await fetchJson(context.fetcher, rulesUrl, XRuleUpdateResponseSchema, {
      method: "POST",
      headers: authHeaders(bearerToken),
      body: { delete: { ids: staleRuleIds } },
      timeoutMs: signal.request.timeoutMs,
      retry: signal.request.retry,
      signal: context.abortSignal,
    });
  }

  if (missingRules.length > 0) {
    await fetchJson(context.fetcher, rulesUrl, XRuleUpdateResponseSchema, {
      method: "POST",
      headers: authHeaders(bearerToken),
      body: {
        add: missingRules.map((rule) => ({ value: rule.value, tag: rule.tag })),
      },
      timeoutMs: signal.request.timeoutMs,
      retry: signal.request.retry,
      signal: context.abortSignal,
    });
  }
}

async function* consumeStream(
  signal: XFilteredStreamSignal,
  context: SignalContext,
  bearerToken: string,
): AsyncGenerator<SignalEvent> {
  const connectController = new AbortController();
  const connectTimeout = setTimeout(
    () => connectController.abort(new Error(`X stream connect timed out after ${signal.request.timeoutMs}ms`)),
    signal.request.timeoutMs,
  );
  const onParentAbort = (): void => connectController.abort(context.abortSignal.reason);
  context.abortSignal.addEventListener("abort", onParentAbort, { once: true });
  let response: Response;
  try {
    response = await context.fetcher(signal.streamUrl, {
      headers: authHeaders(bearerToken),
      signal: connectController.signal,
    });
  } finally {
    clearTimeout(connectTimeout);
    context.abortSignal.removeEventListener("abort", onParentAbort);
  }
  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status} from ${signal.streamUrl}`, response.status, await response.text());
  }
  if (!response.body) {
    throw new Error("X filtered stream response did not include a body.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  while (!context.abortSignal.aborted) {
    const read = await readWithIdleTimeout(reader, signal.streamIdleMs, context.abortSignal);
    if (read.done) {
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const parsed = XStreamLineSchema.parse(JSON.parse(trimmed) as unknown);
      yield {
        id: asSignalEventId(`x:${parsed.data.id}`),
        source: signal.type,
        occurredAt: new Date(),
        text: parsed.data.text,
        data: {
          tweetId: parsed.data.id,
          matchingRules: parsed.matching_rules ?? [],
        },
      };
    }
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<StreamReadResult>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`X stream idle for ${idleMs}ms`)), idleMs);
        onAbort = () => reject(new Error("X stream aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function rulesUrlFor(streamUrl: string): string {
  const url = new URL(streamUrl);
  if (!url.pathname.endsWith("/rules")) {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/rules`;
  }
  return url.toString();
}

function authHeaders(bearerToken: string): Headers {
  return new Headers({
    authorization: `Bearer ${bearerToken}`,
    accept: "application/json",
  });
}
