import { evaluateCondition } from "../conditions.ts";
import { loadOptionalRuntimeEnv } from "../config/env.ts";
import { loadManifestDir, loadManifestFile, manifestSignals, type Manifest } from "../config/manifest.ts";
import { GammaMarketResolver } from "../markets/polymarket.ts";
import { readSignalSnapshot } from "../signals/index.ts";
import { color, info, item, pass, section, status, warn } from "./format.ts";

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
    warn("No enabled manifests to simulate. Pass a path, or enable a manifest in MANIFEST_DIR.");
    process.exit(0);
  }
}

for (const { manifest, source } of manifests) {
  section(`Simulate ${manifest.id}`);
  info(`Loaded from ${source}`);
  const target = await marketResolver.resolve(manifest);
  pass(`Resolved market. ${item("market", target.marketSlug)} ${item("outcome", target.outcome)} ${item("token", target.tokenId)}`);

  const events = (await Promise.all(manifestSignals(manifest).map((signal) => readSignalSnapshot(signal, {
    env,
    fetcher: fetch,
    abortSignal: new AbortController().signal,
  })))).flat();
  if (events.length === 0) {
    warn("No signal events available for simulation.");
    continue;
  }
  for (const event of events) {
    const result = evaluateCondition(manifest.condition, event);
    const matchStatus = result.matched ? "matched" : "missed";
    console.log(`  ${status(matchStatus)} ${item("event", event.id)} ${item("source", event.source)}`);
    console.log(`        ${color(result.reason, "dim")}`);
    if (result.matched) {
      pass(`Would submit ${manifest.order.type} ${manifest.order.side} order. ${item("amountUsd", String(manifest.order.amountUsd))} ${item("maxPrice", String(manifest.order.maxPrice))}`);
    }
  }
}
