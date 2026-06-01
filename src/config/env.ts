import { readFile } from "node:fs/promises";
import { z } from "zod";
import { asHexAddress, asPrivateKey, type HexAddress, type PrivateKey } from "../types.ts";

export const WalletSignatureTypeSchema = z.enum(["EOA", "POLY_PROXY", "GNOSIS_SAFE", "POLY_1271"]);
export type WalletSignatureType = z.output<typeof WalletSignatureTypeSchema>;

const OptionalNonEmptyString = z.preprocess(
  (value) => typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().min(1).optional(),
);

const RuntimeEnvBaseSchema = z.object({
  POLYMARKET_CLOB_HOST: z.url().default("https://clob.polymarket.com"),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().refine((value) => value === 137 || value === 80002, {
    message: "POLYMARKET_CHAIN_ID must be 137 (Polygon) or 80002 (Amoy).",
  }).default(137),
  POLYMARKET_RPC_URL: OptionalNonEmptyString,
  POLYMARKET_PRIVATE_KEY: z.string().min(1),
  POLYMARKET_API_KEY: OptionalNonEmptyString,
  POLYMARKET_API_SECRET: OptionalNonEmptyString,
  POLYMARKET_API_PASSPHRASE: OptionalNonEmptyString,
  POLYMARKET_FUNDER_ADDRESS: z.string().min(1),
  POLYMARKET_SIGNATURE_TYPE: WalletSignatureTypeSchema.default("POLY_PROXY"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1).optional(),
  XAI_API_KEY: z.string().min(1).optional(),
  X_BEARER_TOKEN: z.string().min(1).optional(),
  TRUTH_SOCIAL_BASE_URL: z.url().default("https://truthsocial.com"),
  MANIFEST_DIR: z.string().min(1).default("manifests"),
  STATE_DIR: z.string().min(1).default(".portent"),
});

const RuntimeEnvSchema = RuntimeEnvBaseSchema.superRefine((env, ctx) => {
  const supplied = [env.POLYMARKET_API_KEY, env.POLYMARKET_API_SECRET, env.POLYMARKET_API_PASSPHRASE].filter(Boolean).length;
  if (supplied !== 0 && supplied !== 3) {
    ctx.addIssue({
      code: "custom",
      message: "Provide all CLOB API credential fields, or leave all three empty so Portent derives them on startup.",
      path: ["POLYMARKET_API_KEY"],
    });
  }
});

const OptionalEnvSchema = RuntimeEnvBaseSchema.partial().extend({
  POLYMARKET_CLOB_HOST: z.url().default("https://clob.polymarket.com"),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().refine((value) => value === 137 || value === 80002).default(137),
  POLYMARKET_SIGNATURE_TYPE: WalletSignatureTypeSchema.default("POLY_PROXY"),
  TRUTH_SOCIAL_BASE_URL: z.url().default("https://truthsocial.com"),
  MANIFEST_DIR: z.string().min(1).default("manifests"),
  STATE_DIR: z.string().min(1).default(".portent"),
});

export interface RuntimeEnv {
  readonly polymarket: {
    readonly clobHost: string;
    readonly chainId: 137 | 80002;
    readonly rpcUrl: string;
    readonly privateKey: PrivateKey;
    readonly apiKey?: string;
    readonly apiSecret?: string;
    readonly apiPassphrase?: string;
    readonly funderAddress: HexAddress;
    readonly signatureType: WalletSignatureType;
  };
  readonly telegram: {
    readonly botToken: string;
    readonly chatId: string;
  };
  readonly openai: {
    readonly apiKey?: string;
  };
  readonly xai: {
    readonly apiKey?: string;
  };
  readonly x: {
    readonly bearerToken?: string;
  };
  readonly truthSocial: {
    readonly baseUrl: string;
  };
  readonly paths: {
    readonly manifestDir: string;
    readonly stateDir: string;
  };
}

export interface OptionalRuntimeEnv {
  readonly polymarket: {
    readonly clobHost: string;
    readonly chainId: 137 | 80002;
    readonly rpcUrl: string;
    readonly privateKey?: PrivateKey;
    readonly apiKey?: string;
    readonly apiSecret?: string;
    readonly apiPassphrase?: string;
    readonly funderAddress?: HexAddress;
    readonly signatureType: WalletSignatureType;
  };
  readonly telegram?: {
    readonly botToken: string;
    readonly chatId: string;
  };
  readonly openai: {
    readonly apiKey?: string;
  };
  readonly xai: {
    readonly apiKey?: string;
  };
  readonly x: {
    readonly bearerToken?: string;
  };
  readonly truthSocial: {
    readonly baseUrl: string;
  };
  readonly paths: {
    readonly manifestDir: string;
    readonly stateDir: string;
  };
}

export async function loadRuntimeEnv(envFile = ".env"): Promise<RuntimeEnv> {
  return parseRuntimeEnv(await loadRawEnv(envFile));
}

export async function loadOptionalRuntimeEnv(envFile = ".env"): Promise<OptionalRuntimeEnv> {
  return parseOptionalRuntimeEnv(await loadRawEnv(envFile));
}

