import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_COMPACTION_TIMEOUT_MS = 30_000;
const COMPACTION_MAX_TOKENS = 4096;
const COMPACTION_MAX_INPUT_CHARS = 10_000;
const COMPACTION_MAX_FILES = 3;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

const COMPACTION_SYSTEM_PROMPT = [
  "You are a memory compaction assistant. Given the content of a memory file, produce a structured summary using EXACTLY the following template — no additional sections, no content outside the headers:",
  "",
  "## Key Rules",
  "[Essential rules and constraints from the original content]",
  "",
  "## Recent Decisions",
  "[Decisions made recently with rationale]",
  "",
  "## Open Tasks / Blockers",
  "[Active tasks, their status, and any blockers]",
  "",
  "## Critical References",
  "[Important file paths, URLs, IDs, and technical details that must be preserved exactly]",
  "",
  "RULES:",
  "- Use the exact four section headers above.",
  "- Preserve all identifiers exactly: UUIDs, IDs, file paths, URLs, IP addresses, model names, config keys.",
  "- Prioritize recent information over older information.",
  "- Keep output under 5000 characters total.",
  "- If a section has no relevant content, write '[none]' for that section.",
].join("\n");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BootstrapCompactionConfig {
  /**
   * Anthropic model to use for compaction.
   * undefined = inherited from the agent's current model (must be Anthropic).
   * Compaction only works with Anthropic models — non-Anthropic agents skip
   * compaction and fall through to the next bootstrap profile (minimal).
   */
  model?: string;
  /** Timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

export interface CompactionResult {
  /** Original file path */
  path: string;
  /** Original char count */
  charsBefore: number;
  /** Compacted char count */
  charsAfter: number;
  /** Whether compaction was attempted and succeeded */
  success: boolean;
  /** If failed, the reason */
  fallbackReason?: string;
}

// ── Content-hash cache ────────────────────────────────────────────────────────

/**
 * In-memory cache (process lifetime). Key = file path, value = { hash, compacted }.
 * Avoids redundant LLM calls when file content hasn't changed.
 */
const compactionCache = new Map<string, { hash: string; compacted: string }>();

/** Exported for testing only. */
export function clearCompactionCache(): void {
  compactionCache.clear();
}

function getContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve compaction config from OpenClawConfig.
 * Config path: cfg.agents.defaults.compaction.model / .timeoutMs
 */
export function resolveCompactionConfig(cfg?: OpenClawConfig): BootstrapCompactionConfig {
  // The existing AgentCompactionConfig type doesn't include bootstrap-specific fields,
  // so we access them via a type-erased cast. They're optional runtime extensions.
  const raw = cfg?.agents?.defaults?.compaction as unknown as
    | { model?: unknown; timeoutMs?: unknown }
    | undefined;
  return {
    model: typeof raw?.model === "string" ? raw.model : undefined,
    timeoutMs: typeof raw?.timeoutMs === "number" ? raw.timeoutMs : undefined,
  };
}

/**
 * Check if a bootstrap file is eligible for compaction.
 * Only MEMORY.md and memory/YYYY-MM-DD.md files can be compacted.
 */
export function isCompactableFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (basename === "MEMORY.md") {
    return true;
  }
  // Match memory/YYYY-MM-DD.md pattern
  if (/^20\d{2}-\d{2}-\d{2}\.md$/.test(basename)) {
    const dir = path.basename(path.dirname(filePath));
    return dir === "memory";
  }
  return false;
}

// ── Internal: LLM call via fetch ──────────────────────────────────────────────

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicMessagesResponse {
  content: AnthropicTextBlock[];
}

