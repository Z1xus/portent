import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "../src/config/manifest.ts";
import { JsonStateStore } from "../src/runtime/state.ts";
import type { SignalEvent } from "../src/signals/index.ts";
import type { OrderSubmission } from "../src/trading/polymarket.ts";
import { asOrderId, asSignalEventId } from "../src/types.ts";

const tmpDir = join(".tmp-tests", "state");

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("state store", () => {
  test("prevents duplicate once executions", async () => {
    const manifest = parseManifest({
      id: "once-test",
      enabled: true,
      market: {
        url: "https://polymarket.com/event/event/market",
      },
      signal: {
        type: "openai.models",
      },
      condition: {
        type: "modelIdPresent",
        modelId: "gpt-5.6",
      },
      order: {
        side: "BUY",
        amountUsd: 10,
        maxPrice: 0.9,
        type: "FOK",
      },
    }, "inline.yaml");
    const event: SignalEvent = {
      id: asSignalEventId("event-1"),
      source: "openai.models",
      occurredAt: new Date(),
      data: {},
    };
    const submission: OrderSubmission = {
      orderId: asOrderId("order-1"),
      status: "matched",
      success: true,
      raw: {},
    };
    const state = new JsonStateStore(tmpDir);
    await state.init();
    expect(state.canExecute(manifest, event).allowed).toBe(true);
    await state.recordExecution(manifest, event, submission);
    expect(state.canExecute(manifest, event).allowed).toBe(false);
  });

  test("reserves shared budget across manifests", async () => {
    const first = manifestWithBudget("budget-a", 20, 30);
    const second = manifestWithBudget("budget-b", 20, 30);
    const event = signalEvent("event-1");
    const state = new JsonStateStore(tmpDir);
    await state.init();

    const firstReservation = state.reserveExecution(first, event);
    const secondReservation = state.reserveExecution(second, event);

    expect(firstReservation.allowed).toBe(true);
    expect(secondReservation.allowed).toBe(false);
    firstReservation.release();
  });

  test("blocks concurrent once reservations for the same manifest", async () => {
    const manifest = manifestWithBudget("once-pending", 10, 30);
    const state = new JsonStateStore(tmpDir);
    await state.init();

    const firstReservation = state.reserveExecution(manifest, signalEvent("xai-event"));
    const secondReservation = state.reserveExecution(manifest, signalEvent("openrouter-event"));

    expect(firstReservation.allowed).toBe(true);
    expect(secondReservation.allowed).toBe(false);
    expect(secondReservation.reason).toContain("order.once already reserved");
    firstReservation.release();
  });

  test("commits the actual sized spend, freeing the unused reservation", async () => {
    const first = manifestWithBudget("budget-a", 20, 30);
    const second = manifestWithBudget("budget-b", 20, 30);
    const state = new JsonStateStore(tmpDir);
    await state.init();

    const firstReservation = state.reserveExecution(first, signalEvent("event-1"));
    expect(firstReservation.allowed).toBe(true);
    await firstReservation.commit({ orderId: asOrderId("order-1"), status: "matched", success: true, amountUsd: 5, raw: {} });

    const secondReservation = state.reserveExecution(second, signalEvent("event-2"));
    expect(secondReservation.allowed).toBe(true);
    secondReservation.release();
  });

  test("committed shared budget blocks later reservations", async () => {
    const first = manifestWithBudget("budget-a", 20, 30);
    const second = manifestWithBudget("budget-b", 20, 30);
    const state = new JsonStateStore(tmpDir);
    await state.init();

    const firstReservation = state.reserveExecution(first, signalEvent("event-1"));
    expect(firstReservation.allowed).toBe(true);
    await firstReservation.commit(submission("order-1"));

    const secondReservation = state.reserveExecution(second, signalEvent("event-2"));
    expect(secondReservation.allowed).toBe(false);
  });
});

function manifestWithBudget(id: string, amountUsd: number, limitUsd: number) {
  return parseManifest({
    id,
    enabled: true,
    market: {
      url: "https://polymarket.com/event/event/market",
    },
    signal: {
      type: "openai.models",
    },
    condition: {
      type: "modelIdPresent",
      modelId: "gpt-5.6",
    },
    order: {
      side: "BUY",
      amountUsd,
      maxPrice: 0.9,
      type: "FOK",
    },
    budget: {
      group: "shared-gpt-budget",
      limitUsd,
    },
  }, "inline.yaml");
}

function signalEvent(id: string): SignalEvent {
  return {
    id: asSignalEventId(id),
    source: "openai.models",
    occurredAt: new Date(),
    data: {},
  };
}

function submission(orderId: string): OrderSubmission {
  return {
    orderId: asOrderId(orderId),
    status: "matched",
    success: true,
    raw: {},
  };
}
