# Agent Notes

Read this before changing Portent. This repo can place live Polymarket orders. Small-looking changes can affect real money.

Keep the design boring. Most behavior should stay visible in YAML manifests, not hidden behind clever runtime inference.

## Quick Commands

```bash
bun run typecheck
bun run check
bun test
bun run simulate -- manifests/my-strategy.yaml
bun run preflight -- manifests/my-strategy.yaml
bun run schema
```

`bun run preflight` is an optional live check. Read-only by default: it builds the real CLOB client, posts a heartbeat, sends a test Telegram message, and runs order preflight against resolved markets. It checks that markets resolve and are within their `startAt`/`stopAt` window; it does not evaluate signals/conditions (that's `simulate`) and does not check wallet balance or allowances. With `--execute` it places one post-only probe order at the market minimum size and lowest tick, then cancels it; a cancel failure is returned as data so the command can report the live order id rather than masking a placement success as a failure. The probe lives on the concrete `PolymarketTradingClient` (`probeOrder`), deliberately not on the `TradingClient` interface, so the runtime and test fakes stay minimal.

`bun run check` runs TypeScript and validates every manifest in `MANIFEST_DIR` or `manifests/`.

Checked-in examples live in `manifest-examples/`. Runtime manifests live in `manifests/`. The YAML files under `manifests/` are gitignored because they may contain live strategy intent, position sizes, and private market choices.

`bun run schema` regenerates `schemas/manifest.schema.json` from the Zod manifest schema. Run it after changing manifest shape.

The full `bun test` command may fail on Windows/Bun while importing the Polymarket SDK through axios/form-data. Do not ignore new test failures, but know this existing failure mode before chasing the wrong problem.

## The Mental Model

A manifest says:

```text
watch this signal
when this pure condition matches
pick one eligible market target
reserve execution/budget
submit one order
record local state
notify the operator
```

The service is one process. It reads `.env`, loads YAML manifests, groups compatible signal loops, and writes local state under `.portent/`.

Do not add a database, queue, scheduler, plugin system, or strategy engine unless the user explicitly asks for that level of machinery. This project is intentionally a small Bun service.

## File Map

`src/config/env.ts`
: Parses `.env`. This is the only place environment variable shape should live.

`src/config/manifest.ts`
: Owns the manifest schema, defaults, TypeScript output types, JSON Schema export, and cross-manifest validation.

`src/signals/*`
: Signal adapters. They turn external APIs or streams into normalized `SignalEvent` records.

`src/conditions.ts`
: Pure condition matching over `SignalEvent`. No network calls. No arbitrary user code.

`src/markets/polymarket.ts`
: Polymarket URL parsing, Gamma lookup, outcome token resolution, market date handling, and live-target checks.

`src/trading/polymarket.ts`
: CLOB client setup, auth credential derivation, order preflight, order creation/posting, and heartbeat.

`src/runtime/runner.ts`
: Runtime orchestration. Group signal loops, evaluate conditions, reserve execution, resolve/select market target, submit order, notify.

`src/runtime/state.ts`
: Local durable state. Dedupe, repeat limits, provider cursors, budget reservations, execution records, and order ledger.

`src/notifications/telegram.ts`
: Console/Telegram notification formatting and delivery.

`src/notifications/telegram-commands.ts`
: Telegram slash commands. Keep this read-only unless the user explicitly asks for remote control.

`src/http.ts`
: Typed HTTP boundary with Zod parsing, retry, timeout, and abort behavior.

`src/sleep.ts`
: Abortable and long-delay-safe timers. Use this instead of raw `setTimeout` for runtime waits.

## Manifest Relationships

See the README for `market` / `markets` / `marketSelection` semantics. Agent-specific rules:

- Keep live strategies out of the repo. Generic examples go in `manifest-examples/`; users copy them into the gitignored `manifests/`.
- `market` and `markets` are mutually exclusive. `markets` is target selection, one buy per execution.
- Do not split `order.amountUsd` across `markets`. That was intentionally rejected: multi-market is selection, not allocation.

## Shared Budgets

See the README for what `budget` does. Invariants to preserve:

- `budget.limitUsd` caps total spend across all executions in the same `budget.group`.
- All manifests in a `budget.group` must declare the same `limitUsd`; `validateManifestSet()` enforces this.
- `priority` controls same-event ordering only (lower first, ties by manifest id). It is claim order, not an optimizer.
- Budget usage is recorded in `.portent/state.json`, so restarts preserve spent budget.

## Runtime Flow

The core path is in `src/runtime/runner.ts`.

1. Load enabled manifests.
2. Group manifests by exact stable JSON of `signal`.
3. Resolve market timing for the group.
4. Wait until the earliest `startAt` if needed.
5. Create a scoped abort that ends the group when all known targets reach cutoff.
6. Stream or poll one signal for the group.
7. Evaluate each manifest's own condition once per signal event.
8. For each matched manifest in budget priority order:
   - reserve execution in `JsonStateStore`
   - resolve fresh markets
   - skip expired/not-started targets
   - select one market target
   - notify `conditionMatched`
   - submit one order
   - commit execution

`conditionMatched` should not fire on every polling match. It should fire only when the manifest is past dedupe/budget/timing checks and is about to submit.

Signal grouping is deliberately by `signal`, not by `{ signal, condition }`. If two manifests poll the same API with different conditions, they must share one signal loop. Keep conditions per manifest.

Use `reserveExecution()` before doing order work. Release the reservation on every failure or skip path before commit.

## State Invariants

`JsonStateStore` owns:

- provider cursors via `getLastSeen()` / `setLastSeen()`
- once/repeat dedupe
- pending budget reservations
- committed execution records
- order ledger JSONL

Do not reimplement dedupe or budget logic in `runner.ts`, signal adapters, or trading code. Ask state for a reservation and either commit it or release it.

`recordExecution()` is what makes a manifest/event durable. If an order submission succeeds but execution is not recorded, the bot can submit again after restart.

Budget reservations are in memory while orders are in flight. Committed budget is in `.portent/state.json`.

## Market Timing

Market timing comes from two places:

- manifest `startAt` / `stopAt`
- Gamma market end/resolution fields

Manifest `stopAt` overrides Gamma end date for that target.

Targets before `startAt` are not live. Targets at or after `stopAt` are not live.

Use the helpers in `src/markets/polymarket.ts`:

- `effectiveMarketStartAt`
- `effectiveMarketStopAt`
- `isBeforeMarketStart`
- `isPastMarketStop`
- `isMarketTargetLive`

Do not use raw date comparisons in runner changes unless you are adding a helper there for a specific reason.

Long waits must use `sleep()` or `setLongTimeout()` from `src/sleep.ts`. Raw `setTimeout()` overflows for delays above `2_147_483_647ms`.

## Signals

A signal adapter produces `SignalEvent`:

```ts
{
  id,
  source,
  occurredAt,
  data,
  text?
}
```

Stable `id` values matter. They drive dedupe. For polling snapshots, the id should be stable for the same observed state. For feeds/streams, use provider ids.

Current adapters:

- `openai.models`: polls OpenAI model ids.
- `http.poll`: polls JSON APIs and extracts events with JSON paths.
- `rss.feed`: polls RSS/Atom feeds.
- `web.page`: polls plain HTTP pages, strips HTML, and emits text changes.
- `websocket.json`: reads JSON messages from a WebSocket.
- `x.filteredStream`: streams X filtered posts.
- `truthsocial.accountStatuses`: polls public Truth Social statuses.

When adding one:

1. Add schema in `src/config/manifest.ts`.
2. Add adapter in `src/signals/`.
3. Wire it in `src/signals/index.ts`.
4. Use `fetchJson()` or `fetchText()` for HTTP and Zod at the boundary.
5. Add tests and an example manifest when useful.

Do not make `web.page` browser-based without a separate design pass. It is intentionally plain HTTP so the service stays small and deterministic.

## Conditions

Conditions are pure: they only inspect a `SignalEvent`. Composition is `all` / `any` / `not`; the README lists the leaf conditions.

Do not add arbitrary JavaScript conditions. If custom logic is needed, expose typed data through `http.poll` and combine JSON conditions.

## Trading

Trading code lives in `src/trading/polymarket.ts`.

The CLOB client uses:

- signer private key
- funder wallet address
- signature type
- optional or derived CLOB API credentials

`resolveApiKeyCreds()` derives credentials on startup when the three `POLYMARKET_API_*` values are blank. Partial credentials are invalid.

Every order goes through preflight:

- token id
- tick size
- negative-risk flag
- best ask when needed

`assertPricePreflight()` protects `maxPrice`. Keep price checks in trading, not in the runtime.

The runtime submits one order per manifest execution. Do not make `TradingClient.submitOrder()` secretly split an order.

## Notifications

Notifications are operational events, not logs.

Expected high-value notifications:

- startup summary
- manifest armed/disabled
- manifest expired
- condition matched when an order is about to submit
- order submitted
- order failed
- non-routine skipped orders
- recoverable runtime errors
- fatal shutdown

Avoid notification spam from polling. Repeated already-executed, `order.once`, and cooldown skips should stay quiet unless the user asks for verbose diagnostics.

## Telegram Commands

Telegram commands are separate from outbound notifications.

Current commands:

- `/status`: reports uptime, enabled manifests, signal groups, last event/match/error, and budget usage.
- `/help`: lists commands.

Only accept commands from `TELEGRAM_CHAT_ID`. Do not add order-placement, manifest enabling, or wallet operations through Telegram unless the user explicitly asks for a remote-control feature and the safety model is updated.

`/status` should stay read-only and cheap. It should inspect `RuntimeStatusTracker` and `JsonStateStore`; it should not poll providers, resolve markets, or touch CLOB.

## Config And Schema

Manifest shape is Zod-first. Change `src/config/manifest.ts`, then regenerate JSON Schema:

```bash
bun run schema
```

Do not hand-edit `schemas/manifest.schema.json`.

If a manifest field affects more than one manifest, add validation in `validateManifestSet()`. Current example: same `budget.group` must use the same `limitUsd`.

## Testing Expectations

For schema or manifest changes:

```bash
bun run typecheck
bun run check
bun test test/manifest.test.ts
```

For runtime/state changes:

```bash
bun test test/state.test.ts test/market-selection.test.ts
```

For signal changes:

```bash
bun test test/http-signal.test.ts test/conditions.test.ts
```

For trading changes:

```bash
bun test test/trading.test.ts
```

If full `bun test` fails only on the known Polymarket SDK `form-data` import issue, say that clearly. Do not claim the full suite passed.

## Production Caution

`enabled: true` can place live orders.

Before enabling a manifest:

- run `bun run check`
- run `bun run simulate -- path/to/manifest.yaml`
- optionally run `bun run preflight -- path/to/manifest.yaml` to confirm credentials, markets, and order preflight against the live CLOB
- verify `.env` points at the intended wallet and chain
- verify `POLYMARKET_SIGNATURE_TYPE`
- verify `order.amountUsd`, `maxPrice`, and budget group
- verify market `stopAt` for time-window markets

Never make a change that increases spend, bypasses dedupe, or broadens matching conditions without making it obvious in the manifest or docs.

## Design Rules

Prefer boring explicitness:

- YAML describes strategy intent.
- Signals fetch and normalize outside data.
- Conditions decide on normalized data.
- Markets resolve Polymarket-specific target details.
- State owns dedupe and budget.
- Trading owns CLOB details.
- Runtime coordinates; it should not become a strategy engine.

When a feature feels like "the bot should decide," stop and make the decision configurable in the manifest or expressed by signal data.

Keep modules shallow. Add a new abstraction only when it removes real coupling or protects an invariant that multiple callers would otherwise have to remember.
