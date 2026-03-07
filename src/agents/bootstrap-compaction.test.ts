import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BootstrapCompactionConfig,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  clearCompactionCache,
  compactBootstrapFile,
  compactBootstrapFiles,
  isAnthropicProvider,
  isCompactableFile,
  resolveCompactionConfig,
} from "./bootstrap-compaction.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFetchResponse(text: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(`{"error":"${text}"}`),
    json: () =>
      Promise.resolve({
        content: [{ type: "text", text }],
      }),
  } as unknown as Response;
}

function makeApiKeyResolver(
  apiKey = "test-key",
): () => Promise<{ apiKey: string; provider: string }> {
  return () => Promise.resolve({ apiKey, provider: "anthropic" });
}

const TEST_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const STRUCTURED_SUMMARY = `## Key Rules
- Rule A
- Rule B

## Recent Decisions
- Decision X made because Y

## Open Tasks / Blockers
- Task 1: in-progress

## Critical References
- /path/to/file.ts`;

// ── isCompactableFile ─────────────────────────────────────────────────────────

describe("isCompactableFile", () => {
  it("accepts MEMORY.md", () => {
    expect(isCompactableFile("/workspace/MEMORY.md")).toBe(true);
    expect(isCompactableFile("MEMORY.md")).toBe(true);
  });

  it("accepts memory/YYYY-MM-DD.md", () => {
    expect(isCompactableFile("/workspace/memory/2026-03-07.md")).toBe(true);
    expect(isCompactableFile("memory/2024-01-01.md")).toBe(true);
    expect(isCompactableFile("/home/user/memory/2025-12-31.md")).toBe(true);
  });

  it("rejects AGENTS.md", () => {
    expect(isCompactableFile("/workspace/AGENTS.md")).toBe(false);
  });

  it("rejects SOUL.md", () => {
    expect(isCompactableFile("/workspace/SOUL.md")).toBe(false);
  });

  it("rejects IDENTITY.md", () => {
    expect(isCompactableFile("IDENTITY.md")).toBe(false);
  });

  it("rejects CONSTITUTION.md", () => {
    expect(isCompactableFile("/workspace/CONSTITUTION.md")).toBe(false);
  });

  it("rejects arbitrary .md files", () => {
    expect(isCompactableFile("/workspace/README.md")).toBe(false);
    expect(isCompactableFile("/workspace/TOOLS.md")).toBe(false);
    expect(isCompactableFile("/workspace/memory/notes.md")).toBe(false);
  });

  it("rejects MEMORY.md in wrong directory (date-like name but wrong parent)", () => {
    // A date-named .md that is not inside a 'memory' directory
    expect(isCompactableFile("/workspace/logs/2026-03-07.md")).toBe(false);
  });

  it("accepts memory/YYYY-MM-DD.md only when parent dir is 'memory'", () => {
    expect(isCompactableFile("/workspace/archive/2026-03-07.md")).toBe(false);
    expect(isCompactableFile("/workspace/memory/2026-03-07.md")).toBe(true);
  });
});

// ── resolveCompactionConfig ───────────────────────────────────────────────────

