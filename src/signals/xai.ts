import type { ManifestSignal } from "../config/manifest.ts";
import { readModelListSnapshot, streamModelList } from "./model-list.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type XAiModelsSignal = Extract<ManifestSignal, { readonly type: "xai.models" }>;

export async function* streamXAiModels(
  signal: XAiModelsSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  yield* streamModelList(signal, context, xAiHeaders(context));
}

export async function readXAiModelsSnapshot(
  signal: XAiModelsSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  return readModelListSnapshot(signal, context, xAiHeaders(context));
}

function xAiHeaders(context: SignalContext): HeadersInit {
  const apiKey = context.env.xai.apiKey;
  if (!apiKey) {
    throw new Error("XAI_API_KEY is required for xai.models signals. xAI also requires a topped-up account with at least $5 in credits.");
  }
  return { authorization: `Bearer ${apiKey}` };
}
