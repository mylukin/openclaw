import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Claude Code writes structured session transcripts as JSONL under
// `<configDir>/projects/<cwd-slug>/<sessionId>.jsonl`. Each *content block*
// is its own JSONL line. Multiple blocks of the same logical assistant
// message share `message.id` but have distinct `uuid`s. Critically, when the
// model emits a parallel batch of tool_use blocks, Claude Code writes each
// block on its own line AND writes each tool_result line as soon as that tool
// finishes — so results interleave BEFORE later tool_use lines of the same
// message. Raw file order is therefore NOT a canonical (text → tool_use →
// tool_result) stream.
//
// To present a canonical stream we buffer assistant blocks per `message.id`,
// seal a message when a different assistant message or a user turn appears,
// and emit its blocks in true content order (thinking, text, tool_use). A
// tool_result is only emitted once its matching tool_use has been emitted
// (orphan results are buffered), so downstream observers never see a result
// before its start.

export function workspaceSlug(workspaceDir: string): string {
  return workspaceDir.replaceAll(/[/\\]/g, "-");
}

export function resolveTranscriptPath(params: {
  configDir?: string;
  workspaceDir: string;
  sessionId: string;
}): string {
  const baseDir = params.configDir ?? path.join(os.homedir(), ".claude");
  return path.join(
    baseDir,
    "projects",
    workspaceSlug(params.workspaceDir),
    `${params.sessionId}.jsonl`,
  );
}

/**
 * Locate the most recent Claude session JSONL touched after `sinceMs` in the
 * project dir for this workspace. Used as a post-run fallback when the
 * SessionStart hook never delivered a session id but Claude still wrote a
 * transcript on disk. Returns undefined if the project dir is missing, has
 * no JSONL files, or none are fresh enough to belong to this run.
 */
export async function findLatestTranscriptFile(params: {
  configDir?: string;
  workspaceDir: string;
  sinceMs: number;
}): Promise<string | undefined> {
  const baseDir = params.configDir ?? path.join(os.homedir(), ".claude");
  const projectDir = path.join(baseDir, "projects", workspaceSlug(params.workspaceDir));
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { file: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const full = path.join(projectDir, entry.name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < params.sinceMs) {
        continue;
      }
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { file: full, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // skip races
    }
  }
  return best?.file;
}

export type TranscriptSegment =
  | { kind: "text"; text: string; final: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; toolUseId?: string; input?: unknown }
  | { kind: "tool_result"; toolUseId?: string; text?: string; isError?: boolean };

type RawBlock = Record<string, unknown>;

type PendingMessage = {
  messageId: string;
  thinking: string[];
  text: string[];
  // A message whose stop_reason is "tool_use" is interim narration (the model
  // is about to call a tool); anything else (end_turn / stop_sequence / null)
  // carries the final reply text for that message.
  finalText: boolean;
  toolUses: Array<{ name: string; toolUseId?: string; input?: unknown }>;
};

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (content === undefined || content === null) {
    return undefined;
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (entry && typeof entry === "object") {
        const block = entry as RawBlock;
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
          continue;
        }
      }
      try {
        parts.push(JSON.stringify(entry));
      } catch {
        // Unserializable (circular) entry — skip rather than emit
        // "[object Object]".
      }
    }
    return parts.join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return undefined;
  }
}

// OpenClaw pastes the serialized conversation context (XML message
// envelopes + Feishu "[Pasted text #N +M lines]" placeholders) into the
// tmux Claude as its prompt. When that blob is large the model frequently
// reproduces fragments of the envelope verbatim in its own reply, which
// then leaks into the Feishu card and wrecks readability. These are
// unambiguous machine tokens (never legitimate assistant prose), so strip
// them from captured assistant text. Anchored patterns only — generic
// markdown/XML the model writes intentionally is left untouched.
const PROMPT_ENVELOPE_PATTERNS: RegExp[] = [
  // Feishu paste placeholder: "[Pasted text #29 +35 lines]" and the
  // space-collapsed "[Pastedtext#29+35lines]" variant.
  /\[Pasted\s*text\s*#\d+\s*\+\s*\d+\s*lines?\]/gi,
  // Conversation envelope open/close: <message ...>, <messageindex="2" ...>,
  // <message dex="2" ...>, </message>, </messe> (truncated paste).
  /<\/?messa?ge?(?:index)?\b[^>]*>/gi,
  /<messageindex=[^>]*>/gi,
  // Mention envelope: <atid=ou_xxx></at>, <at user_id="...">...</at> wrappers.
  /<atid=[^>]*>/gi,
  /<\/at>/gi,
  /<at\s+user_id="[^"]*">/gi,
  // Stray serialized metadata attribute runs left on their own lines.
  /(?:^|\s)(?:sender_type|sender_name|sender_id|content_type|created_at|messageindex|message_id|id)="[^"]*"/gi,
];

