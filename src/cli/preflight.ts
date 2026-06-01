import { loadRuntimeEnv } from "../config/env.ts";
import { loadManifestDir, loadManifestFile, type Manifest } from "../config/manifest.ts";
import { GammaMarketResolver, isMarketTargetLive, type MarketTarget } from "../markets/polymarket.ts";
import { TelegramNotifier } from "../notifications/telegram.ts";
import { assertPricePreflight, createPolymarketTradingClient, type PolymarketTradingClient } from "../trading/polymarket.ts";
import { formatUnknownError } from "../types.ts";
import { color, fail as printFail, info, item, pass, section, title, warn } from "./format.ts";

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
function fail(message: string): void {
  failures += 1;
  printFail(message);
}

section("Preflight");
pass(`Environment parsed. ${item("chain", String(env.polymarket.chainId))} ${item("signatureType", env.polymarket.signatureType)} ${item("funder", env.polymarket.funderAddress)}`);

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
  section(`Manifest ${manifest.id}`);
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
  if (live.length < targets.length) {
    warn(`${targets.length - live.length} inactive target(s) skipped by startAt/stopAt.`);
  }
  for (const target of live) {
    try {
      const preflight = await trading.resolvePreflight(target, manifest);
      assertPricePreflight(manifest, preflight);
      const ask = preflight.bestAsk === undefined ? "n/a" : String(preflight.bestAsk);
      pass(`${target.id} ${target.outcome}: ${item("tick", preflight.tickSize)} ${item("negRisk", String(preflight.negRisk))} ${item("bestAsk", ask)} <= ${item("maxPrice", String(manifest.order.maxPrice))}`);
      probeCandidates.push({ manifest, target });
    } catch (error) {
      fail(`${target.id} ${target.outcome}: ${formatUnknownError(error)}`);
    }
  }
}

if (execute) {
  section("Execute probe");
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

console.log(failures === 0
  ? `\n${color("Preflight passed.", "green")}`
  : `\n${color(`Preflight finished with ${failures} failure(s).`, "red")}`);
process.exit(failures > 0 ? 1 : 0);

function confirm(): boolean {
  console.log(title("Preflight will:"));
  info("Build the live Polymarket CLOB client with your real credentials (derives API keys if needed).");
  info("Send a test message to your Telegram chat.");
  info("Resolve each market and run order preflight. Signals/conditions are not evaluated.");
  if (execute) {
    warn("--execute places ONE real post-only order at the market minimum size and lowest tick, then cancels it.");
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
