import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type OrderBookSummary,
  type OrderResponse,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RuntimeEnv } from "../config/env.ts";
import type { Manifest } from "../config/manifest.ts";
import type { MarketTarget } from "../markets/polymarket.ts";
import type { SignalEvent } from "../signals/index.ts";
import { asOrderId, unixSeconds, type OrderId, type TokenId } from "../types.ts";

export interface TradingClient {
  resolvePreflight(target: MarketTarget, manifest: Manifest): Promise<OrderPreflight>;
  submitOrder(manifest: Manifest, target: MarketTarget, event: SignalEvent): Promise<OrderSubmission>;
  heartbeat(): Promise<void>;
}

export interface OrderPreflight {
  readonly tokenId: TokenId;
  readonly tickSize: TickSize;
  readonly negRisk: boolean;
  readonly bestAsk?: number;
}

export interface OrderSubmission {
  readonly orderId?: OrderId;
  readonly status: string;
  readonly success: boolean;
  readonly raw: unknown;
}

export interface OrderProbeResult {
  readonly tokenId: TokenId;
  readonly price: number;
  readonly size: number;
  readonly placed: OrderSubmission;
  readonly canceled: boolean;
  readonly cancelRaw: unknown;
  readonly cancelError?: unknown;
}

const PROBE_FALLBACK_SHARES = 5;

export async function createPolymarketTradingClient(env: RuntimeEnv): Promise<PolymarketTradingClient> {
  const account = privateKeyToAccount(env.polymarket.privateKey);
  const signer = createWalletClient({
    account,
    transport: http(env.polymarket.rpcUrl),
  });
  const baseClient = new ClobClient({
    host: env.polymarket.clobHost,
    chain: toClobChain(env.polymarket.chainId),
    signer,
    signatureType: toSignatureType(env.polymarket.signatureType),
    funderAddress: env.polymarket.funderAddress,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true,
  });
  const creds = await resolveApiKeyCreds(env, baseClient);
  const client = new ClobClient({
    host: env.polymarket.clobHost,
    chain: toClobChain(env.polymarket.chainId),
    signer,
    creds,
    signatureType: toSignatureType(env.polymarket.signatureType),
    funderAddress: env.polymarket.funderAddress,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true,
  });
  return new PolymarketTradingClient(client);
}

export async function resolveApiKeyCreds(
  env: RuntimeEnv,
  client: Pick<ClobClient, "createApiKey" | "deriveApiKey">,
): Promise<ApiKeyCreds> {
  if (env.polymarket.apiKey && env.polymarket.apiSecret && env.polymarket.apiPassphrase) {
    return {
      key: env.polymarket.apiKey,
      secret: env.polymarket.apiSecret,
      passphrase: env.polymarket.apiPassphrase,
    };
  }
  if (env.polymarket.apiKey || env.polymarket.apiSecret || env.polymarket.apiPassphrase) {
    throw new Error("Provide all CLOB API credential fields, or leave all three empty so Portent derives them on startup.");
  }
  return deriveOrCreateApiKeyCreds(client);
}

export async function deriveOrCreateApiKeyCreds(
  client: Pick<ClobClient, "createApiKey" | "deriveApiKey">,
): Promise<ApiKeyCreds> {
  try {
    return await client.deriveApiKey();
  } catch (deriveError) {
    try {
      return await client.createApiKey();
    } catch (createError) {
      throw new Error(
        `Could not derive or create Polymarket CLOB API credentials. derive failed: ${formatAuthError(deriveError)}; create failed: ${formatAuthError(createError)}`,
      );
    }
  }
}

export class PolymarketTradingClient implements TradingClient {
  public constructor(private readonly client: ClobClient) {}

  public async resolvePreflight(target: MarketTarget, manifest: Manifest): Promise<OrderPreflight> {
    const [tickSize, negRisk] = await Promise.all([
      this.client.getTickSize(target.tokenId),
      this.client.getNegRisk(target.tokenId),
    ]);
    const preflight: OrderPreflight = {
      tokenId: target.tokenId,
      tickSize,
      negRisk,
      ...(await this.bestAskIfImmediate(target, manifest)),
    };
    return preflight;
  }

  public async submitOrder(manifest: Manifest, target: MarketTarget, event: SignalEvent): Promise<OrderSubmission> {
    const preflight = await this.resolvePreflight(target, manifest);
    assertPricePreflight(manifest, preflight);
    const response = await this.postOrder(manifest, target, preflight, event);
    return normalizeOrderResponse(response);
  }

  public async heartbeat(): Promise<void> {
    await this.client.postHeartbeat();
  }

