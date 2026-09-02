export interface BackoffOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
}

/** Computes exponential backoff delay for a given attempt (0-indexed). */
export function computeBackoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const { initialDelayMs = 500, maxDelayMs = 30_000, factor = 2, jitter = true } = options;
  const raw = Math.min(initialDelayMs * Math.pow(factor, attempt), maxDelayMs);
  if (!jitter) return raw;
  // full jitter: uniform in [0, raw]
  return Math.floor(Math.random() * raw);
}

export interface RetryOptions extends BackoffOptions {
  maxAttempts?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fn` with exponential backoff + jitter, retrying up to `maxAttempts` times. */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 5, onRetry, isRetryable = () => true, sleep = defaultSleep } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(err)) {
        throw err;
      }
      const delayMs = computeBackoffDelay(attempt, options);
      onRetry?.(attempt + 1, err, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
