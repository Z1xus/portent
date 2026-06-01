import { createHash } from "node:crypto";
import { z } from "zod";
import type { ManifestSignal } from "../config/manifest.ts";
import { fetchJson } from "../http.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

export interface ModelListSignal {
  readonly type: Extract<ManifestSignal["type"], "openai.models" | "openrouter.models" | "xai.models">;
  readonly pollMs: number;
  readonly baseUrl: string;
  readonly request: {
    readonly timeoutMs: number;
    readonly retry: {
      readonly attempts: number;
      readonly backoffMs: number;
      readonly maxBackoffMs: number;
    };
  };
}

const ModelsResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
  }).passthrough()),
}).passthrough();

export async function* streamModelList(
  signal: ModelListSignal,
  context: SignalContext,
  headers: HeadersInit,
): AsyncGenerator<SignalEvent> {
  while (!context.abortSignal.aborted) {
    yield await fetchModelList(signal, context, headers);
    await sleep(signal.pollMs, context.abortSignal);
  }
}

export async function readModelListSnapshot(
  signal: ModelListSignal,
  context: SignalContext,
  headers: HeadersInit,
): Promise<readonly SignalEvent[]> {
  return [await fetchModelList(signal, context, headers)];
}

async function fetchModelList(
  signal: ModelListSignal,
  context: SignalContext,
  headers: HeadersInit,
): Promise<SignalEvent> {
  const response = await fetchJson(context.fetcher, signal.baseUrl, ModelsResponseSchema, {
    headers,
    timeoutMs: signal.request.timeoutMs,
    retry: signal.request.retry,
    signal: context.abortSignal,
  });
  const modelIds = response.data.map((model) => model.id).sort((left, right) => left.localeCompare(right));
  return {
    id: asSignalEventId(`${signal.type}:${stableHash(modelIds.join("\n"))}`),
    source: signal.type,
    occurredAt: new Date(),
    data: {
      modelIds,
      count: modelIds.length,
    },
  };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
