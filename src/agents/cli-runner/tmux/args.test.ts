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
      managedSettingsJson: '{"allowManagedHooksOnly":true}',
      systemPromptFile: "/tmp/system.txt",
      sessionId: "session-id",
    });

    expect(args).not.toContain("-p");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--include-partial-messages");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/mcp.json",
        "--settings",
        "/tmp/settings.json",
        "--managed-settings",
        '{"allowManagedHooksOnly":true}',
        "--setting-sources",
        "",
        "--append-system-prompt-file",
        "/tmp/system.txt",
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
      systemPromptFile: "/tmp/p.txt",
    });

    expect(args).toEqual([
      "--settings",
      "/tmp/s.json",
      "--setting-sources",
      "",
      "--append-system-prompt-file",
      "/tmp/p.txt",
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
      systemPromptFile: "/tmp/p.txt",
    });
    expect(args).toContain("--keep-me");
    expect(args).not.toContain("--model=opus");
    expect(args).not.toContain("--settings=/x.json");
    expect(args).not.toContain("--permission-mode=plan");
    expect(args.slice(-2)).toEqual(["--model", "sonnet"]);
  });
});
