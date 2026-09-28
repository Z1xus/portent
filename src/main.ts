import { loadRuntimeEnv } from "./config/env.ts";
import { loadManifestDir } from "./config/manifest.ts";
import { GammaMarketResolver } from "./markets/polymarket.ts";
import { runTelegramCommandLoop } from "./notifications/telegram-commands.ts";
import { CompositeNotifier, ConsoleNotifier, TelegramNotifier } from "./notifications/telegram.ts";
import { runRuntime } from "./runtime/runner.ts";
import { JsonStateStore } from "./runtime/state.ts";
import { RuntimeStatusTracker } from "./runtime/status.ts";
import { createPolymarketTradingClient } from "./trading/polymarket.ts";

async function main(): Promise<void> {
  const env = await loadRuntimeEnv();
  const manifests = await loadManifestDir(env.paths.manifestDir);
  const state = new JsonStateStore(env.paths.stateDir);
  await state.init();

  const abortController = new AbortController();
  installShutdownHandlers(abortController);

  const notifier = new CompositeNotifier([
    new ConsoleNotifier(),
    new TelegramNotifier(env.telegram),
  ]);
  const status = new RuntimeStatusTracker();
  const trading = await createPolymarketTradingClient(env);
  const marketResolver = new GammaMarketResolver({ fetcher: fetch, cacheTtlMs: 30_000 });

  try {
    await Promise.all([
      runRuntime({
        env,
        manifests,
        state,
        notifier,
        trading,
        marketResolver,
        abortSignal: abortController.signal,
        status,
      }),
      runTelegramCommandLoop({
        env: env.telegram,
        manifests,
        state,
        status,
        abortSignal: abortController.signal,
      }),
    ]);
  } catch (error) {
    await notifier.notify({ type: "fatal", error });
    throw error;
  }
}

function installShutdownHandlers(abortController: AbortController): void {
  const shutdown = (): void => {
    if (abortController.signal.aborted) {
      process.exit(1);
    }
    abortController.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
