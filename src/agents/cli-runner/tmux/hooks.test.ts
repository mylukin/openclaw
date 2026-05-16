import { describe, expect, it } from "vitest";
import { buildClaudeTmuxSettings, parseHookEventLine } from "./hooks.js";

const TEST_PATHS = {
  rootDir: "/tmp/root",
  activeRunFile: "/tmp/root/active-run.json",
  eventsFile: "/tmp/root/events.jsonl",
  paneLogFile: "/tmp/root/pane.log",
  launcherFile: "/tmp/root/launch-claude.mjs",
  settingsFile: "/tmp/root/settings.json",
  hookWriterFile: "/tmp/root/hook-writer.mjs",
  promptBufferFile: "/tmp/root/prompt.txt",
  metadataFile: "/tmp/root/metadata.json",
};

describe("buildClaudeTmuxSettings", () => {
  it("embeds hooks block into settings when hookMode is managed", () => {
    const settings = buildClaudeTmuxSettings({ paths: TEST_PATHS, hookMode: "managed" });

    expect(settings).toMatchObject({
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
      disableBackgroundAgents: true,
      disableRemoteControl: true,
    });
    expect(settings).toHaveProperty("hooks");
    expect(JSON.stringify(settings)).toContain("Stop");
    expect(JSON.stringify(settings)).toContain("hook-writer.mjs");
  });

  it("omits hooks block when hookMode is off", () => {
    const settings = buildClaudeTmuxSettings({ paths: TEST_PATHS, hookMode: "off" });

    expect(settings).toMatchObject({
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
    });
    expect(settings).not.toHaveProperty("hooks");
  });
});

describe("parseHookEventLine", () => {
  it("parses known hook event JSONL records", () => {
    expect(
      parseHookEventLine(
        JSON.stringify({
          event: "Stop",
          runId: "run",
          timestamp: 123,
          stdin: { session_id: "claude-session" },
        }),
      ),
    ).toEqual({
      event: "Stop",
      runId: "run",
      timestamp: 123,
      stdin: { session_id: "claude-session" },
    });
  });

  it("ignores malformed or unknown event lines", () => {
    expect(parseHookEventLine("{")).toBeNull();
    expect(parseHookEventLine("   ")).toBeNull();
    expect(parseHookEventLine(JSON.stringify({ event: "Unknown", timestamp: 1 }))).toBeNull();
    expect(parseHookEventLine(JSON.stringify({ event: 123, timestamp: 1 }))).toBeNull();
  });

  it("defaults the timestamp and omits non-string/optional fields", () => {
    const event = parseHookEventLine(
      JSON.stringify({
        event: "Stop",
        timestamp: "not-a-number",
        runId: 42,
        openclawSessionId: null,
        claudeSessionId: { x: 1 },
        stdin: "not-an-object",
      }),
    );
    expect(event).not.toBeNull();
    expect(event?.event).toBe("Stop");
    expect(typeof event?.timestamp).toBe("number");
    expect(event?.timestamp).toBeGreaterThan(0);
    expect(event?.runId).toBeUndefined();
    expect(event?.openclawSessionId).toBeUndefined();
    expect(event?.claudeSessionId).toBeUndefined();
    expect(event?.stdin).toBeUndefined();
  });
});
