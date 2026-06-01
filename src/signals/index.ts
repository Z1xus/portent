import type { ManifestSignal } from "../config/manifest.ts";
import { assertNever } from "../types.ts";
import { readHttpPollSnapshot, streamHttpPoll } from "./http-poll.ts";
import { readOpenAiModelsSnapshot, streamOpenAiModels } from "./openai.ts";
import { readOpenRouterModelsSnapshot, streamOpenRouterModels } from "./openrouter.ts";
import { readRssFeedSnapshot, streamRssFeed } from "./rss.ts";
import { readTruthSocialSnapshot, streamTruthSocialStatuses } from "./truthsocial.ts";
import type { SignalContext, SignalEvent } from "./types.ts";
import { readWebPageSnapshot, streamWebPage } from "./web-page.ts";
import { readWebSocketJsonSnapshot, streamWebSocketJson } from "./websocket-json.ts";
import { readXSnapshot, streamXFilteredStream } from "./x.ts";
import { readXAiModelsSnapshot, streamXAiModels } from "./xai.ts";

export function streamSignal(
  signal: ManifestSignal,
  context: SignalContext,
): AsyncIterable<SignalEvent> {
  switch (signal.type) {
    case "openai.models":
      return streamOpenAiModels(signal, context);
    case "openrouter.models":
      return streamOpenRouterModels(signal, context);
    case "xai.models":
      return streamXAiModels(signal, context);
    case "x.filteredStream":
      return streamXFilteredStream(signal, context);
    case "truthsocial.accountStatuses":
      return streamTruthSocialStatuses(signal, context);
    case "http.poll":
      return streamHttpPoll(signal, context);
    case "rss.feed":
      return streamRssFeed(signal, context);
    case "web.page":
      return streamWebPage(signal, context);
    case "websocket.json":
      return streamWebSocketJson(signal, context);
    default:
      return assertNever(signal);
  }
}

export function readSignalSnapshot(
  signal: ManifestSignal,
  context: SignalContext,
): Promise<readonly SignalEvent[]> {
  switch (signal.type) {
    case "openai.models":
      return readOpenAiModelsSnapshot(signal, context);
    case "openrouter.models":
      return readOpenRouterModelsSnapshot(signal, context);
    case "xai.models":
      return readXAiModelsSnapshot(signal, context);
    case "x.filteredStream":
      return readXSnapshot(signal);
    case "truthsocial.accountStatuses":
      return readTruthSocialSnapshot(signal, context);
    case "http.poll":
      return readHttpPollSnapshot(signal, context);
    case "rss.feed":
      return readRssFeedSnapshot(signal, context);
    case "web.page":
      return readWebPageSnapshot(signal, context).then((event) => [event]);
    case "websocket.json":
      return readWebSocketJsonSnapshot(signal);
    default:
      return assertNever(signal);
  }
}

export type { SignalContext, SignalEvent, SignalState } from "./types.ts";
