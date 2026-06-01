import type { ManifestSignal } from "../config/manifest.ts";
import { readModelListSnapshot, streamModelList } from "./model-list.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type OpenRouterModelsSignal = Extract<ManifestSignal, { readonly type: "openrouter.models" }>;

export async function* streamOpenRouterModels(
  signal: OpenRouterModelsSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  yield* streamModelList(signal, context, {});
}

export function readOpenRouterModelsSnapshot(
  signal: OpenRouterModelsSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  return readModelListSnapshot(signal, context, {});
}
