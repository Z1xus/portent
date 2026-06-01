import { describe, expect, test } from "bun:test";
import type { ManifestSignal } from "../src/config/manifest.ts";
import type { Fetcher } from "../src/http.ts";
import { readSignalSnapshot } from "../src/signals/index.ts";
import type { SignalContext } from "../src/signals/types.ts";

const request = {
  timeoutMs: 1_000,
  retry: {
    attempts: 1,
    backoffMs: 0,
    maxBackoffMs: 0,
  },
};

describe("model list signals", () => {
  test("polls OpenRouter models without provider credentials", async () => {
    const signal: ManifestSignal = {
      type: "openrouter.models",
      pollMs: 60_000,
      baseUrl: "https://openrouter.ai/api/v1/models",
      request,
    };
    const fetcher: Fetcher = async (input, init) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return modelsResponse(["x-ai/grok-5", "openai/gpt-5.6"]);
    };

    const events = await readSignalSnapshot(signal, context(fetcher));

    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("openrouter.models");
    expect(events[0]?.data).toEqual({
      modelIds: ["openai/gpt-5.6", "x-ai/grok-5"],
      count: 2,
    });
  });

  test("polls xAI models with XAI_API_KEY", async () => {
    const signal: ManifestSignal = {
      type: "xai.models",
      pollMs: 60_000,
      baseUrl: "https://api.x.ai/v1/models",
      request,
    };
    const fetcher: Fetcher = async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-key");
      return modelsResponse(["grok-4", "grok-5"]);
    };

    const events = await readSignalSnapshot(signal, context(fetcher, { xaiApiKey: "xai-key" }));

    expect(events[0]?.source).toBe("xai.models");
    expect(events[0]?.data).toEqual({
      modelIds: ["grok-4", "grok-5"],
      count: 2,
    });
  });

  test("requires XAI_API_KEY for xAI models", async () => {
    const signal: ManifestSignal = {
      type: "xai.models",
      pollMs: 60_000,
      baseUrl: "https://api.x.ai/v1/models",
      request,
    };

    await expect(readSignalSnapshot(signal, context(async () => modelsResponse([]))))
      .rejects.toThrow("topped-up account with at least $5");
  });
});

function context(fetcher: Fetcher, options: { readonly xaiApiKey?: string } = {}): SignalContext {
  return {
    env: {
      polymarket: {
        clobHost: "https://clob.polymarket.com",
        chainId: 137,
        rpcUrl: "https://polygon-rpc.com",
        signatureType: "POLY_PROXY",
      },
      openai: {},
      xai: options.xaiApiKey ? { apiKey: options.xaiApiKey } : {},
      x: {},
      truthSocial: { baseUrl: "https://truthsocial.com" },
      paths: { manifestDir: "manifests", stateDir: ".portent" },
    },
    fetcher,
    abortSignal: new AbortController().signal,
  };
}

function modelsResponse(modelIds: readonly string[]): Response {
  return new Response(JSON.stringify({
    data: modelIds.map((id) => ({ id })),
  }));
}
