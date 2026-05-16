import { describe, expect, it } from "vitest";
import { buildTmuxSessionName, sanitizeTmuxNamePart } from "./session-name.js";

describe("buildTmuxSessionName", () => {
  it("builds stable safe tmux names", () => {
    const base = {
      prefix: "openclaw claude!",
      backendId: "claude-cli",
      workspaceDir: "/repo",
      sessionKey: "chat-1",
      modelId: "sonnet",
      memoryMode: "managed-disabled",
      hookMode: "managed",
    };

    expect(buildTmuxSessionName(base)).toBe(buildTmuxSessionName(base));
    expect(buildTmuxSessionName(base)).toMatch(/^openclaw-claude-[0-9a-f]{12}$/);
    // The conversation identity (model) changes the name. The volatile system
    // prompt is intentionally not part of the signature any more, so follow-up
    // turns of the same conversation map to the same persistent session (see
    // manager.test.ts for the reuse regression).
    expect(buildTmuxSessionName({ ...base, modelId: "opus" })).not.toBe(buildTmuxSessionName(base));
  });

  it("sanitizes arbitrary prefix text", () => {
    expect(sanitizeTmuxNamePart(" hello/world:tmux ")).toBe("hello-world-tmux");
  });

  it("falls back to the default prefix when the prefix sanitizes to empty", () => {
    const name = buildTmuxSessionName({
      prefix: "!!!",
      backendId: "claude-cli",
      workspaceDir: "/repo",
      sessionKey: "chat-1",
      modelId: "sonnet",
      memoryMode: "managed-disabled",
      hookMode: "managed",
    });
    expect(name).toMatch(/^openclaw-claude-[0-9a-f]{12}$/);
  });
});
