import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPasteLocksForTest,
  __resetTmuxCapabilityProbeForTest,
  defaultTmuxCommandRunner,
  TmuxSessionManager,
} from "./manager.js";
import type { NormalizedTmuxConfig, TmuxRuntimePaths } from "./types.js";

function buildPaths(rootDir: string): TmuxRuntimePaths {
  return {
    rootDir,
    activeRunFile: path.join(rootDir, "active-run.json"),
    eventsFile: path.join(rootDir, "events.jsonl"),
    paneLogFile: path.join(rootDir, "pane.log"),
    launcherFile: path.join(rootDir, "launch-claude.mjs"),
    settingsFile: path.join(rootDir, "settings.json"),
    hookWriterFile: path.join(rootDir, "hook-writer.mjs"),
    promptBufferFile: path.join(rootDir, "prompt-buffer.txt"),
    metadataFile: path.join(rootDir, "metadata.json"),
    precompactFlagFile: path.join(rootDir, "precompact.flag"),
  };
}

const config: NormalizedTmuxConfig = {
  sessionNamePrefix: "openclaw-claude",
  startupTimeoutMs: 1_000,
  turnTimeoutMs: 5_000,
  turnIdleMs: 100,
  hookStallMs: 8_000,
  captureLines: 20,
  stopOnAbort: true,
  memoryMode: "managed-disabled",
  hookMode: "managed",
  authMode: "openclaw",
  reapIdleAfterMs: 0,
};

