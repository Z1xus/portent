export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setLongTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      timeout.clear();
      resolve();
    }, { once: true });
  });
}

export interface LongTimeout {
  clear(): void;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

export function setLongTimeout(callback: () => void, delayMs: number): LongTimeout {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const start = (remainingMs: number): void => {
    timeout = setTimeout(() => {
      if (cleared) {
        return;
      }
      const nextRemainingMs = remainingMs - MAX_TIMEOUT_MS;
      if (nextRemainingMs > 0) {
        start(nextRemainingMs);
        return;
      }
      callback();
    }, Math.min(remainingMs, MAX_TIMEOUT_MS));
  };
  start(Math.max(0, delayMs));
  return {
    clear: () => {
      cleared = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}
