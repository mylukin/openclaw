import { beforeEach, describe, expect, it, vi } from "vitest";

let runClaudeCliAgent: typeof import("./claude-cli-runner.js").runClaudeCliAgent;

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (...args: unknown[]) => {
      const input = args[0] as { onStdout?: (chunk: string) => void } | undefined;
      const managedRun = (await mocks.spawn(...args)) as
        | { __stdoutForStreaming?: string; wait?: () => Promise<{ stdout?: string }> }
        | undefined;
      if (input?.onStdout && typeof managedRun?.__stdoutForStreaming === "string") {
        input.onStdout(managedRun.__stdoutForStreaming);
      }
      if (input?.onStdout && managedRun?.wait) {
        const originalWait = managedRun.wait.bind(managedRun);
        managedRun.wait = async () => {
          const result = await originalWait();
          if (typeof result?.stdout === "string") {
            input.onStdout?.(result.stdout);
          }
          return result;
        };
      }
      return managedRun;
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    cancelSession: vi.fn(() => 0),
    reconcileOrphans: async () => {},
    getRecord: vi.fn(),
  }),
}));

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: resolve as (value: T) => void,
    reject: reject as (error: unknown) => void,
  };
}

function createManagedRun(
  exit: Promise<{
    reason: "exit" | "overall-timeout" | "no-output-timeout" | "signal" | "manual-cancel";
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    noOutputTimedOut: boolean;
  }>,
) {
  return {
    runId: "run-test",
    pid: 12345,
    startedAtMs: Date.now(),
    __stdoutForStreaming: undefined as string | undefined,
    wait: async () => await exit,
    cancel: vi.fn(),
  };
}

function successExit(payload: { message: string; session_id: string }) {
  return {
    reason: "exit" as const,
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: payload.session_id }),
      JSON.stringify({
        type: "assistant",
        session_id: payload.session_id,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_test_read",
              name: "Read",
              input: { file_path: "/tmp/session.claude-system-prompt.txt" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: payload.session_id,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_test_read", content: "prompt file" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: payload.session_id,
        message: { role: "assistant", content: [{ type: "text", text: payload.message }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: payload.message,
        session_id: payload.session_id,
      }),
    ].join("\n"),
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
  };
}

async function waitForCalls(mockFn: { mock: { calls: unknown[][] } }, count: number) {
  await vi.waitFor(
    () => {
      expect(mockFn.mock.calls.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 2_000, interval: 5 },
  );
}

describe("runClaudeCliAgent", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../process/supervisor/index.js", () => ({
      getProcessSupervisor: () => ({
        spawn: async (...args: unknown[]) => {
          const input = args[0] as { onStdout?: (chunk: string) => void } | undefined;
          const managedRun = (await mocks.spawn(...args)) as
            | { __stdoutForStreaming?: string; wait?: () => Promise<{ stdout?: string }> }
            | undefined;
          if (input?.onStdout && typeof managedRun?.__stdoutForStreaming === "string") {
            input.onStdout(managedRun.__stdoutForStreaming);
          }
          if (input?.onStdout && managedRun?.wait) {
            const originalWait = managedRun.wait.bind(managedRun);
            managedRun.wait = async () => {
              const result = await originalWait();
              if (typeof result?.stdout === "string") {
                input.onStdout?.(result.stdout);
              }
              return result;
            };
          }
          return managedRun;
        },
        cancel: vi.fn(),
        cancelScope: vi.fn(),
        cancelSession: vi.fn(() => 0),
        reconcileOrphans: async () => {},
        getRecord: vi.fn(),
      }),
    }));
    ({ runClaudeCliAgent } = await import("./claude-cli-runner.js"));
    mocks.spawn.mockClear();
  });

  it("starts a new session with --session-id when none is provided", async () => {
    mocks.spawn.mockResolvedValueOnce(
      createManagedRun(Promise.resolve(successExit({ message: "ok", session_id: "sid-1" }))),
    );

    await runClaudeCliAgent({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const spawnInput = mocks.spawn.mock.calls[0]?.[0] as { argv: string[]; mode: string };
    expect(spawnInput.mode).toBe("child");
    expect(spawnInput.argv).toContain("claude");
    expect(spawnInput.argv).toContain("--session-id");
    expect(spawnInput.argv).toContain("hi");
  });

  it("uses --resume when a claude session id is provided", async () => {
    mocks.spawn.mockResolvedValueOnce(
      createManagedRun(Promise.resolve(successExit({ message: "ok", session_id: "sid-2" }))),
    );

    await runClaudeCliAgent({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-2",
      claudeSessionId: "c9d7b831-1c31-4d22-80b9-1e50ca207d4b",
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const spawnInput = mocks.spawn.mock.calls[0]?.[0] as { argv: string[] };
    expect(spawnInput.argv).toContain("--resume");
    expect(spawnInput.argv).toContain("c9d7b831-1c31-4d22-80b9-1e50ca207d4b");
    expect(spawnInput.argv).not.toContain("--session-id");
    expect(spawnInput.argv).toContain("hi");
  });

  it("serializes concurrent claude-cli runs", async () => {
    const firstDeferred = createDeferred<ReturnType<typeof successExit>>();
    const secondDeferred = createDeferred<ReturnType<typeof successExit>>();

    mocks.spawn
      .mockResolvedValueOnce(createManagedRun(firstDeferred.promise))
      .mockResolvedValueOnce(createManagedRun(secondDeferred.promise));

    const firstRun = runClaudeCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "first",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    const secondRun = runClaudeCliAgent({
      sessionId: "s2",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "second",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-2",
    });

    await waitForCalls(mocks.spawn, 1);

    firstDeferred.resolve(successExit({ message: "ok", session_id: "sid-1" }));

    await waitForCalls(mocks.spawn, 2);

    secondDeferred.resolve(successExit({ message: "ok", session_id: "sid-2" }));

    await Promise.all([firstRun, secondRun]);
  });
});
