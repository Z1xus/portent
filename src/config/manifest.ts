import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { asManifestId, type ManifestId } from "../types.ts";

const PollMsSchema = z.number().int().min(1_000).max(86_400_000);
const TimeoutMsSchema = z.number().int().min(100).max(300_000);
const PriceSchema = z.number().positive().max(1);
const DateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected a parseable date/time string.",
});

const RetryPolicySchema = z.object({
  attempts: z.number().int().min(1).max(10).default(2),
  backoffMs: z.number().int().min(0).max(300_000).default(1_000),
  maxBackoffMs: z.number().int().min(0).max(300_000).default(15_000),
}).default({ attempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000 });

const RequestPolicySchema = z.object({
  timeoutMs: TimeoutMsSchema.default(30_000),
  retry: RetryPolicySchema,
}).default({ timeoutMs: 30_000, retry: { attempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000 } });

const MarketSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  url: z.url(),
  outcome: z.string().min(1).default("Yes"),
  startAt: DateTimeSchema.optional(),
  stopAt: DateTimeSchema.optional(),
});

const MarketSelectionSchema = z.object({
  mode: z.enum(["first", "lowestBestAsk"]).default("first"),
}).default({ mode: "first" });

const OpenAiModelsSignalSchema = z.object({
  type: z.literal("openai.models"),
  pollMs: PollMsSchema.default(300_000),
  baseUrl: z.url().default("https://api.openai.com/v1/models"),
  request: RequestPolicySchema,
});

const XFilteredStreamRuleSchema = z.object({
  value: z.string().min(1),
  tag: z.string().min(1).max(64),
});

const XFilteredStreamSignalSchema = z.object({
  type: z.literal("x.filteredStream"),
  streamUrl: z.url().default("https://api.x.com/2/tweets/search/stream"),
  rules: z.array(XFilteredStreamRuleSchema).min(1).max(25),
  reconnectMs: PollMsSchema.default(15_000),
  streamIdleMs: TimeoutMsSchema.default(300_000),
  request: RequestPolicySchema,
});

const TruthSocialSignalSchema = z.object({
  type: z.literal("truthsocial.accountStatuses"),
  baseUrl: z.url().optional(),
  accountId: z.string().min(1),
  pollMs: PollMsSchema.default(30_000),
  limit: z.number().int().min(1).max(40).default(20),
  excludeReplies: z.boolean().default(false),
  excludeReblogs: z.boolean().default(true),
  startFromLatest: z.boolean().default(true),
  request: RequestPolicySchema,
});

const HttpAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    tokenEnv: z.string().min(1),
  }),
  z.object({
    type: z.literal("basic"),
    usernameEnv: z.string().min(1),
    passwordEnv: z.string().min(1),
  }),
  z.object({
    type: z.literal("header"),
    name: z.string().min(1),
    valueEnv: z.string().min(1),
    prefix: z.string().optional(),
  }),
]);

const HttpPollSignalSchema = z.object({
  type: z.literal("http.poll"),
  url: z.url(),
  method: z.enum(["GET", "POST"]).default("GET"),
  pollMs: PollMsSchema.default(60_000),
  auth: HttpAuthSchema.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  headersFromEnv: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  eventsPath: z.string().min(1).default("$"),
  dataPath: z.string().min(1).default("$"),
  eventIdPath: z.string().min(1).optional(),
  textPath: z.string().min(1).optional(),
  startFromLatest: z.boolean().default(false),
  request: RequestPolicySchema,
});

const RssFeedSignalSchema = z.object({
  type: z.literal("rss.feed"),
  url: z.url(),
  pollMs: PollMsSchema.default(300_000),
  auth: HttpAuthSchema.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  headersFromEnv: z.record(z.string(), z.string()).default({}),
  startFromLatest: z.boolean().default(true),
  request: RequestPolicySchema,
});

const WebPageSignalSchema = z.object({
  type: z.literal("web.page"),
  url: z.url(),
  pollMs: PollMsSchema.default(300_000),
  auth: HttpAuthSchema.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  headersFromEnv: z.record(z.string(), z.string()).default({}),
  emit: z.enum(["changed", "always"]).default("changed"),
  startFromLatest: z.boolean().default(true),
  request: RequestPolicySchema,
});