export function stripPromptEnvelopeArtifacts(text: string): string {
  let out = text;
  for (const re of PROMPT_ENVELOPE_PATTERNS) {
    out = out.replace(re, "");
  }
  // Collapse the blank-line debris left where envelopes were removed.
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Concatenate text records for the same message. Claude normally writes one
// complete text block per message, but if a build streams partial then full
// text records, treat a later record that extends an earlier one as the
// canonical (replace), otherwise join distinct paragraphs with a blank line.
function joinMessageText(parts: string[]): string {
  let out = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (!out) {
      out = part;
      continue;
    }
    if (part.startsWith(out)) {
      out = part;
    } else if (out.startsWith(part)) {
      // keep the longer existing text
    } else {
      out = `${out}\n\n${part}`;
    }
  }
  return out;
}

export type TranscriptUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export class TranscriptTailer {
  private offset = 0;
  private buffer = "";
  private accumulatedText = "";
  // Text of the latest final (non-tool_use) assistant message. This is the
  // turn's actual deliverable — interim narration before tool calls is not.
  private finalReplyText = "";
  private readonly seenUuids = new Set<string>();
  // Assistant message currently being buffered (sealed when a different
  // message id or a user turn arrives).
  private pending: PendingMessage | undefined;
  // tool_use ids already emitted downstream — gates tool_result emission.
  private readonly emittedToolUseIds = new Set<string>();
  // tool_result blocks seen before their tool_use was emitted.
  private readonly orphanResults = new Map<string, TranscriptSegment>();
  // Latest assistant `message.usage` seen on this run. Used to populate
  // CliOutput.usage so /status (which reads usage from the openclaw session
  // transcript) shows real Context numbers instead of 0/200k.
  private lastUsage: TranscriptUsage | undefined;

  constructor(
    private readonly filePath: string,
    private readonly startedAt: number,
  ) {}

  async poll(): Promise<TranscriptSegment[]> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, "r");
    } catch {
      return [];
    }
    let chunk = "";
    try {
      const stat = await handle.stat();
      if (stat.size <= this.offset) {
        return [];
      }
      const length = stat.size - this.offset;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, this.offset);
      this.offset = stat.size;
      chunk = buf.toString("utf8");
    } finally {
      await handle.close();
    }
    this.buffer += chunk;
    const segments: TranscriptSegment[] = [];
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.consumeLine(line, segments);
      newlineIdx = this.buffer.indexOf("\n");
    }
    return segments;
  }

  /**
   * Flush any buffered-but-not-yet-sealed assistant message. Call this once
   * the run has ended (Stop hook + drain) so the final message's blocks are
   * not lost waiting for a successor that will never arrive.
   */
  flushPending(): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    this.sealPending(segments);
    return segments;
  }

  /** Cumulative assistant text seen so far (joined with blank lines). */
  getText(): string {
    return this.accumulatedText.trim();
  }

  /**
   * Text of the final (non-tool_use) assistant message — the turn's actual
   * deliverable. Empty if the run only produced interim narration. Used to
   * decide silent (NO_REPLY) disposition without the narration polluting it.
   */
  getFinalReplyText(): string {
    return this.finalReplyText.trim();
  }

  /** Latest assistant message.usage seen on this run, or undefined if none. */
  getLastUsage(): TranscriptUsage | undefined {
    return this.lastUsage ? { ...this.lastUsage } : undefined;
  }

  /** Path of the transcript file this tailer is reading. */
  getFilePath(): string {
    return this.filePath;
  }

  private consumeLine(line: string, out: TranscriptSegment[]): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const ts = parseTimestamp(parsed.timestamp);
    if (Number.isFinite(ts) && ts < this.startedAt) {
      return;
    }
    const uuid = typeof parsed.uuid === "string" ? parsed.uuid : undefined;
    if (uuid) {
      if (this.seenUuids.has(uuid)) {
        return;
      }
      this.seenUuids.add(uuid);
    }
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? (message?.content as RawBlock[]) : [];
    if (parsed.type === "assistant") {
      const messageId = typeof message?.id === "string" && message.id ? message.id : (uuid ?? "");
      if (this.pending && this.pending.messageId !== messageId) {
        // A new assistant message starts: the previous one is complete.
        this.sealPending(out);
      }
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        // Anthropic shape: input_tokens / output_tokens /
        // cache_read_input_tokens / cache_creation_input_tokens. Take the
        // latest non-zero values (later records on the same message carry
        // updated counts).
        const next: TranscriptUsage = { ...this.lastUsage };
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
        const input = num(usage.input_tokens);
        const output = num(usage.output_tokens);
        const cacheRead = num(usage.cache_read_input_tokens);
        const cacheWrite = num(usage.cache_creation_input_tokens);
        if (input !== undefined) {
          next.input = input;
        }
        if (output !== undefined) {
          next.output = output;
        }
        if (cacheRead !== undefined) {
          next.cacheRead = cacheRead;
        }
        if (cacheWrite !== undefined) {
          next.cacheWrite = cacheWrite;
        }
        this.lastUsage = next;
      }
      const stopReason = typeof message?.stop_reason === "string" ? message.stop_reason : undefined;
      if (!this.pending) {
        this.pending = {
          messageId,
          thinking: [],
          text: [],
          finalText: stopReason !== "tool_use",
          toolUses: [],
        };
      } else if (stopReason !== undefined) {
        // Later records of the same message carry the authoritative
        // stop_reason (the text block record vs the tool_use record).
        this.pending.finalText = stopReason !== "tool_use";
      }
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          this.pending.text.push(block.text);
        } else if (block.type === "thinking") {
          const tk =
            typeof block.thinking === "string"
              ? block.thinking
              : typeof block.text === "string"
                ? block.text
                : "";
          if (tk.trim()) {
            this.pending.thinking.push(tk);
          }
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          this.pending.toolUses.push({
            name: block.name,
            ...(typeof block.id === "string" ? { toolUseId: block.id } : {}),
            ...(block.input !== undefined ? { input: block.input } : {}),
          });
        }
      }
      return;
    }
    if (parsed.type === "user") {
      // A user turn seals the in-flight assistant message. Tool-result user
      // turns still seal it (the assistant message that issued the tools is
      // complete once results start coming back).
      this.sealPending(out);
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") {
          continue;
        }
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const isError = block.is_error === true;
        const text = stringifyToolResultContent(block.content);
        const segment: TranscriptSegment = {
          kind: "tool_result",
          ...(toolUseId ? { toolUseId } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(isError ? { isError: true } : {}),
        };
        if (toolUseId && !this.emittedToolUseIds.has(toolUseId)) {
          // Result arrived before its tool_use was emitted (parallel batch
          // interleaving). Hold it until the tool_use flushes.
          this.orphanResults.set(toolUseId, segment);
        } else {
          out.push(segment);
        }
      }
    }
  }

  private sealPending(out: TranscriptSegment[]): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    for (const thinking of pending.thinking) {
      out.push({ kind: "thinking", text: thinking });
    }
    const text = stripPromptEnvelopeArtifacts(joinMessageText(pending.text));
    if (text.trim()) {
      this.accumulatedText = this.accumulatedText ? `${this.accumulatedText}\n\n${text}` : text;
      if (pending.finalText) {
        // Latest final (end_turn) message wins as the turn's deliverable.
        this.finalReplyText = text;
      }
      out.push({ kind: "text", text, final: pending.finalText });
    }
    for (const toolUse of pending.toolUses) {
      out.push({
        kind: "tool_use",
        name: toolUse.name,
        ...(toolUse.toolUseId ? { toolUseId: toolUse.toolUseId } : {}),
        ...(toolUse.input !== undefined ? { input: toolUse.input } : {}),
      });
      if (toolUse.toolUseId) {
        this.emittedToolUseIds.add(toolUse.toolUseId);
        const orphan = this.orphanResults.get(toolUse.toolUseId);
        if (orphan) {
          this.orphanResults.delete(toolUse.toolUseId);
          out.push(orphan);
        }
      }
    }
  }
}
