import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defaultPolymarketRpcUrl, loadRawEnv, WalletSignatureTypeSchema } from "../config/env.ts";
import { deriveOrCreateApiKeyCreds, toClobChain, toSignatureType } from "../trading/polymarket.ts";
import { asHexAddress, asPrivateKey } from "../types.ts";

const raw = await loadRawEnv();
const privateKey = raw["POLYMARKET_PRIVATE_KEY"];
if (!privateKey) {
  throw new Error("POLYMARKET_PRIVATE_KEY is required to derive CLOB API credentials.");
}

const chainId = Number(raw["POLYMARKET_CHAIN_ID"] ?? "137");
const clobChain = toClobChain(chainId === 80002 ? 80002 : 137);
const rpcUrl = raw["POLYMARKET_RPC_URL"] ?? defaultPolymarketRpcUrl(clobChain);
const account = privateKeyToAccount(asPrivateKey(privateKey));
const signer = createWalletClient({ account, transport: http(rpcUrl) });
const signatureType = WalletSignatureTypeSchema.parse(raw["POLYMARKET_SIGNATURE_TYPE"] ?? "POLY_PROXY");
const funderAddress = raw["POLYMARKET_FUNDER_ADDRESS"];
const client = new ClobClient({
  host: raw["POLYMARKET_CLOB_HOST"] ?? "https://clob.polymarket.com",
  chain: clobChain,
  signer,
  signatureType: toSignatureType(signatureType),
  ...(funderAddress ? { funderAddress: asHexAddress(funderAddress) } : {}),
  useServerTime: true,
  throwOnError: true,
});

const creds = await deriveOrCreateApiKeyCreds(client);
console.log(`POLYMARKET_API_KEY=${creds.key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