export async function loadRawEnv(envFile = ".env"): Promise<Record<string, string | undefined>> {
  const fileEnv = await readDotEnvIfPresent(envFile);
  return { ...fileEnv, ...Bun.env };
}

export function parseRuntimeEnv(raw: Record<string, string | undefined>): RuntimeEnv {
  const parsed = RuntimeEnvSchema.parse(raw);
  return {
    polymarket: {
      clobHost: parsed.POLYMARKET_CLOB_HOST,
      chainId: parsed.POLYMARKET_CHAIN_ID,
      rpcUrl: parsed.POLYMARKET_RPC_URL ?? defaultPolymarketRpcUrl(parsed.POLYMARKET_CHAIN_ID),
      privateKey: asPrivateKey(parsed.POLYMARKET_PRIVATE_KEY),
      ...(parsed.POLYMARKET_API_KEY ? { apiKey: parsed.POLYMARKET_API_KEY } : {}),
      ...(parsed.POLYMARKET_API_SECRET ? { apiSecret: parsed.POLYMARKET_API_SECRET } : {}),
      ...(parsed.POLYMARKET_API_PASSPHRASE ? { apiPassphrase: parsed.POLYMARKET_API_PASSPHRASE } : {}),
      funderAddress: asHexAddress(parsed.POLYMARKET_FUNDER_ADDRESS),
      signatureType: parsed.POLYMARKET_SIGNATURE_TYPE,
    },
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      chatId: parsed.TELEGRAM_CHAT_ID,
    },
    openai: optionalApiKey(parsed.OPENAI_API_KEY),
    xai: optionalApiKey(parsed.XAI_API_KEY),
    x: optionalBearerToken(parsed.X_BEARER_TOKEN),
    truthSocial: {
      baseUrl: parsed.TRUTH_SOCIAL_BASE_URL,
    },
    paths: {
      manifestDir: parsed.MANIFEST_DIR,
      stateDir: parsed.STATE_DIR,
    },
  };
}

export function parseOptionalRuntimeEnv(raw: Record<string, string | undefined>): OptionalRuntimeEnv {
  const parsed = OptionalEnvSchema.parse(raw);
  const polymarket = {
    clobHost: parsed.POLYMARKET_CLOB_HOST,
    chainId: parsed.POLYMARKET_CHAIN_ID,
    rpcUrl: parsed.POLYMARKET_RPC_URL ?? defaultPolymarketRpcUrl(parsed.POLYMARKET_CHAIN_ID),
    signatureType: parsed.POLYMARKET_SIGNATURE_TYPE,
    ...(parsed.POLYMARKET_PRIVATE_KEY ? { privateKey: asPrivateKey(parsed.POLYMARKET_PRIVATE_KEY) } : {}),
    ...(parsed.POLYMARKET_API_KEY ? { apiKey: parsed.POLYMARKET_API_KEY } : {}),
    ...(parsed.POLYMARKET_API_SECRET ? { apiSecret: parsed.POLYMARKET_API_SECRET } : {}),
    ...(parsed.POLYMARKET_API_PASSPHRASE ? { apiPassphrase: parsed.POLYMARKET_API_PASSPHRASE } : {}),
    ...(parsed.POLYMARKET_FUNDER_ADDRESS ? { funderAddress: asHexAddress(parsed.POLYMARKET_FUNDER_ADDRESS) } : {}),
  };
  return {
    polymarket,
    ...(parsed.TELEGRAM_BOT_TOKEN && parsed.TELEGRAM_CHAT_ID
      ? { telegram: { botToken: parsed.TELEGRAM_BOT_TOKEN, chatId: parsed.TELEGRAM_CHAT_ID } }
      : {}),
    openai: optionalApiKey(parsed.OPENAI_API_KEY),
    xai: optionalApiKey(parsed.XAI_API_KEY),
    x: optionalBearerToken(parsed.X_BEARER_TOKEN),
    truthSocial: {
      baseUrl: parsed.TRUTH_SOCIAL_BASE_URL,
    },
    paths: {
      manifestDir: parsed.MANIFEST_DIR,
      stateDir: parsed.STATE_DIR,
    },
  };
}

async function readDotEnvIfPresent(envFile: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await readFile(envFile, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (!match) {
      continue;
    }
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    values[key] = unquoteEnvValue(rawValue.trim());
  }
  return values;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const commentIndex = value.indexOf(" #");
  if (commentIndex >= 0) {
    return value.slice(0, commentIndex).trim();
  }
  return value;
}

function optionalApiKey(value: string | undefined): { readonly apiKey?: string } {
  return value ? { apiKey: value } : {};
}

function optionalBearerToken(value: string | undefined): { readonly bearerToken?: string } {
  return value ? { bearerToken: value } : {};
}

export function defaultPolymarketRpcUrl(chainId: 137 | 80002): string {
  return chainId === 137 ? "https://polygon-rpc.com" : "https://rpc-amoy.polygon.technology";
}
