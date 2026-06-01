import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/config/manifest.ts";
import { readSignalSnapshot, streamSignal } from "../src/signals/index.ts";
import { baseManifest, contextWithText, firstSignal, MemoryState, wait } from "./signal-test-utils.ts";

describe("rss.feed signal", () => {
  test("emits feed entries", async () => {
    const manifest = parseManifest(baseManifest({
      type: "rss.feed",
      url: "https://example.com/feed.xml",
    }), "inline.yaml");
    const events = await readSignalSnapshot(firstSignal(manifest), contextWithText(`
      <rss><channel><item><title>Release shipped</title><link>https://example.com/post</link><guid>post-1</guid><pubDate>Fri, 29 May 2026 10:00:00 GMT</pubDate><description>hello</description></item></channel></rss>
    `));
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain("Release shipped");
    expect(events[0]?.url).toBe("https://example.com/post");
  });

  test("supports Atom entries", async () => {
    const manifest = parseManifest(baseManifest({
      type: "rss.feed",
      url: "https://example.com/atom.xml",
    }), "inline.yaml");
    const events = await readSignalSnapshot(firstSignal(manifest), contextWithText(`
      <feed><entry><title>Atom release</title><id>tag:example,2026:1</id><updated>2026-05-29T10:00:00Z</updated><link rel="alternate" href="https://example.com/atom-post" /><summary>done</summary></entry></feed>
    `));
    expect(events[0]?.text).toContain("Atom release");
    expect(events[0]?.url).toBe("https://example.com/atom-post");
    expect(events[0]?.occurredAt.toISOString()).toBe("2026-05-29T10:00:00.000Z");
  });

  test("startFromLatest seeds cursor and does not emit old items", async () => {
    const manifest = parseManifest(baseManifest({
      type: "rss.feed",
      url: "https://example.com/feed.xml",
      pollMs: 1000,
      startFromLatest: true,
    }), "inline.yaml");
    const abort = new AbortController();
    const state = new MemoryState();
    const iterator = streamSignal(firstSignal(manifest), contextWithText(feedXml("new", "old"), abort.signal, state))[Symbol.asyncIterator]();
    const next = iterator.next();
    await wait(20);
    abort.abort();
    const result = await next;
    expect(result.done).toBe(true);
    expect(await state.getLastSeen("rss.feed:last:https://example.com/feed.xml")).toStartWith("rss:");
  });

  test("emits only items newer than last seen", async () => {
    const manifest = parseManifest(baseManifest({
      type: "rss.feed",
      url: "https://example.com/feed.xml",
      pollMs: 1000,
      startFromLatest: false,
    }), "inline.yaml");
    const oldId = (await readSignalSnapshot(firstSignal(manifest), contextWithText(feedXml("old"))))[0]?.id;
    expect(oldId).toBeDefined();
    const state = new MemoryState({ "rss.feed:last:https://example.com/feed.xml": oldId ?? "" });
    const abort = new AbortController();
    const iterator = streamSignal(firstSignal(manifest), contextWithText(feedXml("new", "old", "older"), abort.signal, state))[Symbol.asyncIterator]();
    const result = await iterator.next();
    abort.abort();
    expect(result.value?.text).toContain("new");
  });
});

function feedXml(...titles: readonly string[]): string {
  return `<rss><channel>${titles.map((title) => `<item><title>${title}</title><guid>${title}</guid></item>`).join("")}</channel></rss>`;
}
