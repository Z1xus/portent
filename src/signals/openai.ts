import { createHash } from "node:crypto";
import { z } from "zod";
import type { ManifestSignal } from "../config/manifest.ts";
import { fetchJson } from "../http.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type OpenAiModelsSignal = Extract<ManifestSignal, { readonly type: "openai.models" }>;

const OpenAiModelsResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
  }).passthrough()),
}).passthrough();

export async function* streamOpenAiModels(
  signal: OpenAiModelsSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  while (!context.abortSignal.aborted) {
    yield await fetchOpenAiModels(signal, context);
    await sleep(signal.pollMs, context.abortSignal);
  }
}

export async function readOpenAiModelsSnapshot(
  signal: OpenAiModelsSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  return [await fetchOpenAiModels(signal, context)];
}

async function fetchOpenAiModels(signal: OpenAiModelsSignal, context: SignalContext): Promise<SignalEvent> {
  const apiKey = context.env.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for openai.models signals.");
  }
  const response = await fetchJson(context.fetcher, signal.baseUrl, OpenAiModelsResponseSchema, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    timeoutMs: signal.request.timeoutMs,
    retry: signal.request.retry,
    signal: context.abortSignal,
  });
  const modelIds = response.data.map((model) => model.id).sort((left, right) => left.localeCompare(right));
  return {
    id: asSignalEventId(`openai.models:${stableHash(modelIds.join("\n"))}`),
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
