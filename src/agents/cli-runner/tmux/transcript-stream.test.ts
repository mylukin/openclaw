import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTranscriptPath, TranscriptTailer, workspaceSlug } from "./transcript-stream.js";

describe("workspaceSlug", () => {
  it("replaces forward slashes with hyphens", () => {
    expect(workspaceSlug("/Users/lukin")).toBe("-Users-lukin");
    expect(workspaceSlug("/private/tmp/llm/218")).toBe("-private-tmp-llm-218");
  });

  it("replaces backslashes for Windows paths", () => {
    expect(workspaceSlug("C:\\\\Users\\\\foo")).toBe("C:--Users--foo");
  });
});

describe("resolveTranscriptPath", () => {
  it("uses CLAUDE_CONFIG_DIR when provided", () => {
    expect(
      resolveTranscriptPath({
        configDir: "/srv/cfg",
        workspaceDir: "/Users/lukin",
        sessionId: "abc",
      }),
    ).toBe("/srv/cfg/projects/-Users-lukin/abc.jsonl");
  });

  it("defaults to ~/.claude when configDir omitted", () => {
    const home = os.homedir();
    expect(resolveTranscriptPath({ workspaceDir: "/Users/lukin", sessionId: "abc" })).toBe(
      `${home}/.claude/projects/-Users-lukin/abc.jsonl`,
    );
  });
});

