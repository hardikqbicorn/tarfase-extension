import { describe, expect, it, vi } from "vitest";
import { debounce, throttle, Sampler } from "./throttle";

describe("debounce", () => {
  it("only invokes once after the wait period following the last call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    debounced();
    debounced();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("throttle", () => {
  it("invokes immediately then trails the last call within the interval", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled(1);
    expect(fn).toHaveBeenCalledWith(1);
    throttled(2);
    throttled(3);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith(3);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("Sampler", () => {
  it("keeps the first call and every Nth after", () => {
    const sampler = new Sampler(3);
    const results = Array.from({ length: 7 }, () => sampler.shouldSample());
    expect(results).toEqual([true, false, true, false, false, true, false]);
  });
});
