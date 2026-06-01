import { describe, expect, test } from "bun:test";
import { type ClobClient, OrderType, type OrderBookSummary } from "@polymarket/clob-client-v2";
import { parseManifest } from "../src/config/manifest.ts";
import type { MarketTarget } from "../src/markets/polymarket.ts";
import { assertPricePreflight, bestAskFromBook, depthUsdAtOrBelow, deriveOrCreateApiKeyCreds, OrderSkippedError, PolymarketTradingClient, resolveApiKeyCreds, resolveOrderAmountUsd, toOrderType, toSignatureType } from "../src/trading/polymarket.ts";
import type { OrderPreflight } from "../src/trading/polymarket.ts";
import { asTokenId, formatUnknownError } from "../src/types.ts";

describe("trading helpers", () => {
  test("maps configured wallet and order types to SDK enums", () => {
    expect(toSignatureType("POLY_PROXY")).toBe(1);
    expect(toSignatureType("GNOSIS_SAFE")).toBe(2);
    expect(toSignatureType("POLY_1271")).toBe(3);
    expect(toOrderType("FOK")).toBe(OrderType.FOK);
  });

  test("finds best ask and blocks too-expensive immediate orders", () => {
    const book: OrderBookSummary = {
      market: "condition",
      asset_id: "token",
      timestamp: "0",
      bids: [],
      asks: [{ price: "0.7", size: "10" }, { price: "0.5", size: "10" }],
      min_order_size: "1",
      tick_size: "0.01",
      neg_risk: false,
      hash: "hash",
      last_trade_price: "0.5",
    };
    expect(bestAskFromBook(book)).toBe(0.5);
    const manifest = parseManifest({
      id: "preflight-test",
      market: {
        url: "https://polymarket.com/event/event/market",
      },
      signal: {
        type: "openai.models",
      },
      condition: {
        type: "modelIdPresent",
        modelId: "gpt-5.6",
      },
      order: {
        side: "BUY",
        amountUsd: 10,
        maxPrice: 0.4,
        type: "FOK",
      },
    }, "inline.yaml");
    expect(() => assertPricePreflight(manifest, {
      tokenId: asTokenId("token"),
      tickSize: "0.01",
      negRisk: false,
      bestAsk: 0.5,
    })).toThrow("above maxPrice");
  });

  test("uses supplied CLOB credentials when present", async () => {
    await expect(resolveApiKeyCreds({
      polymarket: {
        clobHost: "https://clob.polymarket.com",
        chainId: 137,
        rpcUrl: "https://polygon-rpc.com",
        privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111" as never,
        apiKey: "key",
        apiSecret: "secret",
        apiPassphrase: "passphrase",
        funderAddress: "0x2222222222222222222222222222222222222222" as never,
        signatureType: "POLY_PROXY",
      },
      telegram: {
        botToken: "token",
        chatId: "chat",
      },
      openai: {},
      xai: {},
      x: {},
      truthSocial: {
        baseUrl: "https://truthsocial.com",
      },
      paths: {
        manifestDir: "manifests",
        stateDir: ".polyedge",
      },
    }, {
      createApiKey: async () => {
        throw new Error("should not create");
      },
      deriveApiKey: async () => {
        throw new Error("should not derive");
      },
    })).resolves.toEqual({
      key: "key",
      secret: "secret",
      passphrase: "passphrase",
    });
  });

  test("derives CLOB credentials when absent", async () => {
    await expect(resolveApiKeyCreds({
      polymarket: {
        clobHost: "https://clob.polymarket.com",
        chainId: 137,
        rpcUrl: "https://polygon-rpc.com",
        privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111" as never,
        funderAddress: "0x2222222222222222222222222222222222222222" as never,
        signatureType: "POLY_PROXY",
      },
      telegram: {
        botToken: "token",
        chatId: "chat",
      },
      openai: {},
      xai: {},
      x: {},
      truthSocial: {
        baseUrl: "https://truthsocial.com",
      },
      paths: {
        manifestDir: "manifests",
        stateDir: ".polyedge",
      },
    }, {
      createApiKey: async () => {
        throw new Error("should not create");
      },
      deriveApiKey: async () => ({
        key: "derived-key",
        secret: "derived-secret",
        passphrase: "derived-passphrase",
      }),
    })).resolves.toEqual({
      key: "derived-key",
      secret: "derived-secret",
      passphrase: "derived-passphrase",
    });
  });

  test("creates CLOB credentials when derive has no existing key", async () => {
    await expect(deriveOrCreateApiKeyCreds({
      deriveApiKey: async () => {
        throw new Error("not found");
      },
      createApiKey: async () => ({
        key: "created-key",
        secret: "created-secret",
        passphrase: "created-passphrase",
      }),
    })).resolves.toEqual({
      key: "created-key",
      secret: "created-secret",
      passphrase: "created-passphrase",
    });
  });
});

