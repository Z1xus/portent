import { z } from "zod";
import type { RuntimeEnv } from "../config/env.ts";
import { manifestMarkets, type Manifest } from "../config/manifest.ts";
import { fetchJson, type Fetcher } from "../http.ts";
import type { MarketTarget } from "../markets/polymarket.ts";
import type { OrderSubmission } from "../trading/polymarket.ts";
import { formatUnknownError } from "../types.ts";

export type NotificationEvent =
  | { readonly type: "startup"; readonly manifests: readonly Manifest[] }
  | { readonly type: "preflight" }
  | { readonly type: "manifestEnded"; readonly manifest: Manifest; readonly stopAt?: Date; readonly reason?: string }
  | { readonly type: "conditionMatched"; readonly manifest: Manifest; readonly reason: string }
  | { readonly type: "orderSubmitted"; readonly manifest: Manifest; readonly target: MarketTarget; readonly submission: OrderSubmission }
  | { readonly type: "orderSkipped"; readonly manifest: Manifest; readonly reason: string }
  | { readonly type: "orderFailed"; readonly manifest: Manifest; readonly error: unknown }
  | { readonly type: "recoverableError"; readonly title: string; readonly manifest?: Manifest; readonly error: unknown }
  | { readonly type: "fatal"; readonly error: unknown };

export interface FormattedNotification {
  readonly title: string;
  readonly lines: readonly string[];
  readonly silent: boolean;
}

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

export class CompositeNotifier implements Notifier {
  public constructor(private readonly notifiers: readonly Notifier[]) {}

  public async notify(event: NotificationEvent): Promise<void> {
    await Promise.all(this.notifiers.map((notifier) => notifier.notify(event)));
  }
}

export class ConsoleNotifier implements Notifier {
  public async notify(event: NotificationEvent): Promise<void> {
    console.log(renderPlain(formatNotification(event)));
  }
}

const TelegramResponseSchema = z.object({
  ok: z.boolean(),
}).passthrough();

export class TelegramNotifier implements Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetcher: Fetcher;

  public constructor(env: RuntimeEnv["telegram"], fetcher: Fetcher = fetch) {
    this.token = env.botToken;
    this.chatId = env.chatId;
    this.fetcher = fetcher;
  }

  public async notify(event: NotificationEvent): Promise<void> {
    if ("manifest" in event && event.manifest.notifications.telegram === false) {
      return;
    }
    const message = formatNotification(event);
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const response = await fetchJson(this.fetcher, url, TelegramResponseSchema, {
      method: "POST",
      body: {
        chat_id: this.chatId,
        text: renderTelegramHtml(message),
        parse_mode: "HTML",
        disable_notification: message.silent,
        disable_web_page_preview: true,
      },
      timeoutMs: 10_000,
      retry: { attempts: 3, backoffMs: 500, maxBackoffMs: 4_000 },
    });
    if (!response.ok) {
      throw new Error("Telegram sendMessage returned ok=false.");
    }
  }
}

export class MemoryNotifier implements Notifier {
  public readonly events: NotificationEvent[] = [];

  public async notify(event: NotificationEvent): Promise<void> {
    this.events.push(event);
  }
}

export function formatNotification(event: NotificationEvent): FormattedNotification {
  switch (event.type) {
    case "startup":
      return formatStartup(event.manifests);
    case "preflight":
      return loud("✅ Telegram alerts work", ["This is a Portent preflight test."]);
    case "manifestEnded":
      return silent(`⏹ ${event.manifest.id} ended`, [
        event.reason ?? (event.stopAt ? `Market window closed at ${formatTime(event.stopAt)}.` : "Market closed."),
      ]);
    case "conditionMatched":
      return silent(`🎯 ${event.manifest.id} matched`, [event.reason, "Placing order…"]);
    case "orderSubmitted":
      return formatOrderSubmitted(event.manifest, event.target, event.submission);
    case "orderSkipped":
      return silent(`⏭ ${event.manifest.id} skipped`, [event.reason]);
    case "orderFailed":
      return loud(`❌ ${event.manifest.id} order failed`, [formatUnknownError(event.error)]);
    case "recoverableError":
      return loud(`⚠️ ${event.title}`, [formatUnknownError(event.error)]);
    case "fatal":
      return loud("🛑 Portent stopped", [formatUnknownError(event.error)]);
  }
}

export function renderPlain(message: FormattedNotification): string {
  return [message.title, ...message.lines].join(" | ");
}

export function renderTelegramHtml(message: FormattedNotification): string {
  return [`<b>${escapeHtml(message.title)}</b>`, ...message.lines.map(escapeHtml)].join("\n");
}

function formatStartup(manifests: readonly Manifest[]): FormattedNotification {
  const enabled = manifests.filter((manifest) => manifest.enabled);
  if (enabled.length === 0) {
    return silent("▶️ Portent started", [`No manifests enabled (${manifests.length} loaded).`]);
  }
  return silent("▶️ Portent started", [
    `Watching ${enabled.length} of ${manifests.length} manifests:`,
    ...enabled.map((manifest) => `• ${manifest.id}: ${formatManifestOrder(manifest)}`),
  ]);
}

function formatOrderSubmitted(manifest: Manifest, target: MarketTarget, submission: OrderSubmission): FormattedNotification {
  const lines = [
    target.question ?? target.marketSlug,
    `${formatUsd(submission.amountUsd ?? manifest.order.amountUsd)} of ${target.outcome} at ≤ ${manifest.order.maxPrice}`,
    `Order ${submission.orderId ?? "id unknown"} (${submission.status})`,
  ];
  return submission.success
    ? loud(`✅ ${manifest.id} bought ${target.outcome}`, lines)
    : loud(`⚠️ ${manifest.id} order not confirmed`, [...lines, "Check the order on Polymarket."]);
}

function formatManifestOrder(manifest: Manifest): string {
  const markets = manifestMarkets(manifest);
  const outcomes = Array.from(new Set(markets.map((market) => market.outcome))).join("/");
  const slugs = markets.map((market) => market.id ?? marketSlugFromUrl(market.url)).join(", ");
  return `${outcomes} on ${slugs}, ${formatUsd(manifest.order.amountUsd)} at ≤ ${manifest.order.maxPrice}`;
}

function marketSlugFromUrl(url: string): string {
  const segments = new URL(url).pathname.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? url;
}

export function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function loud(title: string, lines: readonly string[]): FormattedNotification {
  return { title, lines, silent: false };
}

function silent(title: string, lines: readonly string[]): FormattedNotification {
  return { title, lines, silent: true };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
