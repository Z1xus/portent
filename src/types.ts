export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type HexAddress = Brand<`0x${string}`, "HexAddress">;
export type PrivateKey = Brand<`0x${string}`, "PrivateKey">;
export type ManifestId = Brand<string, "ManifestId">;
export type TokenId = Brand<string, "TokenId">;
export type ConditionId = Brand<string, "ConditionId">;
export type OrderId = Brand<string, "OrderId">;
export type SignalEventId = Brand<string, "SignalEventId">;

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const privateKeyPattern = /^0x[a-fA-F0-9]{64}$/;
const manifestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/;

export function asHexAddress(value: string): HexAddress {
  if (!addressPattern.test(value)) {
    throw new Error(`Invalid EVM address: ${value}`);
  }
  return value as HexAddress;
}

export function asPrivateKey(value: string): PrivateKey {
  if (!privateKeyPattern.test(value)) {
    throw new Error("POLYMARKET_PRIVATE_KEY must be a 0x-prefixed 32-byte private key.");
  }
  return value as PrivateKey;
}

export function asManifestId(value: string): ManifestId {
  if (!manifestIdPattern.test(value)) {
    throw new Error(`Invalid manifest id '${value}'. Use 2-80 chars: letters, numbers, dot, dash, underscore.`);
  }
  return value as ManifestId;
}

export function asTokenId(value: string): TokenId {
  if (value.trim().length === 0) {
    throw new Error("Token id cannot be empty.");
  }
  return value as TokenId;
}

export function asConditionId(value: string): ConditionId {
  if (value.trim().length === 0) {
    throw new Error("Condition id cannot be empty.");
  }
  return value as ConditionId;
}

export function asOrderId(value: string): OrderId {
  if (value.trim().length === 0) {
    throw new Error("Order id cannot be empty.");
  }
  return value as OrderId;
}

export function asSignalEventId(value: string): SignalEventId {
  if (value.trim().length === 0) {
    throw new Error("Signal event id cannot be empty.");
  }
  return value as SignalEventId;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
