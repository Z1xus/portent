import { formatUnknownError } from "../types.ts";
import type { NotificationEvent, Notifier } from "./telegram.ts";

export class QueuedNotifier implements Notifier {
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly inner: Notifier) {}

  public async notify(event: NotificationEvent): Promise<void> {
    this.tail = this.tail.then(() => this.deliver(event));
  }

  public drain(): Promise<void> {
    return this.tail;
  }

  private async deliver(event: NotificationEvent): Promise<void> {
    try {
      await this.inner.notify(event);
    } catch (error) {
      console.error(`Notification failed: ${formatUnknownError(error)}`);
    }
  }
}