describe("resolveCompactionConfig", () => {
  it("returns empty config when cfg is undefined", () => {
    const result = resolveCompactionConfig(undefined);
    expect(result.model).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
  });

  it("returns empty config when agents.defaults.compaction is absent", () => {
    const result = resolveCompactionConfig({ agents: { defaults: {} } } as never);
    expect(result.model).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
  });

  it("reads model from config", () => {
    const cfg = {
      agents: { defaults: { compaction: { model: "claude-haiku-4-5-20251001" } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  it("reads timeoutMs from config", () => {
    const cfg = {
      agents: { defaults: { compaction: { timeoutMs: 15_000 } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.timeoutMs).toBe(15_000);
  });

  it("reads both model and timeoutMs from config", () => {
    const cfg = {
      agents: {
        defaults: { compaction: { model: "claude-opus-4-6", timeoutMs: 60_000 } },
      },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.timeoutMs).toBe(60_000);
  });

  it("ignores non-string model values", () => {
    const cfg = {
      agents: { defaults: { compaction: { model: 42 } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.model).toBeUndefined();
  });

  it("ignores non-number timeoutMs values", () => {
    const cfg = {
      agents: { defaults: { compaction: { timeoutMs: "30000" } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.timeoutMs).toBeUndefined();
  });

  it("DEFAULT_COMPACTION_TIMEOUT_MS is 30 seconds", () => {
    expect(DEFAULT_COMPACTION_TIMEOUT_MS).toBe(30_000);
  });
});

// ── isAnthropicProvider ──────────────────────────────────────────────────────

describe("isAnthropicProvider", () => {
  it("recognizes anthropic providers", () => {
    expect(isAnthropicProvider("anthropic")).toBe(true);
    expect(isAnthropicProvider("anthropic-vertex")).toBe(true);
    expect(isAnthropicProvider("anthropic-bedrock")).toBe(true);
  });

  it("rejects non-anthropic providers", () => {
    expect(isAnthropicProvider("openai-crs")).toBe(false);
    expect(isAnthropicProvider("claude-cli")).toBe(false);
    expect(isAnthropicProvider("vllm-local")).toBe(false);
    expect(isAnthropicProvider("")).toBe(false);
  });
});

// ── compactBootstrapFile ──────────────────────────────────────────────────────

describe("compactBootstrapFile", () => {
  beforeEach(() => {
    clearCompactionCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Anthropic API and returns compacted content", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const { compacted, result } = await compactBootstrapFile({
      content: "Some long memory content that needs compaction.",
      filePath: "/workspace/MEMORY.md",
      config: { model: "claude-haiku-4-5-20251001" },
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(compacted).toBe(STRUCTURED_SUMMARY);
    expect(result.success).toBe(true);
    expect(result.path).toBe("/workspace/MEMORY.md");
    expect(result.charsBefore).toBe("Some long memory content that needs compaction.".length);
    expect(result.charsAfter).toBe(STRUCTURED_SUMMARY.length);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("sends correct Anthropic API request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    await compactBootstrapFile({
      content: "Memory content",
      filePath: "/workspace/MEMORY.md",
      config: { model: "claude-haiku-4-5-20251001" },
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver("my-api-key"),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "my-api-key",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toHaveLength(1);
    expect((body.messages as Array<{ role: string }>)[0].role).toBe("user");
  });

  it("uses defaultModel when config.model is undefined", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    await compactBootstrapFile({
      content: "Memory content",
      filePath: "/workspace/MEMORY.md",
      config: {},
      defaultModel: "my-custom-model",
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.model).toBe("my-custom-model");
  });

  it("skips compaction and returns original content for non-Anthropic provider", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const content = "Memory content for non-anthropic agent";
    const { compacted, result } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      defaultModel: "gpt-4o",
      provider: "openai-crs",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(result.success).toBe(false);
    expect(result.fallbackReason).toContain("not Anthropic");
    expect(compacted).toBe(content);
    expect(mockFetch).not.toHaveBeenCalled(); // no LLM call at all
  });

  it("allows non-Anthropic provider when config.model is explicitly set", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const { result } = await compactBootstrapFile({
      content: "Memory content",
      filePath: "/workspace/MEMORY.md",
      config: { model: "claude-haiku-4-5-20251001" },
      defaultModel: "gpt-4o",
      provider: "openai-crs",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("returns original content with success=false on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Object.assign(makeFetchResponse("Error message", false, 500), {
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const content = "Original memory content";
    const { compacted, result } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(result.success).toBe(false);
    expect(compacted).toBe(content);
    expect(result.fallbackReason).toBeTruthy();
    expect(result.charsAfter).toBe(content.length);
  });

  it("returns original content with success=false on fetch rejection", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const content = "Original memory content";
    const { compacted, result } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(result.success).toBe(false);
    expect(compacted).toBe(content);
    expect(result.fallbackReason).toContain("Network error");
  });

  it("truncates input to COMPACTION_MAX_INPUT_CHARS with head+tail split before sending", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const longContent = "H".repeat(5_000) + "T".repeat(10_000); // 15K, exceeds 10K limit
    await compactBootstrapFile({
      content: longContent,
      filePath: "/workspace/MEMORY.md",
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      messages: Array<{ content: string }>;
    };
    const sent = body.messages[0].content;
    // Head 30% = 3000 chars, tail 70% = 7000 chars, plus omission marker in between
    expect(sent).toContain("[... middle content omitted for compaction ...]");
    expect(sent.startsWith("H")).toBe(true);
    expect(sent.endsWith("T")).toBe(true);
    // Total should be 10K + marker length
    const markerLen = "\n\n[... middle content omitted for compaction ...]\n\n".length;
    expect(sent.length).toBe(10_000 + markerLen);
  });
});

// ── Content-hash caching ──────────────────────────────────────────────────────

describe("compactBootstrapFile - content-hash cache", () => {
  beforeEach(() => {
    clearCompactionCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns cached result without calling LLM on second call with same content", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const content = "Memory content for caching test";
    const config: BootstrapCompactionConfig = {};
    const apiKeyResolver = makeApiKeyResolver();

    // First call — should hit the LLM
    const first = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config,
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver,
    });
    expect(mockFetch).toHaveBeenCalledOnce();

    // Second call with same content — should use cache
    const second = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config,
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver,
    });
    expect(mockFetch).toHaveBeenCalledOnce(); // still only one call
    expect(second.compacted).toBe(first.compacted);
  });

  it("calls LLM again when content changes (cache miss)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse("Summary A"))
      .mockResolvedValueOnce(makeFetchResponse("Summary B"));
    vi.stubGlobal("fetch", mockFetch);

    const config: BootstrapCompactionConfig = {};
    const apiKeyResolver = makeApiKeyResolver();

    await compactBootstrapFile({
      content: "Content version 1",
      filePath: "/workspace/MEMORY.md",
      config,
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await compactBootstrapFile({
      content: "Content version 2 — different content",
      filePath: "/workspace/MEMORY.md",
      config,
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("cache is keyed by file path — different paths do not share cache", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const content = "Same content for both files";
    const config: BootstrapCompactionConfig = {};
    const apiKeyResolver = makeApiKeyResolver();

    await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config,
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver,
    });
    await compactBootstrapFile({
      content,
      filePath: "/workspace/memory/2026-03-07.md",
      config,
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver,
    });

    // Different file paths → two separate LLM calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── Timeout handling ──────────────────────────────────────────────────────────

describe("compactBootstrapFile - timeout handling", () => {
  beforeEach(() => {
    clearCompactionCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back gracefully when signal is already aborted", async () => {
    // Simulate a fetch that is aborted immediately
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal("fetch", mockFetch);

    const content = "Memory content";
    const { compacted, result } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
      signal: AbortSignal.abort(), // pre-aborted
    });

    expect(result.success).toBe(false);
    expect(compacted).toBe(content); // original content returned
    expect(result.fallbackReason).toBeTruthy();
  });
});

// ── compactBootstrapFiles (orchestrator) ──────────────────────────────────────

describe("compactBootstrapFiles", () => {
  beforeEach(() => {
    clearCompactionCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns unchanged files when no compactable files present", async () => {
    const contextFiles = [
      { path: "/workspace/AGENTS.md", content: "Agents content" },
      { path: "/workspace/SOUL.md", content: "Soul content" },
    ];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(result).toEqual(contextFiles);
    expect(results).toHaveLength(0);
  });

  it("compacts MEMORY.md and replaces its content", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const contextFiles = [
      { path: "/workspace/AGENTS.md", content: "Agents content (not compactable)" },
      { path: "/workspace/MEMORY.md", content: "Long memory content".repeat(100) },
    ];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: { model: "claude-haiku-4-5-20251001" },
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(result).toHaveLength(2);
    // AGENTS.md should be unchanged
    expect(result[0].content).toBe("Agents content (not compactable)");
    // MEMORY.md should be compacted
    expect(result[1].content).toBe(STRUCTURED_SUMMARY);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].path).toBe("/workspace/MEMORY.md");
  });

  it("compacts memory/YYYY-MM-DD.md files", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const contextFiles = [
      { path: "/workspace/memory/2026-03-07.md", content: "Daily log content".repeat(50) },
    ];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(result[0].content).toBe(STRUCTURED_SUMMARY);
    expect(results[0].success).toBe(true);
  });

  it("selects only the largest 3 compactable files", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(STRUCTURED_SUMMARY));
    vi.stubGlobal("fetch", mockFetch);

    const contextFiles = [
      { path: "/workspace/MEMORY.md", content: "A".repeat(5000) },
      { path: "/workspace/memory/2026-03-05.md", content: "B".repeat(3000) },
      { path: "/workspace/memory/2026-03-06.md", content: "C".repeat(4000) },
      { path: "/workspace/memory/2026-03-07.md", content: "D".repeat(2000) },
      // 4 compactable files → only 3 largest should be compacted
    ];

    const { results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(results).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Verify the 3 largest were selected (MEMORY.md=5000, 2026-03-06=4000, 2026-03-05=3000)
    const compactedPaths = results.map((r) => r.path).toSorted();
    expect(compactedPaths).toContain("/workspace/MEMORY.md");
    expect(compactedPaths).toContain("/workspace/memory/2026-03-06.md");
    expect(compactedPaths).toContain("/workspace/memory/2026-03-05.md");
    // Smallest (2026-03-07=2000) should NOT be compacted
    expect(compactedPaths).not.toContain("/workspace/memory/2026-03-07.md");
  });

  it("preserves original content for files that fail compaction", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("API unavailable"));
    vi.stubGlobal("fetch", mockFetch);

    const originalContent = "Memory content to compact";
    const contextFiles = [{ path: "/workspace/MEMORY.md", content: originalContent }];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    // Content should be unchanged on failure
    expect(result[0].content).toBe(originalContent);
    expect(results[0].success).toBe(false);
    expect(results[0].fallbackReason).toContain("API unavailable");
  });

  it("returns CompactionResult with correct charsBefore and charsAfter on success", async () => {
    const compactedText = STRUCTURED_SUMMARY;
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(compactedText));
    vi.stubGlobal("fetch", mockFetch);

    const originalContent = "Original content";
    const contextFiles = [{ path: "/workspace/MEMORY.md", content: originalContent }];

    const { results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      defaultModel: TEST_DEFAULT_MODEL,
      provider: "anthropic",
      apiKeyResolver: makeApiKeyResolver(),
    });

    expect(results[0].charsBefore).toBe(originalContent.length);
    expect(results[0].charsAfter).toBe(compactedText.length);
  });
});
