import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  getCliSessionId,
  hashCliSessionText,
  hashCliSessionStablePrompt,
  resolveCliSessionReuse,
  resolvePhysicalContextId,
  setCliSessionBinding,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("persists binding metadata alongside legacy session ids", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry.claudeCliSessionId).toBe("cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });
  });

  it("stores and loads rich cli session bindings (systemPrompt fields)", () => {
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
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual(
      expect.objectContaining({
        sessionId: "claude-session-1",
        systemPromptFile: "/tmp/session.claude-system-prompt.txt",
        systemPromptHash: "hash-1",
        systemPromptCompactionCount: 2,
      }),
    );
  });

  it("keeps legacy bindings reusable until richer metadata is persisted", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };

    expect(resolveCliSessionReuse({ binding: getCliSessionBinding(entry, "claude-cli") })).toEqual({
      sessionId: "legacy-session",
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

  it("invalidates legacy bindings when auth or MCP state changes, but not on first hash establishment", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };
    const binding = getCliSessionBinding(entry, "claude-cli");

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        mcpConfigHash: "mcp-hash",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-hash",
      }),
    ).toEqual({ sessionId: "legacy-session" });
  });

  it("invalidates reuse when stored auth profile or prompt shape changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-b",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-b",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("keeps dynamic turn context out of the stable CLI session prompt hash", () => {
    const stablePrompt = "Group rules: reply only when addressed.";

    const first = hashCliSessionStablePrompt({
      extraSystemPrompt: `${stablePrompt}\n\nrecent_group_context: hello`,
      extraSystemPromptStatic: stablePrompt,
    });
    const second = hashCliSessionStablePrompt({
      extraSystemPrompt: `${stablePrompt}\n\nrecent_group_context: new message`,
      extraSystemPromptStatic: stablePrompt,
    });

    expect(first).toBe(second);
    expect(first).toBe(hashCliSessionText(stablePrompt));
  });

  it("changes the stable CLI session prompt hash when stable system context changes", () => {
    expect(
      hashCliSessionStablePrompt({
        extraSystemPrompt: "stable system prompt A\n\nrecent_group_context: hello",
        extraSystemPromptStatic: "stable system prompt A",
      }),
    ).not.toBe(
      hashCliSessionStablePrompt({
        extraSystemPrompt: "stable system prompt B\n\nrecent_group_context: hello",
        extraSystemPromptStatic: "stable system prompt B",
      }),
    );
  });

  it("does not treat model changes as a session mismatch", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ sessionId: "cli-session-1" });
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "claude-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");

    clearAllCliSessions(entry);
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });
});

describe("resolvePhysicalContextId", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-physical-ctx-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function writeStore(
    label: string,
    entries: Record<string, Partial<SessionEntry>>,
  ): Promise<string> {
    const storePath = path.join(fixtureRoot, `${label}.json`);
    await fs.writeFile(storePath, JSON.stringify(entries), "utf-8");
    return storePath;
  }

  it("returns the persisted claude-cli session id for the requested session key", async () => {
    const storePath = await writeStore("hit", {
      "agent:chat:1": {
        sessionId: "openclaw-session",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "phys-claude-1" } },
        cliSessionIds: { "claude-cli": "phys-claude-1" },
        claudeCliSessionId: "phys-claude-1",
      },
    });
    expect(resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:1" })).toBe(
      "phys-claude-1",
    );
  });

  it("returns undefined when no binding exists, so callers fall back to sessionKey", async () => {
    const storePath = await writeStore("miss-no-binding", {
      "agent:chat:2": { sessionId: "openclaw-session", updatedAt: 1 },
    });
    expect(resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:2" })).toBeUndefined();
  });

  it("returns undefined for unknown session keys", async () => {
    const storePath = await writeStore("miss-no-entry", {
      "other:key": {
        sessionId: "x",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "phys" } },
      },
    });
    expect(
      resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:missing" }),
    ).toBeUndefined();
  });

  it("returns undefined when the store file is missing", () => {
    expect(
      resolvePhysicalContextId({
        storePath: path.join(fixtureRoot, "does-not-exist.json"),
        sessionKey: "agent:chat:any",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when sessionKey is empty", () => {
    expect(resolvePhysicalContextId({ storePath: "/dev/null", sessionKey: "  " })).toBeUndefined();
  });

  it("honors a custom provider id", async () => {
    const storePath = await writeStore("provider", {
      "agent:chat:3": {
        sessionId: "x",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": { sessionId: "phys-claude-3" },
          "codex-cli": { sessionId: "phys-codex-3" },
        },
      },
    });
    expect(
      resolvePhysicalContextId({
        storePath,
        sessionKey: "agent:chat:3",
        provider: "codex-cli",
      }),
    ).toBe("phys-codex-3");
    expect(resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:3" })).toBe(
      "phys-claude-3",
    );
  });
});
