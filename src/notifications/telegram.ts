import { z } from "zod";
import type { RuntimeEnv } from "../config/env.ts";
import { manifestMarkets, type Manifest } from "../config/manifest.ts";
import { fetchJson, type Fetcher } from "../http.ts";
import type { OrderSubmission } from "../trading/polymarket.ts";
import { formatUnknownError } from "../types.ts";

export type NotificationEvent =
  | { readonly type: "startup"; readonly manifestCount: number; readonly enabledCount: number }
  | { readonly type: "preflight" }
  | { readonly type: "manifestArmed"; readonly manifest: Manifest }
  | { readonly type: "manifestDisabled"; readonly manifest: Manifest }
  | { readonly type: "manifestExpired"; readonly manifest: Manifest; readonly stopAt: Date }
  | { readonly type: "conditionMatched"; readonly manifest: Manifest; readonly reason: string }
  | { readonly type: "orderSubmitted"; readonly manifest: Manifest; readonly submission: OrderSubmission }
  | { readonly type: "orderSkipped"; readonly manifest: Manifest; readonly reason: string }
  | { readonly type: "orderFailed"; readonly manifest: Manifest; readonly error: unknown }
  | { readonly type: "recoverableError"; readonly manifest?: Manifest; readonly error: unknown }
  | { readonly type: "fatal"; readonly error: unknown };

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
    console.log(formatNotification(event));
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
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const response = await fetchJson(this.fetcher, url, TelegramResponseSchema, {
      method: "POST",
      body: {
        chat_id: this.chatId,
        text: formatNotification(event),
        disable_web_page_preview: true,
      },
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

export function formatNotification(event: NotificationEvent): string {
  switch (event.type) {
    case "startup":
      return `Portent started. manifests=${event.manifestCount}, enabled=${event.enabledCount}`;
    case "preflight":
      return "Portent preflight check. If you can read this, Telegram alerts are wired up correctly.";
    case "manifestArmed":
      return `Manifest armed: ${event.manifest.id} -> ${formatManifestMarkets(event.manifest)}`;
    case "manifestDisabled":
      return `Manifest disabled: ${event.manifest.id}`;
    case "manifestExpired":
      return `Manifest expired: ${event.manifest.id}. stopAt=${event.stopAt.toISOString()}`;
    case "conditionMatched":
      return `Condition matched: ${event.manifest.id}. ${event.reason}`;
    case "orderSubmitted":
      return `Order submitted: ${event.manifest.id}. status=${event.submission.status}, success=${event.submission.success}, orderId=${event.submission.orderId ?? "unknown"}`;
    case "orderSkipped":
      return `Order skipped: ${event.manifest.id}. ${event.reason}`;
    case "orderFailed":
      return `Order failed: ${event.manifest.id}. ${formatUnknownError(event.error)}`;
    case "recoverableError":
      return event.manifest
        ? `Recoverable error in ${event.manifest.id}: ${formatUnknownError(event.error)}`
        : `Recoverable error: ${formatUnknownError(event.error)}`;
    case "fatal":
      return `Portent fatal shutdown: ${formatUnknownError(event.error)}`;
  }
}

function formatManifestMarkets(manifest: Manifest): string {
  return manifestMarkets(manifest)
    .map((market) => `${market.id ? `${market.id}:` : ""}${market.outcome} on ${market.url}`)
    .join(", ");
}