  public async probeOrder(target: MarketTarget): Promise<OrderProbeResult> {
    const [tickSize, negRisk, book] = await Promise.all([
      this.client.getTickSize(target.tokenId),
      this.client.getNegRisk(target.tokenId),
      this.client.getOrderBook(target.tokenId),
    ]);
    const price = Number(tickSize);
    const size = probeSize(book);
    const placed = normalizeOrderResponse(
      await this.client.createAndPostOrder(
        { tokenID: target.tokenId, price, size, side: Side.BUY },
        { tickSize, negRisk },
        OrderType.GTC,
        true,
        false,
      ),
    );
    if (!placed.orderId) {
      return { tokenId: target.tokenId, price, size, placed, canceled: false, cancelRaw: undefined };
    }
    try {
      const cancelRaw = await this.client.cancelOrder({ orderID: placed.orderId });
      return { tokenId: target.tokenId, price, size, placed, canceled: true, cancelRaw };
    } catch (error) {
      return { tokenId: target.tokenId, price, size, placed, canceled: false, cancelRaw: undefined, cancelError: error };
    }
  }

  private async bestAskIfImmediate(target: MarketTarget, _manifest: Manifest): Promise<{ readonly bestAsk?: number }> {
    const book = await this.client.getOrderBook(target.tokenId);
    const bestAsk = bestAskFromBook(book);
    return bestAsk === undefined ? {} : { bestAsk };
  }

  private async postOrder(
    manifest: Manifest,
    target: MarketTarget,
    preflight: OrderPreflight,
    event: SignalEvent,
  ): Promise<unknown> {
    const orderType = toOrderType(manifest.order.type);
    const metadata = metadataFor(manifest, event);
    if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
      return this.client.createAndPostMarketOrder(
        {
          tokenID: target.tokenId,
          price: manifest.order.maxPrice,
          amount: manifest.order.amountUsd,
          side: Side.BUY,
          orderType,
          metadata,
        },
        { tickSize: preflight.tickSize, negRisk: preflight.negRisk },
        orderType,
        manifest.order.deferExecution,
      );
    }

    const price = manifest.order.maxPrice;
    const size = roundSize(manifest.order.amountUsd / price);
    return this.client.createAndPostOrder(
      {
        tokenID: target.tokenId,
        price,
        size,
        side: Side.BUY,
        metadata,
        ...(orderType === OrderType.GTD
          ? { expiration: unixSeconds(new Date()) + (manifest.order.expiresInSeconds ?? 86_400) }
          : {}),
      },
      { tickSize: preflight.tickSize, negRisk: preflight.negRisk },
      orderType,
      manifest.order.postOnly,
      manifest.order.deferExecution,
    );
  }
}

export function toSignatureType(value: RuntimeEnv["polymarket"]["signatureType"]): SignatureTypeV2 {
  switch (value) {
    case "EOA":
      return SignatureTypeV2.EOA;
    case "POLY_PROXY":
      return SignatureTypeV2.POLY_PROXY;
    case "GNOSIS_SAFE":
      return SignatureTypeV2.POLY_GNOSIS_SAFE;
    case "POLY_1271":
      return SignatureTypeV2.POLY_1271;
  }
}

export function toOrderType(value: Manifest["order"]["type"]): OrderType {
  switch (value) {
    case "FOK":
      return OrderType.FOK;
    case "FAK":
      return OrderType.FAK;
    case "GTC":
      return OrderType.GTC;
    case "GTD":
      return OrderType.GTD;
  }
}

export function toClobChain(chainId: RuntimeEnv["polymarket"]["chainId"]): Chain {
  return chainId === 137 ? Chain.POLYGON : Chain.AMOY;
}

export function bestAskFromBook(book: OrderBookSummary): number | undefined {
  const prices = book.asks
    .map((ask) => Number(ask.price))
    .filter((price) => Number.isFinite(price));
  if (prices.length === 0) {
    return undefined;
  }
  return Math.min(...prices);
}

export function assertPricePreflight(manifest: Manifest, preflight: OrderPreflight): void {
  if (preflight.bestAsk !== undefined && preflight.bestAsk > manifest.order.maxPrice) {
    throw new Error(`Best ask ${preflight.bestAsk} is above maxPrice ${manifest.order.maxPrice}.`);
  }
}

function normalizeOrderResponse(response: unknown): OrderSubmission {
  const candidate = response as Partial<OrderResponse> | undefined;
  const orderId = typeof candidate?.orderID === "string" && candidate.orderID.length > 0
    ? asOrderId(candidate.orderID)
    : undefined;
  return {
    ...(orderId ? { orderId } : {}),
    status: typeof candidate?.status === "string" ? candidate.status : "submitted",
    success: typeof candidate?.success === "boolean" ? candidate.success : true,
    raw: response,
  };
}

function metadataFor(manifest: Manifest, event: SignalEvent): string {
  const seed = `${manifest.id}:${event.id}`;
  const bytes = new TextEncoder().encode(seed).slice(0, 32);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x${hex.padEnd(64, "0")}`;
}

function roundSize(value: number): number {
  return Number(value.toFixed(6));
}

function probeSize(book: OrderBookSummary): number {
  const minOrderSize = Number(book.min_order_size);
  return roundSize(Number.isFinite(minOrderSize) && minOrderSize > 0 ? minOrderSize : PROBE_FALLBACK_SHARES);
}

function formatAuthError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
