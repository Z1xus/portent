import { describe, expect, test } from "bun:test";
import { parseDotEnv, parseRuntimeEnv } from "../src/config/env.ts";

const validRawEnv = {
  POLYMARKET_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
  POLYMARKET_API_KEY: "key",
  POLYMARKET_API_SECRET: "secret",
  POLYMARKET_API_PASSPHRASE: "passphrase",
  POLYMARKET_FUNDER_ADDRESS: "0x2222222222222222222222222222222222222222",
  POLYMARKET_SIGNATURE_TYPE: "GNOSIS_SAFE",
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_CHAT_ID: "chat",
};

describe("env parsing", () => {
  test("parses runtime env with defaults and branded values", () => {
    const env = parseRuntimeEnv(validRawEnv);
    expect(env.polymarket.clobHost).toBe("https://clob.polymarket.com");
    expect(env.polymarket.chainId).toBe(137);
    expect(env.polymarket.signatureType).toBe("GNOSIS_SAFE");
    expect(env.telegram.chatId).toBe("chat");
    expect(env.xai.apiKey).toBeUndefined();
  });

  test("allows missing CLOB API credentials for startup derivation", () => {
    const env = parseRuntimeEnv({
      POLYMARKET_PRIVATE_KEY: validRawEnv.POLYMARKET_PRIVATE_KEY,
      POLYMARKET_FUNDER_ADDRESS: validRawEnv.POLYMARKET_FUNDER_ADDRESS,
      TELEGRAM_BOT_TOKEN: validRawEnv.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: validRawEnv.TELEGRAM_CHAT_ID,
    });
    expect(env.polymarket.apiKey).toBeUndefined();
  });

  test("rejects partial CLOB API credentials", () => {
    expect(() => parseRuntimeEnv({
      ...validRawEnv,
      POLYMARKET_API_SECRET: undefined,
    })).toThrow("Provide all CLOB API credential fields");
  });

  test("rejects invalid signer key", () => {
    expect(() => parseRuntimeEnv({ ...validRawEnv, POLYMARKET_PRIVATE_KEY: "bad" })).toThrow("private key");
  });

  test("parses simple dotenv files", () => {
    expect(parseDotEnv("A=1\nB=\"two words\"\n# ignored\nC=value # comment")).toEqual({
      A: "1",
      B: "two words",
      C: "value",
    });
  });
});
