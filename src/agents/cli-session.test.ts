import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAllCliSessions,
  clearCliSession,
  clearCliSessionFromStore,
  getCliSessionBinding,
  getCliSessionId,
  hashCliSessionText,
  hashCliSessionStablePrompt,
  persistCliSessionBindingToStore,
  resolveCliSessionReuse,
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

describe("persistCliSessionBindingToStore", () => {
  const cleanupPaths: string[] = [];
  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop();
      if (target) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  async function createSeededStore(seed: Record<string, unknown>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-session-store-"));
    cleanupPaths.push(dir);
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, JSON.stringify(seed, null, 2), "utf-8");
    return storePath;
  }

  it("writes cliSessionBindings[claude-cli].sessionId so resolvePhysicalContextIdFromRuntime can read it", async () => {
    const sessionKey = "agent:main:feishu:chat:abc";
    const storePath = await createSeededStore({
      [sessionKey]: { sessionId: "s1", updatedAt: Date.now() },
    });

    const wrote = await persistCliSessionBindingToStore({
      storePath,
      sessionKey,
      provider: "claude-cli",
      binding: {
        sessionId: "claude-physical-1",
        systemPromptFile: "/tmp/session.claude-system-prompt.txt",
        systemPromptHash: "hash-1",
      },
    });

    expect(wrote).toBe(true);
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].cliSessionBindings).toEqual({
      "claude-cli": {
        sessionId: "claude-physical-1",
        systemPromptFile: "/tmp/session.claude-system-prompt.txt",
        systemPromptHash: "hash-1",
      },
    });
    expect(stored[sessionKey].cliSessionIds).toEqual({ "claude-cli": "claude-physical-1" });
    expect(stored[sessionKey].claudeCliSessionId).toBe("claude-physical-1");
  });

  it("returns false (no-op) when sessionKey is missing — fallback behavior unchanged", async () => {
    const storePath = await createSeededStore({});
    const wrote = await persistCliSessionBindingToStore({
      storePath,
      provider: "claude-cli",
      binding: { sessionId: "claude-physical-1" },
    });
    expect(wrote).toBe(false);
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored).toEqual({});
  });

  it("returns false when the binding has no sessionId", async () => {
    const sessionKey = "agent:main:feishu:chat:abc";
    const storePath = await createSeededStore({
      [sessionKey]: { sessionId: "s1", updatedAt: Date.now() },
    });
    const wrote = await persistCliSessionBindingToStore({
      storePath,
      sessionKey,
      provider: "claude-cli",
      binding: { sessionId: "   " },
    });
    expect(wrote).toBe(false);
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].cliSessionBindings).toBeUndefined();
  });

  it("returns false when the entry does not yet exist (best-effort write)", async () => {
    const storePath = await createSeededStore({});
    const wrote = await persistCliSessionBindingToStore({
      storePath,
      sessionKey: "unknown-key",
      provider: "claude-cli",
      binding: { sessionId: "claude-physical-1" },
    });
    expect(wrote).toBe(false);
  });

  it("overwrites the binding when a new physical session id supersedes the old one", async () => {
    const sessionKey = "agent:main:feishu:chat:abc";
    const storePath = await createSeededStore({
      [sessionKey]: {
        sessionId: "s1",
        updatedAt: Date.now(),
        cliSessionBindings: { "claude-cli": { sessionId: "previous-id" } },
      },
    });

    await persistCliSessionBindingToStore({
      storePath,
      sessionKey,
      provider: "claude-cli",
      binding: { sessionId: "claude-physical-2" },
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].cliSessionBindings["claude-cli"].sessionId).toBe("claude-physical-2");
  });

  it("does not write a binding when the sessionId is empty even for non-claude-cli providers", async () => {
    const sessionKey = "agent:main:feishu:chat:abc";
    const storePath = await createSeededStore({
      [sessionKey]: { sessionId: "s1", updatedAt: Date.now() },
    });
    const wrote = await persistCliSessionBindingToStore({
      storePath,
      sessionKey,
      provider: "codex-cli",
      binding: { sessionId: "" },
    });
    expect(wrote).toBe(false);
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].cliSessionBindings).toBeUndefined();
  });
});

describe("clearCliSessionFromStore", () => {
  const cleanupPaths: string[] = [];
  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop();
      if (target) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  async function createSeededStore(seed: Record<string, unknown>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-session-store-"));
    cleanupPaths.push(dir);
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, JSON.stringify(seed, null, 2), "utf-8");
    return storePath;
  }

  it("clears the stored binding so resolvePhysicalContextIdFromRuntime falls back to sessionKey", async () => {
    const sessionKey = "agent:main:feishu:chat:abc";
    const storePath = await createSeededStore({
      [sessionKey]: {
        sessionId: "s1",
        updatedAt: Date.now(),
        cliSessionBindings: { "claude-cli": { sessionId: "stale-physical-id" } },
        cliSessionIds: { "claude-cli": "stale-physical-id" },
        claudeCliSessionId: "stale-physical-id",
      },
    });

    const cleared = await clearCliSessionFromStore({
      storePath,
      sessionKey,
      provider: "claude-cli",
    });

    expect(cleared).toBe(true);
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].cliSessionBindings).toBeUndefined();
    expect(stored[sessionKey].cliSessionIds).toBeUndefined();
    expect(stored[sessionKey].claudeCliSessionId).toBeUndefined();
  });

  it("returns false when sessionKey is missing", async () => {
    const storePath = await createSeededStore({});
    const cleared = await clearCliSessionFromStore({
      storePath,
      provider: "claude-cli",
    });
    expect(cleared).toBe(false);
  });
});
