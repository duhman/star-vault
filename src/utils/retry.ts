import type { ErrorBucket } from "../shared/starVault.js";

function getRetryDelayMsFromHeaders(headers?: Headers): number | null {
  if (!headers) return null;

  const retryAfter = headers.get("Retry-After");
  if (retryAfter) {
    const asNumber = Number(retryAfter);
    if (!Number.isNaN(asNumber)) {
      return Math.max(0, asNumber * 1000);
    }
  }

  const resetHeader = headers.get("X-RateLimit-Reset");
  if (resetHeader) {
    const resetEpochSec = Number(resetHeader);
    if (!Number.isNaN(resetEpochSec)) {
      const msUntilReset = resetEpochSec * 1000 - Date.now();
      return Math.max(0, msUntilReset);
    }
  }

  return null;
}

function shouldRetryStatus(status: number): boolean {
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok) return response;
      if (!shouldRetryStatus(response.status) || attempt === maxAttempts) {
        return response;
      }

      const retryHeaderDelay = getRetryDelayMsFromHeaders(response.headers);
      const backoffDelay = baseDelayMs * 2 ** (attempt - 1);
      const delay = retryHeaderDelay ?? backoffDelay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Request failed after retries");
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 400;
  const shouldRetry = options?.shouldRetry ?? defaultRetryErrorPredicate;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === maxAttempts) {
        break;
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Operation failed after retries");
}

export function classifyError(error: unknown): ErrorBucket {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);

  if (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("retry-after")
  ) {
    return "rate_limit";
  }
  if (
    message.includes("network") ||
    message.includes("econn") ||
    message.includes("fetch failed") ||
    message.includes("timeout")
  ) {
    return "network";
  }
  if (
    message.includes("invalid") ||
    message.includes("validation") ||
    message.includes("parse") ||
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("incorrect api key")
  ) {
    return "validation";
  }
  if (
    message.includes("supabase") ||
    message.includes("postgres") ||
    message.includes("db")
  ) {
    return "db";
  }
  return "unknown";
}

function defaultRetryErrorPredicate(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("500")
  );
}
