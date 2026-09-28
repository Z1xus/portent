import { z } from "zod";
import type { RuntimeEnv } from "../config/env.ts";
import type { Manifest } from "../config/manifest.ts";
import { fetchJson, type Fetcher } from "../http.ts";
import { sleep } from "../sleep.ts";
import type { JsonStateStore } from "../runtime/state.ts";
import type { RuntimeStatusTracker } from "../runtime/status.ts";
import { formatUnknownError } from "../types.ts";
import { escapeHtml } from "./telegram.ts";

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
  let failures = 0;
  await registerCommands(fetcher, options.env.botToken).catch((error: unknown) => {
    console.error(`Telegram setMyCommands failed: ${formatUnknownError(error)}`);
  });
  while (!options.abortSignal.aborted) {
    try {
      const updates = await getUpdates(fetcher, options.env.botToken, offset, options.abortSignal);
      failures = 0;
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await handleUpdate(update, options, fetcher);
      }
    } catch (error) {
      if (!options.abortSignal.aborted) {
        failures += 1;
        if (failures === 1 || failures % 10 === 0) {
          console.error(`Telegram command polling failed (${failures} in a row): ${formatUnknownError(error)}`);
        }
        await sleep(Math.min(1_000 * 2 ** (failures - 1), 60_000), options.abortSignal);
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
    await sendTelegramMessage(fetcher, options.env, "<b>Commands</b>\n/status: signal health and budgets");
  }
}

async function registerCommands(fetcher: Fetcher, token: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const response = await fetchJson(fetcher, url, TelegramSendSchema, {
    method: "POST",
    body: {
      commands: [
        { command: "status", description: "Signal health and budgets" },
        { command: "help", description: "List commands" },
      ],
    },
    timeoutMs: 10_000,
  });
  if (!response.ok) {
    throw new Error("Telegram setMyCommands returned ok=false.");
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
      parse_mode: "HTML",
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
    "<b>📊 Portent status</b>",
    `Up ${formatDuration(uptimeMs)} · ${snapshot.enabledManifestIds.length} of ${snapshot.manifestCount} manifests enabled`,
  ];

  const budgets = options.state.budgetSummaries(options.manifests);
  if (budgets.length > 0) {
    lines.push("", "<b>Budgets</b>");
    for (const budget of budgets) {
      lines.push(escapeHtml(`• ${budget.group}: ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.limitUsd)} spent, ${formatUsd(budget.remainingUsd)} left`)
        + (budget.pendingUsd > 0 ? escapeHtml(`, ${formatUsd(budget.pendingUsd)} pending`) : ""));
    }
  }

  lines.push("", "<b>Signals</b>");
  if (snapshot.groups.length === 0) {
    lines.push("None running.");
  }
  for (const group of snapshot.groups) {
    const failing = group.lastErrorAt !== undefined && (group.lastEventAt === undefined || group.lastErrorAt > group.lastEventAt);
    lines.push(escapeHtml(`${failing ? "⚠️" : "✅"} ${group.label} (${group.manifestIds.join(", ")})`));
    const event = group.lastEventAt ? `${formatAge(group.lastEventAt, snapshot.now)} ago` : "none";
    const match = group.lastMatchedAt ? `${formatAge(group.lastMatchedAt, snapshot.now)} ago` : "none";
    lines.push(escapeHtml(`   Last event ${event} · last match ${match}`));
    if (failing && group.lastErrorAt) {
      lines.push(escapeHtml(`   Error ${formatAge(group.lastErrorAt, snapshot.now)} ago: ${group.lastError ?? "unknown"}`));
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
