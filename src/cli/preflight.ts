import { loadRuntimeEnv } from "../config/env.ts";
import { loadManifestDir, loadManifestFile, type Manifest } from "../config/manifest.ts";
import { GammaMarketResolver, isMarketTargetLive, type MarketTarget } from "../markets/polymarket.ts";
import { TelegramNotifier } from "../notifications/telegram.ts";
import { assertPricePreflight, createPolymarketTradingClient, type PolymarketTradingClient } from "../trading/polymarket.ts";
import { formatUnknownError } from "../types.ts";

const args = Bun.argv.slice(2).filter((arg) => arg !== "--");
const execute = args.includes("--execute");
const skipConfirm = args.includes("--yes") || args.includes("-y");
const manifestPaths = args.filter((arg) => !arg.startsWith("--") && arg !== "-y");

const env = await loadRuntimeEnv();

if (!confirm()) {
  console.log("Aborted.");
  process.exit(0);
}

let failures = 0;
function pass(message: string): void {
  console.log(`  OK    ${message}`);
}
function fail(message: string): void {
  failures += 1;
  console.log(`  FAIL  ${message}`);
}

pass(`Environment parsed. chain=${env.polymarket.chainId}, signatureType=${env.polymarket.signatureType}, funder=${env.polymarket.funderAddress}`);

let trading: PolymarketTradingClient;
try {
  trading = await createPolymarketTradingClient(env);
  pass("CLOB client built and API credentials resolved.");
} catch (error) {
  fail(`Could not build CLOB client: ${formatUnknownError(error)}`);
  console.log("\nPreflight aborted: trading client is required for the remaining checks.");
  process.exit(1);
}

try {
  await trading.heartbeat();
  pass("CLOB heartbeat accepted.");
} catch (error) {
  fail(`CLOB heartbeat failed: ${formatUnknownError(error)}`);
}

try {
  await new TelegramNotifier(env.telegram).notify({ type: "preflight" });
  pass(`Telegram reachable. A preflight test message was sent to chat ${env.telegram.chatId}.`);
} catch (error) {
  fail(`Telegram notification failed: ${formatUnknownError(error)}`);
}

const manifests = await resolveManifests();
if (manifests.length === 0) {
  console.log("\nNo manifests to check. Pass a path, or enable a manifest in MANIFEST_DIR.");
  process.exit(failures > 0 ? 1 : 0);
}

const marketResolver = new GammaMarketResolver({ fetcher: fetch });
const probeCandidates: { readonly manifest: Manifest; readonly target: MarketTarget }[] = [];

for (const manifest of manifests) {
  console.log(`\nManifest ${manifest.id}`);
  let targets: readonly MarketTarget[];
  try {
    targets = await marketResolver.resolveAll(manifest);
  } catch (error) {
    fail(`Market resolution failed: ${formatUnknownError(error)}`);
    continue;
  }
  const live = targets.filter((target) => isMarketTargetLive(target));
  if (live.length === 0) {
    fail(`No live market targets (resolved ${targets.length}). Check startAt/stopAt and market dates.`);
    continue;
  }
  for (const target of live) {
    try {
      const preflight = await trading.resolvePreflight(target, manifest);
      assertPricePreflight(manifest, preflight);
      const ask = preflight.bestAsk === undefined ? "n/a" : String(preflight.bestAsk);
      pass(`${target.id} ${target.outcome}: tick=${preflight.tickSize}, negRisk=${preflight.negRisk}, bestAsk=${ask} <= maxPrice=${manifest.order.maxPrice}`);
      probeCandidates.push({ manifest, target });
    } catch (error) {
      fail(`${target.id} ${target.outcome}: ${formatUnknownError(error)}`);
    }
  }
}

if (execute) {
  console.log("\nExecute probe (--execute)");
  const candidate = probeCandidates[0];
  if (!candidate) {
    fail("No market target passed preflight, so no probe order could be placed.");
  } else {
    try {
      const result = await trading.probeOrder(candidate.target);
      const placed = result.placed.orderId
        ? `orderId=${result.placed.orderId}`
        : `status=${result.placed.status} (no orderId returned)`;
      pass(`Probe order placed on ${candidate.target.id} (${result.size} @ ${result.price}). ${placed}`);
      if (result.canceled) {
        pass("Probe order canceled.");
      } else if (result.cancelError) {
        fail(`Probe order placed but the cancel FAILED: ${formatUnknownError(result.cancelError)}. A resting bid (orderId=${result.placed.orderId}) is LIVE on the book — cancel it on Polymarket now.`);
      } else {
        fail("Probe order placed but no orderId was returned to cancel. Check it manually on Polymarket.");
      }
    } catch (error) {
      fail(`Probe order failed: ${formatUnknownError(error)}`);
    }
  }
}

console.log(failures === 0 ? "\nPreflight passed." : `\nPreflight finished with ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);

function confirm(): boolean {
  console.log("Preflight will:");
  console.log("  - build the live Polymarket CLOB client with your real credentials (derives API keys if needed)");
  console.log("  - send a test message to your Telegram chat");
  console.log("  - resolve each market and run order preflight (no orders placed; signals/conditions are NOT evaluated)");
  if (execute) {
    console.log("  - --execute: place ONE real post-only order at the market minimum size and lowest tick, then cancel it");
  }
  if (skipConfirm) {
    return true;
  }
  const answer = prompt("\nContinue? [y/N]")?.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function resolveManifests(): Promise<readonly Manifest[]> {
  if (manifestPaths.length > 0) {
    return Promise.all(manifestPaths.map((path) => loadManifestFile(path)));
  }
  const all = await loadManifestDir(env.paths.manifestDir);
  return all.filter((manifest) => manifest.enabled);
}
