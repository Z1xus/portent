import { createHash } from "node:crypto";
import type { ManifestSignal } from "../config/manifest.ts";
import { fetchText } from "../text-http.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import { resolveConfiguredHeaders } from "./http-auth.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type WebPageSignal = Extract<ManifestSignal, { readonly type: "web.page" }>;

export async function* streamWebPage(
  signal: WebPageSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  const stateKey = `web.page:last:${signal.url}`;
  while (!context.abortSignal.aborted) {
    const event = await readWebPageSnapshot(signal, context);
    const lastSeen = await context.state?.getLastSeen(stateKey);
    if (!lastSeen && signal.startFromLatest) {
      await context.state?.setLastSeen(stateKey, event.id);
    } else if (signal.emit === "always" || event.id !== lastSeen) {
      yield event;
      await context.state?.setLastSeen(stateKey, event.id);
    }
    await sleep(signal.pollMs, context.abortSignal);
  }
}

export async function readWebPageSnapshot(
  signal: WebPageSignal,
  context: SignalContext,
): Promise<SignalEvent> {
  const html = await fetchText(context.fetcher, signal.url, {
    headers: resolveConfiguredHeaders(signal),
    timeoutMs: signal.request.timeoutMs,
    retry: signal.request.retry,
    signal: context.abortSignal,
  });
  const text = normalizeWhitespace(stripHtml(html));
  const contentHash = hash(text);
  return {
    id: asSignalEventId(`web.page:${contentHash}`),
    source: signal.type,
    occurredAt: new Date(),
    text,
    url: signal.url,
    data: {
      url: signal.url,
      contentHash,
      text,
    },
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
