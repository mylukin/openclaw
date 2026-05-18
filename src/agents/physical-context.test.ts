import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolvePhysicalContextId } from "./physical-context.js";

describe("resolvePhysicalContextId", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-physical-ctx-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function writeStore(
    label: string,
    entries: Record<string, Partial<SessionEntry>>,
  ): Promise<string> {
    const storePath = path.join(fixtureRoot, `${label}.json`);
    await fs.writeFile(storePath, JSON.stringify(entries), "utf-8");
    return storePath;
  }

  it("returns the persisted claude-cli session id for the requested session key", async () => {
    const storePath = await writeStore("hit", {
      "agent:chat:1": {
        sessionId: "openclaw-session",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "phys-claude-1" } },
        cliSessionIds: { "claude-cli": "phys-claude-1" },
        claudeCliSessionId: "phys-claude-1",
      },
    });
    expect(resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:1" })).toBe(
      "phys-claude-1",
    );
  });

  it("returns undefined when no binding exists, so callers fall back to sessionKey", async () => {
    const storePath = await writeStore("miss-no-binding", {
      "agent:chat:2": { sessionId: "openclaw-session", updatedAt: 1 },
    });
    expect(resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:2" })).toBeUndefined();
  });

  it("returns undefined for unknown session keys", async () => {
    const storePath = await writeStore("miss-no-entry", {
      "other:key": {
        sessionId: "x",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "phys" } },
      },
    });
    expect(
      resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:missing" }),
    ).toBeUndefined();
  });

  it("returns undefined when the store file is missing (loadSessionStore returns empty)", () => {
    // loadSessionStore is tolerant of ENOENT and yields {} rather than throwing,
    // so the debug-log path covers only harder failures (permission, parse).
    const debug = vi.fn();
    expect(
      resolvePhysicalContextId({
        storePath: path.join(fixtureRoot, "does-not-exist.json"),
        sessionKey: "agent:chat:any",
        logger: { debug },
      }),
    ).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
  });

  it("returns undefined when sessionKey is empty", () => {
    expect(resolvePhysicalContextId({ storePath: "/dev/null", sessionKey: "  " })).toBeUndefined();
  });

  it("resolves entry when store key is lowercase and sessionKey has different casing", async () => {
    const storePath = await writeStore("normalized-hit", {
      "agent:chat:norm": {
        sessionId: "s",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "phys-norm" } },
      },
    });
    expect(resolvePhysicalContextId({ storePath, sessionKey: "AGENT:CHAT:NORM" })).toBe(
      "phys-norm",
    );
  });

  it("resolves entry when store key is mixed-case (legacy) and sessionKey is normalized", async () => {
    const storePath = await writeStore("legacy-mixed", {
      "Agent:Chat:Legacy": {
        sessionId: "s",
        updatedAt: 2,
        cliSessionBindings: { "claude-cli": { sessionId: "phys-legacy" } },
      },
    });
    expect(resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:legacy" })).toBe(
      "phys-legacy",
    );
  });

  it("returns undefined when no case-insensitive match exists", async () => {
    const storePath = await writeStore("no-ci-match", {
      "totally:different": {
        sessionId: "s",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "phys-other" } },
      },
    });
    expect(
      resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:nothere" }),
    ).toBeUndefined();
  });

  it("honors a custom provider id", async () => {
    const storePath = await writeStore("provider", {
      "agent:chat:3": {
        sessionId: "x",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": { sessionId: "phys-claude-3" },
          "codex-cli": { sessionId: "phys-codex-3" },
        },
      },
    });
    expect(
      resolvePhysicalContextId({
        storePath,
        sessionKey: "agent:chat:3",
        provider: "codex-cli",
      }),
    ).toBe("phys-codex-3");
    expect(resolvePhysicalContextId({ storePath, sessionKey: "agent:chat:3" })).toBe(
      "phys-claude-3",
    );
  });
});
