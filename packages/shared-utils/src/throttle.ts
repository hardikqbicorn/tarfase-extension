/**
 * Debounce/throttle helpers used to tame high-frequency IDE events
 * (cursor movement, keystrokes, document changes) before they ever reach
 * the local buffer.
 */

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number
): (...args: Args) => void {
  let lastCall = 0;
  let trailingArgs: Args | undefined;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;

  return (...args: Args) => {
    const now = Date.now();
    const remaining = intervalMs - (now - lastCall);
    if (remaining <= 0) {
      lastCall = now;
      fn(...args);
    } else {
      trailingArgs = args;
      if (!trailingTimer) {
        trailingTimer = setTimeout(() => {
          lastCall = Date.now();
          trailingTimer = undefined;
          if (trailingArgs) fn(...trailingArgs);
          trailingArgs = undefined;
        }, remaining);
      }
    }
  };
}

/** Simple sliding-window sampler: keeps roughly 1-in-N calls, always keeping the first. */
export class Sampler {
  private count = 0;
  constructor(private readonly rate: number) {}
  shouldSample(): boolean {
    this.count += 1;
    return this.count === 1 || this.count % this.rate === 0;
  }
}
