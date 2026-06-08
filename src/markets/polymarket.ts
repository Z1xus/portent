import { z } from "zod";
import { manifestMarkets, type Manifest, type ManifestMarket } from "../config/manifest.ts";
import { fetchJson, type Fetcher } from "../http.ts";
import { asConditionId, asTokenId, type ConditionId, type TokenId } from "../types.ts";

export interface MarketSlugParts {
  readonly eventSlug?: string;
  readonly marketSlug: string;
}

export interface MarketTarget {
  readonly id: string;
  readonly marketSlug: string;
  readonly question?: string;
  readonly conditionId?: ConditionId;
  readonly outcome: string;
  readonly tokenId: TokenId;
  readonly startAt?: Date;
  readonly stopAt?: Date;
}

export interface GammaMarketResolverOptions {
  readonly fetcher: Fetcher;
  readonly gammaBaseUrl?: string;
}

const GammaTokenSchema = z.object({
  token_id: z.string().optional(),
  tokenId: z.string().optional(),
  outcome: z.string().optional(),
}).passthrough();

const GammaMarketSchema = z.object({
  slug: z.string().optional(),
  question: z.string().optional(),
  conditionId: z.string().optional(),
  condition_id: z.string().optional(),
  clobTokenIds: z.union([z.string(), z.array(z.string())]).optional(),
  outcomes: z.union([z.string(), z.array(z.string())]).optional(),
  tokens: z.array(GammaTokenSchema).optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  archived: z.boolean().optional(),
  endDate: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  endDateIso: z.string().nullable().optional(),
  end_date_iso: z.string().nullable().optional(),
  resolutionDate: z.string().nullable().optional(),
  resolution_date: z.string().nullable().optional(),
  resolvedDate: z.string().nullable().optional(),
  resolved_date: z.string().nullable().optional(),
  closedTime: z.string().nullable().optional(),
  closed_time: z.string().nullable().optional(),
}).passthrough();

const GammaMarketsSchema = z.array(GammaMarketSchema);
const GammaEventsSchema = z.array(z.object({
  markets: z.array(GammaMarketSchema).optional(),
}).passthrough());

type GammaMarket = z.output<typeof GammaMarketSchema>;

export class MarketClosedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MarketClosedError";
  }
}

export class GammaMarketResolver {
  private readonly fetcher: Fetcher;
  private readonly gammaBaseUrl: string;

  public constructor(options: GammaMarketResolverOptions) {
    this.fetcher = options.fetcher;
    this.gammaBaseUrl = (options.gammaBaseUrl ?? "https://gamma-api.polymarket.com").replace(/\/+$/u, "");
  }

  public async resolve(manifest: Manifest): Promise<MarketTarget> {
    const targets = await this.resolveAll(manifest);
    const firstTarget = targets[0];
    if (!firstTarget) {
      throw new Error(`Manifest ${manifest.id} has no resolved markets.`);
    }
    return firstTarget;
  }

  public async resolveAll(manifest: Manifest): Promise<readonly MarketTarget[]> {
    return Promise.all(manifestMarkets(manifest).map((market) => this.resolveOne(market)));
  }

  private async resolveOne(manifestMarket: ManifestMarket): Promise<MarketTarget> {
    const slugParts = parsePolymarketUrl(manifestMarket.url);
    const market = await this.fetchMarket(slugParts);
    assertTradableMarket(market, slugParts.marketSlug);
    return resolveOutcome(market, slugParts.marketSlug, manifestMarket);
  }

  private async fetchMarket(slugParts: MarketSlugParts): Promise<GammaMarket> {
    const marketUrl = new URL(`${this.gammaBaseUrl}/markets`);
    marketUrl.searchParams.set("slug", slugParts.marketSlug);
    const markets = await fetchJson(this.fetcher, marketUrl.toString(), GammaMarketsSchema);
    const directMarket = markets.find((market) => market.slug === slugParts.marketSlug) ?? markets[0];
    if (directMarket) {
      return directMarket;
    }

    if (!slugParts.eventSlug) {
      throw new Error(`No Polymarket Gamma market found for slug '${slugParts.marketSlug}'.`);
    }

    const eventUrl = new URL(`${this.gammaBaseUrl}/events`);
    eventUrl.searchParams.set("slug", slugParts.eventSlug);
    const events = await fetchJson(this.fetcher, eventUrl.toString(), GammaEventsSchema);
    const eventMarkets = events.flatMap((event) => event.markets ?? []);
    const eventMarket = eventMarkets.find((market) => market.slug === slugParts.marketSlug);
    if (!eventMarket) {
      throw new Error(`No Polymarket Gamma event market found for slug '${slugParts.marketSlug}'.`);
    }
    return eventMarket;
  }
}

