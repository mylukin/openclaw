import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import { executeTmuxCliRun, linkUserClaudeAssets } from "./execute.js";
import { resolveTmuxRuntimePaths } from "./runtime-dir.js";
import { buildTmuxSessionName } from "./session-name.js";
import type { TmuxExecutionInput, TmuxRuntimePaths } from "./types.js";

class FakeTmuxManager {
  paths?: TmuxRuntimePaths;
  sessionNames: string[] = [];

  async ensureSession(params: {
    paths: TmuxRuntimePaths;
    metadata: { sessionName: string };
  }): Promise<{ created: boolean }> {
    this.paths = params.paths;
    this.sessionNames.push(params.metadata.sessionName);
    await fs.writeFile(params.paths.paneLogFile, "Claude Code v2.1.140\nprevious turn text");
    await fs.writeFile(params.paths.eventsFile, "");
    return { created: true };
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

  async hasSession(): Promise<boolean> {
    return true;
  }

  async isPaneAlive(): Promise<boolean> {
    return true;
  }

  async killSession(): Promise<void> {}

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
        sessionFile: path.join(runtimeDir, "session.jsonl"),
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

  it("drives tool callbacks from the JSONL transcript in canonical order", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-config-"));
    tempDirs.push(configDir);
    const sessionId = "cs-9";
    const slug = runtimeDir.replaceAll(/[/\\]/g, "-");
    const transcriptDir = path.join(configDir, "projects", slug);
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);

    class HookManager extends FakeTmuxManager {
      async pastePrompt(params: { promptFile: string }) {
        if (!this.paths) {
          throw new Error("missing paths");
        }
        const promptEcho = await fs.readFile(params.promptFile, "utf8");
        await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}Done`);
        const now = Date.now();
        // SessionStart hook gives us the Claude session id so the runner can
        // locate the JSONL transcript.
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({
            runId: "run-1",
            timestamp: now,
            event: "SessionStart",
            claudeSessionId: sessionId,
            stdin: { session_id: sessionId },
          })}\n`,
        );
        // Tool events are emitted by the transcript in canonical order
        // (assistant tool_use blocks, then user tool_result blocks).
        await fs.writeFile(
          transcriptFile,
          `${JSON.stringify({
            type: "assistant",
            uuid: "a-1",
            timestamp: new Date(now + 1).toISOString(),
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Done" },
                { type: "tool_use", id: "tu-1", name: "Read", input: { file: "a.ts" } },
                { type: "tool_use", id: "tu-2", name: "Read", input: { file: "b.ts" } },
              ],
            },
          })}\n`,
        );
        await fs.appendFile(
          transcriptFile,
          `${JSON.stringify({
            type: "user",
            uuid: "u-1",
            timestamp: new Date(now + 2).toISOString(),
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-1", content: { ok: true } },
                { type: "tool_result", tool_use_id: "tu-2", content: "boom", is_error: true },
              ],
            },
          })}\n`,
        );
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({
            runId: "run-1",
            timestamp: now + 3,
            event: "Stop",
            stdin: { session_id: sessionId },
          })}\n`,
        );
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
          execution: { mode: "tmux", tmux: { runtimeDir, authMode: "user-claude" } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionFile: path.join(runtimeDir, "session.jsonl"),
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "go",
        timeoutMs: 5_000,
        env: { CLAUDE_CONFIG_DIR: configDir },
        onSystemInit,
        onToolUseEvent,
        onToolResult,
      },
      new HookManager() as never,
    );

    expect(output.text).toBe("Done");
    expect(onSystemInit).toHaveBeenCalledWith({ subtype: "init", sessionId });
    expect(onToolUseEvent).toHaveBeenCalledWith({
      name: "Read",
      toolUseId: "tu-1",
      input: { file: "a.ts" },
    });
    expect(onToolUseEvent).toHaveBeenCalledWith({
      name: "Read",
      toolUseId: "tu-2",
      input: { file: "b.ts" },
    });
    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "tu-1",
      text: JSON.stringify({ ok: true }),
    });
    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "tu-2",
      text: "boom",
      isError: true,
    });
  });

  it("anchors transcript tool segments after the preceding text (no race with hook events)", async () => {
    // Regression for the inline-tool ordering race: when hook PostToolUse
    // fires in the same poll iteration as a fresh assistant text block, the
    // transcript poll runs first and the resulting callbacks fire in
    // text-then-tool order so downstream inline rendering anchors the tool
    // stats at end-of-text, not end-of-previous-turn.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-config-"));
    tempDirs.push(configDir);
    const sessionId = "cs-race";
    const slug = runtimeDir.replaceAll(/[/\\]/g, "-");
    const transcriptDir = path.join(configDir, "projects", slug);
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);

    class RaceManager extends FakeTmuxManager {
      async pastePrompt(params: { promptFile: string }) {
        if (!this.paths) {
          throw new Error("missing paths");
        }
        const promptEcho = await fs.readFile(params.promptFile, "utf8");
        await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}`);
        const now = Date.now();
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({
            runId: "run-1",
            timestamp: now,
            event: "SessionStart",
            claudeSessionId: sessionId,
            stdin: { session_id: sessionId },
          })}\n`,
        );
        await fs.writeFile(
          transcriptFile,
          `${JSON.stringify({
            type: "assistant",
            uuid: "a-1",
            timestamp: new Date(now + 1).toISOString(),
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Now reading workspace." },
                { type: "tool_use", id: "tu-1", name: "Read" },
                { type: "tool_use", id: "tu-2", name: "Read" },
              ],
            },
          })}\n` +
            `${JSON.stringify({
              type: "user",
              uuid: "u-1",
              timestamp: new Date(now + 2).toISOString(),
              message: {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "tu-1", content: "" },
                  { type: "tool_result", tool_use_id: "tu-2", content: "" },
                ],
              },
            })}\n` +
            `${JSON.stringify({
              type: "assistant",
              uuid: "a-2",
              timestamp: new Date(now + 3).toISOString(),
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Finished." }],
              },
            })}\n`,
        );
        // Hooks deliberately fire AFTER the transcript already has the full
        // turn — the bug we're guarding against would dispatch tool events
        // before the second text segment lands.
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({
            runId: "run-1",
            timestamp: now + 4,
            event: "PostToolUse",
            stdin: { tool_use_id: "tu-1", tool_response: "" },
          })}\n${JSON.stringify({
            runId: "run-1",
            timestamp: now + 5,
            event: "PostToolUse",
            stdin: { tool_use_id: "tu-2", tool_response: "" },
          })}\n${JSON.stringify({
            runId: "run-1",
            timestamp: now + 6,
            event: "Stop",
            stdin: { session_id: sessionId },
          })}\n`,
        );
      }
    }

    const events: string[] = [];
    await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir, authMode: "user-claude" } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionFile: path.join(runtimeDir, "session.jsonl"),
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "go",
        timeoutMs: 5_000,
        env: { CLAUDE_CONFIG_DIR: configDir },
        onAssistantTurn: (text) => {
          events.push(`text:${text}`);
        },
        onToolUseEvent: (payload) => {
          events.push(`use:${payload.toolUseId ?? payload.name}`);
        },
        onToolResult: (payload) => {
          events.push(`result:${payload.toolUseId ?? "?"}`);
        },
      },
      new RaceManager() as never,
    );

    expect(events).toEqual([
      "text:Now reading workspace.",
      "use:tu-1",
      "use:tu-2",
      "result:tu-1",
      "result:tu-2",
      "text:Finished.",
    ]);
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
        sessionFile: path.join(runtimeDir, "session.jsonl"),
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
        sessionFile: path.join(runtimeDir, "session.jsonl"),
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
        sessionFile: path.join(runtimeDir, "session.jsonl"),
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
          sessionFile: path.join(runtimeDir, "session.jsonl"),
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
          sessionFile: path.join(runtimeDir, "session.jsonl"),
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
      sessionFile: path.join(runtimeDir, "session.jsonl"),
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
      async hasSession() {
        return true;
      }
      async isPaneAlive() {
        return true;
      }
      async killSession() {}
      async interrupt() {}
    }

    const output = await executeTmuxCliRun(baseInput(runtimeDir), new EventReadyManager() as never);
    expect(output.text).toBe("Ready answer");
  });

  it("propagates sessionId from a SessionStart hook seen during startup", async () => {
    // Regression: in fresh sessions the SessionStart hook fires during
    // waitForStartup and the event is consumed before the main loop's event
    // reader starts (initialEventOffset is captured after startup). The
    // discovered claudeSessionId must still be carried into the main loop so
    // the JSONL transcript tailer is instantiated before any tool events.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-config-"));
    tempDirs.push(configDir);
    const sessionId = "cs-startup-discovery";
    const slug = runtimeDir.replaceAll(/[/\\]/g, "-");
    const transcriptDir = path.join(configDir, "projects", slug);
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);

    class StartupSessionManager {
      paths?: TmuxRuntimePaths;
      async ensureSession(p: { paths: TmuxRuntimePaths; metadata: { sessionName: string } }) {
        this.paths = p.paths;
        await fs.writeFile(p.paths.paneLogFile, "Claude Code v2.1.140\n");
        // SessionStart event lands BEFORE the main loop opens its event
        // window — this is the fresh-session path the bug fix targets.
        await fs.writeFile(
          p.paths.eventsFile,
          `${JSON.stringify({
            event: "SessionStart",
            timestamp: Date.now() - 100,
            claudeSessionId: sessionId,
            stdin: { session_id: sessionId },
          })}\n`,
        );
      }
      async pastePrompt(p: { promptFile: string }) {
        const echo = await fs.readFile(p.promptFile, "utf8");
        await fs.appendFile(this.paths!.paneLogFile, `> ${echo}`);
        const now = Date.now();
        // The assistant immediately uses a tool, then replies. Tool events
        // come only from the JSONL transcript — if the bug fix regresses,
        // the runner would fall back to hook-driven tool events and break
        // ordering / naming.
        await fs.writeFile(
          transcriptFile,
          `${JSON.stringify({
            type: "assistant",
            uuid: "a-1",
            timestamp: new Date(now + 1).toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "tu-1", name: "Read" }],
            },
          })}\n${JSON.stringify({
            type: "user",
            uuid: "u-1",
            timestamp: new Date(now + 2).toISOString(),
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "tu-1", content: "" }],
            },
          })}\n${JSON.stringify({
            type: "assistant",
            uuid: "a-2",
            timestamp: new Date(now + 3).toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Ready answer" }],
            },
          })}\n`,
        );
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({
            event: "Stop",
            runId: "run-1",
            timestamp: now + 4,
            claudeSessionId: sessionId,
            stdin: { session_id: sessionId },
          })}\n`,
        );
      }
      async captureTail() {
        return "";
      }
      async hasSession() {
        return true;
      }
      async isPaneAlive() {
        return true;
      }
      async killSession() {}
      async interrupt() {}
    }

    const onToolUseEvent = vi.fn();
    const onToolResult = vi.fn();
    const output = await executeTmuxCliRun(
      {
        ...baseInput(runtimeDir, {
          env: { CLAUDE_CONFIG_DIR: configDir },
          onToolUseEvent,
          onToolResult,
        }),
        backend: {
          command: "claude",
          args: ["-p"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir, authMode: "user-claude" } },
        },
      },
      new StartupSessionManager() as never,
    );

    expect(output.text).toBe("Ready answer");
    expect(output.sessionId).toBe(sessionId);
    expect(onToolUseEvent).toHaveBeenCalledWith({ name: "Read", toolUseId: "tu-1" });
    expect(onToolResult).toHaveBeenCalledWith({ toolUseId: "tu-1", text: "" });
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
      async hasSession() {
        return true;
      }
      async isPaneAlive() {
        return true;
      }
      async killSession() {}
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
      async hasSession() {
        return true;
      }
      async isPaneAlive() {
        return true;
      }
      async killSession() {}
      async interrupt() {}
    }

    await expect(
      executeTmuxCliRun(
        baseInput(runtimeDir, {}, { startupTimeoutMs: 150 }),
        new NeverReadyManager() as never,
      ),
    ).rejects.toThrow(/did not become ready/);
  });

  it("raises session_expired failover immediately when pane reports session-id conflict", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);

    class SessionIdConflictManager {
      async ensureSession(p: { paths: TmuxRuntimePaths }) {
        await fs.writeFile(
          p.paths.paneLogFile,
          "Error: Session ID abc123-dead-beef-0000 is already in use.\n",
        );
        await fs.writeFile(p.paths.eventsFile, "");
      }
      async pastePrompt() {}
      async captureTail() {
        return "";
      }
      async hasSession() {
        return true;
      }
      async isPaneAlive() {
        return true;
      }
      async killSession() {}
      async interrupt() {}
    }

    const err = await executeTmuxCliRun(
      // Use a generous startupTimeoutMs to prove we don't wait it out
      baseInput(runtimeDir, {}, { startupTimeoutMs: 10_000 }),
      new SessionIdConflictManager() as never,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FailoverError);
    expect((err as FailoverError).reason).toBe("session_expired");
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

  it("streams clean text from the Claude session JSONL transcript when available", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-config-"));
    tempDirs.push(configDir);
    const sessionId = "cs-transcript";
    const slug = runtimeDir.replaceAll(/[/\\]/g, "-");
    const transcriptDir = path.join(configDir, "projects", slug);
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);

    class TranscriptManager extends FakeTmuxManager {
      async pastePrompt(params: { promptFile: string }) {
        if (!this.paths) {
          throw new Error("missing paths");
        }
        const promptEcho = await fs.readFile(params.promptFile, "utf8");
        await fs.appendFile(
          this.paths.paneLogFile,
          `╭────────╮\n│ Thinking… │\n╰────────╯\n> ${promptEcho}╭─ Assistant ─╮\n│ noisy TUI text │\n╰──────────────╯\n`,
        );
        const now = Date.now();
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({
            event: "SessionStart",
            runId: "run-1",
            timestamp: now,
            claudeSessionId: sessionId,
            stdin: { session_id: sessionId },
          })}\n`,
        );
        await fs.writeFile(
          transcriptFile,
          `${JSON.stringify({
            type: "assistant",
            uuid: "msg-1",
            timestamp: new Date(now + 5).toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Clean transcript answer" }],
            },
          })}\n`,
        );
        await fs.appendFile(
          this.paths.eventsFile,
          `${JSON.stringify({
            event: "Stop",
            runId: "run-1",
            timestamp: now + 10,
            claudeSessionId: sessionId,
            stdin: { session_id: sessionId },
          })}\n`,
        );
      }
    }

    const onAssistantTurn = vi.fn();
    const output = await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir, authMode: "user-claude" } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        sessionFile: path.join(runtimeDir, "session.jsonl"),
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "go",
        timeoutMs: 5_000,
        env: { CLAUDE_CONFIG_DIR: configDir },
        onAssistantTurn,
      },
      new TranscriptManager() as never,
    );

    expect(output.text).toBe("Clean transcript answer");
    expect(onAssistantTurn).toHaveBeenCalledWith("Clean transcript answer");
    for (const call of onAssistantTurn.mock.calls) {
      expect(call[0]).not.toContain("noisy TUI text");
      expect(call[0]).not.toContain("╭");
    }
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
      sessionFile: path.join(runtimeDir, "session.jsonl"),
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

  it("keeps launchHash stable when the only arg change between turns is the --session-id value", async () => {
    // Regression: turn 1 (fresh /new) had no cliSessionId so the args lacked
    // `--session-id`; turn 2 (hello) inherited the Claude session id and the
    // args carried `--session-id <uuid>`. The launchHash difference triggered
    // killSession + recreate, which collapsed the tmux pane and surfaced as
    // "tmux 直接退出了" with the user-visible reply lost.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const launchHashes: string[] = [];
    class CapturingManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string; launchHash: string };
      }) {
        launchHashes.push(p.metadata.launchHash);
        return super.ensureSession(p as never);
      }
    }
    const manager = new CapturingManager();
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
      sessionFile: path.join(runtimeDir, "session.jsonl"),
      sessionId: "openclaw-session",
      modelId: "sonnet",
      systemPrompt: "system",
      timeoutMs: 5_000,
      env: {},
    };
    await executeTmuxCliRun({ ...baseInput, runId: "run-1", prompt: "hello" }, manager as never);
    await executeTmuxCliRun(
      { ...baseInput, runId: "run-2", prompt: "again", cliSessionId: "claude-session-uuid" },
      manager as never,
    );
    expect(launchHashes).toHaveLength(2);
    expect(launchHashes[0]).toBe(launchHashes[1]);
  });

  it("keeps launchHash stable when only volatile per-run env keys differ", async () => {
    // Regression: prepare.ts injects OPENCLAW_MCP_RUN_ID into the child env on
    // every turn. It is baked into the initial tmux child process and can't be
    // updated for a reused session, so including it in the launch signature
    // would force kill+recreate on every follow-up turn. The first repro:
    // turn 1 launchHash=bf464f..., turn 2 launchHash=e1f95f... with
    // mismatchReasons=["launchHash"] → tmux pane collapsed mid-paste.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const launchHashes: string[] = [];
    class CapturingManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string; launchHash: string };
      }) {
        launchHashes.push(p.metadata.launchHash);
        return super.ensureSession(p as never);
      }
    }
    const manager = new CapturingManager();
    const baseInput: Omit<TmuxExecutionInput, "runId" | "prompt" | "env"> = {
      backend: {
        command: "claude",
        args: ["-p", "--bare"],
        modelArg: "--model",
        sessionArg: "--session-id",
        execution: { mode: "tmux", tmux: { runtimeDir } },
      },
      backendId: "claude-cli",
      workspaceDir: runtimeDir,
      sessionFile: path.join(runtimeDir, "session.jsonl"),
      sessionId: "openclaw-session",
      modelId: "sonnet",
      systemPrompt: "system",
      timeoutMs: 5_000,
    };
    await executeTmuxCliRun(
      { ...baseInput, runId: "run-1", prompt: "hello", env: { OPENCLAW_MCP_RUN_ID: "run-1" } },
      manager as never,
    );
    await executeTmuxCliRun(
      { ...baseInput, runId: "run-2", prompt: "again", env: { OPENCLAW_MCP_RUN_ID: "run-2" } },
      manager as never,
    );
    expect(launchHashes).toHaveLength(2);
    expect(launchHashes[0]).toBe(launchHashes[1]);
  });

  it("keeps launchHash stable when only the --mcp-config temp path differs", async () => {
    // Real-world repro (the one that kept killing tmux on "hello"):
    // prepareCliBundleMcpConfig writes the bundled MCP config to a fresh
    // mkdtemp dir every turn, so backend.args carried
    //   --mcp-config /var/folders/.../openclaw-cli-mcp-FJs13w/mcp.json
    // with a different random segment each turn. That shifted stableArgs →
    // launchHash → mismatchReasons=["launchHash"] → kill+recreate mid-paste,
    // surfacing as "发了 hello，tmux 就被关闭了". The path is per-turn noise;
    // content is guarded separately via metadata.mcpConfigHash.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const launchHashes: string[] = [];
    class CapturingManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string; launchHash: string };
      }) {
        launchHashes.push(p.metadata.launchHash);
        return super.ensureSession(p as never);
      }
    }
    const manager = new CapturingManager();
    const baseInput: Omit<TmuxExecutionInput, "runId" | "prompt" | "backend"> = {
      backendId: "claude-cli",
      workspaceDir: runtimeDir,
      sessionFile: path.join(runtimeDir, "session.jsonl"),
      sessionId: "openclaw-session",
      modelId: "sonnet",
      systemPrompt: "system",
      timeoutMs: 5_000,
      env: {},
      mcpConfigHash: "stable-mcp-content-hash",
    };
    const backendWith = (mcpPath: string): TmuxExecutionInput["backend"] => ({
      command: "claude",
      args: ["--strict-mcp-config", "--mcp-config", mcpPath, "-p", "--bare"],
      modelArg: "--model",
      sessionArg: "--session-id",
      execution: { mode: "tmux", tmux: { runtimeDir } },
    });
    await executeTmuxCliRun(
      {
        ...baseInput,
        backend: backendWith("/var/folders/aa/openclaw-cli-mcp-FJs13w/mcp.json"),
        runId: "run-1",
        prompt: "hello",
      },
      manager as never,
    );
    await executeTmuxCliRun(
      {
        ...baseInput,
        backend: backendWith("/var/folders/bb/openclaw-cli-mcp-ZZ99kq/mcp.json"),
        runId: "run-2",
        prompt: "again",
      },
      manager as never,
    );
    expect(launchHashes).toHaveLength(2);
    expect(launchHashes[0]).toBe(launchHashes[1]);
  });

  const resumeBackend = (runtimeDir: string, tmux: Record<string, unknown> = {}) => ({
    command: "claude",
    args: ["-p", "--bare"],
    resumeArgs: ["-p", "--bare", "--resume", "{sessionId}"],
    modelArg: "--model",
    sessionArg: "--session-id",
    systemPromptArg: "--append-system-prompt",
    execution: { mode: "tmux" as const, tmux: { runtimeDir, ...tmux } },
  });

  function seedMetadata(
    runtimeDir: string,
    extra: Record<string, unknown>,
  ): Promise<{ sessionName: string; paths: TmuxRuntimePaths }> {
    const sessionName = buildTmuxSessionName({
      prefix: "openclaw-claude",
      backendId: "claude-cli",
      workspaceDir: runtimeDir,
      sessionKey: "openclaw-session",
      modelId: "sonnet",
      memoryMode: "managed-disabled",
      hookMode: "managed",
    });
    const paths = resolveTmuxRuntimePaths({ runtimeDir, sessionName });
    return fs
      .mkdir(paths.rootDir, { recursive: true })
      .then(() =>
        fs.writeFile(
          paths.metadataFile,
          `${JSON.stringify({
            backendId: "claude-cli",
            workspaceDir: runtimeDir,
            sessionName,
            launchHash: "x",
            model: "sonnet",
            systemPromptHash: "old",
            memoryMode: "managed-disabled",
            hookMode: "managed",
            ...extra,
          })}\n`,
        ),
      )
      .then(() => ({ sessionName, paths }));
  }

  it("pre-paste dead pane with a prior-bound id: resume-relaunches", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    // A prior turn bound a Claude id to THIS tmux identity → resume evidence.
    await seedMetadata(runtimeDir, { launchMode: "resume", claudeSessionId: "claude-x" });
    const ensureArgs: string[][] = [];
    let aliveCalls = 0;
    class DeadThenHealedManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string };
        args?: string[];
      }) {
        ensureArgs.push(p.args ?? []);
        await super.ensureSession(p as never);
        return { created: true };
      }
      // sessionAliveAtStart probe reports dead; everything after heal alive.
      async isPaneAlive() {
        aliveCalls += 1;
        return aliveCalls > 1;
      }
    }
    const onAssistantTurn = vi.fn();
    const output = await executeTmuxCliRun(
      { ...baseInput(runtimeDir, { onAssistantTurn }), backend: resumeBackend(runtimeDir) },
      new DeadThenHealedManager() as never,
    );

    const resumeCall = ensureArgs.find((a) => a.includes("--resume"));
    expect(resumeCall).toBeDefined();
    expect(resumeCall).toContain("claude-x");
    expect(resumeCall).not.toContain("--append-system-prompt");
    // Loader text rode in front of the prompt but never surfaced as output.
    const emitted = onAssistantTurn.mock.calls.map((c) => String(c[0])).join("");
    expect(emitted).not.toContain("MANDATORY FIRST STEP");
    expect(output.text).toContain("Hello from Claude");
  });

  it("no prior-bound id: heals via FRESH relaunch, not a resume failure", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const ensureArgs: string[][] = [];
    let aliveCalls = 0;
    class DeadThenHealedManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string };
        args?: string[];
      }) {
        ensureArgs.push(p.args ?? []);
        return super.ensureSession(p as never);
      }
      async isPaneAlive() {
        aliveCalls += 1;
        return aliveCalls > 1;
      }
    }
    // resumeBackend has a resume template, but there is NO prior-bound id
    // (fresh /new). Must NOT try `--resume`; FRESH relaunch instead.
    const output = await executeTmuxCliRun(
      {
        ...baseInput(runtimeDir),
        backend: resumeBackend(runtimeDir),
        cliSessionId: "stale-foreign-id",
      },
      new DeadThenHealedManager() as never,
    );
    expect(ensureArgs.some((a) => a.includes("--resume"))).toBe(false);
    expect(ensureArgs.length).toBeLessThanOrEqual(4);
    expect(output.text).toContain("Hello from Claude");
  });

  it("cold restart: resumes from claudeSessionId persisted in metadata.json", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    // Recreate the exact runtime path the runner will resolve, then pre-seed
    // metadata.json as if a prior gateway process had bound a Claude id.
    const sessionName = buildTmuxSessionName({
      prefix: "openclaw-claude",
      backendId: "claude-cli",
      workspaceDir: runtimeDir,
      sessionKey: "openclaw-session",
      modelId: "sonnet",
      memoryMode: "managed-disabled",
      hookMode: "managed",
    });
    const paths = resolveTmuxRuntimePaths({ runtimeDir, sessionName });
    await fs.mkdir(paths.rootDir, { recursive: true });
    await fs.writeFile(
      paths.metadataFile,
      `${JSON.stringify({
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionName,
        launchHash: "x",
        model: "sonnet",
        systemPromptHash: "old",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        launchMode: "resume",
        claudeSessionId: "cold-id",
        createdAt: 1,
        lastUsedAt: 1,
      })}\n`,
    );
    const ensureArgs: string[][] = [];
    class ColdManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string };
        args?: string[];
      }) {
        ensureArgs.push(p.args ?? []);
        return super.ensureSession(p as never);
      }
      async hasSession() {
        return false;
      }
      async isPaneAlive() {
        return false;
      }
    }
    await executeTmuxCliRun(
      // No cliSessionId → must fall back to the persisted claudeSessionId.
      { ...baseInput(runtimeDir), backend: resumeBackend(runtimeDir) },
      new ColdManager() as never,
    ).catch(() => {});
    const resumeCall = ensureArgs.find((a) => a.includes("--resume"));
    expect(resumeCall).toBeDefined();
    expect(resumeCall).toContain("cold-id");
  });

  it("alive pane + launchHash mismatch escalates to resume instead of fresh", async () => {
    // Regression: when the tmux pane is alive at probe time but the persisted
    // launchHash differs from the one this turn would compute (e.g. routing
    // env shifted: OPENCLAW_MCP_ACCOUNT_ID / _CURRENT_CHANNEL /
    // _MESSAGE_CHANNEL drift between followups), ensureSession kills the
    // pane and relaunches. Pre-fix, the relaunch used fresh args → a new
    // Claude --session-id with no memory of prior turns → Ada created
    // duplicate issue #324 right after #323. Post-fix, the launchMode is
    // escalated to resume so `claude --resume <priorBoundClaudeId>` replays
    // the disk transcript and the conversation survives the recreate.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    // Seed metadata as if a prior turn ran successfully (fresh launchMode,
    // a bound Claude id, and a launchHash that will NOT match this turn's
    // computed hash — "x" is a sentinel value that no real hash equals).
    await seedMetadata(runtimeDir, { launchMode: "fresh", claudeSessionId: "prior-bound-id" });
    const ensureArgs: string[][] = [];
    class AlivePaneManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string };
        args?: string[];
      }) {
        ensureArgs.push(p.args ?? []);
        return super.ensureSession(p as never);
      }
      // Pane probed alive at the launchMode-decision point.
      override async hasSession() {
        return true;
      }
      override async isPaneAlive() {
        return true;
      }
    }
    await executeTmuxCliRun(
      { ...baseInput(runtimeDir), backend: resumeBackend(runtimeDir) },
      new AlivePaneManager() as never,
    );
    // The launch must use --resume with the prior-bound id, NOT a fresh
    // --session-id with a brand-new uuid.
    const launchArgs = ensureArgs[0];
    expect(launchArgs).toBeDefined();
    expect(launchArgs).toContain("--resume");
    expect(launchArgs).toContain("prior-bound-id");
    expect(launchArgs).not.toContain("--session-id");
  });

  it("mid-turn death is bounded: exhausts resume attempts then FailoverError", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    let ensureCalls = 0;
    class AlwaysDeadManager extends FakeTmuxManager {
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string };
      }) {
        ensureCalls += 1;
        return super.ensureSession(p as never);
      }
      async isPaneAlive() {
        return false;
      }
      // Never emit Stop so the turn cannot complete normally.
      override async pastePrompt() {}
    }
    await expect(
      executeTmuxCliRun(
        {
          ...baseInput(runtimeDir, {}, { startupTimeoutMs: 200 }),
          backend: resumeBackend(runtimeDir, { startupTimeoutMs: 200 }),
          cliSessionId: "claude-x",
          timeoutMs: 30_000,
        },
        new AlwaysDeadManager() as never,
      ),
    ).rejects.toThrow(/(exhausted|resume-recovery)/);
    // 1 initial + at most MAX_RECOVERY_ATTEMPTS(3) relaunches.
    expect(ensureCalls).toBeLessThanOrEqual(4);
    expect(ensureCalls).toBeGreaterThanOrEqual(2);
  }, 20_000);

  describe("linkUserClaudeAssets", () => {
    it("symlinks existing user skills/commands/agents into the config dir", async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-assets-test-"));
      tempDirs.push(base);
      const userClaudeDir = path.join(base, "user-claude");
      const configDir = path.join(base, "isolated-config");
      await fs.mkdir(path.join(userClaudeDir, "skills", "demo"), { recursive: true });
      await fs.writeFile(path.join(userClaudeDir, "skills", "demo", "SKILL.md"), "# demo skill");
      await fs.mkdir(path.join(userClaudeDir, "commands"), { recursive: true });
      // agents intentionally absent → must be skipped, not error.
      await fs.mkdir(configDir, { recursive: true });

      await linkUserClaudeAssets({ configDir, userClaudeDir });

      const skillLink = path.join(configDir, "skills");
      const lst = await fs.lstat(skillLink);
      expect(lst.isSymbolicLink()).toBe(true);
      // Resolves through the symlink to the real SKILL.md.
      expect(await fs.readFile(path.join(skillLink, "demo", "SKILL.md"), "utf8")).toBe(
        "# demo skill",
      );
      expect((await fs.lstat(path.join(configDir, "commands"))).isSymbolicLink()).toBe(true);
      await expect(fs.lstat(path.join(configDir, "agents"))).rejects.toThrow();
    });

    it("never clobbers a real (non-symlink) dir already in the config dir", async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-assets-test-"));
      tempDirs.push(base);
      const userClaudeDir = path.join(base, "user-claude");
      const configDir = path.join(base, "isolated-config");
      await fs.mkdir(path.join(userClaudeDir, "skills", "u"), { recursive: true });
      await fs.writeFile(path.join(userClaudeDir, "skills", "u", "SKILL.md"), "user");
      // Pre-existing REAL skills dir in the isolated config — must survive.
      await fs.mkdir(path.join(configDir, "skills", "local"), { recursive: true });
      await fs.writeFile(path.join(configDir, "skills", "local", "SKILL.md"), "local");

      await linkUserClaudeAssets({ configDir, userClaudeDir });

      const st = await fs.lstat(path.join(configDir, "skills"));
      expect(st.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(configDir, "skills", "local", "SKILL.md"), "utf8")).toBe(
        "local",
      );
    });

    it("is a no-op when the user ~/.claude has none of the assets", async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-assets-test-"));
      tempDirs.push(base);
      const userClaudeDir = path.join(base, "empty-user");
      const configDir = path.join(base, "cfg");
      await fs.mkdir(userClaudeDir, { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await linkUserClaudeAssets({ configDir, userClaudeDir });
      await expect(fs.lstat(path.join(configDir, "skills"))).rejects.toThrow();
    });
  });

  it("suppresses pane fallback when its content matches the prompt envelope", async () => {
    // Regression for the Feishu-card leak: SessionStart hook never delivers a
    // session id AND the project dir has no transcript JSONL yet — both
    // discovery paths fail, transcript stays undefined. Without the envelope
    // detector this would have flushed the pane (containing the pasted
    // OpenClaw conversation envelope rendered as TUI placeholders) directly
    // into the card. The detector forces suppression.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    class NoHookEnvelopeManager extends FakeTmuxManager {
      override async pastePrompt(p: { promptFile: string }) {
        // Pane stream contains the prompt envelope echoed by the TUI — no
        // assistant text, no SessionStart hook event with a claude id.
        await fs.appendFile(
          this.paths!.paneLogFile,
          "[Pastedtext#21+35lines] paste gain to expad\n" +
            '</message><messageindex="4" id="om_xyz" sender_type="bot">extra prompt echo\n' +
            "<atid=ou_abc></at>some interim noise",
        );
        // Stop hook fires without a claudeSessionId so transcript is never
        // instantiated via the live path either.
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
    }
    const onAssistantTurn = vi.fn();
    const diagnostics: Array<{ event: string; data?: Record<string, unknown> }> = [];
    await expect(
      executeTmuxCliRun(
        // hookMode managed (default) -> transcriptIsAuthoritative=true.
        baseInput(runtimeDir, {
          onAssistantTurn,
          onDiagnostic: (event, data) => diagnostics.push({ event, data }),
        }),
        new NoHookEnvelopeManager() as never,
      ),
    ).rejects.toThrow(/empty output/i);

    // Envelope detector must short-circuit pane fallback even without any
    // transcript file -> no envelope text reaches the card; after one clean
    // retry, a second empty result fails closed instead of returning "".
    const emitted = onAssistantTurn.mock.calls.map((c) => String(c[0])).join("");
    expect(emitted).not.toMatch(/Pasted\s*text\s*#/i);
    expect(emitted).not.toContain("</message>");
    expect(emitted).not.toContain("<atid=");
    expect(diagnostics.some((entry) => entry.event === "tmux.empty-output.retry")).toBe(true);
    expect(diagnostics.some((entry) => entry.event === "tmux.empty-output.failure")).toBe(true);
  });

  it("retries once with a clean boundary instead of returning empty output from envelope-only pane residue", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    class RetryAfterEnvelopeManager extends FakeTmuxManager {
      pasteCount = 0;
      killCount = 0;
      override async pastePrompt() {
        this.pasteCount += 1;
        if (this.pasteCount === 1) {
          await fs.appendFile(
            this.paths!.paneLogFile,
            '[Pasted text #21 +35 lines]</message><messageindex="4">prompt echo only',
          );
        } else {
          await fs.appendFile(this.paths!.paneLogFile, "Clean retry answer");
        }
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
      override async killSession() {
        this.killCount += 1;
      }
    }
    const manager = new RetryAfterEnvelopeManager();
    const onAssistantTurn = vi.fn();
    const diagnostics: Array<{ event: string; data?: Record<string, unknown> }> = [];

    const output = await executeTmuxCliRun(
      baseInput(runtimeDir, {
        onAssistantTurn,
        onDiagnostic: (event, data) => diagnostics.push({ event, data }),
      }),
      manager as never,
    );

    expect(manager.killCount).toBe(1);
    expect(manager.pasteCount).toBe(2);
    expect(output.text).toBe("Clean retry answer");
    expect(onAssistantTurn.mock.calls.flat().join("")).not.toContain("Pasted text");
    expect(diagnostics.some((entry) => entry.event === "tmux.empty-output.retry")).toBe(true);
  });

  it("empty-output retry ignores persisted claudeSessionId: must not --resume into prior session", async () => {
    // Regression guard: if metadata.json already has a claudeSessionId from a
    // prior turn, the empty-output retry must clear it before recursing so the
    // fresh launch does NOT become a --resume that reattaches the same session
    // that produced empty output.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    // Seed metadata with a prior bound Claude session id (simulates a warm session).
    await seedMetadata(runtimeDir, { launchMode: "fresh", claudeSessionId: "prior-bound-id" });

    const ensureArgsList: string[][] = [];
    class EnvelopeThenAnswerManager extends FakeTmuxManager {
      pasteCount = 0;
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string };
        args?: string[];
      }) {
        ensureArgsList.push(p.args ?? []);
        this.paths = p.paths;
        // Write the startup banner so waitForStartup can exit promptly.
        await fs.writeFile(p.paths.paneLogFile, "Claude Code v2.1.140\n");
        await fs.writeFile(p.paths.eventsFile, "");
        return { created: true };
      }
      override async pastePrompt() {
        this.pasteCount += 1;
        if (this.pasteCount === 1) {
          // First attempt: envelope-only pane → triggers empty-output retry.
          await fs.appendFile(
            this.paths!.paneLogFile,
            '[Pasted text #3 +10 lines]</message><messageindex="1">echo noise',
          );
        } else {
          // Retry attempt: real answer.
          await fs.appendFile(this.paths!.paneLogFile, "Retry clean answer");
        }
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
      override async killSession() {}
    }
    const manager = new EnvelopeThenAnswerManager();
    const output = await executeTmuxCliRun(
      { ...baseInput(runtimeDir), backend: resumeBackend(runtimeDir) },
      manager as never,
    );

    expect(output.text).toBe("Retry clean answer");
    // First ensureSession (initial attempt) may use any mode.
    // Second ensureSession (the retry) must NOT use --resume — it must be fresh.
    expect(ensureArgsList).toHaveLength(2);
    const retryArgs = ensureArgsList[1];
    expect(retryArgs).toBeDefined();
    expect(retryArgs).not.toContain("--resume");
    expect(retryArgs).not.toContain("prior-bound-id");
  });

  it("empty-output retry strips cliSessionId from input so buildArgsForMode('fresh') never carries a stale --session-id", async () => {
    // Regression: the recursive retry call passed the original `input` unchanged,
    // so buildArgsForMode("fresh") still read input.cliSessionId and forwarded it
    // as --session-id. Both metadata AND input could carry a stale id; the retry
    // must clear both to guarantee a truly fresh launch.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    // Seed metadata with a prior bound id so both stale-id paths are exercised.
    await seedMetadata(runtimeDir, { launchMode: "fresh", claudeSessionId: "stale-meta-id" });

    const ensureArgsList: string[][] = [];
    class EnvelopeThenAnswerWithCliId extends FakeTmuxManager {
      pasteCount = 0;
      override async ensureSession(p: {
        paths: TmuxRuntimePaths;
        metadata: { sessionName: string };
        args?: string[];
      }) {
        ensureArgsList.push(p.args ?? []);
        this.paths = p.paths;
        await fs.writeFile(p.paths.paneLogFile, "Claude Code v2.1.140\n");
        await fs.writeFile(p.paths.eventsFile, "");
        return { created: true };
      }
      override async pastePrompt() {
        this.pasteCount += 1;
        if (this.pasteCount === 1) {
          // First attempt: envelope-only pane → triggers empty-output retry.
          await fs.appendFile(
            this.paths!.paneLogFile,
            '[Pasted text #3 +10 lines]</message><messageindex="1">echo noise',
          );
        } else {
          await fs.appendFile(this.paths!.paneLogFile, "Clean retry answer");
        }
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
      override async killSession() {}
    }

    const manager = new EnvelopeThenAnswerWithCliId();
    const output = await executeTmuxCliRun(
      {
        ...baseInput(runtimeDir),
        cliSessionId: "stale-input-id",
        backend: resumeBackend(runtimeDir),
      },
      manager as never,
    );

    expect(output.text).toBe("Clean retry answer");
    expect(ensureArgsList).toHaveLength(2);
    const retryArgs = ensureArgsList[1];
    // Retry must be a truly fresh launch: no --resume and no --session-id.
    expect(retryArgs).not.toContain("--resume");
    expect(retryArgs).not.toContain("--session-id");
    expect(retryArgs).not.toContain("stale-input-id");
    expect(retryArgs).not.toContain("stale-meta-id");
  });

  it("preserves legit Feishu mentions even when other envelope tokens trigger suppression", async () => {
    // Mixed pane: envelope tokens + a real <at user_id> mention. With pane
    // fallback active (no transcript), the sanitizer must strip the envelope
    // but keep the @mention as-is.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    class MixedManager extends FakeTmuxManager {
      override async pastePrompt(p: { promptFile: string }) {
        // hookMode=off makes pane the canonical reply path so the sanitizer
        // runs through the flush+text-return logic (envelope detector still
        // applies but pane is allowed when not authoritative).
        await fs.appendFile(
          this.paths!.paneLogFile,
          'real reply <at user_id="ou_a">Ada</at> ok</message> trailing',
        );
        await fs.appendFile(
          this.paths!.eventsFile,
          `${JSON.stringify({ event: "Stop", runId: "run-1", timestamp: Date.now(), stdin: {} })}\n`,
        );
      }
    }
    const onAssistantTurn = vi.fn();
    const output = await executeTmuxCliRun(
      baseInput(runtimeDir, { onAssistantTurn }, { hookMode: "off" }),
      new MixedManager() as never,
    );
    expect(output.text).toContain('<at user_id="ou_a">Ada</at>');
    expect(output.text).not.toContain("</message>");
  });
});
