import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/config/manifest.ts";
import { readSignalSnapshot, streamSignal } from "../src/signals/index.ts";
import { baseManifest, contextWithText, firstSignal, MemoryState, wait } from "./signal-test-utils.ts";

describe("web.page signal", () => {
  test("emits normalized page text", async () => {
    const manifest = parseManifest(baseManifest({
      type: "web.page",
      url: "https://example.com/status",
    }), "inline.yaml");
    const events = await readSignalSnapshot(firstSignal(manifest), contextWithText("<html><body><h1>Status</h1><p>Ready now</p></body></html>"));
    expect(events[0]?.text).toBe("Status Ready now");
    expect(events[0]?.data["contentHash"]).toBeString();
  });

  test("changed mode skips unchanged page content", async () => {
    const manifest = parseManifest(baseManifest({
      type: "web.page",
      url: "https://example.com/status",
      pollMs: 1000,
      emit: "changed",
      startFromLatest: true,
    }), "inline.yaml");
    const abort = new AbortController();
    const state = new MemoryState();
    const iterator = streamSignal(firstSignal(manifest), contextWithText("<p>same</p>", abort.signal, state))[Symbol.asyncIterator]();
    const next = iterator.next();
    await wait(20);
    abort.abort();
    const result = await next;
    expect(result.done).toBe(true);
  });
});