async function callAnthropicApi(params: {
  apiKey: string;
  model: string;
  system: string;
  userContent: string;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<string> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: [{ role: "user", content: params.userContent }],
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as AnthropicMessagesResponse;
  const textBlocks = data.content.filter((b) => b.type === "text");
  if (textBlocks.length === 0) {
    throw new Error("No text content in Anthropic response");
  }
  return textBlocks.map((b) => b.text).join("\n");
}

// ── Core compaction functions ─────────────────────────────────────────────────

/**
 * Compact a single bootstrap file using LLM summarization.
 *
 * Uses content-hash caching: if the file content hasn't changed since last
 * compaction, returns the cached result without calling the LLM.
 *
 * Always returns successfully — on LLM failure, returns the original content
 * with success=false and fallbackReason set.
 */
/**
 * Known Anthropic provider strings. Compaction requires an Anthropic model;
 * non-Anthropic providers are rejected early with a clear fallback reason.
 */
const ANTHROPIC_PROVIDERS = new Set(["anthropic", "anthropic-vertex", "anthropic-bedrock"]);

export function isAnthropicProvider(provider: string): boolean {
  return ANTHROPIC_PROVIDERS.has(provider);
}

export async function compactBootstrapFile(params: {
  content: string;
  filePath: string;
  config: BootstrapCompactionConfig;
  /** Fallback model when config.model is not set. Must be an Anthropic model. */
  defaultModel: string;
  /** Provider of the agent. Used to verify Anthropic compatibility. */
  provider: string;
  apiKeyResolver: () => Promise<{ apiKey: string; provider: string }>;
  signal?: AbortSignal;
}): Promise<{ compacted: string; result: CompactionResult }> {
  const { content, filePath, config, signal } = params;
  const charsBefore = content.length;

  // Compaction is Anthropic-only. If config.model is set, it's expected to be
  // an Anthropic model. If not set, we inherit the agent's model but only when
  // the agent itself is using an Anthropic provider.
  if (!config.model && !isAnthropicProvider(params.provider)) {
    return {
      compacted: content,
      result: {
        path: filePath,
        charsBefore,
        charsAfter: charsBefore,
        success: false,
        fallbackReason: `compaction skipped: provider "${params.provider}" is not Anthropic`,
      },
    };
  }

  const compactionModel = config.model ?? params.defaultModel;

  // Enforce max input size — head+tail split to preserve recent content at end of file.
  // MEMORY.md and daily memory files have latest entries at the bottom.
  let inputContent: string;
  if (content.length > COMPACTION_MAX_INPUT_CHARS) {
    const headChars = Math.floor(COMPACTION_MAX_INPUT_CHARS * 0.3);
    const tailChars = COMPACTION_MAX_INPUT_CHARS - headChars;
    inputContent =
      content.slice(0, headChars) +
      "\n\n[... middle content omitted for compaction ...]\n\n" +
      content.slice(-tailChars);
  } else {
    inputContent = content;
  }

  // Cache lookup
  const contentHash = getContentHash(inputContent);
  const cached = compactionCache.get(filePath);
  if (cached?.hash === contentHash) {
    return {
      compacted: cached.compacted,
      result: {
        path: filePath,
        charsBefore,
        charsAfter: cached.compacted.length,
        success: true,
      },
    };
  }

  try {
    const { apiKey } = await params.apiKeyResolver();
    const compacted = await callAnthropicApi({
      apiKey,
      model: compactionModel,
      system: COMPACTION_SYSTEM_PROMPT,
      userContent: inputContent,
      maxTokens: COMPACTION_MAX_TOKENS,
      signal,
    });

    compactionCache.set(filePath, { hash: contentHash, compacted });

    return {
      compacted,
      result: {
        path: filePath,
        charsBefore,
        charsAfter: compacted.length,
        success: true,
      },
    };
  } catch (err) {
    const fallbackReason = err instanceof Error ? err.message : String(err);
    return {
      compacted: content,
      result: {
        path: filePath,
        charsBefore,
        charsAfter: charsBefore,
        success: false,
        fallbackReason,
      },
    };
  }
}

/**
 * Try to compact eligible files in a bootstrap context file list.
 * Selects up to COMPACTION_MAX_FILES largest compactable files.
 * Returns new context files with compacted content + per-file results.
 */
export async function compactBootstrapFiles(params: {
  contextFiles: EmbeddedContextFile[];
  config: BootstrapCompactionConfig;
  /** Fallback model when config.model is not set. Must be an Anthropic model. */
  defaultModel: string;
  /** Provider of the agent. Used to verify Anthropic compatibility. */
  provider: string;
  apiKeyResolver: () => Promise<{ apiKey: string; provider: string }>;
  signal?: AbortSignal;
}): Promise<{
  contextFiles: EmbeddedContextFile[];
  results: CompactionResult[];
}> {
  const { contextFiles, config, signal } = params;

  // Select compactable files, sorted by size descending, capped at max
  const compactable = contextFiles
    .filter((f) => isCompactableFile(f.path))
    .toSorted((a, b) => b.content.length - a.content.length)
    .slice(0, COMPACTION_MAX_FILES);

  if (compactable.length === 0) {
    return { contextFiles, results: [] };
  }

  const compactableSet = new Set(compactable.map((f) => f.path));
  const results: CompactionResult[] = [];
  const compactedMap = new Map<string, string>();

  for (const file of compactable) {
    const { compacted, result } = await compactBootstrapFile({
      content: file.content,
      filePath: file.path,
      config,
      defaultModel: params.defaultModel,
      provider: params.provider,
      apiKeyResolver: params.apiKeyResolver,
      signal,
    });
    results.push(result);
    if (result.success) {
      compactedMap.set(file.path, compacted);
    }
  }

  // Rebuild context files list with compacted content where successful
  const updatedContextFiles = contextFiles.map((f) => {
    if (compactableSet.has(f.path) && compactedMap.has(f.path)) {
      return { ...f, content: compactedMap.get(f.path) as string };
    }
    return f;
  });

  return { contextFiles: updatedContextFiles, results };
}
