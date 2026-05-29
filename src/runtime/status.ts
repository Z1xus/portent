import type { Manifest } from "../config/manifest.ts";
import type { SignalEvent } from "../signals/index.ts";
import { formatUnknownError } from "../types.ts";

export interface SignalGroupStatus {
  readonly key: string;
  readonly label: string;
  readonly manifestIds: readonly string[];
  readonly startedAt: Date;
  readonly lastEventAt?: Date;
  readonly lastEventId?: string;
  readonly lastMatchedAt?: Date;
  readonly lastErrorAt?: Date;
  readonly lastError?: string;
}

export interface RuntimeStatusSnapshot {
  readonly startedAt: Date;
  readonly now: Date;
  readonly manifestCount: number;
  readonly enabledManifestIds: readonly string[];
  readonly groups: readonly SignalGroupStatus[];
}

export class RuntimeStatusTracker {
  private readonly startedAt = new Date();
  private manifestCount = 0;
  private enabledManifestIds: readonly string[] = [];
  private readonly groups = new Map<string, SignalGroupStatus>();

  public setManifests(manifests: readonly Manifest[]): void {
    this.manifestCount = manifests.length;
    this.enabledManifestIds = manifests
      .filter((manifest) => manifest.enabled)
      .map((manifest) => String(manifest.id))
      .sort((left, right) => left.localeCompare(right));
  }

  public groupStarted(key: string, manifests: readonly Manifest[], signalType: string, conditionType: string): void {
    const existing = this.groups.get(key);
    this.groups.set(key, {
      ...(existing ?? {
        key,
        startedAt: new Date(),
      }),
      label: `${signalType} / ${conditionType}`,
      manifestIds: manifests.map((manifest) => String(manifest.id)).sort((left, right) => left.localeCompare(right)),
    });
  }

  public signalEvent(key: string, event: SignalEvent): void {
    this.patchGroup(key, {
      lastEventAt: event.occurredAt,
      lastEventId: event.id,
    });
  }

  public conditionMatched(key: string): void {
    this.patchGroup(key, {
      lastMatchedAt: new Date(),
    });
  }

  public groupError(key: string, error: unknown): void {
    this.patchGroup(key, {
      lastErrorAt: new Date(),
      lastError: formatUnknownError(error),
    });
  }

  public snapshot(now = new Date()): RuntimeStatusSnapshot {
    return {
      startedAt: this.startedAt,
      now,
      manifestCount: this.manifestCount,
      enabledManifestIds: this.enabledManifestIds,
      groups: Array.from(this.groups.values()).sort((left, right) => left.label.localeCompare(right.label)),
    };
  }

  private patchGroup(key: string, patch: Partial<SignalGroupStatus>): void {
    const existing = this.groups.get(key);
    if (!existing) {
      return;
    }
    this.groups.set(key, { ...existing, ...patch });
  }
}
