import { describe, expect, it } from "vitest";
import { resolveProactiveCompactionDecision } from "./execute.js";

/**
 * Unit tests for the pure decision function that gates proactive
 * post-run `/compact` in the CLI runner.  Covers every guard condition
 * and the ratio-vs-threshold boundary.  Actual `/compact` invocation is
 * driven by `executeWithOverflowProtection` (integration territory);
 * these tests cover the decision layer only.
 */

const baseParams = {
  compactionsThisRun: 0,
  abortSignalAborted: false,
  hasSession: true,
  isClaude: true,
  proactiveRatio: 0.8,
  promptTokens: 850_000,
  contextWindowTokens: 1_000_000,
};

describe("resolveProactiveCompactionDecision", () => {
  it("compacts when prompt tokens exceed the configured ratio", () => {
    const decision = resolveProactiveCompactionDecision(baseParams);
    expect(decision.shouldCompact).toBe(true);
    if (decision.shouldCompact) {
      expect(decision.promptTokens).toBe(850_000);
      expect(decision.ratio).toBeCloseTo(0.85, 5);
      expect(decision.threshold).toBe(0.8);
    }
  });

  it("does not compact when this run already compacted", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      compactionsThisRun: 1,
    });
    expect(decision).toEqual({
      shouldCompact: false,
      reason: "already_compacted_this_run",
    });
  });

  it("does not compact when the abort signal fired", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      abortSignalAborted: true,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "aborted" });
  });

  it("does not compact without a reusable session", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      hasSession: false,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "no_session" });
  });

  it("does not compact for non-Claude CLI backends", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      isClaude: false,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "not_claude_cli" });
  });

  it("does not compact when config disables proactive compaction (ratio = 0)", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      proactiveRatio: 0,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "disabled_by_config" });
  });

  it("does not compact when the prompt tokens are unknown", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      promptTokens: undefined,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "prompt_tokens_unknown" });
  });

  it("does not compact when the context window size is unknown", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      contextWindowTokens: 0,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "context_window_unknown" });
  });

  it("does not compact when the ratio is exactly at the threshold (strict >)", () => {
    // 800_000 / 1_000_000 = 0.8 — equal to threshold, should NOT trigger
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      promptTokens: 800_000,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "ratio_below_threshold" });
  });

  it("compacts when the ratio exceeds the threshold by even a small margin", () => {
    // 800_001 / 1_000_000 = 0.800001 > 0.8
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      promptTokens: 800_001,
    });
    expect(decision.shouldCompact).toBe(true);
  });

  it("does not compact when prompt tokens are below the threshold", () => {
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      promptTokens: 500_000,
    });
    expect(decision).toEqual({ shouldCompact: false, reason: "ratio_below_threshold" });
  });

  it("respects a custom ratio configured via config", () => {
    // Lower threshold (0.5) — 600k/1m = 0.6 > 0.5
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      proactiveRatio: 0.5,
      promptTokens: 600_000,
    });
    expect(decision.shouldCompact).toBe(true);
    if (decision.shouldCompact) {
      expect(decision.threshold).toBe(0.5);
      expect(decision.ratio).toBeCloseTo(0.6, 5);
    }
  });

  it("handles the 203% context-overflow scenario (reproduction of the original bug)", () => {
    // The session in the bug report was at 2.0m / 1.0m tokens — 203%.
    // The threshold is 80%. With the feature enabled, this must trigger
    // compaction so the session no longer grows unbounded.
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      promptTokens: 2_000_000,
      contextWindowTokens: 1_000_000,
    });
    expect(decision.shouldCompact).toBe(true);
    if (decision.shouldCompact) {
      expect(decision.ratio).toBeCloseTo(2.0, 5);
    }
  });

  it("short-circuits on compactionsThisRun before evaluating other guards", () => {
    // Even with aborted signal etc., the first guard wins — makes the
    // reason field predictable for log/metric consumers.
    const decision = resolveProactiveCompactionDecision({
      ...baseParams,
      compactionsThisRun: 1,
      abortSignalAborted: true,
      hasSession: false,
    });
    expect(decision).toEqual({
      shouldCompact: false,
      reason: "already_compacted_this_run",
    });
  });
});
