import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearCliSession,
  getCliSessionBinding,
  getCliSessionId,
  setCliSessionBinding,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("stores and loads rich cli session bindings", () => {
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "claude-session-1",
      systemPromptFile: "/tmp/session.claude-system-prompt.txt",
      systemPromptHash: "hash-1",
      systemPromptCompactionCount: 2,
    });

    expect(getCliSessionId(entry, "claude-cli")).toBe("claude-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "claude-session-1",
      systemPromptFile: "/tmp/session.claude-system-prompt.txt",
      systemPromptHash: "hash-1",
      systemPromptCompactionCount: 2,
    });
  });

  it("falls back to legacy cliSessionIds and clears all related fields", () => {
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };

    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "legacy-session",
    });

    clearCliSession(entry, "claude-cli");
    expect(getCliSessionId(entry, "claude-cli")).toBeUndefined();
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });
});
