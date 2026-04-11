import { describe, expect, it } from "vitest";
import { checkAbortSignal } from "./execute.js";

/**
 * Unit tests for the pure abort-check helper used by the CLI runner
 * to exit JS orchestration promptly when the user sends /stop.
 *
 * The behaviour mirrors `pi-embedded-runner/run.ts` `throwIfAborted`:
 * when the signal's reason is an Error, re-throw it directly; otherwise
 * construct a new Error with `name = "AbortError"` so downstream code in
 * `agent-runner-execution.ts` can recognise the abort uniformly across
 * both runtimes.
 */

describe("checkAbortSignal", () => {
  it("does nothing when signal is undefined", () => {
    expect(() => checkAbortSignal(undefined)).not.toThrow();
  });

  it("does nothing when signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => checkAbortSignal(controller.signal)).not.toThrow();
  });

  it("throws an AbortError with the default reason when aborted without an explicit reason", () => {
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      checkAbortSignal(controller.signal);
    } catch (err) {
      caught = err;
    }
    // In modern Node (>=17) `AbortController.abort()` with no args sets
    // the signal's `reason` to a DOMException whose `name` is already
    // "AbortError". Our helper detects `reason instanceof Error` and
    // rethrows it directly. The caller-facing contract is simply
    // `err.name === "AbortError"`, which holds in every runtime.
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.name).toBe("AbortError");
    }
  });

  it("constructs a new AbortError when the signal has no reason at all", () => {
    // Synthesize a minimal AbortSignal-shaped object where `reason` is
    // explicitly undefined, to exercise the `reason !== undefined` branch
    // in checkAbortSignal that constructs a fresh Error. Real
    // AbortController.abort() always populates reason in modern Node, so
    // this path is only reachable via custom-shaped signals (polyfills,
    // tests, or manual aborts).
    const fakeSignal = {
      aborted: true,
      reason: undefined,
    } as unknown as AbortSignal;
    let caught: unknown;
    try {
      checkAbortSignal(fakeSignal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.name).toBe("AbortError");
      expect(caught.message).toBe("CLI runner aborted");
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("rethrows the exact Error instance when signal.reason is an Error", () => {
    const controller = new AbortController();
    const userErr = new Error("User pressed /stop");
    userErr.name = "AbortError";
    controller.abort(userErr);
    let caught: unknown;
    try {
      checkAbortSignal(controller.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(userErr);
  });

  it("wraps a non-Error reason into a new AbortError with the reason as cause", () => {
    const controller = new AbortController();
    controller.abort("timeout-sentinel");
    let caught: unknown;
    try {
      checkAbortSignal(controller.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.name).toBe("AbortError");
      expect(caught.message).toBe("CLI runner aborted");
      // `cause` is only set when the reason is a non-Error primitive.
      expect((caught as Error & { cause?: unknown }).cause).toBe("timeout-sentinel");
    }
  });

  it("is reentrant: multiple calls on the same non-aborted signal are safe", () => {
    const controller = new AbortController();
    expect(() => {
      checkAbortSignal(controller.signal);
      checkAbortSignal(controller.signal);
      checkAbortSignal(controller.signal);
    }).not.toThrow();
  });

  it("throws consistently on repeated calls after abort", () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => checkAbortSignal(controller.signal)).toThrow("stop");
    expect(() => checkAbortSignal(controller.signal)).toThrow("stop");
  });
});
