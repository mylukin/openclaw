import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Session prompt file management
//
// Leaf module: only depends on node builtins so it can be imported from the
// tmux execution path without pulling in the heavy prepare.ts dependency graph
// (pi-ai, skills, tools, config). prepare.ts re-exports these symbols.
// ---------------------------------------------------------------------------

const CLAUDE_SYSTEM_PROMPT_CHUNK_MAX_CHARS = 12_000;
// Below this size, a trailing chunk is considered an "orphan" — a tiny
// fragment left over from snap-to-newline that confuses the reading agent
// (e.g. a single line like "Reasoning: off…" becoming its own part file).
// Such tails are merged back into the previous chunk.
const CLAUDE_SYSTEM_PROMPT_MIN_TAIL_CHUNK_CHARS = 1_000;

function hashSystemPromptText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export type ClaudeSystemPromptChunk = {
  index: number;
  total: number;
  filePath: string;
  totalLines: number;
};

export function resolveClaudeSystemPromptFilePath(sessionFile: string): string {
  const resolvedSessionFile = path.resolve(sessionFile);
  const sessionDir = path.dirname(resolvedSessionFile);
  const ext = path.extname(resolvedSessionFile);
  const baseName = path.basename(resolvedSessionFile, ext);
  return path.join(sessionDir, `${baseName}.claude-system-prompt.txt`);
}

function resolveClaudeSystemPromptChunkFilePath(sessionFile: string, index: number): string {
  if (index === 0) {
    return resolveClaudeSystemPromptFilePath(sessionFile);
  }
  const resolvedSessionFile = path.resolve(sessionFile);
  const sessionDir = path.dirname(resolvedSessionFile);
  const ext = path.extname(resolvedSessionFile);
  const baseName = path.basename(resolvedSessionFile, ext);
  return path.join(
    sessionDir,
    `${baseName}.part${String(index + 1).padStart(3, "0")}.claude-system-prompt.txt`,
  );
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  // Count the lines a `cat -n`-style reader would emit. Trailing newline does
  // not produce an extra blank line, matching Claude CLI Read output.
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (normalized.length === 0) {
    return text.length > 0 ? 1 : 0;
  }
  let count = 1;
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized.charCodeAt(i) === 10) {
      count += 1;
    }
  }
  return count;
}

