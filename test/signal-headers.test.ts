import { describe, expect, test } from "bun:test";
import { resolveConfiguredHeaders } from "../src/signals/http-auth.ts";

describe("configured signal headers", () => {
  test("resolves bearer, static, and env headers", () => {
    const previous = Bun.env["CUSTOM_HEADER_VALUE"];
    Bun.env["CUSTOM_HEADER_VALUE"] = "from-env";
    try {
      const headers = resolveConfiguredHeaders({
        auth: { type: "bearer", tokenEnv: "CUSTOM_HEADER_VALUE" },
        headers: { "X-Static": "static" },
        headersFromEnv: { "X-From-Env": "CUSTOM_HEADER_VALUE" },
      });
      expect(headers.get("authorization")).toBe("Bearer from-env");
      expect(headers.get("x-static")).toBe("static");
      expect(headers.get("x-from-env")).toBe("from-env");
    } finally {
      if (previous === undefined) {
        delete Bun.env["CUSTOM_HEADER_VALUE"];
      } else {
        Bun.env["CUSTOM_HEADER_VALUE"] = previous;
      }
    }
  });
});
