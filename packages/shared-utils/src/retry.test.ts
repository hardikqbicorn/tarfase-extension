import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff, computeBackoffDelay } from "./retry";

describe("computeBackoffDelay", () => {
  it("grows exponentially and respects the max cap", () => {
    const d0 = computeBackoffDelay(0, { initialDelayMs: 100, jitter: false });
    const d1 = computeBackoffDelay(1, { initialDelayMs: 100, jitter: false });
    const d2 = computeBackoffDelay(2, { initialDelayMs: 100, jitter: false });
    expect(d0).toBe(100);
    expect(d1).toBe(200);
    expect(d2).toBe(400);
    const capped = computeBackoffDelay(10, { initialDelayMs: 100, maxDelayMs: 500, jitter: false });
    expect(capped).toBe(500);
  });
});

describe("retryWithBackoff", () => {
  it("succeeds without retrying when fn resolves", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { sleep: async () => {} });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxAttempts then throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, sleep: async () => {} })
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("recovers after transient failures", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    });
    const result = await retryWithBackoff(fn, { maxAttempts: 5, sleep: async () => {} });
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("does not retry when isRetryable returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(
      retryWithBackoff(fn, { maxAttempts: 5, isRetryable: () => false, sleep: async () => {} })
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