export function parsePolymarketUrl(value: string): MarketSlugParts {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Polymarket URL does not contain a market slug: ${value}`);
  }
  const lastPart = parts.at(-1);
  if (!lastPart) {
    throw new Error(`Polymarket URL does not contain a market slug: ${value}`);
  }
  if (parts[0] === "event" && parts.length >= 3) {
    const eventSlug = parts[1];
    if (!eventSlug) {
      throw new Error(`Polymarket event URL does not contain an event slug: ${value}`);
    }
    return {
      eventSlug,
      marketSlug: lastPart,
    };
  }
  return {
    marketSlug: lastPart,
  };
}

function assertTradableMarket(market: GammaMarket, slug: string): void {
  if (market.closed === true || market.archived === true) {
    throw new MarketClosedError(`Market '${slug}' is closed or archived.`);
  }
  if (market.active === false) {
    throw new Error(`Market '${slug}' is not active.`);
  }
  if (market.acceptingOrders === false) {
    throw new Error(`Market '${slug}' is not accepting orders.`);
  }
}

function resolveOutcome(market: GammaMarket, slug: string, manifestMarket: ManifestMarket): MarketTarget {
  const tokenFromTokens = market.tokens?.find((token) => equalsIgnoreCase(token.outcome, manifestMarket.outcome));
  const tokenIdFromTokens = tokenFromTokens?.token_id ?? tokenFromTokens?.tokenId;
  if (tokenIdFromTokens) {
    return targetFromMarket(market, slug, manifestMarket, tokenIdFromTokens);
  }

  const outcomes = parseStringArray(market.outcomes, "outcomes");
  const tokenIds = parseStringArray(market.clobTokenIds, "clobTokenIds");
  const outcomeIndex = outcomes.findIndex((candidate) => equalsIgnoreCase(candidate, manifestMarket.outcome));
  if (outcomeIndex < 0) {
    throw new Error(`Outcome '${manifestMarket.outcome}' not found for market '${slug}'. Available outcomes: ${outcomes.join(", ")}`);
  }
  const tokenId = tokenIds[outcomeIndex];
  if (!tokenId) {
    throw new Error(`Outcome '${manifestMarket.outcome}' for market '${slug}' has no clob token id.`);
  }
  return targetFromMarket(market, slug, manifestMarket, tokenId);
}

function targetFromMarket(market: GammaMarket, slug: string, manifestMarket: ManifestMarket, tokenId: string): MarketTarget {
  const startAt = manifestMarket.startAt ? new Date(manifestMarket.startAt) : undefined;
  const stopAt = manifestMarket.stopAt ? new Date(manifestMarket.stopAt) : marketEndDate(market);
  return {
    id: manifestMarket.id ?? slug,
    marketSlug: slug,
    outcome: manifestMarket.outcome,
    tokenId: asTokenId(tokenId),
    ...(market.question ? { question: market.question } : {}),
    ...(market.conditionId ?? market.condition_id ? { conditionId: asConditionId(market.conditionId ?? market.condition_id ?? "") } : {}),
    ...(startAt ? { startAt } : {}),
    ...(stopAt ? { stopAt } : {}),
  };
}

export function effectiveMarketStartAt(targets: readonly Pick<MarketTarget, "startAt">[]): Date | undefined {
  const timestamps = targets
    .map((target) => target.startAt?.getTime())
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  if (timestamps.length === 0) {
    return undefined;
  }
  return new Date(Math.min(...timestamps));
}

export function effectiveMarketStopAt(targets: readonly Pick<MarketTarget, "stopAt">[]): Date | undefined {
  if (targets.some((target) => target.stopAt === undefined)) {
    return undefined;
  }
  const timestamps = targets
    .map((target) => target.stopAt?.getTime())
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  if (timestamps.length === 0) {
    return undefined;
  }
  return new Date(Math.max(...timestamps));
}

export function isPastMarketStop(stopAt: Date | undefined, now = new Date()): stopAt is Date {
  return stopAt !== undefined && now.getTime() >= stopAt.getTime();
}

export function isBeforeMarketStart(startAt: Date | undefined, now = new Date()): startAt is Date {
  return startAt !== undefined && now.getTime() < startAt.getTime();
}

export function isMarketTargetLive(target: Pick<MarketTarget, "startAt" | "stopAt">, now = new Date()): boolean {
  return !isBeforeMarketStart(target.startAt, now) && !isPastMarketStop(target.stopAt, now);
}

function marketEndDate(market: GammaMarket): Date | undefined {
  return firstValidDate([
    market.endDateIso,
    market.end_date_iso,
    market.endDate,
    market.end_date,
    market.resolutionDate,
    market.resolution_date,
    market.resolvedDate,
    market.resolved_date,
    market.closedTime,
    market.closed_time,
  ]);
}

function firstValidDate(values: readonly (string | null | undefined)[]): Date | undefined {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return undefined;
}

function parseStringArray(value: string | string[] | undefined, fieldName: string): readonly string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    throw new Error(`Gamma field '${fieldName}' is not valid JSON.`);
  }
  throw new Error(`Gamma field '${fieldName}' is not a string array.`);
}

function equalsIgnoreCase(left: string | undefined, right: string): boolean {
  return left?.toLocaleLowerCase() === right.toLocaleLowerCase();
}
