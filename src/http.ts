import type { z } from "zod";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly headers?: HeadersInit;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly retry?: RetryOptions;
}

export interface RetryOptions {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
}

export async function fetchJson<T>(
  fetcher: Fetcher,
  url: string,
  schema: z.ZodType<T>,
  options: FetchJsonOptions = {},
): Promise<T> {
  return fetchJsonRaw(fetcher, url, options).then((json) => schema.parse(json));
}

export async function fetchJsonRaw(
  fetcher: Fetcher,
  url: string,
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const retry = options.retry ?? { attempts: 1, backoffMs: 0, maxBackoffMs: 0 };
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await fetchJsonRawOnce(fetcher, url, options);
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

async function fetchJsonRawOnce(
  fetcher: Fetcher,
  url: string,
  options: FetchJsonOptions,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${options.timeoutMs ?? 30_000}ms`)), options.timeoutMs ?? 30_000);
  const onParentAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: jsonHeaders(options.headers, options.body !== undefined),
      signal: controller.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };
    const response = await fetcher(url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} from ${url}`, response.status, text);
    }
    return text.length === 0 ? null : JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

function jsonHeaders(headers: HeadersInit | undefined, hasBody: boolean): Headers {
  const next = new Headers(headers);
  if (hasBody && !next.has("content-type")) {
    next.set("content-type", "application/json");
  }
  if (!next.has("accept")) {
    next.set("accept", "application/json");
  }
  return next;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError || error instanceof DOMException || error instanceof Error && /timed out|abort/i.test(error.message);
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
