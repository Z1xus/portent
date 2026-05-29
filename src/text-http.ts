import { type FetchJsonOptions, HttpError, type Fetcher } from "./http.ts";

export async function fetchText(
  fetcher: Fetcher,
  url: string,
  options: FetchJsonOptions = {},
): Promise<string> {
  const retry = options.retry ?? { attempts: 1, backoffMs: 0, maxBackoffMs: 0 };
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await fetchTextOnce(fetcher, url, options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt >= retry.attempts || !isRetryable(error)) {
        throw error;
      }
      await wait(Math.min(retry.backoffMs * 2 ** (attempt - 1), retry.maxBackoffMs), options.signal);
    }
  }
  throw lastError;
}

async function fetchTextOnce(fetcher: Fetcher, url: string, options: FetchJsonOptions): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${options.timeoutMs ?? 30_000}ms`)), options.timeoutMs ?? 30_000);
  const onParentAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      signal: controller.signal,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };
    const response = await fetcher(url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} from ${url}`, response.status, text);
    }
    return text;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError || error instanceof DOMException || error instanceof Error && /timed out|abort/iu.test(error.message);
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