const WebSocketJsonSignalSchema = z.object({
  type: z.literal("websocket.json"),
  url: z.url(),
  auth: HttpAuthSchema.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  headersFromEnv: z.record(z.string(), z.string()).default({}),
  subscribe: z.unknown().optional(),
  reconnectMs: PollMsSchema.default(15_000),
  idleMs: TimeoutMsSchema.default(300_000),
  dataPath: z.string().min(1).default("$"),
  eventIdPath: z.string().min(1).optional(),
  textPath: z.string().min(1).optional(),
});

export const SignalSchema = z.discriminatedUnion("type", [
  OpenAiModelsSignalSchema,
  XFilteredStreamSignalSchema,
  TruthSocialSignalSchema,
  HttpPollSignalSchema,
  RssFeedSignalSchema,
  WebPageSignalSchema,
  WebSocketJsonSignalSchema,
]);

const ModelIdPresentConditionSchema = z.object({
  type: z.literal("modelIdPresent"),
  modelId: z.string().min(1),
  match: z.enum(["exact", "includes", "regex"]).default("exact"),
}).superRefine((condition, ctx) => {
  if (condition.match !== "regex") {
    return;
  }
  try {
    new RegExp(condition.modelId, "u");
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid regular expression.",
      path: ["modelId"],
    });
  }
});

const TextIncludesConditionSchema = z.object({
  type: z.literal("textIncludes"),
  terms: z.array(z.string().min(1)).min(1),
  mode: z.enum(["any", "all"]).default("any"),
  caseSensitive: z.boolean().default(false),
});

const TextMatchesConditionSchema = z.object({
  type: z.literal("textMatches"),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/u).default("iu"),
}).superRefine((condition, ctx) => {
  try {
    new RegExp(condition.pattern, condition.flags);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid regular expression.",
      path: ["pattern"],
    });
  }
});

const JsonExistsConditionSchema = z.object({
  type: z.literal("jsonExists"),
  path: z.string().min(1),
});

const JsonEqualsConditionSchema = z.object({
  type: z.literal("jsonEquals"),
  path: z.string().min(1),
  value: z.unknown(),
});

const JsonIncludesConditionSchema = z.object({
  type: z.literal("jsonIncludes"),
  path: z.string().min(1),
  value: z.unknown(),
});

const JsonMatchesConditionSchema = z.object({
  type: z.literal("jsonMatches"),
  path: z.string().min(1),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/u).default("iu"),
}).superRefine((condition, ctx) => {
  try {
    new RegExp(condition.pattern, condition.flags);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid regular expression.",
      path: ["pattern"],
    });
  }
});

const JsonCompareConditionSchema = z.object({
  type: z.literal("jsonCompare"),
  path: z.string().min(1),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq"]),
  value: z.number(),
});

const LeafConditionSchema = z.discriminatedUnion("type", [
  ModelIdPresentConditionSchema,
  TextIncludesConditionSchema,
  TextMatchesConditionSchema,
  JsonExistsConditionSchema,
  JsonEqualsConditionSchema,
  JsonIncludesConditionSchema,
  JsonMatchesConditionSchema,
  JsonCompareConditionSchema,
]);

export type ManifestCondition =
  | z.output<typeof LeafConditionSchema>
  | { readonly type: "all"; readonly conditions: readonly ManifestCondition[] }
  | { readonly type: "any"; readonly conditions: readonly ManifestCondition[] }
  | { readonly type: "not"; readonly condition: ManifestCondition };

export const ConditionSchema: z.ZodType<ManifestCondition> = z.lazy(() => z.union([
  LeafConditionSchema,
  z.object({
    type: z.literal("all"),
    conditions: z.array(ConditionSchema).min(1),
  }),
  z.object({
    type: z.literal("any"),
    conditions: z.array(ConditionSchema).min(1),
  }),
  z.object({
    type: z.literal("not"),
    condition: ConditionSchema,
  }),
]));

