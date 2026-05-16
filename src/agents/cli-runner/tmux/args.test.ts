import { describe, expect, it } from "vitest";
import { buildClaudeTmuxArgs } from "./args.js";

describe("buildClaudeTmuxArgs", () => {
  it("removes print and bare flags while preserving MCP args", () => {
    const args = buildClaudeTmuxArgs({
      backend: { command: "claude", modelArg: "--model", sessionArg: "--session-id" },
      baseArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--bare",
        "--setting-sources",
        "user",
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/mcp.json",
      ],
      modelId: "sonnet",
      settingsFile: "/tmp/settings.json",
      systemPrompt: "LOADER PROMPT TEXT",
      launch: { mode: "fresh", sessionId: "session-id" },
    });

    expect(args).not.toContain("-p");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--include-partial-messages");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--managed-settings");
    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/mcp.json",
        "--settings",
        "/tmp/settings.json",
        "--setting-sources",
        "",
        "--append-system-prompt",
        "LOADER PROMPT TEXT",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "sonnet",
        "--session-id",
        "session-id",
      ]),
    );
  });

  it("works with no baseArgs and omits model/session when unset", () => {
    const args = buildClaudeTmuxArgs({
      backend: { command: "claude" },
      modelId: "",
      settingsFile: "/tmp/s.json",
      systemPrompt: "LOADER",
      launch: { mode: "fresh" },
    });

    expect(args).toEqual([
      "--settings",
      "/tmp/s.json",
      "--setting-sources",
      "",
      "--append-system-prompt",
      "LOADER",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--managed-settings");
  });

  it("drops equals-form settings/model overrides from baseArgs", () => {
    const args = buildClaudeTmuxArgs({
      backend: { command: "claude", modelArg: "--model" },
      baseArgs: ["--model=opus", "--settings=/x.json", "--permission-mode=plan", "--keep-me"],
      modelId: "sonnet",
      settingsFile: "/tmp/s.json",
      systemPrompt: "LOADER",
      launch: { mode: "fresh" },
    });
    expect(args).toContain("--keep-me");
    expect(args).not.toContain("--model=opus");
    expect(args).not.toContain("--settings=/x.json");
    expect(args).not.toContain("--permission-mode=plan");
    expect(args.slice(-2)).toEqual(["--model", "sonnet"]);
  });

  it("resume mode substitutes {sessionId}, drops --append-system-prompt", () => {
    const args = buildClaudeTmuxArgs({
      backend: {
        command: "claude",
        modelArg: "--model",
        sessionArg: "--session-id",
        systemPromptArg: "--append-system-prompt",
        resumeArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--bare",
          "--dangerously-skip-permissions",
          "--resume",
          "{sessionId}",
        ],
      },
      baseArgs: ["-p", "--bare"],
      modelId: "sonnet",
      settingsFile: "/tmp/s.json",
      systemPrompt: "LOADER PROMPT TEXT",
      launch: { mode: "resume", claudeSessionId: "claude-abc-123" },
    });

    // Resume must replay history; the loader is pasted as a message, never
    // via --append-system-prompt (Claude CLI rejects it on resume).
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("LOADER PROMPT TEXT");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--session-id");
    expect(args).toEqual(
      expect.arrayContaining([
        "--resume",
        "claude-abc-123",
        "--settings",
        "/tmp/s.json",
        "--setting-sources",
        "",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "sonnet",
      ]),
    );
    // {sessionId} placeholder fully substituted.
    expect(args.some((a) => a.includes("{sessionId}"))).toBe(false);
  });

  it("resume mode adds --resume defensively when template lacks it", () => {
    const args = buildClaudeTmuxArgs({
      backend: { command: "claude", resumeArgs: ["-p", "--bare"] },
      modelId: "",
      settingsFile: "/tmp/s.json",
      systemPrompt: "LOADER",
      launch: { mode: "resume", claudeSessionId: "sid-9" },
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sid-9");
  });
});
