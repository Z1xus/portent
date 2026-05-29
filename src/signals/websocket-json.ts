import { createHash } from "node:crypto";
import type { ManifestSignal } from "../config/manifest.ts";
import { firstJsonValue, normalizeJsonData, stableJsonStringify } from "../json-path.ts";
import { sleep } from "../sleep.ts";
import { asSignalEventId } from "../types.ts";
import { resolveConfiguredHeaders } from "./http-auth.ts";
import type { SignalContext, SignalEvent } from "./types.ts";

type WebSocketJsonSignal = Extract<ManifestSignal, { readonly type: "websocket.json" }>;

export async function* streamWebSocketJson(
  signal: WebSocketJsonSignal,
  context: SignalContext,
): AsyncGenerator<SignalEvent> {
  while (!context.abortSignal.aborted) {
    try {
      for await (const event of connect(signal, context.abortSignal)) {
        yield event;
      }
    } finally {
      if (!context.abortSignal.aborted) {
        await sleep(signal.reconnectMs, context.abortSignal);
      }
    }
  }
}

export async function readWebSocketJsonSnapshot(_signal: WebSocketJsonSignal): Promise<readonly SignalEvent[]> {
  throw new Error("websocket.json is streaming-only and cannot be simulated as a snapshot.");
}

async function* connect(signal: WebSocketJsonSignal, abortSignal: AbortSignal): AsyncGenerator<SignalEvent> {
  const headers = headersObject(resolveConfiguredHeaders(signal));
  const WebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    options?: { readonly headers?: Readonly<Record<string, string>> },
  ) => WebSocket;
  const ws = new WebSocketWithHeaders(signal.url, { headers });
  const queue: SignalEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let error: unknown;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;

  const resetIdle = (): void => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(() => {
      ws.close(4000, `idle after ${signal.idleMs}ms`);
    }, signal.idleMs);
  };
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  const closeFromAbort = (): void => ws.close(1000, "runtime shutdown");

  abortSignal.addEventListener("abort", closeFromAbort, { once: true });
  resetIdle();

  ws.addEventListener("open", () => {
    if (signal.subscribe !== undefined) {
      ws.send(JSON.stringify(signal.subscribe));
    }
  });
  ws.addEventListener("message", (message) => {
    resetIdle();
    try {
      queue.push(parseWebSocketJsonMessage(signal, message.data));
    } catch (messageError) {
      error = messageError;
      ws.close(4001, "invalid message");
    }
    notify();
  });
  ws.addEventListener("error", (event) => {
    error = event;
    notify();
  });
  ws.addEventListener("close", () => {
    closed = true;
    notify();
  });

  try {
    while (!abortSignal.aborted) {
      const event = queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (error) {
        throw error;
      }
      if (closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    abortSignal.removeEventListener("abort", closeFromAbort);
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    ws.close();
  }
}

export function parseWebSocketJsonMessage(signal: WebSocketJsonSignal, data: unknown): SignalEvent {
  const raw = typeof data === "string" ? data : String(data);
  const parsed = JSON.parse(raw) as unknown;
  const dataValue = firstJsonValue(parsed, signal.dataPath) ?? parsed;
  const eventIdValue = signal.eventIdPath ? firstJsonValue(parsed, signal.eventIdPath) : undefined;
  const textValue = signal.textPath ? firstJsonValue(parsed, signal.textPath) : undefined;
  return {
    id: asSignalEventId(`websocket:${hash(eventIdValue ?? dataValue)}`),
    source: signal.type,
    occurredAt: new Date(),
    data: normalizeJsonData(dataValue),
    ...(typeof textValue === "string" ? { text: textValue } : {}),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex").slice(0, 16);
}

function headersObject(headers: Headers): Record<string, string> {
  const values: Record<string, string> = {};
  headers.forEach((value, key) => {
    values[key] = value;
  });
  return values;
}
