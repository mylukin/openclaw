import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTmuxCliRun } from "./execute.js";
import type { TmuxExecutionInput, TmuxRuntimePaths } from "./types.js";

class FakeTmuxManager {
  paths?: TmuxRuntimePaths;
  sessionNames: string[] = [];

  async ensureSession(params: { paths: TmuxRuntimePaths; metadata: { sessionName: string } }) {
    this.paths = params.paths;
    this.sessionNames.push(params.metadata.sessionName);
    await fs.writeFile(params.paths.paneLogFile, "Claude Code v2.1.140\nprevious turn text");
    await fs.writeFile(params.paths.eventsFile, "");
  }

  async pastePrompt(params: { promptFile: string }) {
    if (!this.paths) {
      throw new Error("missing paths");
    }
    const promptEcho = await fs.readFile(params.promptFile, "utf8");
    await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}Hello from Claude`);
    await fs.appendFile(
      this.paths.eventsFile,
      `${JSON.stringify({
        event: "UserPromptSubmit",
        runId: "run-1",
        claudeSessionId: "claude-session",
        timestamp: Date.now(),
        stdin: { session_id: "claude-session" },
      })}\n`,
    );
    await fs.appendFile(
      this.paths.eventsFile,
      `${JSON.stringify({
        event: "Stop",
        runId: "run-1",
        claudeSessionId: "claude-session",
        timestamp: Date.now(),
        stdin: { session_id: "claude-session" },
      })}\n`,
    );
  }

  async captureTail() {
    return "tail";
  }

  async interrupt() {}
}

describe("executeTmuxCliRun", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("streams pane output and completes on current-run Stop hook", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const onAssistantTurn = vi.fn();

    const output = await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p", "--bare", "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "hello",
        timeoutMs: 5_000,
        env: {},
        onAssistantTurn,
      },
      new FakeTmuxManager() as never,
    );

    expect(output).toEqual({ text: "Hello from Claude", sessionId: "claude-session" });
    expect(onAssistantTurn).toHaveBeenCalledWith("Hello from Claude");
    expect(onAssistantTurn).not.toHaveBeenCalledWith(expect.stringContaining("previous turn text"));
    expect(onAssistantTurn).not.toHaveBeenCalledWith(expect.stringContaining("hello"));
  });

  it("fans hook events out to tool/system callbacks", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class HookManager extends FakeTmuxManager {
      async pastePrompt(params: { promptFile: string }) {
        if (!this.paths) {
          throw new Error("missing paths");
        }
        const promptEcho = await fs.readFile(params.promptFile, "utf8");
        await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}Done`);
        const now = Date.now();
        const lines = [
          { event: "SessionStart", claudeSessionId: "cs-9", stdin: { session_id: "cs-9" } },
          {
            event: "PreToolUse",
            stdin: { tool_name: "Read", tool_use_id: "tu-1", tool_input: { file: "a.ts" } },
          },
          {
            event: "PostToolUse",
            stdin: { tool_use_id: "tu-1", tool_response: { ok: true } },
          },
          {
            event: "PostToolUseFailure",
            stdin: { tool_use_id: "tu-2", tool_response: "boom" },
          },
          { event: "Stop", stdin: { session_id: "cs-9" } },
        ];
        for (const line of lines) {
          await fs.appendFile(
            this.paths.eventsFile,
            `${JSON.stringify({ runId: "run-1", timestamp: now, ...line })}\n`,
          );
        }
      }
    }

    const onSystemInit = vi.fn();
    const onToolUseEvent = vi.fn();
    const onToolResult = vi.fn();

    const output = await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "go",
        timeoutMs: 5_000,
        env: {},
        onSystemInit,
        onToolUseEvent,
        onToolResult,
      },
      new HookManager() as never,
    );

    expect(output.text).toBe("Done");
    expect(onSystemInit).toHaveBeenCalledWith({ subtype: "init", sessionId: "cs-9" });
    expect(onToolUseEvent).toHaveBeenCalledWith({
      name: "Read",
      toolUseId: "tu-1",
      input: { file: "a.ts" },
    });
    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "tu-1",
      text: JSON.stringify({ ok: true }),
      isError: false,
    });
    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "tu-2",
      text: "boom",
      isError: true,
    });
  });

  it("ignores hook events from other runs", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class StaleManager extends FakeTmuxManager {
      async pastePrompt(params: { promptFile: string }) {
        if (!this.paths) {
          throw new Error("missing paths");
        }
        const promptEcho = await fs.readFile(params.promptFile, "utf8");
        await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}Answer`);
        const now = Date.now();
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({ event: "PreToolUse", runId: "run-OTHER", timestamp: now, stdin: { tool_name: "Bash" } })}\n`,
        );
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: now, stdin: { session_id: "cs" } })}\n`,
        );
      }
    }

    const onToolUseEvent = vi.fn();
    await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "go",
        timeoutMs: 5_000,
        env: {},
        onToolUseEvent,
      },
      new StaleManager() as never,
    );

    expect(onToolUseEvent).not.toHaveBeenCalled();
  });

  it("completes via terminal-idle fallback when hooks are off", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class NoHookManager extends FakeTmuxManager {
      async pastePrompt(params: { promptFile: string }) {
        if (!this.paths) {
          throw new Error("missing paths");
        }
        const promptEcho = await fs.readFile(params.promptFile, "utf8");
        await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}Idle answer`);
        // no events written: relies on idle fallback to finish the turn
      }
    }

    const output = await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir, hookMode: "off", turnIdleMs: 50 } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "go",
        timeoutMs: 5_000,
        env: {},
      },
      new NoHookManager() as never,
    );

    expect(output.text).toBe("Idle answer");
  });

  it("falls back to hook-stall completion when Stop never fires", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class NoStopManager extends FakeTmuxManager {
      async pastePrompt(params: { promptFile: string }) {
        if (!this.paths) {
          throw new Error("missing paths");
        }
        const promptEcho = await fs.readFile(params.promptFile, "utf8");
        await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}Partial answer`);
        const now = Date.now();
        // Hooks fire (so sawCurrentRunHook=true) but the Stop hook never arrives.
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({ event: "SessionStart", runId: "run-1", timestamp: now, claudeSessionId: "cs", stdin: { session_id: "cs" } })}\n`,
        );
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({ event: "PreToolUse", runId: "run-1", timestamp: now, stdin: { tool_name: "Read" } })}\n`,
        );
      }
    }

    const start = Date.now();
    const output = await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p"],
          modelArg: "--model",
          execution: {
            mode: "tmux",
            tmux: { runtimeDir, turnIdleMs: 50, hookStallMs: 300 },
          },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "go",
        timeoutMs: 10_000,
        env: {},
      },
      new NoStopManager() as never,
    );

    expect(output.text).toBe("Partial answer");
    // Completed via hookStallMs (~300ms), well before the 10s deadline.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("rejects bare memory mode", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    await expect(
      executeTmuxCliRun(
        {
          backend: {
            command: "claude",
            args: ["-p", "--bare"],
            modelArg: "--model",
            execution: { mode: "tmux", tmux: { runtimeDir, memoryMode: "bare" } },
          },
          backendId: "claude-cli",
          workspaceDir: runtimeDir,
          sessionId: "openclaw-session",
          runId: "run-1",
          modelId: "sonnet",
          systemPrompt: "system",
          prompt: "go",
          timeoutMs: 5_000,
          env: {},
        },
        new FakeTmuxManager() as never,
      ),
    ).rejects.toThrow(/does not support --bare/);
  });

  it("aborts when the abort signal is already triggered", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const controller = new AbortController();
    controller.abort();
    const interrupt = vi.fn();

    class AbortManager extends FakeTmuxManager {
      async interrupt() {
        interrupt();
      }
    }

    await expect(
      executeTmuxCliRun(
        {
          backend: {
            command: "claude",
            args: ["-p"],
            modelArg: "--model",
            execution: { mode: "tmux", tmux: { runtimeDir } },
          },
          backendId: "claude-cli",
          workspaceDir: runtimeDir,
          sessionId: "openclaw-session",
          runId: "run-1",
          modelId: "sonnet",
          systemPrompt: "system",
          prompt: "go",
          timeoutMs: 5_000,
          env: {},
          abortSignal: controller.signal,
        },
        new AbortManager() as never,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(interrupt).toHaveBeenCalled();
  });

  function baseInput(
    runtimeDir: string,
    extra: Partial<TmuxExecutionInput> = {},
    tmux: Record<string, unknown> = {},
  ): TmuxExecutionInput {
    return {
      backend: {
        command: "claude",
        args: ["-p"],
        modelArg: "--model",
        execution: { mode: "tmux", tmux: { runtimeDir, ...tmux } },
      },
      backendId: "claude-cli",
      workspaceDir: runtimeDir,
      sessionId: "openclaw-session",
      runId: "run-1",
      modelId: "sonnet",
      systemPrompt: "system",
      prompt: "go",
      timeoutMs: 5_000,
      env: {},
      ...extra,
    };
  }

  it("becomes ready via a SessionStart hook event when no banner is printed", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class EventReadyManager {
      paths?: TmuxRuntimePaths;
      async ensureSession(p: { paths: TmuxRuntimePaths; metadata: { sessionName: string } }) {
        this.paths = p.paths;
        // No "Claude Code vX.Y.Z" banner: readiness must come from the hook event.
        await fs.writeFile(p.paths.paneLogFile, "booting...\n");
        await fs.writeFile(
          p.paths.eventsFile,
          `${JSON.stringify({ event: "SessionStart", timestamp: Date.now() + 5, stdin: {} })}\n`,
        );
      }
      async pastePrompt(p: { promptFile: string }) {
        const echo = await fs.readFile(p.promptFile, "utf8");
        await fs.appendFile(this.paths!.paneLogFile, `> ${echo}Ready answer`);
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
      async captureTail() {
        return "";
      }
      async interrupt() {}
    }

    const output = await executeTmuxCliRun(baseInput(runtimeDir), new EventReadyManager() as never);
    expect(output.text).toBe("Ready answer");
  });

  it("confirms the workspace trust prompt during startup", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class TrustManager {
      paths?: TmuxRuntimePaths;
      enterCount = 0;
      async ensureSession(p: { paths: TmuxRuntimePaths; metadata: { sessionName: string } }) {
        this.paths = p.paths;
        await fs.writeFile(
          p.paths.paneLogFile,
          "Quick safety check\nYes, I trust this folder\nEnter to confirm\n",
        );
        await fs.writeFile(p.paths.eventsFile, "");
      }
      async sendEnter() {
        this.enterCount += 1;
        // Trust confirmed → Claude prints its ready banner.
        await fs.appendFile(this.paths!.paneLogFile, "\nClaude Code v2.1.140\n");
      }
      async pastePrompt(p: { promptFile: string }) {
        const echo = await fs.readFile(p.promptFile, "utf8");
        await fs.appendFile(this.paths!.paneLogFile, `> ${echo}Trusted answer`);
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
      async captureTail() {
        return "";
      }
      async interrupt() {}
    }

    const manager = new TrustManager();
    const output = await executeTmuxCliRun(baseInput(runtimeDir), manager as never);
    expect(manager.enterCount).toBeGreaterThanOrEqual(1);
    expect(output.text).toBe("Trusted answer");
  });

  it("raises a failover error when startup never becomes ready", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class NeverReadyManager {
      async ensureSession(p: { paths: TmuxRuntimePaths }) {
        await fs.writeFile(p.paths.paneLogFile, "still booting, no banner\n");
        await fs.writeFile(p.paths.eventsFile, "");
      }
      async pastePrompt() {}
      async captureTail() {
        return "pane diagnostic tail";
      }
      async interrupt() {}
    }

    await expect(
      executeTmuxCliRun(
        baseInput(runtimeDir, {}, { startupTimeoutMs: 150 }),
        new NeverReadyManager() as never,
      ),
    ).rejects.toThrow(/did not become ready/);
  });

  it("raises a failover error when the turn exceeds the deadline", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class SlowManager extends FakeTmuxManager {
      async pastePrompt(p: { promptFile: string }) {
        const echo = await fs.readFile(p.promptFile, "utf8");
        // Produces output but never a Stop event; deadline must fire.
        await fs.appendFile(this.paths!.paneLogFile, `> ${echo}working...`);
      }
    }

    await expect(
      executeTmuxCliRun(
        baseInput(runtimeDir, { timeoutMs: 120 }, { turnIdleMs: 60_000, hookStallMs: 60_000 }),
        new SlowManager() as never,
      ),
    ).rejects.toThrow(/exceeded timeout/);
  });

  it("interrupts and aborts when the signal trips mid-run", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const controller = new AbortController();
    const interrupt = vi.fn();

    class MidRunAbortManager extends FakeTmuxManager {
      async pastePrompt(p: { promptFile: string }) {
        const echo = await fs.readFile(p.promptFile, "utf8");
        await fs.appendFile(this.paths!.paneLogFile, `> ${echo}partial`);
        // No Stop event; trip the abort so the loop exits via abort handling.
        controller.abort();
      }
      async interrupt() {
        interrupt();
      }
    }

    await expect(
      executeTmuxCliRun(
        baseInput(runtimeDir, { abortSignal: controller.signal }, { turnIdleMs: 60_000 }),
        new MidRunAbortManager() as never,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(interrupt).toHaveBeenCalled();
  });

  it("strips a prompt echo embedded mid-pane", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class MidEchoManager extends FakeTmuxManager {
      async pastePrompt(p: { promptFile: string }) {
        const echo = await fs.readFile(p.promptFile, "utf8");
        // Prompt echo appears after a banner line and before the answer.
        await fs.appendFile(this.paths!.paneLogFile, `assistant prelude\n> ${echo}Final reply`);
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
    }

    const output = await executeTmuxCliRun(
      baseInput(runtimeDir, { prompt: "explain caching" }),
      new MidEchoManager() as never,
    );
    expect(output.text).not.toContain("explain caching");
    expect(output.text).toContain("Final reply");
  });

  it("strips a prompt echo that prefixes the pane with no leading marker", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class PrefixEchoManager extends FakeTmuxManager {
      async pastePrompt(p: { promptFile: string }) {
        const echo = await fs.readFile(p.promptFile, "utf8");
        // Pane starts exactly with the echoed prompt (no "> " marker).
        await fs.appendFile(this.paths!.paneLogFile, `${echo}Stripped answer`);
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
    }

    const output = await executeTmuxCliRun(
      baseInput(runtimeDir, { prompt: "ping" }),
      new PrefixEchoManager() as never,
    );
    expect(output.text).toBe("Stripped answer");
    expect(output.text).not.toContain("ping");
  });

  it("keeps the tmux session name stable when Claude reports a session id", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const manager = new FakeTmuxManager();
    const baseInput: Omit<TmuxExecutionInput, "runId" | "prompt" | "cliSessionId"> = {
      backend: {
        command: "claude",
        args: ["-p", "--bare"],
        modelArg: "--model",
        sessionArg: "--session-id",
        execution: { mode: "tmux", tmux: { runtimeDir } },
      },
      backendId: "claude-cli",
      workspaceDir: runtimeDir,
      sessionId: "openclaw-session",
      modelId: "sonnet",
      systemPrompt: "system",
      timeoutMs: 5_000,
      env: {},
    };

    await executeTmuxCliRun(
      { ...baseInput, runId: "run-1", prompt: "hello", cliSessionId: "openclaw-cli-uuid" },
      manager as never,
    );
    await executeTmuxCliRun(
      { ...baseInput, runId: "run-2", prompt: "again", cliSessionId: "claude-session" },
      manager as never,
    );

    expect(manager.sessionNames).toHaveLength(2);
    expect(manager.sessionNames[0]).toBe(manager.sessionNames[1]);
  });
});
