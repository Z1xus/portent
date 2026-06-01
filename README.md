# Portent

[![CI](https://github.com/Z1xus/portent/actions/workflows/ci.yml/badge.svg)](https://github.com/Z1xus/portent/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)

A manifest-driven Polymarket trading bot.

You describe a strategy in YAML: a market, a signal to watch, a condition to match, and an order to place. Portent watches the signal and submits a CLOB order the moment the condition fires. Configuration is one `.env` plus one or more manifest files.

`enabled: true` places real orders with the wallet in your `.env`. Keep manifests `enabled: false` until you actually want to trade.

> [!CAUTION]
> In live mode this bot signs transactions, so a bug can spend real money rather than just crash. Review the code before running it, start with a burner wallet and small amounts, and do not point it at funds you cannot afford to lose.

## Install

```bash
bun install
cp .env.example .env # fill in your credentials
```

## `.env`

```bash
POLYMARKET_CLOB_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137
POLYMARKET_RPC_URL=https://polygon-rpc.com
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
POLYMARKET_SIGNATURE_TYPE=POLY_PROXY

# Optional. Leave blank to derive on startup.
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

OPENAI_API_KEY=...
X_BEARER_TOKEN=...
TRUTH_SOCIAL_BASE_URL=https://truthsocial.com

MANIFEST_DIR=manifests
STATE_DIR=.portent
```

- `POLYMARKET_FUNDER_ADDRESS` is the wallet that holds funds (proxy/Safe/deposit).
- `POLYMARKET_PRIVATE_KEY` is the signer key.
- `POLYMARKET_SIGNATURE_TYPE` is `POLY_PROXY`, `GNOSIS_SAFE`, `POLY_1271`, or `EOA`.
- `POLYMARKET_RPC_URL` defaults to the free public Polygon/Amoy endpoints. They're rate-limited, so use a dedicated provider (Alchemy, Infura, your own node) for serious use.
- `POLYMARKET_API_*` is optional. Leave it blank and Portent derives the creds on startup, or run `bun run auth:derive` to cache them.

## Manifests

A strategy is a YAML file in `manifests/`. Start from an example:

```bash
cp manifest-examples/openai-model-release.example.yaml manifests/my-strategy.yaml
```

The runtime only reads `MANIFEST_DIR` (default `manifests/`), never `manifest-examples/`. A manifest ties together a market, a signal, a condition, and an order:

```yaml
id: model-release-watch
enabled: false
market:
  url: https://polymarket.com/event/example-release-market/example-release-market-by-date
  outcome: "Yes"
  stopAt: "2026-12-31T23:59:59Z"
signal:
  type: openai.models
  pollMs: 300000
  request:
    timeoutMs: 15000
    retry:
      attempts: 2
      backoffMs: 1000
      maxBackoffMs: 10000
condition:
  type: modelIdPresent
  modelId: example-model-id
  match: exact
order:
  side: BUY
  amountUsd: 10
  maxPrice: 0.9
  type: FOK
  once: true
```

Portent resolves the Polymarket URL to the token id for `outcome`, then posts the order when the condition fires.

`market.startAt` delays polling until the window opens. Polling stops at the market's resolution date if Polymarket exposes one, otherwise at `market.stopAt`. After that the manifest is expired and stops trading.

## Run it

Validate everything, dry-run your manifest, then start:

```bash
bun run check                                   # typecheck + validate manifests
bun run simulate -- manifests/my-strategy.yaml  # dry-run one manifest (omit path for all enabled)
bun run start                                   # run for real
```

Other commands:

```bash
bun test
bun run auth:derive  # print CLOB API credentials
bun run schema       # emit the manifest JSON schema
```

### Preflight (optional)

`simulate` proves a condition *would* match, but it never touches your wallet, so it can't tell you whether an order would actually go through when the signal fires. `preflight` closes that gap. It's optional, but worth running before you enable a manifest.

```bash
bun run preflight                                 # check every enabled manifest in MANIFEST_DIR
bun run preflight -- manifests/my-strategy.yaml   # check specific manifests
```

It first prints what it's about to do and waits for confirmation at the prompt. Pass `--yes` (or `-y`) to skip the prompt in non-interactive setups.

By default it is read-only and places no orders. It:

- builds the live CLOB client and posts a heartbeat to confirm your credentials, signature type, and funder address work;
- sends a test message to your Telegram chat;
- resolves each market and runs the same order preflight the runtime uses (tick size, negative-risk flag, best ask vs. `maxPrice`).

It does **not** evaluate your signal or condition (that's `simulate`'s job); it only confirms each market is open within its `startAt`/`stopAt` window. Read-only mode also skips balance and allowance checks, so a passing run can still hit an order that fails for lack of funds. `--execute` covers that path.

Add `--execute` to also place one real, deliberately non-marketable order (a post-only bid at the lowest tick) and immediately cancel it, proving the full sign/post/cancel path end to end:

```bash
bun run preflight -- --execute manifests/my-strategy.yaml
```

> [!CAUTION]
> `--execute` signs and submits a real order against the live CLOB, sized at the market's minimum order size and lowest tick (usually well under a cent), then cancels it. If the cancel fails the bid stays on the book; the command prints its order id so you can cancel it on Polymarket.

Once running, the Telegram bot listens for `/status` and `/help` from `TELEGRAM_CHAT_ID`. `/status` is read-only and reports uptime, signal health, and budget usage.

## Docker Compose

Use Compose when you want Portent to run as a restartable service.

```bash
docker compose build
docker compose run --rm portent bun run check
docker compose run --rm portent bun run simulate -- /app/manifests/my-strategy.yaml
docker compose up -d
```

Useful operations:

```bash
docker compose logs -f portent
docker compose restart portent
docker compose down
```

The Compose file mounts `manifests/` read-only and `.portent/` read-write. It does not publish any ports. Secrets and live manifests are kept out of the image build context by `.dockerignore`.

### Podman

Both `Dockerfile` and `compose.yaml` also work with Podman, just swap the command:

```bash
podman compose build
podman compose up -d
```

On rootless Podman, the container may not be able to write to `.portent/`. If you get permission errors, add `:Z` to the volumes (SELinux hosts) or run with `--userns=keep-id`:

```yaml
    volumes:
      - ./manifests:/app/manifests:ro,Z
      - ./.portent:/app/.portent:Z
```

## Multiple markets

Use `markets` when one condition maps to several targets:

```yaml
markets:
  - id: early-window
    url: https://polymarket.com/event/example-window-market/example-market-in-early-window
    outcome: "Yes"
    startAt: "2026-06-01T00:00:00Z"
    stopAt: "2026-06-07T23:59:59Z"
  - id: later-window
    url: https://polymarket.com/event/example-window-market/example-market-in-later-window
    outcome: "Yes"
    startAt: "2026-06-08T00:00:00Z"
    stopAt: "2026-06-14T23:59:59Z"
marketSelection:
  mode: lowestBestAsk
```

Selection modes:

- `first`: buy the first live market in manifest order.
- `lowestBestAsk`: buy the live market with the lowest best ask at or below `order.maxPrice`.

Targets before their `startAt` or past their cutoff are skipped.

Manifests with an identical `signal` block share one poll loop, each evaluating its own `condition`. So two manifests can watch the same API at once and look for different things.

## Shared budgets

Use `budget` when several manifests draw from the same money. Each keeps its own `order.amountUsd`, and the group caps the total that can be reserved or spent across all of them.

```yaml
budget:
  group: example-basket
  limitUsd: 69420
  priority: 10
```

Once spending in a group would exceed its `limitUsd`, further orders in that group are skipped. When several manifests match the same event, `priority` decides order (lower first, ties broken by manifest id).

Optionally add `maxFractionPerExecution` to cap how much a single execution can stake, as a fraction of the group `limitUsd`. With it set, `order.amountUsd` must be at or below `maxFractionPerExecution * limitUsd` or the manifest fails to load. It's a static check against fat-fingering one oversized order into a shared pool.

```yaml
budget:
  group: example-basket
  limitUsd: 1000
  maxFractionPerExecution: 0.1   # no execution may stake more than $100
```

## Order sizing

By default `order.amountUsd` is exactly what each order spends. Add an optional `order.sizing` block to treat `amountUsd` as a ceiling instead and size the order to the live book, so a thin book gives you a smaller order rather than one that sweeps the asks to a bad average price.

```yaml
order:
  side: BUY
  amountUsd: 100        # ceiling when sizing is present
  maxPrice: 0.9
  type: FOK
  sizing:
    mode: bookFraction
    fraction: 0.5       # spend up to 50% of the depth available at or below maxPrice
    minUsd: 10          # optional: skip the order if the sized amount falls below this
```

`bookFraction` spends `fraction` of the dollar depth resting at or below `maxPrice`, capped by `amountUsd`. If the sized amount comes out below `minUsd`, or there's no depth at or below `maxPrice`, the order is skipped for that event and retried on the next, so it can still fill once liquidity improves. While an order is in flight the budget reserves the full `amountUsd` ceiling, then records the actual sized spend once it fills, so a shared group is never over-committed.

## Conditions

Combine leaf conditions with `and`, `or`, and `not`. They nest.

```yaml
condition:
  type: and
  conditions:
    - type: jsonEquals
      path: $.model
      value: example-model-id
    - type: or
      conditions:
        - type: jsonCompare
          path: $.confidence
          operator: gte
          value: 0.95
        - type: textIncludes
          terms: ["confirmed"]
    - type: not
      condition:
        type: textIncludes
        terms: ["rumor", "unconfirmed"]
```

Leaf conditions: `modelIdPresent`, `textIncludes`, `textMatches`, `jsonExists`, `jsonEquals`, `jsonIncludes`, `jsonMatches`, `jsonCompare`.

## Signals

### Custom APIs (`http.poll`)

For any signal that's just a JSON API:

```yaml
signal:
  type: http.poll
  url: https://example.com/api/releases
  method: GET
  pollMs: 60000
  auth:
    type: bearer
    tokenEnv: CUSTOM_RELEASE_API_TOKEN
  eventsPath: $.items[*]
  dataPath: $
  eventIdPath: $.id
  textPath: $.message
  request:
    timeoutMs: 10000
    retry:
      attempts: 3
      backoffMs: 1000
      maxBackoffMs: 10000
```

`eventsPath` picks what becomes signal events, `dataPath` what conditions read, `eventIdPath` the stable id for dedupe, and `textPath` the text fed to text conditions.

Secrets stay out of YAML. Auth reads from the environment:

```yaml
auth: { type: bearer, tokenEnv: CUSTOM_API_TOKEN }
auth: { type: basic, usernameEnv: CUSTOM_API_USER, passwordEnv: CUSTOM_API_PASSWORD }
auth: { type: header, name: X-API-Key, valueEnv: CUSTOM_API_KEY }
```

For anything unusual, `headersFromEnv` maps headers to env vars:

```yaml
headersFromEnv:
  X-Account-Id: CUSTOM_ACCOUNT_ID
```

### RSS and Atom (`rss.feed`)

Polls RSS/Atom feeds and emits feed items. Use it for blogs, changelogs, release feeds, and official announcement feeds.

```yaml
signal:
  type: rss.feed
  url: https://example.com/feed.xml
  pollMs: 300000
  startFromLatest: true
```

Each item exposes `title`, `link`, and `summary` to JSON conditions, plus the item text for text conditions. With `startFromLatest: true`, the first poll seeds state instead of trading on existing items.

### Web pages (`web.page`)

Polls a normal HTTP page, strips HTML, normalizes text, and emits when the text changes. This is plain HTTP, not browser automation. JavaScript-rendered pages need a real API, RSS feed, or a different adapter.

```yaml
signal:
  type: web.page
  url: https://example.com/status
  pollMs: 300000
  emit: changed
  startFromLatest: true
```

The normalized page text is available to text conditions and as `data.text`. `emit: changed` fires only when the text differs from the last poll. `emit: always` fires every poll.

### JSON WebSockets (`websocket.json`)

Connects to a WebSocket, expects JSON messages, and emits one event per message. If the stream needs a subscription payload, set `subscribe`.

```yaml
signal:
  type: websocket.json
  url: wss://example.com/events
  subscribe:
    type: subscribe
    channel: announcements
  dataPath: $
  eventIdPath: $.id
  textPath: $.message
  reconnectMs: 15000
  idleMs: 300000
```

`rss.feed`, `web.page`, and `websocket.json` support `auth`, `headers`, and `headersFromEnv` like `http.poll`.

### OpenAI models (`openai.models`)

Polls OpenAI's `/v1/models` and emits the current list of model ids, so you can trade on a model going live. Reads `OPENAI_API_KEY` from `.env`. Pair it with the `modelIdPresent` condition.

```yaml
signal:
  type: openai.models
  pollMs: 300000
```

Each event exposes `modelIds` (sorted) and `count` to conditions. Override `baseUrl` to point at a compatible API.

### X (`x.filteredStream`)

Uses the X API v2 filtered stream and reads `X_BEARER_TOKEN` from `.env`. Portent syncs your `rules` on startup and reconnects automatically after errors or timeouts.

```yaml
signal:
  type: x.filteredStream
  rules:
    - tag: account-posts
      value: 'from:exampleAccount -is:retweet'
  reconnectMs: 15000
  streamIdleMs: 300000
```

### Truth Social (`truthsocial.accountStatuses`)

Polls the public Mastodon-style endpoint `/api/v1/accounts/:accountId/statuses` and stores the last seen status id in `.portent/state.json`. With `startFromLatest: true`, the first poll just seeds state and won't trade on old posts.

```yaml
signal:
  type: truthsocial.accountStatuses
  accountId: "107780257626128497"
  pollMs: 30000
  limit: 20
  excludeReplies: false
  excludeReblogs: true
  startFromLatest: true
```

## Timeouts and retries

Every HTTP-based signal takes a `request` block:

```yaml
request:
  timeoutMs: 15000
  retry:
    attempts: 2
    backoffMs: 1000
    maxBackoffMs: 10000
```

Retryable failures: `408`, `429`, `5xx`, network errors, and request timeouts. Shutdown aborts in-flight requests.

## State and dedupe

State lives in `.portent/`:

- `state.json`: executed signal ids, provider cursors, and budget spend.
- `orders.jsonl`: the submitted-order ledger.

Restarting keeps prior budget usage. Deleting state resets it. `order.once: true` stops a manifest from buying more than once. `repeat` allows bounded repeats instead:

```yaml
repeat:
  cooldownMs: 3600000
  maxExecutions: 3
```
