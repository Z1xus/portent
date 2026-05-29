import { evaluateCondition } from "../conditions.ts";
import { loadOptionalRuntimeEnv } from "../config/env.ts";
import { loadManifestFile } from "../config/manifest.ts";
import { GammaMarketResolver } from "../markets/polymarket.ts";
import { readSignalSnapshot } from "../signals/index.ts";

const manifestPaths = Bun.argv.slice(2).filter((arg) => arg !== "--");
if (manifestPaths.length === 0) {
  throw new Error("Usage: bun run simulate -- manifests/example.yaml");
}

const env = await loadOptionalRuntimeEnv();
const marketResolver = new GammaMarketResolver({ fetcher: fetch });

for (const path of manifestPaths) {
  const manifest = await loadManifestFile(path);
  console.log(`Simulating ${manifest.id} (${path})`);
  const target = await marketResolver.resolve(manifest);
  console.log(`Resolved market: ${target.marketSlug} / ${target.outcome} / token=${target.tokenId}`);

  const events = await readSignalSnapshot(manifest.signal, {
    env,
    fetcher: fetch,
    abortSignal: new AbortController().signal,
  });
  if (events.length === 0) {
    console.log("No signal events available for simulation.");
    continue;
  }
  for (const event of events) {
    const result = evaluateCondition(manifest.condition, event);
    console.log(`${event.id}: matched=${result.matched} reason=${result.reason}`);
    if (result.matched) {
      console.log(`Would submit ${manifest.order.type} ${manifest.order.side} order: amountUsd=${manifest.order.amountUsd}, maxPrice=${manifest.order.maxPrice}`);
    }
  }
}