describe("liquidity-aware sizing", () => {
  function sizedManifest(sizing: unknown, amountUsd = 100) {
    return parseManifest({
      id: "sizing-test",
      market: { url: "https://polymarket.com/event/event/market" },
      signal: { type: "openai.models" },
      condition: { type: "modelIdPresent", modelId: "gpt-5.6" },
      order: { side: "BUY", amountUsd, maxPrice: 0.9, type: "FOK", ...(sizing ? { sizing } : {}) },
    }, "inline.yaml");
  }

  function preflight(depthUsdAtMaxPrice: number): OrderPreflight {
    return { tokenId: asTokenId("token"), tickSize: "0.01", negRisk: false, depthUsdAtMaxPrice };
  }

  test("sums ask depth at or below maxPrice", () => {
    const book: OrderBookSummary = {
      market: "condition",
      asset_id: "token",
      timestamp: "0",
      bids: [],
      asks: [{ price: "0.5", size: "100" }, { price: "0.9", size: "100" }, { price: "0.95", size: "100" }],
      min_order_size: "1",
      tick_size: "0.01",
      neg_risk: false,
      hash: "hash",
      last_trade_price: "0.5",
    };
    expect(depthUsdAtOrBelow(book, 0.9)).toBeCloseTo(140);
    expect(depthUsdAtOrBelow(book, 0.4)).toBe(0);
  });

  test("returns the full amount when no sizing is configured", () => {
    expect(resolveOrderAmountUsd(sizedManifest(undefined), preflight(1000))).toBe(100);
  });

  test("scales spend to a fraction of available depth", () => {
    expect(resolveOrderAmountUsd(sizedManifest({ mode: "bookFraction", fraction: 0.5 }), preflight(120))).toBe(60);
  });

  test("never exceeds amountUsd as the ceiling", () => {
    expect(resolveOrderAmountUsd(sizedManifest({ mode: "bookFraction", fraction: 0.5 }), preflight(1000))).toBe(100);
  });

  test("skips when sized spend is below minUsd", () => {
    expect(() => resolveOrderAmountUsd(sizedManifest({ mode: "bookFraction", fraction: 0.5, minUsd: 40 }), preflight(20)))
      .toThrow(OrderSkippedError);
  });

  test("skips when there is no depth at or below maxPrice", () => {
    expect(() => resolveOrderAmountUsd(sizedManifest({ mode: "bookFraction", fraction: 0.5 }), preflight(0)))
      .toThrow(OrderSkippedError);
  });
});

describe("probe order", () => {
  function probeTarget(): MarketTarget {
    return {
      id: "probe-market",
      marketSlug: "probe-market",
      outcome: "Yes",
      tokenId: asTokenId("token-1"),
    };
  }

  function probeBook(minOrderSize: string): OrderBookSummary {
    return {
      market: "condition",
      asset_id: "token-1",
      timestamp: "0",
      bids: [],
      asks: [],
      min_order_size: minOrderSize,
      tick_size: "0.01",
      neg_risk: false,
      hash: "hash",
      last_trade_price: "0.5",
    };
  }

  function probeClient(options: {
    readonly minOrderSize?: string;
    readonly placed: unknown;
    readonly cancel?: () => Promise<unknown>;
  }): { readonly client: ClobClient; readonly cancelCalls: string[] } {
    const cancelCalls: string[] = [];
    const client = {
      getTickSize: async () => "0.01",
      getNegRisk: async () => false,
      getOrderBook: async () => probeBook(options.minOrderSize ?? "5"),
      createAndPostOrder: async () => options.placed,
      cancelOrder: async (payload: { orderID: string }) => {
        cancelCalls.push(payload.orderID);
        return options.cancel ? options.cancel() : { canceled: [payload.orderID] };
      },
    } as unknown as ClobClient;
    return { client, cancelCalls };
  }

  test("places the market-minimum size at the lowest tick and cancels on success", async () => {
    const { client, cancelCalls } = probeClient({
      minOrderSize: "8",
      placed: { orderID: "0xabc", status: "live", success: true },
    });
    const result = await new PolymarketTradingClient(client).probeOrder(probeTarget());
    expect(result.price).toBe(0.01);
    expect(result.size).toBe(8);
    expect(String(result.placed.orderId)).toBe("0xabc");
    expect(result.canceled).toBe(true);
    expect(result.cancelError).toBeUndefined();
    expect(cancelCalls).toEqual(["0xabc"]);
  });

  test("reports a cancel failure as data without losing the placed order", async () => {
    const { client } = probeClient({
      placed: { orderID: "0xdef", status: "live", success: true },
      cancel: async () => {
        throw new Error("cancel rejected");
      },
    });
    const result = await new PolymarketTradingClient(client).probeOrder(probeTarget());
    expect(String(result.placed.orderId)).toBe("0xdef");
    expect(result.canceled).toBe(false);
    expect(formatUnknownError(result.cancelError)).toContain("cancel rejected");
  });

  test("skips cancellation when no order id is returned", async () => {
    const { client, cancelCalls } = probeClient({ placed: { status: "matched", success: true } });
    const result = await new PolymarketTradingClient(client).probeOrder(probeTarget());
    expect(result.placed.orderId).toBeUndefined();
    expect(result.canceled).toBe(false);
    expect(result.cancelError).toBeUndefined();
    expect(cancelCalls).toEqual([]);
  });

  test("falls back to a default size when the book omits a minimum", async () => {
    const { client } = probeClient({
      minOrderSize: "0",
      placed: { orderID: "0x1", status: "live", success: true },
    });
    const result = await new PolymarketTradingClient(client).probeOrder(probeTarget());
    expect(result.size).toBe(5);
  });
});
