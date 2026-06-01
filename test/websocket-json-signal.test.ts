import { describe, expect, test } from "bun:test";
import { parseManifest, type ConcreteManifestSignal } from "../src/config/manifest.ts";
import { readSignalSnapshot } from "../src/signals/index.ts";
import { parseWebSocketJsonMessage } from "../src/signals/websocket-json.ts";
import { baseManifest, contextWithText, firstSignal } from "./signal-test-utils.ts";

describe("websocket.json signal", () => {
  test("parses JSON messages using configured paths", () => {
    const manifest = parseManifest(baseManifest({
      type: "websocket.json",
      url: "wss://example.com/events",
      dataPath: "$.payload",
      eventIdPath: "$.id",
      textPath: "$.payload.message",
    }), "inline.yaml");
    const event = parseWebSocketJsonMessage(asWebSocketSignal(firstSignal(manifest)), JSON.stringify({
      id: "evt-1",
      payload: {
        status: "released",
        message: "Release shipped",
      },
    }));
    expect(event.id).toStartWith("websocket:");
    expect(event.text).toBe("Release shipped");
    expect(event.data["status"]).toBe("released");
  });

  test("snapshot simulation is rejected", async () => {
    const manifest = parseManifest(baseManifest({
      type: "websocket.json",
      url: "wss://example.com/events",
    }), "inline.yaml");
    await expect(readSignalSnapshot(firstSignal(manifest), contextWithText(""))).rejects.toThrow("streaming-only");
  });
});

function asWebSocketSignal(signal: ConcreteManifestSignal): Extract<ConcreteManifestSignal, { readonly type: "websocket.json" }> {
  if (signal.type !== "websocket.json") {
    throw new Error("Expected websocket.json signal.");
  }
  return signal;
}
