import { describe, expect, test } from "bun:test";
import { evaluateCondition } from "../src/conditions.ts";
import type { ManifestCondition } from "../src/config/manifest.ts";
import type { SignalEvent } from "../src/signals/index.ts";
import { asSignalEventId } from "../src/types.ts";

const event: SignalEvent = {
  id: asSignalEventId("event-1"),
  source: "openai.models",
  occurredAt: new Date("2026-05-28T00:00:00Z"),
  text: "President posted about tariffs",
  data: {
    modelIds: ["gpt-5.6", "gpt-4.1"],
    release: {
      model: "gpt-5.6",
      confidence: 0.98,
    },
    posts: [
      { text: "hello" },
      { text: "tariffs today" },
    ],
  },
};

describe("conditions", () => {
  test("matches OpenAI model ids", () => {
    const condition: ManifestCondition = { type: "modelIdPresent", modelId: "gpt-5.6", match: "exact" };
    expect(evaluateCondition(condition, event).matched).toBe(true);
  });

  test("matches text includes case-insensitively", () => {
    const condition: ManifestCondition = { type: "textIncludes", terms: ["TARIFFS"], mode: "any", caseSensitive: false };
    expect(evaluateCondition(condition, event).matched).toBe(true);
  });

  test("does not match absent text regex", () => {
    const condition: ManifestCondition = { type: "textMatches", pattern: "healthcare", flags: "iu" };
    expect(evaluateCondition(condition, event).matched).toBe(false);
  });

  test("composes multiple conditions with all", () => {
    const condition: ManifestCondition = {
      type: "all",
      conditions: [
        { type: "modelIdPresent", modelId: "gpt-5.6", match: "exact" },
        { type: "jsonCompare", path: "$.release.confidence", operator: "gte", value: 0.9 },
      ],
    };
    expect(evaluateCondition(condition, event).matched).toBe(true);
  });

  test("supports any and not", () => {
    const condition: ManifestCondition = {
      type: "any",
      conditions: [
        { type: "textMatches", pattern: "healthcare", flags: "iu" },
        {
          type: "not",
          condition: { type: "jsonEquals", path: "$.release.model", value: "gpt-4.5" },
        },
      ],
    };
    expect(evaluateCondition(condition, event).matched).toBe(true);
  });

  test("selects wildcard JSON values", () => {
    const condition: ManifestCondition = { type: "jsonMatches", path: "$.posts[*].text", pattern: "tariffs", flags: "iu" };
    expect(evaluateCondition(condition, event).matched).toBe(true);
  });
});
