import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/config/manifest.ts";
import { effectiveMarketStartAt, effectiveMarketStopAt, GammaMarketResolver, isBeforeMarketStart, isPastMarketStop, parsePolymarketUrl } from "../src/markets/polymarket.ts";
import type { Fetcher } from "../src/http.ts";

describe("Polymarket market resolution", () => {
  test("extracts event and market slugs", () => {
    expect(parsePolymarketUrl("https://polymarket.com/event/gpt-5pt6-released-by/gpt-5pt6-released-by-june-5-2026")).toEqual({
      eventSlug: "gpt-5pt6-released-by",
      marketSlug: "gpt-5pt6-released-by-june-5-2026",
    });
  });

  test("resolves outcome token from Gamma markets", async () => {
    const fetcher: Fetcher = async () => new Response(JSON.stringify([
      {
        slug: "market-slug",
        active: true,
        closed: false,
        acceptingOrders: true,
        endDateIso: "2026-06-05T23:59:59Z",
        outcomes: "[\"Yes\",\"No\"]",
        clobTokenIds: "[\"111\",\"222\"]",
      },
    ]));
    const resolver = new GammaMarketResolver({ fetcher, gammaBaseUrl: "https://gamma.example" });
    const manifest = parseManifest({
      id: "resolve-market",
      enabled: true,
      market: {
        url: "https://polymarket.com/event/event-slug/market-slug",
        outcome: "Yes",
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
        maxPrice: 0.9,
        type: "FOK",
      },
    }, "inline.yaml");
    await expect(resolver.resolve(manifest)).resolves.toMatchObject({
      marketSlug: "market-slug",
      outcome: "Yes",
      tokenId: "111",
      stopAt: new Date("2026-06-05T23:59:59Z"),
    });
  });

  test("uses manifest stopAt over Gamma end date", () => {
    parseManifest({
      id: "stop-at-market",
      enabled: true,
      market: {
        url: "https://polymarket.com/event/event-slug/market-slug",
        outcome: "Yes",
        startAt: "2026-06-01T00:00:00Z",
        stopAt: "2026-06-04T00:00:00Z",
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
        maxPrice: 0.9,
        type: "FOK",
      },
    }, "inline.yaml");
    const stopAt = effectiveMarketStopAt([{ stopAt: new Date("2026-06-04T00:00:00Z") }, { stopAt: new Date("2026-06-05T00:00:00Z") }]);
    expect(stopAt?.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    expect(isPastMarketStop(stopAt, new Date("2026-06-05T00:00:00Z"))).toBe(true);
    expect(isPastMarketStop(stopAt, new Date("2026-06-03T23:59:59Z"))).toBe(false);
    const startAt = effectiveMarketStartAt([{ startAt: new Date("2026-06-01T00:00:00Z") }, { startAt: new Date("2026-06-02T00:00:00Z") }]);
    expect(startAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(isBeforeMarketStart(startAt, new Date("2026-05-31T23:59:59Z"))).toBe(true);
  });

  test("resolves multiple market targets in manifest order", async () => {
    const fetcher: Fetcher = async (input) => {
      const url = new URL(String(input));
      const slug = url.searchParams.get("slug");
      return new Response(JSON.stringify([
        {
          slug,
          active: true,
          closed: false,
          acceptingOrders: true,
          outcomes: "[\"Yes\",\"No\"]",
          clobTokenIds: slug === "market-a" ? "[\"111\",\"222\"]" : "[\"333\",\"444\"]",
        },
      ]));
    };
    const resolver = new GammaMarketResolver({ fetcher, gammaBaseUrl: "https://gamma.example" });
    const manifest = parseManifest({
      id: "multi-market",
      enabled: true,
      markets: [
        {
          id: "a",
          url: "https://polymarket.com/event/event-slug/market-a",
          outcome: "Yes",
        },
        {
          id: "b",
          url: "https://polymarket.com/event/event-slug/market-b",
          outcome: "Yes",
        },
      ],
      marketSelection: {
        mode: "first",
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
        maxPrice: 0.9,
        type: "FOK",
      },
    }, "inline.yaml");
    await expect(resolver.resolveAll(manifest)).resolves.toMatchObject([
      { id: "a", marketSlug: "market-a", tokenId: "111" },
      { id: "b", marketSlug: "market-b", tokenId: "333" },
    ]);
  });
});
