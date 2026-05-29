import { z } from "zod";
import type { RuntimeEnv } from "../config/env.ts";
import type { Manifest } from "../config/manifest.ts";
import { fetchJson, type Fetcher } from "../http.ts";
import { sleep } from "../sleep.ts";
import type { JsonStateStore } from "../runtime/state.ts";
import type { RuntimeStatusTracker } from "../runtime/status.ts";
import { formatUnknownError } from "../types.ts";

const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z.object({
    message_id: z.number().int(),
    chat: z.object({
      id: z.union([z.string(), z.number()]),
    }).passthrough(),
    text: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const TelegramUpdatesSchema = z.object({
  ok: z.boolean(),
  result: z.array(TelegramUpdateSchema),
}).passthrough();

const TelegramSendSchema = z.object({
  ok: z.boolean(),
}).passthrough();

export interface TelegramCommandLoopOptions {
  readonly env: RuntimeEnv["telegram"];
  readonly status: RuntimeStatusTracker;
  readonly state: JsonStateStore;
  readonly manifests: readonly Manifest[];
  readonly abortSignal: AbortSignal;
  readonly fetcher?: Fetcher;
}

export async function runTelegramCommandLoop(options: TelegramCommandLoopOptions): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  let offset = 0;
  while (!options.abortSignal.aborted) {
    try {
      const updates = await getUpdates(fetcher, options.env.botToken, offset, options.abortSignal);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await handleUpdate(update, options, fetcher);
      }
    } catch (error) {
      if (!options.abortSignal.aborted) {
        console.error(`Telegram command polling failed: ${formatUnknownError(error)}`);
        await sleep(10_000, options.abortSignal);
      }
    }
  }
}

async function handleUpdate(
  update: z.output<typeof TelegramUpdateSchema>,
  options: TelegramCommandLoopOptions,
  fetcher: Fetcher,
): Promise<void> {
  const message = update.message;
  if (!message?.text || String(message.chat.id) !== options.env.chatId) {
    return;
  }
  const command = normalizeCommand(message.text);
  if (command === "/status") {
    await sendTelegramMessage(fetcher, options.env, formatStatus(options));
    return;
  }
  if (command === "/help") {
    await sendTelegramMessage(fetcher, options.env, "Commands:\n/status - show Portent runtime health");
  }
}

async function getUpdates(
  fetcher: Fetcher,
  token: string,
  offset: number,
  signal: AbortSignal,
): Promise<readonly z.output<typeof TelegramUpdateSchema>[]> {
  const url = `https://api.telegram.org/bot${token}/getUpdates`;
  const response = await fetchJson(fetcher, url, TelegramUpdatesSchema, {
    method: "POST",
    body: {
      offset,
      timeout: 25,
      allowed_updates: ["message"],
    },
    timeoutMs: 30_000,
    signal,
    retry: { attempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  });
  if (!response.ok) {
    throw new Error("Telegram getUpdates returned ok=false.");
  }
  return response.result;
}

async function sendTelegramMessage(
  fetcher: Fetcher,
  env: RuntimeEnv["telegram"],
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
  const response = await fetchJson(fetcher, url, TelegramSendSchema, {
    method: "POST",
    body: {
      chat_id: env.chatId,
      text,
      disable_web_page_preview: true,
    },
  });
  if (!response.ok) {
    throw new Error("Telegram sendMessage returned ok=false.");
  }
}

function normalizeCommand(text: string): string {
  const first = text.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const atIndex = first.indexOf("@");
  return atIndex >= 0 ? first.slice(0, atIndex) : first;
}

function formatStatus(options: TelegramCommandLoopOptions): string {
  const snapshot = options.status.snapshot();
  const uptimeMs = snapshot.now.getTime() - snapshot.startedAt.getTime();
  const lines = [
    "Portent status",
    `uptime: ${formatDuration(uptimeMs)}`,
    `manifests: ${snapshot.enabledManifestIds.length}/${snapshot.manifestCount} enabled`,
  ];

  if (snapshot.enabledManifestIds.length > 0) {
    lines.push(`enabled: ${snapshot.enabledManifestIds.join(", ")}`);
  }

  const budgets = options.state.budgetSummaries(options.manifests);
  if (budgets.length > 0) {
    lines.push("");
    lines.push("budgets:");
    for (const budget of budgets) {
      lines.push(`- ${budget.group}: ${formatUsd(budget.spentUsd)} spent, ${formatUsd(budget.pendingUsd)} pending, ${formatUsd(budget.remainingUsd)} left / ${formatUsd(budget.limitUsd)}`);
    }
  }

  lines.push("");
  lines.push("signal groups:");
  if (snapshot.groups.length === 0) {
    lines.push("- none started");
  } else {
    for (const group of snapshot.groups) {
      lines.push(`- ${group.label}`);
      lines.push(`  manifests: ${group.manifestIds.join(", ")}`);
      lines.push(`  last event: ${group.lastEventAt ? `${formatAge(group.lastEventAt, snapshot.now)} ago (${group.lastEventId ?? "unknown"})` : "none"}`);
      lines.push(`  last match: ${group.lastMatchedAt ? `${formatAge(group.lastMatchedAt, snapshot.now)} ago` : "none"}`);
      if (group.lastErrorAt) {
        lines.push(`  last error: ${formatAge(group.lastErrorAt, snapshot.now)} ago - ${group.lastError ?? "unknown"}`);
      }
    }
  }

  return lines.join("\n");
}

function formatAge(date: Date, now: Date): string {
  return formatDuration(Math.max(0, now.getTime() - date.getTime()));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