describe("TmuxSessionManager", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    __resetPasteLocksForTest();
    __resetTmuxCapabilityProbeForTest();
  });

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("starts tmux through a launcher so injected env reaches Claude even with an existing tmux server", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const manager = new TmuxSessionManager(async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      if (args[0] === "has-session") {
        throw new Error("missing");
      }
      return { stdout: "", stderr: "" };
    });

    await manager.ensureSession({
      paths,
      metadata: {
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      },
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {
        ANTHROPIC_API_KEY: "test-key",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      config,
    });

    const newSession = calls.find((call) => call.args[0] === "new-session");
    expect(newSession?.args.slice(-2)).toEqual(["node", paths.launcherFile]);
    expect(newSession?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(newSession?.args).toContain("-e");
    expect(newSession?.args).toContain("ANTHROPIC_API_KEY=test-key");

    const launcher = await fs.readFile(paths.launcherFile, "utf8");
    expect(launcher).toContain('"ANTHROPIC_API_KEY"');
    expect(launcher).not.toContain("test-key");
    expect(launcher).toContain('"CLAUDE_CODE_DISABLE_AUTO_MEMORY"');
    expect(launcher).toContain("spawn(command, args");
  });

  it("recreates an existing session when the launch hash changes", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    await fs.writeFile(
      paths.metadataFile,
      `${JSON.stringify({
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "old-launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      })}\n`,
    );
    const calls: Array<{ args: string[] }> = [];
    const manager = new TmuxSessionManager(async (_command, args) => {
      calls.push({ args });
      return { stdout: "", stderr: "" };
    });

    await manager.ensureSession({
      paths,
      metadata: {
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "new-launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      },
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {},
      config,
    });

    expect(calls.some((call) => call.args[0] === "kill-session")).toBe(true);
    expect(calls.some((call) => call.args[0] === "new-session")).toBe(true);
  });

  it("truncates stale pane and event logs when creating a fresh session", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    await fs.writeFile(paths.paneLogFile, "Claude Code v0.0.0\nold output");
    await fs.writeFile(
      paths.eventsFile,
      `${JSON.stringify({ event: "SessionStart", timestamp: 1 })}\n`,
    );
    const manager = new TmuxSessionManager(async (_command, args) => {
      if (args[0] === "has-session") {
        throw new Error("missing");
      }
      return { stdout: "", stderr: "" };
    });

    await manager.ensureSession({
      paths,
      metadata: {
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      },
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {},
      config,
    });

    await expect(fs.readFile(paths.paneLogFile, "utf8")).resolves.toBe("");
    await expect(fs.readFile(paths.eventsFile, "utf8")).resolves.toBe("");
  });

  it("reuses a live session when metadata matches and bumps lastUsedAt", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    const metadata = {
      backendId: "claude-cli",
      workspaceDir: rootDir,
      sessionName: "openclaw-claude-test",
      launchHash: "launch-hash",
      model: "sonnet",
      systemPromptHash: "hash",
      memoryMode: "managed-disabled" as const,
      hookMode: "managed" as const,
      createdAt: 1,
      lastUsedAt: 1,
    };
    await fs.writeFile(paths.metadataFile, `${JSON.stringify(metadata)}\n`);
    const calls: string[] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args[0]);
      return { stdout: "", stderr: "" }; // has-session succeeds → exists=true
    });

    const result = await manager.ensureSession({
      paths,
      metadata,
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {},
      config,
    });

    expect(result).toEqual({ created: false });
    expect(calls).toEqual(["has-session"]);
    expect(calls).not.toContain("new-session");
    const persisted = JSON.parse(await fs.readFile(paths.metadataFile, "utf8"));
    expect(persisted.lastUsedAt).toBeGreaterThan(1);
  });

  it("reuses a live session across turns even when only the systemPromptHash changed", async () => {
    // The system prompt is rebuilt every turn (date + rotating context). A
    // persistent tmux Claude REPL must NOT be killed + re-bootstrapped just
    // because the prompt hash differs — follow-up DM turns paste the new
    // user message into the running session instead.
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    const persistedMetadata = {
      backendId: "claude-cli",
      workspaceDir: rootDir,
      sessionName: "openclaw-claude-test",
      launchHash: "launch-hash",
      model: "sonnet",
      systemPromptHash: "turn-1-hash",
      memoryMode: "managed-disabled" as const,
      hookMode: "managed" as const,
      createdAt: 1,
      lastUsedAt: 1,
    };
    await fs.writeFile(paths.metadataFile, `${JSON.stringify(persistedMetadata)}\n`);
    const calls: string[] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args[0]);
      return { stdout: "", stderr: "" };
    });

    const result = await manager.ensureSession({
      paths,
      metadata: { ...persistedMetadata, systemPromptHash: "turn-2-hash" },
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {},
      config,
    });

    expect(result).toEqual({ created: false });
    expect(calls).not.toContain("kill-session");
    expect(calls).not.toContain("new-session");
  });

  it("recreates when the session is live but metadata file is missing", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    const calls: string[] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args[0]);
      return { stdout: "", stderr: "" }; // has-session ok, no metadata file → mismatch
    });

    const result = await manager.ensureSession({
      paths,
      metadata: {
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "h",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      },
      command: "claude",
      args: [],
      cwd: rootDir,
      env: {},
      config,
    });

    expect(result).toEqual({ created: true });
    expect(calls).toContain("kill-session");
    expect(calls).toContain("new-session");
  });

  it("pastes the prompt buffer and sends Enter (tmux 3.2+ uses -p)", async () => {
    const calls: string[][] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args);
      if (args[0] === "-V") {
        return { stdout: "tmux 3.4\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await manager.pastePrompt({
      sessionName: "s",
      bufferName: "buf",
      promptFile: "/tmp/p.txt",
    });
    expect(calls.map((a) => a[0])).toEqual(["load-buffer", "-V", "paste-buffer", "send-keys"]);
    const pasteCall = calls.find((c) => c[0] === "paste-buffer");
    // `-p` forces atomic bracketed-paste so the Claude TUI receives the whole
    // buffer as one paste event (no fragmentation into multiple [Pasted text]
    // placeholders).
    expect(pasteCall).toEqual(["paste-buffer", "-p", "-b", "buf", "-t", "s:0.0"]);
    await manager.sendEnter("s");
    expect(calls.at(-1)).toEqual(["send-keys", "-t", "s:0.0", "Enter"]);
  });

  it("falls back to plain paste-buffer on tmux < 3.2", async () => {
    const calls: string[][] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args);
      if (args[0] === "-V") {
        return { stdout: "tmux 2.8\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await manager.pastePrompt({
      sessionName: "s",
      bufferName: "buf",
      promptFile: "/tmp/p.txt",
    });
    const pasteCall = calls.find((c) => c[0] === "paste-buffer");
    expect(pasteCall).toEqual(["paste-buffer", "-b", "buf", "-t", "s:0.0"]);
    expect(pasteCall).not.toContain("-p");
  });

  it("falls back to plain paste-buffer when tmux -V fails", async () => {
    const manager = new TmuxSessionManager(async (_c, args) => {
      if (args[0] === "-V") {
        throw new Error("tmux not installed");
      }
      return { stdout: "", stderr: "" };
    });
    const calls: string[][] = [];
    const recorder = new TmuxSessionManager(async (_c, args) => {
      calls.push(args);
      if (args[0] === "-V") {
        throw new Error("tmux not installed");
      }
      return { stdout: "", stderr: "" };
    });
    await recorder.pastePrompt({
      sessionName: "s",
      bufferName: "buf",
      promptFile: "/tmp/p.txt",
    });
    expect(manager).toBeDefined();
    const pasteCall = calls.find((c) => c[0] === "paste-buffer");
    expect(pasteCall).toEqual(["paste-buffer", "-b", "buf", "-t", "s:0.0"]);
  });

  it("caches the tmux -V probe across pastePrompt calls", async () => {
    let probeCount = 0;
    const manager = new TmuxSessionManager(async (_c, args) => {
      if (args[0] === "-V") {
        probeCount += 1;
        return { stdout: "tmux 3.4\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await manager.pastePrompt({ sessionName: "s", bufferName: "b1", promptFile: "/tmp/a" });
    await manager.pastePrompt({ sessionName: "s", bufferName: "b2", promptFile: "/tmp/b" });
    await manager.pastePrompt({ sessionName: "s2", bufferName: "b3", promptFile: "/tmp/c" });
    expect(probeCount).toBe(1);
  });

  it("serializes concurrent pastePrompt calls for the same session", async () => {
    // Two concurrent pastePrompt invocations must not interleave their
    // load-buffer / paste-buffer / send-keys triples — otherwise tmux would
    // ship overlapping bracketed-paste sequences to the pty and the Claude
    // TUI would see fragmented / out-of-order pastes.
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const manager = new TmuxSessionManager(async (_c, args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const tag = args.includes("buf-a") ? "a" : args.includes("buf-b") ? "b" : "?";
      order.push(`${args[0]}:${tag}`);
      // Yield to the event loop so a racing caller would have a chance to
      // interleave if the lock weren't holding.
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (args[0] === "-V") {
        return { stdout: "tmux 3.4\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await Promise.all([
      manager.pastePrompt({ sessionName: "s", bufferName: "buf-a", promptFile: "/tmp/a.txt" }),
      manager.pastePrompt({ sessionName: "s", bufferName: "buf-b", promptFile: "/tmp/b.txt" }),
    ]);
    expect(maxInFlight).toBe(1);
    // Filter out the once-per-process `-V` probe; what matters is the paste
    // triple ordering, not the probe call.
    const tagged = order.filter((entry) => !entry.startsWith("-V:"));
    const aIdx = tagged.indexOf("load-buffer:a");
    const bIdx = tagged.indexOf("load-buffer:b");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(tagged.slice(aIdx, aIdx + 3)).toEqual([
      "load-buffer:a",
      "paste-buffer:a",
      "send-keys:?",
    ]);
    expect(tagged.slice(bIdx, bIdx + 3)).toEqual([
      "load-buffer:b",
      "paste-buffer:b",
      "send-keys:?",
    ]);
  });

  it("keeps serializing after a failed pastePrompt without leaking the lock", async () => {
    // Verifies both lock release on rejection AND that a follow-on caller
    // queued behind the failing paste actually waits for the failure before
    // running (not just that the lock is gone post-hoc).
    let firstLoadBufferCall = true;
    let releaseFirstLoad!: (action: "fail" | "ok") => void;
    const firstLoadGate = new Promise<"fail" | "ok">((resolve) => {
      releaseFirstLoad = resolve;
    });
    const calls: string[][] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args);
      if (firstLoadBufferCall && args[0] === "load-buffer") {
        firstLoadBufferCall = false;
        const action = await firstLoadGate;
        if (action === "fail") {
          throw new Error("disk full");
        }
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const first = manager.pastePrompt({
      sessionName: "s",
      bufferName: "buf-a",
      promptFile: "/tmp/a.txt",
    });
    // Let the first invocation reach the suspended load-buffer.
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.map((c) => c[0])).toEqual(["load-buffer"]);
    const second = manager.pastePrompt({
      sessionName: "s",
      bufferName: "buf-b",
      promptFile: "/tmp/b.txt",
    });
    // Second invocation must NOT have started any tmux commands yet; the lock
    // is still held by the in-flight first paste.
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.map((c) => c[0])).toEqual(["load-buffer"]);
    // Release the first load-buffer with a failure.
    releaseFirstLoad("fail");
    await expect(first).rejects.toThrow("disk full");
    // Now the second invocation runs to completion.
    await expect(second).resolves.toBeUndefined();
    const secondLoadIdx = calls.findIndex((c) => c[0] === "load-buffer" && c.includes("buf-b"));
    expect(secondLoadIdx).toBeGreaterThan(0);
  });

  it("captures pane tail and swallows capture failures", async () => {
    let mode: "ok" | "fail" = "ok";
    const manager = new TmuxSessionManager(async (_c, args) => {
      if (args[0] === "capture-pane" && mode === "fail") {
        throw new Error("no pane");
      }
      return { stdout: "PANE TAIL", stderr: "" };
    });
    await expect(manager.captureTail("s", 10)).resolves.toBe("PANE TAIL");
    mode = "fail";
    await expect(manager.captureTail("s", 10)).resolves.toBe("");
  });

  it("interrupts with C-c and falls back to kill-session on failure", async () => {
    const calls: string[] = [];
    const okManager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args[0]);
      return { stdout: "", stderr: "" };
    });
    await okManager.interrupt("s");
    expect(calls).toEqual(["send-keys"]);

    const killCalls: string[] = [];
    const failManager = new TmuxSessionManager(async (_c, args) => {
      killCalls.push(args[0]);
      if (args[0] === "send-keys") {
        throw new Error("send failed");
      }
      return { stdout: "", stderr: "" };
    });
    await failManager.interrupt("s");
    expect(killCalls).toEqual(["send-keys", "kill-session"]);
  });

  it("hasSession reflects the underlying tmux exit", async () => {
    const present = new TmuxSessionManager(async () => ({ stdout: "", stderr: "" }));
    await expect(present.hasSession("s")).resolves.toBe(true);
    const absent = new TmuxSessionManager(async () => {
      throw new Error("no session");
    });
    await expect(absent.hasSession("s")).resolves.toBe(false);
  });

  it("isPaneAlive: alive only when pane not dead and has a live pid", async () => {
    const alive = new TmuxSessionManager(async () => ({ stdout: "0 12345\n", stderr: "" }));
    await expect(alive.isPaneAlive("s")).resolves.toBe(true);
    const dead = new TmuxSessionManager(async () => ({ stdout: "1 12345\n", stderr: "" }));
    await expect(dead.isPaneAlive("s")).resolves.toBe(false);
    const noPid = new TmuxSessionManager(async () => ({ stdout: "0 0\n", stderr: "" }));
    await expect(noPid.isPaneAlive("s")).resolves.toBe(false);
    const empty = new TmuxSessionManager(async () => ({ stdout: "", stderr: "" }));
    await expect(empty.isPaneAlive("s")).resolves.toBe(false);
    const missing = new TmuxSessionManager(async () => {
      throw new Error("no pane");
    });
    await expect(missing.isPaneAlive("s")).resolves.toBe(false);
  });

  it("recreates when launchMode flips fresh<->resume but reuses when it matches", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    const base = {
      backendId: "claude-cli",
      workspaceDir: rootDir,
      sessionName: "openclaw-claude-test",
      launchHash: "launch-hash",
      model: "sonnet",
      systemPromptHash: "hash",
      memoryMode: "managed-disabled" as const,
      hookMode: "managed" as const,
      launchMode: "fresh" as const,
      claudeSessionId: "claude-aaa",
      createdAt: 1,
      lastUsedAt: 1,
    };
    await fs.writeFile(paths.metadataFile, `${JSON.stringify(base)}\n`);
    const calls: string[] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args[0]);
      return { stdout: "", stderr: "" };
    });
    // launchMode changes fresh -> resume: must recreate.
    const recreate = await manager.ensureSession({
      paths,
      metadata: { ...base, launchMode: "resume", claudeSessionId: "claude-bbb" },
      command: "claude",
      args: [],
      cwd: rootDir,
      env: {},
      config,
    });
    expect(recreate.created).toBe(true);
    expect(calls).toContain("kill-session");
  });

  it("reuse ignores claudeSessionId differences and returns the persisted id", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    const persisted = {
      backendId: "claude-cli",
      workspaceDir: rootDir,
      sessionName: "openclaw-claude-test",
      launchHash: "launch-hash",
      model: "sonnet",
      systemPromptHash: "turn-1",
      memoryMode: "managed-disabled" as const,
      hookMode: "managed" as const,
      launchMode: "fresh" as const,
      claudeSessionId: "claude-persisted",
      createdAt: 1,
      lastUsedAt: 1,
    };
    await fs.writeFile(paths.metadataFile, `${JSON.stringify(persisted)}\n`);
    const calls: string[] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      calls.push(args[0]);
      return { stdout: "", stderr: "" };
    });
    // Same identity, only volatile fields differ → reuse, no kill.
    const result = await manager.ensureSession({
      paths,
      metadata: { ...persisted, systemPromptHash: "turn-2", claudeSessionId: undefined },
      command: "claude",
      args: [],
      cwd: rootDir,
      env: {},
      config,
    });
    expect(result.created).toBe(false);
    expect(result.persistedClaudeSessionId).toBe("claude-persisted");
    expect(calls).not.toContain("kill-session");
  });

  it("reapStaleSessions kills idle sibling REPLs and removes their dirs", async () => {
    const rootBase = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-reap-test-"));
    tempDirs.push(rootBase);
    const now = 10_000_000;
    const ttlMs = 60_000;
    // fresh: lastUsedAt within TTL → keep
    const freshDir = path.join(rootBase, "openclaw-claude-fresh");
    // stale: lastUsedAt past TTL → reap
    const staleDir = path.join(rootBase, "openclaw-claude-stale");
    // current: matches `except` → skip even if stale
    const currentDir = path.join(rootBase, "openclaw-claude-current");
    for (const [dir, lastUsedAt, sessionName] of [
      [freshDir, now - 1_000, "openclaw-claude-fresh"],
      [staleDir, now - ttlMs - 5_000, "openclaw-claude-stale"],
      [currentDir, now - ttlMs - 999_999, "openclaw-claude-current"],
    ] as const) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "metadata.json"),
        `${JSON.stringify({ sessionName, lastUsedAt })}\n`,
      );
    }
    const killed: string[] = [];
    const manager = new TmuxSessionManager(async (_c, args) => {
      if (args[0] === "kill-session") {
        killed.push(args[2] ?? "");
      }
      return { stdout: "", stderr: "" };
    });
    const onDiagnostic = vi.fn();
    const result = await manager.reapStaleSessions({
      rootBase,
      ttlMs,
      now,
      except: "openclaw-claude-current",
      onDiagnostic,
    });
    expect(result.reaped).toEqual(["openclaw-claude-stale"]);
    expect(killed).toEqual(["openclaw-claude-stale"]);
    // Fresh and current dirs survived.
    await expect(fs.access(freshDir)).resolves.toBeUndefined();
    await expect(fs.access(currentDir)).resolves.toBeUndefined();
    // Stale dir was removed.
    await expect(fs.access(staleDir)).rejects.toThrow();
    expect(onDiagnostic).toHaveBeenCalledWith(
      "tmux.reap.killed",
      expect.objectContaining({ sessionName: "openclaw-claude-stale" }),
    );
  });

  it("reapStaleSessions disabled when ttlMs <= 0", async () => {
    const rootBase = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-reap-test-"));
    tempDirs.push(rootBase);
    const dir = path.join(rootBase, "openclaw-claude-x");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(dir, "metadata.json"),
      `${JSON.stringify({ sessionName: "openclaw-claude-x", lastUsedAt: 0 })}\n`,
    );
    const manager = new TmuxSessionManager(async () => ({ stdout: "", stderr: "" }));
    const result = await manager.reapStaleSessions({ rootBase, ttlMs: 0, now: 1e12 });
    expect(result.reaped).toEqual([]);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("defaultTmuxCommandRunner executes a real process and returns stdout", async () => {
    const result = await defaultTmuxCommandRunner("node", [
      "-e",
      "process.stdout.write('hi'); process.stderr.write('warn')",
    ]);
    expect(result.stdout).toBe("hi");
    expect(result.stderr).toBe("warn");
  });
});
