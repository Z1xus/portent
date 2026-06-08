import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/config/manifest.ts";
import { RuntimeNotificationThrottle } from "../src/runtime/notification-throttle.ts";

describe("runtime notification throttle", () => {
  test("suppresses repeated order issue notifications within the manifest cooldown", () => {
    const manifest = parseManifest({
      ...baseManifest,
      notifications: {
        failureCooldownMs: 60_000,
      },
    }, "inline.yaml");
    const throttle = new RuntimeNotificationThrottle();

    expect(throttle.shouldNotifyOrderIssue(manifest, new Date("2026-06-08T10:00:00Z"))).toBe(true);
    expect(throttle.shouldNotifyOrderIssue(manifest, new Date("2026-06-08T10:00:30Z"))).toBe(false);
    expect(throttle.shouldNotifyOrderIssue(manifest, new Date("2026-06-08T10:01:00Z"))).toBe(true);
  });

  test("can be disabled per manifest", () => {
    const manifest = parseManifest({
      ...baseManifest,
      notifications: {
        failureCooldownMs: 0,
      },
    }, "inline.yaml");
    const throttle = new RuntimeNotificationThrottle();

    expect(throttle.shouldNotifyOrderIssue(manifest, new Date("2026-06-08T10:00:00Z"))).toBe(true);
    expect(throttle.shouldNotifyOrderIssue(manifest, new Date("2026-06-08T10:00:01Z"))).toBe(true);
  });
});

const baseManifest = {
  id: "throttle-test",
  enabled: true,
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
