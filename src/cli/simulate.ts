import { evaluateCondition } from "../conditions.ts";
import { loadOptionalRuntimeEnv } from "../config/env.ts";
import { loadManifestDir, loadManifestFile, type Manifest } from "../config/manifest.ts";
import { GammaMarketResolver } from "../markets/polymarket.ts";
import { readSignalSnapshot } from "../signals/index.ts";

const manifestPaths = Bun.argv.slice(2).filter((arg) => arg !== "--");

const env = await loadOptionalRuntimeEnv();
const marketResolver = new GammaMarketResolver({ fetcher: fetch });

let manifests: readonly { readonly manifest: Manifest; readonly source: string }[];
if (manifestPaths.length > 0) {
  manifests = await Promise.all(
    manifestPaths.map(async (path) => ({ manifest: await loadManifestFile(path), source: path })),
  );
} else {
  const all = await loadManifestDir(env.paths.manifestDir);
  manifests = all
    .filter((manifest) => manifest.enabled)
    .map((manifest) => ({ manifest, source: env.paths.manifestDir }));
  if (manifests.length === 0) {
    console.log("No enabled manifests to simulate. Pass a path, or enable a manifest in MANIFEST_DIR.");
    process.exit(0);
  }
}

for (const { manifest, source } of manifests) {
  console.log(`Simulating ${manifest.id} (${source})`);
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
