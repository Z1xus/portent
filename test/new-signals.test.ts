import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/config/manifest.ts";
import { readSignalSnapshot } from "../src/signals/index.ts";
import type { SignalContext } from "../src/signals/types.ts";

describe("rss.feed signal", () => {
  test("emits feed entries", async () => {
    const manifest = parseManifest(baseManifest({
      type: "rss.feed",
      url: "https://example.com/feed.xml",
    }), "inline.yaml");
    const events = await readSignalSnapshot(manifest.signal, contextWithText(`
      <rss><channel><item><title>Release shipped</title><link>https://example.com/post</link><guid>post-1</guid><pubDate>Fri, 29 May 2026 10:00:00 GMT</pubDate><description>hello</description></item></channel></rss>
    `));
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain("Release shipped");
    expect(events[0]?.url).toBe("https://example.com/post");
  });
});

describe("web.page signal", () => {
  test("emits normalized page text", async () => {
    const manifest = parseManifest(baseManifest({
      type: "web.page",
      url: "https://example.com/status",
    }), "inline.yaml");
    const events = await readSignalSnapshot(manifest.signal, contextWithText("<html><body><h1>Status</h1><p>Ready now</p></body></html>"));
    expect(events[0]?.text).toBe("Status Ready now");
    expect(events[0]?.data["contentHash"]).toBeString();
  });
});

function baseManifest(signal: Record<string, unknown>) {
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

function contextWithText(text: string): SignalContext {
  return {
    env: {
      polymarket: {
        clobHost: "https://clob.polymarket.com",
        chainId: 137,
        rpcUrl: "https://polygon-rpc.com",
        signatureType: "POLY_PROXY",
      },
      openai: {},
      x: {},
      truthSocial: { baseUrl: "https://truthsocial.com" },
      paths: { manifestDir: "manifests", stateDir: ".portent" },
    },
    fetcher: async () => new Response(text),
    abortSignal: new AbortController().signal,
  };
}
