import { describe, expect, test } from "bun:test";
import type { ManifestSignal } from "../src/config/manifest.ts";
import type { Fetcher } from "../src/http.ts";
import { readHttpPollSnapshot } from "../src/signals/http-poll.ts";

describe("http.poll signal", () => {
  test("turns custom API responses into typed signal events", async () => {
    const signal: ManifestSignal = {
      type: "http.poll",
      url: "https://example.test/releases",
      method: "GET",
      pollMs: 60_000,
      auth: {
        type: "bearer",
        tokenEnv: "TEST_CUSTOM_TOKEN",
      },
      headers: {},
      headersFromEnv: {},
      eventsPath: "$.items[*]",
      dataPath: "$",
      eventIdPath: "$.id",
      textPath: "$.message",
      startFromLatest: false,
      request: {
        timeoutMs: 1_000,
        retry: {
          attempts: 1,
          backoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    };
    Bun.env["TEST_CUSTOM_TOKEN"] = "abc123";
    const fetcher: Fetcher = async (_input, init) => {
      expect(init?.signal).toBeDefined();
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer abc123");
      return new Response(JSON.stringify({
        items: [
          { id: "release-1", message: "gpt-5.6 shipped", confidence: 0.99 },
        ],
      }));
    };

    const events = await readHttpPollSnapshot(signal, {
      env: {
        polymarket: {
          clobHost: "https://clob.polymarket.com",
          chainId: 137,
          rpcUrl: "https://polygon-rpc.com",
          signatureType: "POLY_PROXY",
        },
        openai: {},
        x: {},
        truthSocial: {
          baseUrl: "https://truthsocial.com",
        },
        paths: {
          manifestDir: "manifests",
          stateDir: ".polyedge",
        },
      },
      fetcher,
      abortSignal: new AbortController().signal,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("gpt-5.6 shipped");
    expect(events[0]?.data).toMatchObject({ id: "release-1", confidence: 0.99 });
    delete Bun.env["TEST_CUSTOM_TOKEN"];
  });
});
