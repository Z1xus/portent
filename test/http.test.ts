import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { fetchJson, HttpError, type Fetcher } from "../src/http.ts";

describe("fetchJson", () => {
  test("retries retryable responses and passes timeout signal", async () => {
    let calls = 0;
    const fetcher: Fetcher = async (_input, init) => {
      calls += 1;
      expect(init?.signal).toBeDefined();
      if (calls === 1) {
        return new Response("busy", { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }));
    };

    await expect(fetchJson(fetcher, "https://example.test", z.object({ ok: z.boolean() }), {
      timeoutMs: 1_000,
      retry: {
        attempts: 2,
        backoffMs: 0,
        maxBackoffMs: 0,
      },
    })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("does not retry non-retryable responses", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return new Response("bad", { status: 400 });
    };

    await expect(fetchJson(fetcher, "https://example.test", z.object({ ok: z.boolean() }), {
      retry: {
        attempts: 3,
        backoffMs: 0,
        maxBackoffMs: 0,
      },
    })).rejects.toThrow(HttpError);
    expect(calls).toBe(1);
  });
});
