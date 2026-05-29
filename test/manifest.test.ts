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
