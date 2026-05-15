import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureTmuxRuntimeDir, resolveTmuxRuntimePaths } from "./runtime-dir.js";

describe("resolveTmuxRuntimePaths", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses an explicit runtimeDir when provided", () => {
    const paths = resolveTmuxRuntimePaths({ runtimeDir: "/custom/root", sessionName: "sess-1" });
    expect(paths.rootDir).toBe(path.join("/custom/root", "sess-1"));
    expect(paths.eventsFile).toBe(path.join("/custom/root", "sess-1", "events.jsonl"));
    expect(paths.metadataFile).toBe(path.join("/custom/root", "sess-1", "metadata.json"));
  });

  it("falls back to the preferred OpenClaw tmp dir when runtimeDir is blank", () => {
    const paths = resolveTmuxRuntimePaths({ runtimeDir: "   ", sessionName: "sess-2" });
    expect(paths.rootDir).toContain(path.join("claude-tmux", "sess-2"));
    expect(paths.paneLogFile.endsWith(path.join("sess-2", "pane.log"))).toBe(true);
  });

  it("creates the root directory recursively", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rtdir-test-"));
    tempDirs.push(base);
    const paths = resolveTmuxRuntimePaths({
      runtimeDir: path.join(base, "nested"),
      sessionName: "sess-3",
    });
    await ensureTmuxRuntimeDir(paths);
    await expect(fs.stat(paths.rootDir)).resolves.toBeTruthy();
  });
});
