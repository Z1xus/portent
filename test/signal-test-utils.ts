import type { SignalContext, SignalState } from "../src/signals/types.ts";

export function baseManifest(signal: Record<string, unknown>) {
  return {
    id: "signal-test",
    enabled: false,
    market: {
      url: "https://polymarket.com/event/example/example-market",
    },
    signal,
    condition: {
      type: "textIncludes",
      terms: ["Release"],
    },
    order: {
      side: "BUY",
      amountUsd: 10,
      maxPrice: 0.8,
      type: "FOK",
    },
  };
}

export function contextWithText(text: string, signal = new AbortController().signal, state?: SignalState): SignalContext {
  return {
    env: {
      polymarket: {
        clobHost: "https://clob.polymarket.com",
        chainId: 137,
        rpcUrl: "https://polygon-rpc.com",
        signatureType: "POLY_PROXY",
      },
      openai: {},
      xai: {},
      x: {},
      truthSocial: { baseUrl: "https://truthsocial.com" },
      paths: { manifestDir: "manifests", stateDir: ".portent" },
    },
    fetcher: async () => new Response(text),
    ...(state ? { state } : {}),
    abortSignal: signal,
  };
}

export class MemoryState implements SignalState {
  public constructor(private readonly values: Record<string, string> = {}) {}

  public async getLastSeen(key: string): Promise<string | undefined> {
    return this.values[key];
  }

  public async setLastSeen(key: string, value: string): Promise<void> {
    this.values[key] = value;
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
