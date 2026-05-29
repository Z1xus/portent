import { describe, expect, test } from "bun:test";
import { OrderType, type OrderBookSummary } from "@polymarket/clob-client-v2";
import { parseManifest } from "../src/config/manifest.ts";
import { assertPricePreflight, bestAskFromBook, deriveOrCreateApiKeyCreds, resolveApiKeyCreds, toOrderType, toSignatureType } from "../src/trading/polymarket.ts";
import { asTokenId } from "../src/types.ts";

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