export function splitClaudeSystemPromptIntoChunks(systemPrompt: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < systemPrompt.length) {
    let end = Math.min(offset + CLAUDE_SYSTEM_PROMPT_CHUNK_MAX_CHARS, systemPrompt.length);
    if (end < systemPrompt.length) {
      const remaining = systemPrompt.length - end;
      // Avoid leaving a tiny tail chunk behind: if snapping to the chunk
      // boundary would leave less than MIN_TAIL_CHUNK_CHARS for the final
      // part, just absorb the whole remainder into this chunk.
      if (remaining < CLAUDE_SYSTEM_PROMPT_MIN_TAIL_CHUNK_CHARS) {
        end = systemPrompt.length;
      } else {
        const newline = systemPrompt.lastIndexOf("\n", end - 1);
        if (newline >= offset + Math.floor(CLAUDE_SYSTEM_PROMPT_CHUNK_MAX_CHARS / 2)) {
          end = newline + 1;
        }
      }
    }
    chunks.push(systemPrompt.slice(offset, end));
    offset = end;
  }
  if (chunks.length === 0) {
    return [systemPrompt];
  }
  // Belt-and-suspenders: if a final chunk still ended up below the tail
  // threshold (e.g. because a snap-to-newline shifted content), merge it
  // into the previous chunk.
  if (
    chunks.length >= 2 &&
    (chunks[chunks.length - 1]?.length ?? 0) < CLAUDE_SYSTEM_PROMPT_MIN_TAIL_CHUNK_CHARS
  ) {
    const tail = chunks.pop() ?? "";
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1] ?? ""}${tail}`;
  }
  return chunks;
}

export function buildClaudeSystemPromptFileContents(systemPrompt: string): {
  contents: Array<{ text: string; totalLines: number }>;
  hash: string;
} {
  const normalizedPrompt = systemPrompt.endsWith("\n") ? systemPrompt : `${systemPrompt}\n`;
  const hash = hashSystemPromptText(normalizedPrompt);
  const chunkTexts = splitClaudeSystemPromptIntoChunks(normalizedPrompt);
  return {
    contents: chunkTexts.map((chunkText) => {
      const text = chunkText.endsWith("\n") ? chunkText : `${chunkText}\n`;
      return { text, totalLines: countLines(text) };
    }),
    hash,
  };
}

export async function writeClaudeSystemPromptFile(params: {
  sessionFile: string;
  systemPrompt: string;
}): Promise<{ filePath: string; hash: string; chunks: ClaudeSystemPromptChunk[] }> {
  const filePath = resolveClaudeSystemPromptFilePath(params.sessionFile);
  const { contents, hash } = buildClaudeSystemPromptFileContents(params.systemPrompt);
  const chunks = contents.map((entry, index) => ({
    index,
    total: contents.length,
    filePath: resolveClaudeSystemPromptChunkFilePath(params.sessionFile, index),
    totalLines: entry.totalLines,
  }));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let unchanged = true;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const content = contents[index]?.text ?? "";
    try {
      const existing = await fs.readFile(chunk.filePath, "utf-8");
      if (existing !== content) {
        unchanged = false;
      }
    } catch {
      unchanged = false;
    }
  }
  if (!unchanged) {
    for (let index = 0; index < chunks.length; index += 1) {
      await fs.writeFile(chunks[index]?.filePath ?? filePath, contents[index]?.text ?? "", {
        mode: 0o600,
      });
    }
  }
  const staleChunkPattern = `${path.basename(path.resolve(params.sessionFile), path.extname(params.sessionFile))}.part`;
  const sessionDir = path.dirname(path.resolve(params.sessionFile));
  for (const entry of await fs.readdir(sessionDir).catch(() => [])) {
    if (!entry.startsWith(staleChunkPattern) || !entry.endsWith(".claude-system-prompt.txt")) {
      continue;
    }
    const fullPath = path.join(sessionDir, entry);
    if (!chunks.some((chunk) => chunk.filePath === fullPath)) {
      await fs.rm(fullPath, { force: true }).catch(() => undefined);
    }
  }
  return { filePath, hash, chunks };
}

export function buildClaudeSystemPromptLoaderPrompt(params: {
  chunks: ClaudeSystemPromptChunk[];
  reason: "new-session" | "prompt-changed" | "compaction";
  strict?: boolean;
}): string {
  const orderedFiles = params.chunks.map((chunk) => `${chunk.index + 1}. ${chunk.filePath}`);
  const baseLines = [
    "MANDATORY FIRST STEP: use the Read tool (or lowercase read tool) to read all of the session prompt files below in exact order before you do anything else.",
    ...orderedFiles,
    "Read them sequentially from 1 to N with no offset and no limit. Do not skip, reorder, or stop early.",
    "Do not read any other file, do not call any other tool, and do not begin session startup until every listed file has been read successfully in this run.",
    "Do not answer the user, do not summarize from memory, and do not rely on prior turns until all listed files have been read in this run.",
    "The combined contents of these files are the authoritative system prompt for this session and override any remembered summaries or stale context.",
    "You must follow the combined contents of these files strictly for this turn and all subsequent turns in the session.",
  ];
  if (params.strict) {
    baseLines.unshift(
      "Your previous attempt did not verify a successful read of the session prompt file. You must read it in this run before you answer.",
    );
  }
  if (params.reason === "compaction") {
    baseLines.unshift(
      "Session context may have been compacted or summarized. You must re-read every listed session prompt file now before continuing.",
    );
  } else if (params.reason === "prompt-changed") {
    baseLines.unshift(
      "The session prompt files changed. You must re-read them completely before continuing.",
    );
  }
  return baseLines.join("\n");
}

export function buildClaudeSystemPromptCompletionPrompt(params: {
  chunks: ClaudeSystemPromptChunk[];
  startIndex: number;
}): string {
  const remaining = params.chunks.slice(params.startIndex);
  const orderedFiles = remaining.map((chunk) => `${chunk.index + 1}. ${chunk.filePath}`);
  return [
    "You have not yet completed reading all session prompt files.",
    `MANDATORY NEXT STEP: continue reading the remaining files in exact order, starting with file ${params.startIndex + 1}.`,
    ...orderedFiles,
    "Use the Read tool (or lowercase read tool) on each listed path with no offset and no limit.",
    "If you do not call Read on the next unread file, your response will be ignored.",
    "Do not read any other file first, do not answer the user yet, and do not continue until every remaining file has been read successfully in this run.",
  ].join("\n");
}
