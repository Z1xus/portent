import type { Manifest } from "../config/manifest.ts";

const ORDER_ISSUE_KEY = "orderIssue";

export class RuntimeNotificationThrottle {
  private readonly lastNotificationAt = new Map<string, number>();

  public wouldNotifyOrderIssue(manifest: Manifest, now = new Date()): boolean {
    const cooldownMs = manifest.notifications.failureCooldownMs;
    if (cooldownMs === 0) {
      return true;
    }
    const lastAt = this.lastNotificationAt.get(notificationKey(manifest));
    return lastAt === undefined || now.getTime() - lastAt >= cooldownMs;
  }

  public shouldNotifyOrderIssue(manifest: Manifest, now = new Date()): boolean {
    if (!this.wouldNotifyOrderIssue(manifest, now)) {
      return false;
    }
    this.lastNotificationAt.set(notificationKey(manifest), now.getTime());
    return true;
  }
}

function notificationKey(manifest: Manifest): string {
  return `${manifest.id}:${ORDER_ISSUE_KEY}`;
}
