import { describe, expect, it } from "vitest";
import {
  normalizeTerminalAssistantText,
  stripTerminalControls,
  TerminalDeltaTracker,
} from "./terminal-stream.js";

describe("terminal-stream", () => {
  it("strips ANSI control sequences", () => {
    expect(stripTerminalControls("\u001B[31mhello\u001B[0m\r\n")).toBe("hello\n");
  });

  it("drops common Claude UI chrome lines", () => {
    expect(normalizeTerminalAssistantText("╭── box\nhello\n✻ cooking\n")).toBe("hello");
  });

  it("emits deltas for growing terminal snapshots", () => {
    const tracker = new TerminalDeltaTracker();
    expect(tracker.push("hello")).toBe("hello");
    expect(tracker.push("hello world")).toBe(" world");
    expect(tracker.getText()).toBe("hello world");
  });

  it("returns empty string when a chunk normalizes to nothing", () => {
    const tracker = new TerminalDeltaTracker();
    // Only ANSI + UI chrome → normalized text is empty.
    expect(tracker.push("[2J╭── box\n✻ working\n")).toBe("");
    expect(tracker.getText()).toBe("");
  });

  it("deduplicates a trailing-suffix re-capture", () => {
    const tracker = new TerminalDeltaTracker();
    expect(tracker.push("hello world")).toBe("hello world");
    // "hello world" does not start with "world" but does end with it →
    // treated as an already-seen suffix, no delta emitted.
    expect(tracker.push("world")).toBe("");
    expect(tracker.getText()).toBe("hello world");
  });

  it("appends non-prefix content as a fresh segment", () => {
    const tracker = new TerminalDeltaTracker();
    expect(tracker.push("first line")).toBe("first line");
    // New snapshot is neither a prefix-extension nor a known suffix.
    expect(tracker.push("totally different")).toBe("totally different");
    expect(tracker.getText()).toBe("first linetotally different");
  });
});
