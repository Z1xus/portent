import { createHash } from "node:crypto";
import type { ManifestSignal } from "../config/manifest.ts";
import { fetchText } from "../text-http.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import { resolveConfiguredHeaders } from "./http-auth.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type RssFeedSignal = Extract<ManifestSignal, { readonly type: "rss.feed" }>;

export async function* streamRssFeed(
  signal: RssFeedSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  const stateKey = `rss.feed:last:${signal.url}`;
  while (!context.abortSignal.aborted) {
    const events = await readRssFeedSnapshot(signal, context);
    const lastSeen = await context.state?.getLastSeen(stateKey);
    const newestId = events[0]?.id;
    if (!lastSeen && signal.startFromLatest) {
      if (newestId) {
        await context.state?.setLastSeen(stateKey, newestId);
      }
    } else {
      const fresh = lastSeen ? events.slice(0, events.findIndex((event) => event.id === lastSeen)) : events;
      for (const event of fresh) {
        yield event;
      }
      if (newestId) {
        await context.state?.setLastSeen(stateKey, newestId);
      }
    }
    await sleep(signal.pollMs, context.abortSignal);
  }
}

export async function readRssFeedSnapshot(
  signal: RssFeedSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  const xml = await fetchText(context.fetcher, signal.url, {
    headers: resolveConfiguredHeaders(signal),
    timeoutMs: signal.request.timeoutMs,
    retry: signal.request.retry,
    signal: context.abortSignal,
  });
  return parseFeedItems(xml).map((item) => ({
    id: asSignalEventId(`rss:${hash(item.id ?? item.link ?? item.title ?? item.text)}`),
    source: signal.type,
    occurredAt: item.publishedAt ?? new Date(),
    text: item.text,
    ...(item.link ? { url: item.link } : {}),
    data: {
      title: item.title,
      link: item.link,
      id: item.id,
      publishedAt: item.publishedAt?.toISOString(),
      summary: item.summary,
    },
  }));
}

interface FeedItem {
  readonly id?: string;
  readonly title?: string;
  readonly link?: string;
  readonly summary?: string;
  readonly text: string;
  readonly publishedAt?: Date;
}

function parseFeedItems(xml: string): readonly FeedItem[] {
  const itemBlocks = blocks(xml, "item");
  const entryBlocks = blocks(xml, "entry");
  return [
    ...itemBlocks.map(parseRssItem),
    ...entryBlocks.map(parseAtomEntry),
  ];
}

function parseRssItem(xml: string): FeedItem {
  const title = tagText(xml, "title");
  const link = tagText(xml, "link");
  const summary = tagText(xml, "description");
  const id = tagText(xml, "guid") ?? link;
  const publishedAt = parseDate(tagText(xml, "pubDate") ?? tagText(xml, "dc:date"));
  return feedItem({ ...(id ? { id } : {}), ...(title ? { title } : {}), ...(link ? { link } : {}), ...(summary ? { summary } : {}), ...(publishedAt ? { publishedAt } : {}) });
}

function parseAtomEntry(xml: string): FeedItem {
  const title = tagText(xml, "title");
  const link = atomLink(xml);
  const summary = tagText(xml, "summary") ?? tagText(xml, "content");
  const id = tagText(xml, "id") ?? link;
  const publishedAt = parseDate(tagText(xml, "updated") ?? tagText(xml, "published"));
  return feedItem({ ...(id ? { id } : {}), ...(title ? { title } : {}), ...(link ? { link } : {}), ...(summary ? { summary } : {}), ...(publishedAt ? { publishedAt } : {}) });
}

function feedItem(input: Omit<FeedItem, "text">): FeedItem {
  const text = [input.title, input.summary, input.link].filter(Boolean).join("\n");
  return {
    ...input,
    text,
  };
}

function blocks(xml: string, tagName: string): readonly string[] {
  return Array.from(xml.matchAll(new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "giu")), (match) => match[1] ?? "");
}

function tagText(xml: string, tagName: string): string | undefined {
  const match = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "iu").exec(xml);
  const value = match?.[1];
  return value ? decodeXml(stripCdata(value)).trim() : undefined;
}

function atomLink(xml: string): string | undefined {
  const alternate = /<link\b(?=[^>]*\brel=["']alternate["'])([^>]*)>/iu.exec(xml)?.[1];
  const any = /<link\b([^>]*)>/iu.exec(xml)?.[1];
  const href = /\bhref=["']([^"']+)["']/iu.exec(alternate ?? any ?? "")?.[1];
  return href ? decodeXml(href).trim() : undefined;
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/u, "").replace(/\]\]>$/u, "");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hash(value: unknown): string {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}
