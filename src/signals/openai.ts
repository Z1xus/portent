import type { ManifestSignal } from "../config/manifest.ts";
import { readModelListSnapshot, streamModelList } from "./model-list.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type OpenAiModelsSignal = Extract<ManifestSignal, { readonly type: "openai.models" }>;

export async function* streamOpenAiModels(
  signal: OpenAiModelsSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  yield* streamModelList(signal, context, openAiHeaders(context));
}

export async function readOpenAiModelsSnapshot(
  signal: OpenAiModelsSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  return readModelListSnapshot(signal, context, openAiHeaders(context));
}

function openAiHeaders(context: SignalContext): HeadersInit {
  const apiKey = context.env.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for openai.models signals.");
  }
  return { authorization: `Bearer ${apiKey}` };
}
