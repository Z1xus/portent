import { describe, expect, test } from "bun:test";
import { parseManifest, validateManifestSet } from "../src/config/manifest.ts";

const baseManifest = {
  id: "test-manifest",
  market: {
    url: "https://polymarket.com/event/example/example-market",
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
};

describe("manifest schema", () => {
  test("applies deterministic defaults", () => {
    const manifest = parseManifest(baseManifest, "inline.yaml");
    expect(manifest.enabled).toBe(false);
    expect(manifest.signal.type).toBe("openai.models");
    expect(manifest.order.once).toBe(true);
    expect(manifest.notifications.telegram).toBe(true);
  });

  test("rejects malformed regex conditions", () => {
    expect(() => parseManifest({
      ...baseManifest,
      condition: {
        type: "textMatches",
        pattern: "[",
      },
    }, "bad.yaml")).toThrow();
  });

  test("parses nested and/or conditions", () => {
    const manifest = parseManifest({
      ...baseManifest,
      condition: {
        type: "and",
        conditions: [
          {
            type: "modelIdPresent",
            modelId: "gpt-5.6",
          },
          {
            type: "or",
            conditions: [
              { type: "jsonEquals", path: "$.release.model", value: "gpt-5.6" },
              { type: "textIncludes", terms: ["release"] },
            ],
          },
        ],
      },
    }, "inline.yaml");

    expect(manifest.condition.type).toBe("and");
    if (manifest.condition.type !== "and") {
      throw new Error("expected and condition");
    }
    expect(manifest.condition.conditions[1]?.type).toBe("or");
  });

  test("parses optional bookFraction sizing", () => {
    const manifest = parseManifest({
      ...baseManifest,
      order: { ...baseManifest.order, sizing: { mode: "bookFraction", fraction: 0.5, minUsd: 10 } },
    }, "inline.yaml");
    expect(manifest.order.sizing).toEqual({ mode: "bookFraction", fraction: 0.5, minUsd: 10 });
  });

  test("rejects amountUsd above the per-execution budget fraction", () => {
    expect(() => parseManifest({
      ...baseManifest,
      order: { ...baseManifest.order, amountUsd: 50 },
      budget: { group: "g", limitUsd: 100, maxFractionPerExecution: 0.25 },
    }, "inline.yaml")).toThrow("maxFractionPerExecution");
  });

  test("accepts amountUsd within the per-execution budget fraction", () => {
    const manifest = parseManifest({
      ...baseManifest,
      order: { ...baseManifest.order, amountUsd: 25 },
      budget: { group: "g", limitUsd: 100, maxFractionPerExecution: 0.25 },
    }, "inline.yaml");
    expect(manifest.budget?.maxFractionPerExecution).toBe(0.25);
  });
});

test("manifest set rejects conflicting budget limits", () => {
  const first = parseManifest(manifestData("budget-a", 100), "first.yaml");
  const second = parseManifest(manifestData("budget-b", 200), "second.yaml");
  expect(() => validateManifestSet([first, second])).toThrow("conflicting limitUsd");
});

function manifestData(id: string, limitUsd: number) {
  return {
    id,
    enabled: false,
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
      maxPrice: 0.9,
      type: "FOK",
    },
    budget: {
      group: "shared",
      limitUsd,
    },
  };
}
