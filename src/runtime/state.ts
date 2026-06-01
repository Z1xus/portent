import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Manifest } from "../config/manifest.ts";
import type { SignalState } from "../signals/index.ts";
import type { OrderSubmission } from "../trading/polymarket.ts";
import type { SignalEvent } from "../signals/index.ts";

const ExecutionRecordSchema = z.object({
  manifestId: z.string(),
  eventId: z.string(),
  executedAt: z.string(),
  status: z.string(),
  orderId: z.string().optional(),
  budgetGroup: z.string().optional(),
  budgetAmountUsd: z.number().positive().optional(),
});

const StateDataSchema = z.object({
  executions: z.array(ExecutionRecordSchema).default([]),
  lastSeen: z.record(z.string(), z.string()).default({}),
});

type StateData = z.output<typeof StateDataSchema>;
type ExecutionRecord = z.output<typeof ExecutionRecordSchema>;

export interface ExecutionDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface ExecutionReservation extends ExecutionDecision {
  commit(submission: OrderSubmission, now?: Date): Promise<void>;
  release(): void;
}

export interface BudgetSummary {
  readonly group: string;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly pendingUsd: number;
  readonly remainingUsd: number;
}

export class JsonStateStore implements SignalState {
  private readonly statePath: string;
  private readonly orderLedgerPath: string;
  private data: StateData = { executions: [], lastSeen: {} };
  private readonly pendingBudgetUsd = new Map<string, number>();
  private readonly pendingManifestExecutions = new Set<string>();

  public constructor(private readonly dir: string) {
    this.statePath = join(dir, "state.json");
    this.orderLedgerPath = join(dir, "orders.jsonl");
  }

