import type { OptionalRuntimeEnv, RuntimeEnv } from "../config/env.ts";
import type { ManifestSignal } from "../config/manifest.ts";
import type { Fetcher } from "../http.ts";
import type { SignalEventId } from "../types.ts";

export interface SignalEvent {
  readonly id: SignalEventId;
  readonly source: ManifestSignal["type"];
  readonly occurredAt: Date;
  readonly text?: string;
  readonly url?: string;
  readonly data: Record<string, unknown>;
}

export interface SignalState {
  getLastSeen(key: string): Promise<string | undefined>;
  setLastSeen(key: string, value: string): Promise<void>;
}

export interface SignalContext {
  readonly env: RuntimeEnv | OptionalRuntimeEnv;
  readonly fetcher: Fetcher;
  readonly state?: SignalState;
  readonly abortSignal: AbortSignal;
}