describe("TranscriptTailer", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-test-"));
    tempDirs.push(dir);
    return path.join(dir, "session.jsonl");
  }

  function assistantLine(params: {
    uuid: string;
    messageId: string;
    timestampMs: number;
    content: Array<Record<string, unknown>>;
  }): string {
    return `${JSON.stringify({
      type: "assistant",
      uuid: params.uuid,
      timestamp: new Date(params.timestampMs).toISOString(),
      message: { id: params.messageId, role: "assistant", content: params.content },
    })}\n`;
  }

  function userToolResultLine(params: {
    uuid: string;
    timestampMs: number;
    results: Array<{ toolUseId: string; content: unknown; isError?: boolean }>;
  }): string {
    return `${JSON.stringify({
      type: "user",
      uuid: params.uuid,
      timestamp: new Date(params.timestampMs).toISOString(),
      message: {
        role: "user",
        content: params.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      },
    })}\n`;
  }

  it("returns no segments when the file does not exist", async () => {
    const file = await makeFile();
    const tailer = new TranscriptTailer(file, Date.now());
    expect(await tailer.poll()).toEqual([]);
    expect(tailer.getText()).toBe("");
  });

  it("buffers a message until it is sealed, then flushPending emits it", async () => {
    const file = await makeFile();
    const startedAt = 1_000;
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "a-1",
        messageId: "m1",
        timestampMs: startedAt + 100,
        content: [{ type: "text", text: "hello world" }],
      }),
    );
    const tailer = new TranscriptTailer(file, startedAt);
    // Not sealed yet — no successor message / user turn.
    expect(await tailer.poll()).toEqual([]);
    expect(tailer.flushPending()).toEqual([{ kind: "text", text: "hello world", final: true }]);
    expect(tailer.getText()).toBe("hello world");
  });

  it("seals a message when a different message id starts", async () => {
    const file = await makeFile();
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "a-1",
        messageId: "m1",
        timestampMs: 1,
        content: [{ type: "text", text: "first" }],
      }) +
        assistantLine({
          uuid: "a-2",
          messageId: "m2",
          timestampMs: 2,
          content: [{ type: "text", text: "second" }],
        }),
    );
    const tailer = new TranscriptTailer(file, 0);
    // m1 sealed by m2 starting; m2 still buffered.
    expect(await tailer.poll()).toEqual([{ kind: "text", text: "first", final: true }]);
    expect(tailer.flushPending()).toEqual([{ kind: "text", text: "second", final: true }]);
  });

  it("filters out entries older than startedAt", async () => {
    const file = await makeFile();
    const startedAt = 5_000;
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "old",
        messageId: "m-old",
        timestampMs: startedAt - 1_000,
        content: [{ type: "text", text: "stale" }],
      }),
    );
    const tailer = new TranscriptTailer(file, startedAt);
    expect(await tailer.poll()).toEqual([]);
    expect(tailer.flushPending()).toEqual([]);
  });

  it("dedupes by uuid", async () => {
    const file = await makeFile();
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "dup",
        messageId: "m1",
        timestampMs: 1,
        content: [{ type: "text", text: "once" }],
      }) +
        assistantLine({
          uuid: "dup",
          messageId: "m1",
          timestampMs: 1,
          content: [{ type: "text", text: "once" }],
        }),
    );
    const tailer = new TranscriptTailer(file, 0);
    await tailer.poll();
    expect(tailer.flushPending()).toEqual([{ kind: "text", text: "once", final: true }]);
  });

  it("emits a message's blocks in canonical order: thinking, text, tool_use", async () => {
    const file = await makeFile();
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "a-1",
        messageId: "m1",
        timestampMs: 1,
        content: [{ type: "thinking", thinking: "ponder" }],
      }) +
        assistantLine({
          uuid: "a-2",
          messageId: "m1",
          timestampMs: 2,
          content: [{ type: "text", text: "intro" }],
        }) +
        assistantLine({
          uuid: "a-3",
          messageId: "m1",
          timestampMs: 3,
          content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { f: "a" } }],
        }),
    );
    const tailer = new TranscriptTailer(file, 0);
    await tailer.poll();
    expect(tailer.flushPending()).toEqual([
      { kind: "thinking", text: "ponder" },
      { kind: "text", text: "intro", final: true },
      { kind: "tool_use", name: "Read", toolUseId: "tu-1", input: { f: "a" } },
    ]);
  });

  it("holds a tool_result that arrives before its tool_use, then pairs it on flush", async () => {
    // Parallel-batch interleaving: tool_result for tu-2 lands before the
    // tool_use line for tu-2 (which comes later in the same message).
    const file = await makeFile();
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "a-1",
        messageId: "m1",
        timestampMs: 1,
        content: [{ type: "tool_use", id: "tu-1", name: "Read" }],
      }) +
        userToolResultLine({
          uuid: "u-1",
          timestampMs: 2,
          results: [
            { toolUseId: "tu-1", content: "r1" },
            { toolUseId: "tu-2", content: "r2" },
          ],
        }) +
        assistantLine({
          uuid: "a-2",
          messageId: "m1",
          timestampMs: 3,
          content: [{ type: "tool_use", id: "tu-2", name: "Read" }],
        }),
    );
    const tailer = new TranscriptTailer(file, 0);
    // u-1 seals m1's first chunk: tool_use tu-1 emitted, its result emitted,
    // tu-2's result is orphaned (its tool_use not yet emitted).
    const first = await tailer.poll();
    expect(first).toEqual([
      { kind: "tool_use", name: "Read", toolUseId: "tu-1" },
      { kind: "tool_result", toolUseId: "tu-1", text: "r1" },
    ]);
    // tu-2's tool_use is still buffered; flushPending emits it + paired result.
    expect(tailer.flushPending()).toEqual([
      { kind: "tool_use", name: "Read", toolUseId: "tu-2" },
      { kind: "tool_result", toolUseId: "tu-2", text: "r2" },
    ]);
  });

  it("marks tool_result errors and stringifies array content", async () => {
    const file = await makeFile();
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "a-1",
        messageId: "m1",
        timestampMs: 1,
        content: [{ type: "tool_use", id: "tu-1", name: "Bash" }],
      }) +
        userToolResultLine({
          uuid: "u-1",
          timestampMs: 2,
          results: [
            { toolUseId: "tu-1", content: [{ type: "text", text: "boom" }], isError: true },
          ],
        }),
    );
    const tailer = new TranscriptTailer(file, 0);
    expect(await tailer.poll()).toEqual([
      { kind: "tool_use", name: "Bash", toolUseId: "tu-1" },
      { kind: "tool_result", toolUseId: "tu-1", text: "boom", isError: true },
    ]);
  });

  it("concatenates streamed/partial text records of the same message", async () => {
    const file = await makeFile();
    await fs.writeFile(
      file,
      assistantLine({
        uuid: "a-1",
        messageId: "m1",
        timestampMs: 1,
        content: [{ type: "text", text: "Now" }],
      }) +
        assistantLine({
          uuid: "a-2",
          messageId: "m1",
          timestampMs: 2,
          content: [{ type: "text", text: "Now reading the session startup files." }],
        }),
    );
    const tailer = new TranscriptTailer(file, 0);
    await tailer.poll();
    // "Now" then a cumulative-extending record collapses to one text segment.
    expect(tailer.flushPending()).toEqual([
      { kind: "text", text: "Now reading the session startup files.", final: true },
    ]);
  });

  it("marks tool_use-stop text as interim and excludes it from the final reply", async () => {
    // Mirrors a real run: the model narrates ("Now I'll run the audit.") with
    // stop_reason=tool_use, calls tools, then ends with NO_REPLY (end_turn).
    // The final reply is NO_REPLY only; narration is interim (final:false).
    const file = await makeFile();
    await fs.writeFile(
      file,
      `${JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        timestamp: new Date(1).toISOString(),
        message: {
          id: "m1",
          stop_reason: "tool_use",
          content: [{ type: "text", text: "Now I'll run the audit." }],
        },
      })}\n${JSON.stringify({
        type: "assistant",
        uuid: "a-2",
        timestamp: new Date(2).toISOString(),
        message: {
          id: "m1",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash" }],
        },
      })}\n${JSON.stringify({
        type: "user",
        uuid: "u-1",
        timestamp: new Date(3).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] },
      })}\n${JSON.stringify({
        type: "assistant",
        uuid: "a-3",
        timestamp: new Date(4).toISOString(),
        message: {
          id: "m2",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "NO_REPLY" }],
        },
      })}\n`,
    );
    const tailer = new TranscriptTailer(file, 0);
    const first = await tailer.poll();
    expect(first).toEqual([
      { kind: "text", text: "Now I'll run the audit.", final: false },
      { kind: "tool_use", name: "Bash", toolUseId: "tu-1" },
      { kind: "tool_result", toolUseId: "tu-1", text: "ok" },
    ]);
    expect(tailer.flushPending()).toEqual([{ kind: "text", text: "NO_REPLY", final: true }]);
    // Narration is excluded; only the end_turn message is the deliverable.
    expect(tailer.getFinalReplyText()).toBe("NO_REPLY");
    expect(tailer.getText()).toContain("Now I'll run the audit.");
  });

  it("handles partial lines across polls", async () => {
    const file = await makeFile();
    const full = assistantLine({
      uuid: "b",
      messageId: "m1",
      timestampMs: 1,
      content: [{ type: "text", text: "buffered" }],
    });
    const split = full.length - 5;
    await fs.writeFile(file, full.slice(0, split));
    const tailer = new TranscriptTailer(file, 0);
    expect(await tailer.poll()).toEqual([]);
    await fs.appendFile(file, full.slice(split));
    await tailer.poll();
    expect(tailer.flushPending()).toEqual([{ kind: "text", text: "buffered", final: true }]);
  });
});