  public async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.data = await this.readState();
  }

  public async getLastSeen(key: string): Promise<string | undefined> {
    return this.data.lastSeen[key];
  }

  public async setLastSeen(key: string, value: string): Promise<void> {
    this.data.lastSeen[key] = value;
    await this.writeState();
  }

  public canExecute(manifest: Manifest, event: SignalEvent, now = new Date()): ExecutionDecision {
    const records = this.recordsForManifest(manifest);
    if (records.some((record) => record.eventId === event.id)) {
      return { allowed: false, reason: `signal event ${event.id} was already executed` };
    }
    if (!manifest.repeat && manifest.order.once && records.length > 0) {
      return { allowed: false, reason: "manifest order.once already executed" };
    }
    if (manifest.repeat?.maxExecutions !== undefined && records.length >= manifest.repeat.maxExecutions) {
      return { allowed: false, reason: `repeat.maxExecutions=${manifest.repeat.maxExecutions} reached` };
    }
    const lastExecution = latestRecord(records);
    if (lastExecution && manifest.repeat?.cooldownMs !== undefined) {
      const elapsed = now.getTime() - new Date(lastExecution.executedAt).getTime();
      if (elapsed < manifest.repeat.cooldownMs) {
        return { allowed: false, reason: `repeat cooldown active for ${manifest.repeat.cooldownMs - elapsed}ms` };
      }
    }
    return { allowed: true, reason: "allowed" };
  }

  public reserveExecution(manifest: Manifest, event: SignalEvent, now = new Date()): ExecutionReservation {
    const execution = this.canExecute(manifest, event, now);
    if (!execution.allowed) {
      return rejectedReservation(execution.reason);
    }
    const pendingKey = `${manifest.id}`;
    if (!manifest.repeat && manifest.order.once && this.pendingManifestExecutions.has(pendingKey)) {
      return rejectedReservation("manifest order.once already reserved");
    }
    this.pendingManifestExecutions.add(pendingKey);
    const budget = manifest.budget;
    if (!budget) {
      return {
        allowed: true,
        reason: "allowed",
        commit: async (submission, commitNow) => {
          try {
            await this.recordExecution(manifest, event, submission, commitNow);
          } finally {
            this.pendingManifestExecutions.delete(pendingKey);
          }
        },
        release: () => {
          this.pendingManifestExecutions.delete(pendingKey);
        },
      };
    }

    const spentUsd = this.spentBudgetUsd(budget.group);
    const pendingUsd = this.pendingBudgetUsd.get(budget.group) ?? 0;
    const nextUsd = spentUsd + pendingUsd + manifest.order.amountUsd;
    if (nextUsd > budget.limitUsd) {
      return rejectedReservation(
        `budget '${budget.group}' exhausted: ${formatUsd(spentUsd + pendingUsd)} reserved/spent of ${formatUsd(budget.limitUsd)}`,
      );
    }

    this.pendingBudgetUsd.set(budget.group, pendingUsd + manifest.order.amountUsd);
    let active = true;
    const release = (): void => {
      if (!active) {
        return;
      }
      active = false;
      this.pendingManifestExecutions.delete(pendingKey);
      this.pendingBudgetUsd.set(
        budget.group,
        Math.max(0, (this.pendingBudgetUsd.get(budget.group) ?? 0) - manifest.order.amountUsd),
      );
    };
    return {
      allowed: true,
      reason: "allowed",
      commit: async (submission, commitNow) => {
        try {
          await this.recordExecution(manifest, event, submission, commitNow);
        } finally {
          release();
        }
      },
      release,
    };
  }

  public async recordExecution(
    manifest: Manifest,
    event: SignalEvent,
    submission: OrderSubmission,
    now = new Date(),
  ): Promise<void> {
    const record: ExecutionRecord = {
      manifestId: manifest.id,
      eventId: event.id,
      executedAt: now.toISOString(),
      status: submission.status,
      ...(submission.orderId ? { orderId: submission.orderId } : {}),
      ...(manifest.budget ? { budgetGroup: manifest.budget.group, budgetAmountUsd: submission.amountUsd ?? manifest.order.amountUsd } : {}),
    };
    this.data.executions.push(record);
    await this.writeState();
    await writeFile(this.orderLedgerPath, `${JSON.stringify({ ...record, raw: submission.raw })}\n`, { flag: "a" });
  }

  public budgetSummaries(manifests: readonly Manifest[]): readonly BudgetSummary[] {
    const limits = new Map<string, number>();
    for (const manifest of manifests) {
      if (manifest.budget) {
        limits.set(manifest.budget.group, manifest.budget.limitUsd);
      }
    }
    return Array.from(limits.entries(), ([group, limitUsd]) => {
      const spentUsd = this.spentBudgetUsd(group);
      const pendingUsd = this.pendingBudgetUsd.get(group) ?? 0;
      return {
        group,
        limitUsd,
        spentUsd,
        pendingUsd,
        remainingUsd: Math.max(0, limitUsd - spentUsd - pendingUsd),
      };
    }).sort((left, right) => left.group.localeCompare(right.group));
  }

  private recordsForManifest(manifest: Manifest): readonly ExecutionRecord[] {
    return this.data.executions.filter((record) => record.manifestId === manifest.id);
  }

  private spentBudgetUsd(group: string): number {
    return this.data.executions
      .filter((record) => record.budgetGroup === group)
      .reduce((sum, record) => sum + (record.budgetAmountUsd ?? 0), 0);
  }

  private async readState(): Promise<StateData> {
    try {
      return StateDataSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { executions: [], lastSeen: {} };
      }
      throw error;
    }
  }

  private async writeState(): Promise<void> {
    const tmpPath = `${this.statePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`);
    await rename(tmpPath, this.statePath);
  }
}

function rejectedReservation(reason: string): ExecutionReservation {
  return {
    allowed: false,
    reason,
    commit: async () => {},
    release: () => {},
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function latestRecord(records: readonly ExecutionRecord[]): ExecutionRecord | undefined {
  return records
    .slice()
    .sort((left, right) => right.executedAt.localeCompare(left.executedAt))[0];
}
