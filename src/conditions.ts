import type { ManifestCondition } from "./config/manifest.ts";
import { selectJsonValues, stableJsonStringify } from "./json-path.ts";
import type { SignalEvent } from "./signals/index.ts";
import { assertNever } from "./types.ts";

export interface ConditionResult {
  readonly matched: boolean;
  readonly reason: string;
}

export function evaluateCondition(condition: ManifestCondition, event: SignalEvent): ConditionResult {
  switch (condition.type) {
    case "all":
      return evaluateAll(condition, event);
    case "any":
      return evaluateAny(condition, event);
    case "not":
      return evaluateNot(condition, event);
    case "modelIdPresent":
      return evaluateModelIdPresent(condition, event);
    case "textIncludes":
      return evaluateTextIncludes(condition, event);
    case "textMatches":
      return evaluateTextMatches(condition, event);
    case "jsonExists":
      return evaluateJsonExists(condition, event);
    case "jsonEquals":
      return evaluateJsonEquals(condition, event);
    case "jsonIncludes":
      return evaluateJsonIncludes(condition, event);
    case "jsonMatches":
      return evaluateJsonMatches(condition, event);
    case "jsonCompare":
      return evaluateJsonCompare(condition, event);
    default:
      return assertNever(condition);
  }
}

function evaluateAll(
  condition: Extract<ManifestCondition, { readonly type: "all" }>,
  event: SignalEvent,
): ConditionResult {
  const results = condition.conditions.map((child) => evaluateCondition(child, event));
  const failed = results.find((result) => !result.matched);
  return failed
    ? { matched: false, reason: `all failed: ${failed.reason}` }
    : { matched: true, reason: `all matched: ${results.map((result) => result.reason).join("; ")}` };
}

function evaluateAny(
  condition: Extract<ManifestCondition, { readonly type: "any" }>,
  event: SignalEvent,
): ConditionResult {
  const results = condition.conditions.map((child) => evaluateCondition(child, event));
  const matched = results.find((result) => result.matched);
  return matched
    ? { matched: true, reason: `any matched: ${matched.reason}` }
    : { matched: false, reason: `any failed: ${results.map((result) => result.reason).join("; ")}` };
}

function evaluateNot(
  condition: Extract<ManifestCondition, { readonly type: "not" }>,
  event: SignalEvent,
): ConditionResult {
  const result = evaluateCondition(condition.condition, event);
  return {
    matched: !result.matched,
    reason: result.matched ? `not failed: ${result.reason}` : `not matched: ${result.reason}`,
  };
}

function evaluateModelIdPresent(
  condition: Extract<ManifestCondition, { readonly type: "modelIdPresent" }>,
  event: SignalEvent,
): ConditionResult {
  const modelIds = readStringArray(event.data, "modelIds");
  const matched = modelIds.some((modelId) => matchModelId(modelId, condition.modelId, condition.match));
  return {
    matched,
    reason: matched
      ? `model '${condition.modelId}' matched in ${modelIds.length} OpenAI models`
      : `model '${condition.modelId}' not found in ${modelIds.length} OpenAI models`,
  };
}

function evaluateJsonExists(
  condition: Extract<ManifestCondition, { readonly type: "jsonExists" }>,
  event: SignalEvent,
): ConditionResult {
  const values = selectJsonValues(event.data, condition.path);
  return {
    matched: values.length > 0,
    reason: values.length > 0 ? `${condition.path} exists` : `${condition.path} does not exist`,
  };
}

function evaluateJsonEquals(
  condition: Extract<ManifestCondition, { readonly type: "jsonEquals" }>,
  event: SignalEvent,
): ConditionResult {
  const values = selectJsonValues(event.data, condition.path);
  const expected = stableJsonStringify(condition.value);
  const matched = values.some((value) => stableJsonStringify(value) === expected);
  return {
    matched,
    reason: matched ? `${condition.path} equals ${expected}` : `${condition.path} did not equal ${expected}`,
  };
}

function evaluateJsonIncludes(
  condition: Extract<ManifestCondition, { readonly type: "jsonIncludes" }>,
  event: SignalEvent,
): ConditionResult {
  const values = selectJsonValues(event.data, condition.path);
  const expected = condition.value;
  const matched = values.some((value) => jsonIncludes(value, expected));
  return {
    matched,
    reason: matched ? `${condition.path} includes ${stableJsonStringify(expected)}` : `${condition.path} did not include ${stableJsonStringify(expected)}`,
  };
}

function evaluateJsonMatches(
  condition: Extract<ManifestCondition, { readonly type: "jsonMatches" }>,
  event: SignalEvent,
): ConditionResult {
  const regexp = new RegExp(condition.pattern, condition.flags);
  const values = selectJsonValues(event.data, condition.path);
  const matched = values.some((value) => typeof value === "string" && regexp.test(value));
  return {
    matched,
    reason: matched ? `${condition.path} matched /${condition.pattern}/${condition.flags}` : `${condition.path} did not match /${condition.pattern}/${condition.flags}`,
  };
}

function evaluateJsonCompare(
  condition: Extract<ManifestCondition, { readonly type: "jsonCompare" }>,
  event: SignalEvent,
): ConditionResult {
  const values = selectJsonValues(event.data, condition.path);
  const matched = values.some((value) => typeof value === "number" && compareNumber(value, condition.operator, condition.value));
  return {
    matched,
    reason: matched ? `${condition.path} ${condition.operator} ${condition.value}` : `${condition.path} did not satisfy ${condition.operator} ${condition.value}`,
  };
}

function evaluateTextIncludes(
  condition: Extract<ManifestCondition, { readonly type: "textIncludes" }>,
  event: SignalEvent,
): ConditionResult {
  const text = event.text ?? "";
  const haystack = condition.caseSensitive ? text : text.toLocaleLowerCase();
  const terms = condition.caseSensitive ? condition.terms : condition.terms.map((term) => term.toLocaleLowerCase());
  const checks = terms.map((term) => haystack.includes(term));
  const matched = condition.mode === "all" ? checks.every(Boolean) : checks.some(Boolean);
  return {
    matched,
    reason: matched ? `text matched ${condition.mode} configured terms` : `text did not match ${condition.mode} configured terms`,
  };
}

function evaluateTextMatches(
  condition: Extract<ManifestCondition, { readonly type: "textMatches" }>,
  event: SignalEvent,
): ConditionResult {
  const regexp = new RegExp(condition.pattern, condition.flags);
  const matched = regexp.test(event.text ?? "");
  return {
    matched,
    reason: matched ? `text matched /${condition.pattern}/${condition.flags}` : `text did not match /${condition.pattern}/${condition.flags}`,
  };
}

function matchModelId(modelId: string, expected: string, mode: "exact" | "includes" | "regex"): boolean {
  switch (mode) {
    case "exact":
      return modelId === expected;
    case "includes":
      return modelId.includes(expected);
    case "regex":
      return new RegExp(expected, "u").test(modelId);
    default:
      return assertNever(mode);
  }
}

function readStringArray(data: Record<string, unknown>, key: string): readonly string[] {
  const value = data[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function jsonIncludes(value: unknown, expected: unknown): boolean {
  if (typeof value === "string" && typeof expected === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    const expectedStable = stableJsonStringify(expected);
    return value.some((item) => stableJsonStringify(item) === expectedStable);
  }
  return false;
}

function compareNumber(left: number, operator: "gt" | "gte" | "lt" | "lte" | "eq", right: number): boolean {
  switch (operator) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
    default:
      return assertNever(operator);
  }
}