const OrderSchema = z.object({
  side: z.literal("BUY"),
  amountUsd: z.number().positive(),
  maxPrice: PriceSchema,
  type: z.enum(["FOK", "FAK", "GTC", "GTD"]),
  once: z.boolean().default(true),
  expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(),
  postOnly: z.boolean().default(false),
  deferExecution: z.boolean().default(false),
});

const RepeatSchema = z.object({
  cooldownMs: z.number().int().min(1_000).optional(),
  maxExecutions: z.number().int().min(1).optional(),
}).strict();

const BudgetSchema = z.object({
  group: z.string().min(1).max(80),
  limitUsd: z.number().positive(),
  priority: z.number().int().default(100),
}).strict();

const NotificationsSchema = z.object({
  telegram: z.boolean().default(true),
}).default({ telegram: true });

export const ManifestSchema = z.object({
  id: z.string().min(2).max(80),
  enabled: z.boolean().default(false),
  market: MarketSchema.optional(),
  markets: z.array(MarketSchema).min(1).optional(),
  marketSelection: MarketSelectionSchema,
  signal: SignalSchema,
  condition: ConditionSchema,
  order: OrderSchema,
  budget: BudgetSchema.optional(),
  repeat: RepeatSchema.optional(),
  notifications: NotificationsSchema,
}).strict().superRefine((manifest, ctx) => {
  if (manifest.market && manifest.markets) {
    ctx.addIssue({
      code: "custom",
      message: "Use either 'market' or 'markets', not both.",
      path: ["markets"],
    });
  }
  if (!manifest.market && !manifest.markets) {
    ctx.addIssue({
      code: "custom",
      message: "A manifest must define 'market' or 'markets'.",
      path: ["market"],
    });
  }
});

export type RawManifest = z.output<typeof ManifestSchema>;
export type ManifestSignal = z.output<typeof SignalSchema>;
export type ManifestOrder = z.output<typeof OrderSchema>;
export type ManifestMarket = z.output<typeof MarketSchema>;

export type Manifest = Omit<RawManifest, "id"> & {
  readonly id: ManifestId;
  readonly sourcePath: string;
};

export async function loadManifestFile(path: string): Promise<Manifest> {
  const content = await readFile(path, "utf8");
  const data = parseYaml(content);
  return parseManifest(data, path);
}

export async function loadManifestDir(dir: string): Promise<readonly Manifest[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml)$/iu.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const manifests = await Promise.all(paths.map((path) => loadManifestFile(path)));
  validateManifestSet(manifests);
  return manifests;
}

export function parseManifest(data: unknown, sourcePath: string): Manifest {
  const parsed = ManifestSchema.parse(data);
  return {
    ...parsed,
    id: asManifestId(parsed.id),
    sourcePath,
  };
}

export function manifestMarkets(manifest: Manifest): readonly ManifestMarket[] {
  if (manifest.markets) {
    return manifest.markets;
  }
  if (manifest.market) {
    return [manifest.market];
  }
  throw new Error(`Manifest ${manifest.id} has no market targets.`);
}

export function validateManifestSet(manifests: readonly Manifest[]): void {
  const budgetLimits = new Map<string, { readonly limitUsd: number; readonly sourcePath: string }>();
  for (const manifest of manifests) {
    const budget = manifest.budget;
    if (!budget) {
      continue;
    }
    const existing = budgetLimits.get(budget.group);
    if (existing && existing.limitUsd !== budget.limitUsd) {
      throw new Error(
        `Budget group '${budget.group}' has conflicting limitUsd values: ${existing.limitUsd} in ${existing.sourcePath}, ${budget.limitUsd} in ${manifest.sourcePath}.`,
      );
    }
    budgetLimits.set(budget.group, { limitUsd: budget.limitUsd, sourcePath: manifest.sourcePath });
  }
}

export function manifestJsonSchema(): unknown {
  const schema = z.toJSONSchema(ManifestSchema);
  return typeof schema === "object" && schema !== null
    ? { title: "PortentManifest", ...schema }
    : schema;
}

export async function writeManifestJsonSchema(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`);
}
