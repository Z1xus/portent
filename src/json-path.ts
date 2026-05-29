export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type Segment =
  | { readonly type: "property"; readonly key: string }
  | { readonly type: "index"; readonly index: number }
  | { readonly type: "wildcard" };

export function selectJsonValues(value: unknown, path: string): readonly unknown[] {
  const segments = parsePath(path);
  let current: readonly unknown[] = [value];
  for (const segment of segments) {
    current = current.flatMap((item) => selectSegment(item, segment));
  }
  return current;
}

export function firstJsonValue(value: unknown, path: string): unknown {
  return selectJsonValues(value, path)[0];
}

export function normalizeJsonData(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return { value };
}

export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsePath(path: string): readonly Segment[] {
  if (path === "$") {
    return [];
  }
  if (!path.startsWith("$.")) {
    throw new Error(`JSON path must start with '$' or '$.': ${path}`);
  }
  const segments: Segment[] = [];
  let index = 2;
  let property = "";

  const flushProperty = (): void => {
    if (property.length > 0) {
      segments.push({ type: "property", key: property });
      property = "";
    }
  };

  while (index < path.length) {
    const char = path[index];
    if (char === ".") {
      flushProperty();
      index += 1;
      continue;
    }
    if (char === "[") {
      flushProperty();
      const close = path.indexOf("]", index);
      if (close < 0) {
        throw new Error(`Unclosed bracket in JSON path: ${path}`);
      }
      const body = path.slice(index + 1, close);
      if (body === "*") {
        segments.push({ type: "wildcard" });
      } else {
        const parsedIndex = Number(body);
        if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
          throw new Error(`Only non-negative array indexes and [*] are supported in JSON paths: ${path}`);
        }
        segments.push({ type: "index", index: parsedIndex });
      }
      index = close + 1;
      continue;
    }
    property += char;
    index += 1;
  }
  flushProperty();
  return segments;
}

function selectSegment(value: unknown, segment: Segment): readonly unknown[] {
  switch (segment.type) {
    case "property":
      return isRecord(value) && segment.key in value ? [value[segment.key]] : [];
    case "index":
      return Array.isArray(value) ? [value[segment.index]].filter((item) => item !== undefined) : [];
    case "wildcard":
      if (Array.isArray(value)) {
        return value;
      }
      if (isRecord(value)) {
        return Object.values(value);
      }
      return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
