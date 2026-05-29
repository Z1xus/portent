import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/config/manifest.ts";
import { selectMarketTarget } from "../src/runtime/runner.ts";
import type { OrderPreflight, OrderSubmission, TradingClient } from "../src/trading/polymarket.ts";
import { asTokenId, type TokenId } from "../src/types.ts";

describe("market selection", () => {
  test("selects the first live market by default", async () => {
    const manifest = manifestWithSelection("first");
    const selected = await selectMarketTarget(manifest, [
      target("a", "111", new Date("2027-01-01T00:00:00Z")),
      target("b", "222", new Date("2027-01-01T00:00:00Z")),
    ], tradingWithAsks({ "111": 0.8, "222": 0.2 }));
    expect(selected.id).toBe("a");
  });

  test("selects the lowest eligible best ask when configured", async () => {
    const manifest = manifestWithSelection("lowestBestAsk");
    const selected = await selectMarketTarget(manifest, [
      target("a", "111", new Date("2027-01-01T00:00:00Z")),
      target("b", "222", new Date("2027-01-01T00:00:00Z")),
    ], tradingWithAsks({ "111": 0.7, "222": 0.3 }));
    expect(selected.id).toBe("b");
  });

  test("ignores markets before startAt", async () => {
    const manifest = manifestWithSelection("first");
    const selected = await selectMarketTarget(manifest, [
      target("future", "111", new Date("2027-01-01T00:00:00Z"), new Date("2099-01-01T00:00:00Z")),
      target("live", "222", new Date("2027-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z")),
    ], tradingWithAsks({ "111": 0.1, "222": 0.8 }));
    expect(selected.id).toBe("live");
  });
});

function manifestWithSelection(mode: "first" | "lowestBestAsk") {
  return parseManifest({
    id: `selection-${mode}`,
    enabled: true,
    markets: [
      { id: "a", url: "https://polymarket.com/event/event/market-a", outcome: "Yes" },
      { id: "b", url: "https://polymarket.com/event/event/market-b", outcome: "Yes" },
    ],
    marketSelection: { mode },
    signal: { type: "openai.models" },
    condition: { type: "modelIdPresent", modelId: "gpt-5.6" },
    order: { side: "BUY", amountUsd: 10, maxPrice: 0.9, type: "FOK" },
  }, "inline.yaml");
}

function target(id: string, tokenId: string, stopAt: Date, startAt?: Date) {
  return {
    id,
    marketSlug: `market-${id}`,
    outcome: "Yes",
    tokenId: asTokenId(tokenId),
    ...(startAt ? { startAt } : {}),
    stopAt,
  };
}

function tradingWithAsks(asks: Record<string, number>): TradingClient {
  return {
    async resolvePreflight(target): Promise<OrderPreflight> {
      const bestAsk = asks[target.tokenId];
      return {
        tokenId: target.tokenId as TokenId,
        tickSize: "0.01",
        negRisk: false,
        ...(bestAsk === undefined ? {} : { bestAsk }),
      };
    },
    async submitOrder(): Promise<OrderSubmission> {
      return {
        status: "submitted",
        success: true,
        raw: {},
      };
    },
    async heartbeat(): Promise<void> {},
  };
}
