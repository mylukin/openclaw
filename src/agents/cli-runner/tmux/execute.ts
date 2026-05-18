import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliOutput } from "../../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import {
  buildClaudeSystemPromptLoaderPrompt,
  writeClaudeSystemPromptFile,
} from "../system-prompt-file.js";
import { buildClaudeTmuxArgs } from "./args.js";
import { parseHookEventLine, writeActiveRun, writeClaudeTmuxRuntimeFiles } from "./hooks.js";
import { TmuxSessionManager } from "./manager.js";
import { resolveTmuxRuntimePaths, ensureTmuxRuntimeDir } from "./runtime-dir.js";
import { buildTmuxSessionName, sha256Hex } from "./session-name.js";
import { TerminalDeltaTracker } from "./terminal-stream.js";
import {
  findLatestTranscriptFile,
  resolveTranscriptPath,
  stripPromptEnvelopeArtifacts,
  TranscriptTailer,
  type TranscriptSegment,
} from "./transcript-stream.js";
import type {
  NormalizedTmuxConfig,
  TmuxActiveRun,
  TmuxExecutionInput,
  TmuxHookEvent,
  TmuxMetadata,
} from "./types.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_IDLE_MS = 1_200;
const DEFAULT_HOOK_STALL_MS = 8_000;
// During Claude Code context compaction, all hooks go silent for 30–120 s
// while Claude summarises the session history. Each extension allows one
// extra hookStallMs idle window; cap to avoid looping until the deadline.
const DEFAULT_COMPACTION_STALL_EXTENSIONS = 20;
const DEFAULT_CAPTURE_LINES = 160;
// Reap sibling tmux REPLs idle longer than this (ms). Bounds orphan
// accumulation from openclaw session rotation, model swaps, mcpConfig
// changes — each spawns a new sessionName digest and the old REPL would
// otherwise linger until tmux server death.
const DEFAULT_REAP_IDLE_AFTER_MS = 60 * 60 * 1_000;
// Claude Code writes the final assistant message to the session JSONL right
// before (or right after) the Stop hook fires. Give the writer a short window
// to flush the final block so downstream surfaces (e.g. Feishu cards) get the
// complete reply instead of only the interim turns.
const TRANSCRIPT_DRAIN_TOTAL_MS = 3_000;
const TRANSCRIPT_DRAIN_QUIET_MS = 500;
const CLAUDE_READY_RE = /\bClaude Code v\d+\.\d+\.\d+\b/;
const PRESS_ENTER_RE = /Press Enter to continue\s*(?:…|\.{2,})/i;
const PRESS_ENTER_DEBOUNCE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTmuxConfig(input: TmuxExecutionInput): NormalizedTmuxConfig {
  const config =
    input.backend.execution?.mode === "tmux" ? input.backend.execution.tmux : undefined;
  return {
    sessionNamePrefix: config?.sessionNamePrefix ?? "openclaw-claude",
    runtimeDir: config?.runtimeDir,
    startupTimeoutMs: config?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    turnTimeoutMs: config?.turnTimeoutMs ?? input.timeoutMs,
    turnIdleMs: config?.turnIdleMs ?? DEFAULT_TURN_IDLE_MS,
    hookStallMs: config?.hookStallMs ?? DEFAULT_HOOK_STALL_MS,
    captureLines: config?.captureLines ?? DEFAULT_CAPTURE_LINES,
    stopOnAbort: config?.stopOnAbort ?? true,
    memoryMode: config?.memoryMode ?? "managed-disabled",
    hookMode: config?.hookMode ?? "managed",
    authMode: config?.authMode ?? "openclaw",
    reapIdleAfterMs:
      typeof (config as { reapIdleAfterMs?: number } | undefined)?.reapIdleAfterMs === "number"
        ? (config as { reapIdleAfterMs: number }).reapIdleAfterMs
        : DEFAULT_REAP_IDLE_AFTER_MS,
  };
}

async function readFromOffset(
  filePath: string,
  offset: number,
): Promise<{ text: string; offset: number }> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (stat.size <= offset) {
        return { text: "", offset: stat.size };
      }
      const buffer = Buffer.alloc(stat.size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      return { text: buffer.toString("utf8"), offset: stat.size };
    } finally {
      await handle.close();
    }
  } catch {
    return { text: "", offset };
  }
}

// User-level Claude assets to surface inside an isolated CLAUDE_CONFIG_DIR.
// Auth/history (`.credentials.json`, `projects/`, `todos/`, etc.) are
// deliberately excluded — those must stay isolated per tmux session.
const USER_CLAUDE_LINKED_ASSETS = ["skills", "commands", "agents"] as const;

export async function linkUserClaudeAssets(params: {
  configDir: string;
  /** Override the user ~/.claude root (tests). */
  userClaudeDir?: string;
  onDiagnostic?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<void> {
  const userRoot = params.userClaudeDir ?? path.join(os.homedir(), ".claude");
  for (const asset of USER_CLAUDE_LINKED_ASSETS) {
    const source = path.join(userRoot, asset);
    const dest = path.join(params.configDir, asset);
    try {
      const srcStat = await fs.stat(source).catch(() => null);
      if (!srcStat || !srcStat.isDirectory()) {
        continue; // user has no such asset dir — nothing to share
      }
      const destStat = await fs.lstat(dest).catch(() => null);
      if (destStat) {
        // Already present (prior run's symlink, or a real dir we must not
        // clobber). Leave it; refresh only stale symlinks pointing nowhere.
        if (destStat.isSymbolicLink()) {
          const resolved = await fs.stat(dest).catch(() => null);
          if (resolved) {
            continue; // valid symlink, keep
          }
          await fs.rm(dest, { force: true }).catch(() => {});
        } else {
          continue; // real dir/file — never overwrite
        }
      }
      await fs.symlink(source, dest, "dir");
      params.onDiagnostic?.("tmux.assets.linked", { asset, source, dest });
    } catch {
      // Best-effort: a missing source or symlink race must never block launch.
    }
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function readTextTail(filePath: string, maxBytes = 32_768): Promise<string> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      if (length <= 0) {
        return "";
      }
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

// Env keys that change every turn (run id, etc.). They get baked into the
// initial child env at session creation, so they cannot be updated for a
// reused session anyway — including them in the launch signature would force
// a kill + recreate on every follow-up turn even though the running Claude
// is perfectly usable.
//
// Routing metadata (OPENCLAW_MCP_ACCOUNT_ID / _CURRENT_CHANNEL /
// _MESSAGE_CHANNEL) is intentionally NOT filtered: when those drift the
// MCP server would otherwise read stale frozen-env headers for routing,
// dedup, and tool-cache scoping. The launchHash mismatch correctly triggers
// a recreate; conversation context is preserved by the resume-on-mismatch
// escalation in the launchMode decision below, not by hash filtering.
const VOLATILE_ENV_KEYS_RE = /^(OPENCLAW_MCP_RUN_ID)$/;

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_ENV_KEYS_RE.test(key))
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function looksLikeTrustPrompt(text: string): boolean {
  return (
    text.includes("Quick safety check") &&
    text.includes("Yes, I trust this folder") &&
    text.includes("Enter to confirm")
  );
}

function looksReadyForPrompt(text: string): boolean {
  return CLAUDE_READY_RE.test(text);
}

function looksLikePressEnterToContinue(text: string): boolean {
  return PRESS_ENTER_RE.test(text);
}

function looksLikeThemePrompt(text: string): boolean {
  return text.includes("Choose the text style") && text.includes("Dark mode");
}

function looksLikeBypassPermissionsWarning(text: string): boolean {
  return (
    text.includes("Bypass Permissions mode") &&
    text.includes("Yes, I accept") &&
    text.includes("No, exit")
  );
}

async function waitForStartup(params: {
  manager: TmuxSessionManager;
  sessionName: string;
  paths: ReturnType<typeof resolveTmuxRuntimePaths>;
  config: NormalizedTmuxConfig;
  startedAt: number;
  input: TmuxExecutionInput;
}): Promise<{ claudeSessionId?: string }> {
  const deadline = params.startedAt + params.config.startupTimeoutMs;
  let confirmedTrustPrompt = false;
  let confirmedThemePrompt = false;
  let confirmedBypassWarning = false;
  let lastPressEnterAt = 0;
  while (Date.now() <= deadline) {
    if (params.input.abortSignal?.aborted) {
      if (params.config.stopOnAbort) {
        await params.manager.interrupt(params.sessionName);
      }
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    const logTail = await readTextTail(params.paths.paneLogFile);
    const captureTail = await params.manager.captureTail(
      params.sessionName,
      params.config.captureLines,
    );
    const combinedTail = `${logTail}\n${captureTail}`;
    if (/Session ID .+ is already in use/i.test(combinedTail)) {
      throw new FailoverError(
        `CLI tmux session reported session-id conflict; not waiting for timeout.${combinedTail ? `\n\nPane tail:\n${combinedTail}` : ""}`,
        {
          reason: "session_expired",
          provider: params.input.backendId,
          model: params.input.modelId,
          status: resolveFailoverStatus("session_expired"),
        },
      );
    }
    if (looksLikeThemePrompt(combinedTail) && !confirmedThemePrompt) {
      await params.manager.sendEnter(params.sessionName);
      confirmedThemePrompt = true;
      await sleep(150);
      continue;
    }
    if (looksLikeBypassPermissionsWarning(combinedTail) && !confirmedBypassWarning) {
      await params.manager.sendKey(params.sessionName, "Down");
      await sleep(80);
      await params.manager.sendEnter(params.sessionName);
      confirmedBypassWarning = true;
      await sleep(150);
      continue;
    }
    if (looksLikeTrustPrompt(combinedTail) && !confirmedTrustPrompt) {
      await params.manager.sendEnter(params.sessionName);
      confirmedTrustPrompt = true;
      await sleep(100);
      continue;
    }
    if (
      looksLikePressEnterToContinue(combinedTail) &&
      Date.now() - lastPressEnterAt > PRESS_ENTER_DEBOUNCE_MS
    ) {
      await params.manager.sendEnter(params.sessionName);
      lastPressEnterAt = Date.now();
      await sleep(100);
      continue;
    }
    const eventTail = await readTextTail(params.paths.eventsFile);
    let discoveredSessionId: string | undefined;
    for (const line of eventTail.split("\n")) {
      const event = parseHookEventLine(line);
      if (event?.event === "SessionStart" && event.timestamp >= params.startedAt) {
        if (event.claudeSessionId) {
          discoveredSessionId = event.claudeSessionId;
        }
        if (!looksReadyForPrompt(combinedTail)) {
          return discoveredSessionId ? { claudeSessionId: discoveredSessionId } : {};
        }
      }
    }
    if (looksReadyForPrompt(combinedTail)) {
      return discoveredSessionId ? { claudeSessionId: discoveredSessionId } : {};
    }
    await sleep(100);
  }
  const tail = await params.manager.captureTail(params.sessionName, params.config.captureLines);
  throw new FailoverError(
    `CLI tmux session did not become ready within ${Math.round(params.config.startupTimeoutMs / 1000)}s.${tail ? `\n\nPane tail:\n${tail}` : ""}`,
    {
      reason: "timeout",
      provider: params.input.backendId,
      model: params.input.modelId,
      status: resolveFailoverStatus("timeout"),
    },
  );
}

function pickToolName(stdin: Record<string, unknown> | undefined): string {
  return (
    (typeof stdin?.tool_name === "string" && stdin.tool_name.trim()) ||
    (typeof stdin?.toolName === "string" && stdin.toolName.trim()) ||
    "tool"
  );
}

function pickToolUseId(stdin: Record<string, unknown> | undefined): string | undefined {
  const candidates = [stdin?.tool_use_id, stdin?.toolUseId, stdin?.id];
  return candidates.find(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function stringifyHookPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable hook payload]";
  }
}

function dispatchHookEvent(
  input: TmuxExecutionInput,
  event: TmuxHookEvent,
  options: { suppressToolEvents: boolean },
): void {
  const stdin = event.stdin;
  if (event.event === "SessionStart") {
    input.onSystemInit?.({ subtype: "init", sessionId: event.claudeSessionId });
    return;
  }
  if (options.suppressToolEvents) {
    // Transcript JSONL is the canonical source for tool events when it is
    // active; emitting them again from the hook stream would duplicate
    // (and mis-order) inline rendering downstream.
    return;
  }
  if (event.event === "PreToolUse") {
    input.onToolUseEvent?.({
      name: pickToolName(stdin),
      toolUseId: pickToolUseId(stdin),
      input: stdin?.tool_input ?? stdin?.toolInput,
    });
    return;
  }
  if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
    input.onToolResult?.({
      toolUseId: pickToolUseId(stdin),
      text: stringifyHookPayload(stdin?.tool_response ?? stdin?.toolResponse),
      isError: event.event === "PostToolUseFailure",
    });
  }
}

function buildMetadata(params: {
  input: TmuxExecutionInput;
  config: NormalizedTmuxConfig;
  sessionName: string;
  systemPromptHash: string;
  launchHash: string;
  launchMode: TmuxMetadata["launchMode"];
  claudeSessionId?: string;
}): TmuxMetadata {
  const now = Date.now();
  return {
    backendId: params.input.backendId,
    workspaceDir: params.input.workspaceDir,
    sessionName: params.sessionName,
    launchHash: params.launchHash,
    model: params.input.modelId,
    systemPromptHash: params.systemPromptHash,
    ...(params.input.mcpConfigHash ? { mcpConfigHash: params.input.mcpConfigHash } : {}),
    ...(params.input.authProfileId ? { authProfileId: params.input.authProfileId } : {}),
    memoryMode: params.config.memoryMode,
    hookMode: params.config.hookMode,
    launchMode: params.launchMode,
    ...(params.claudeSessionId ? { claudeSessionId: params.claudeSessionId } : {}),
    createdAt: now,
    lastUsedAt: now,
  };
}

export async function executeTmuxCliRun(
  input: TmuxExecutionInput,
  manager = new TmuxSessionManager(),
  emptyOutputRetryAttempt = 0,
): Promise<CliOutput> {
  const config = normalizeTmuxConfig(input);
  if (config.memoryMode === "bare") {
    throw new FailoverError(
      "Claude tmux mode does not support --bare; use managed-disabled memory.",
      {
        reason: "unknown",
        provider: input.backendId,
        model: input.modelId,
        status: resolveFailoverStatus("unknown"),
      },
    );
  }
  const systemPromptHash = sha256Hex(input.systemPrompt);
  const sessionName = buildTmuxSessionName({
    prefix: config.sessionNamePrefix,
    backendId: input.backendId,
    workspaceDir: input.workspaceDir,
    sessionKey: input.sessionId,
    modelId: input.modelId,
    mcpConfigHash: input.mcpConfigHash,
    authProfileId: input.authProfileId,
    memoryMode: config.memoryMode,
    hookMode: config.hookMode,
  });
  const paths = resolveTmuxRuntimePaths({ runtimeDir: config.runtimeDir, sessionName });
  await ensureTmuxRuntimeDir(paths);
  // Opportunistic orphan reap. Sibling runtime dirs share the same
  // rootBase = parentOf(paths.rootDir). Stale-by-TTL sibling REPLs are
  // killed here so /new / model swap / mcp-config churn does not leave
  // dead tmux servers around. Best-effort; never blocks the run.
  try {
    const reapResult = await manager.reapStaleSessions({
      rootBase: path.dirname(paths.rootDir),
      ttlMs: config.reapIdleAfterMs,
      now: Date.now(),
      except: sessionName,
      ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
    });
    if (reapResult.reaped.length > 0) {
      input.onDiagnostic?.("tmux.reap.summary", {
        scanned: reapResult.scanned,
        reapedCount: reapResult.reaped.length,
        reaped: reapResult.reaped.join(","),
      });
    }
  } catch {
    // Reaper failures must never block the actual run.
  }
  await writeClaudeTmuxRuntimeFiles({
    paths,
    hookMode: config.hookMode,
  });

  const cliSystemPromptFile = await writeClaudeSystemPromptFile({
    sessionFile: input.sessionFile,
    systemPrompt: input.systemPrompt,
  });
  // Cold-restart durability: a prior turn may have persisted the Claude
  // session id in metadata even though this gateway process lost its
  // in-memory binding. Read it so recovery can resume the right conversation
  // instead of starting blank.
  const persistedMeta = await readJsonFile<TmuxMetadata>(paths.metadataFile);
  const resumeTemplateAvailable = (input.backend.resumeArgs?.length ?? 0) > 0;
  // Resume is ONLY valid against a Claude session that actually exists on
  // disk under THIS tmux identity. The only launch-time evidence of that is
  // a prior-bound id persisted in this session's metadata.json. NOTE:
  // input.cliSessionId is deliberately NOT treated as resume evidence here —
  // on a fresh `/new` conversation upstream still passes a (stale/foreign)
  // cliSessionId, and `claude --resume <nonexistent-id>` exits immediately,
  // which previously made every fresh session fail to start. A first launch
  // must be FRESH; input.cliSessionId is still used as the fresh
  // `--session-id` value below.
  const priorBoundClaudeId = persistedMeta?.claudeSessionId?.trim() || undefined;
  // Mutable: updated to the live Claude id once discovered this run, so a
  // mid-turn death can resume the session we just created.
  let resumableClaudeId = priorBoundClaudeId;
  const canResumeAtLaunch = Boolean(priorBoundClaudeId) && resumeTemplateAvailable;
  // Liveness governs launch mode. A warm, alive REPL is reused as-is (the
  // fast path — the entire point of tmux mode). Only when the pane is dead
  // or missing AND we have a prior-bound id do we RESUME from disk so
  // conversation context survives. Otherwise FRESH. A reused alive session
  // keeps whatever launchMode it was created with so metadataMismatchReasons
  // does not spuriously kill it.
  const sessionAliveAtStart =
    (await manager.hasSession(sessionName)) && (await manager.isPaneAlive(sessionName));
  // Initial mode pick. An alive REPL prefers reuse-as-fresh (the persisted
  // launchMode); a dead/missing pane prefers resume when we have a prior id.
  // The "alive but launchHash mismatch" case escalates to resume below so a
  // routing/env change does not silently restart Claude blank.
  let launchMode: TmuxMetadata["launchMode"] = sessionAliveAtStart
    ? (persistedMeta?.launchMode ?? "fresh")
    : canResumeAtLaunch
      ? "resume"
      : "fresh";
  const buildLoaderPrompt = (mode: TmuxMetadata["launchMode"]): string =>
    buildClaudeSystemPromptLoaderPrompt({
      chunks: cliSystemPromptFile.chunks,
      // A resumed REPL is a fresh process replaying disk history but WITHOUT
      // the --append-system-prompt (Claude CLI rejects it on resume), so the
      // authoritative system prompt files must be re-read — same need as after
      // a compaction.
      reason: mode === "resume" ? "compaction" : "new-session",
    });
  const buildArgsForMode = (mode: TmuxMetadata["launchMode"]): string[] =>
    buildClaudeTmuxArgs({
      backend: input.backend,
      baseArgs: input.backend.args,
      modelId: input.modelId,
      settingsFile: paths.settingsFile,
      systemPrompt: buildLoaderPrompt(mode),
      launch:
        mode === "resume" && resumableClaudeId
          ? { mode: "resume", claudeSessionId: resumableClaudeId }
          : {
              mode: "fresh",
              ...(input.cliSessionId ? { sessionId: input.cliSessionId } : {}),
            },
    });
  let args = buildArgsForMode(launchMode);
  const env = {
    ...input.env,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...(config.authMode === "openclaw"
      ? { CLAUDE_CONFIG_DIR: path.join(paths.rootDir, "claude-config") }
      : {}),
  };
  if (config.authMode === "openclaw" && env.CLAUDE_CONFIG_DIR) {
    await fs.mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
    // The isolated CLAUDE_CONFIG_DIR replaces ~/.claude wholesale, so
    // user-level skills/commands/agents would be invisible. Symlink them in
    // (best-effort) so the tmux Claude can still use them while keeping its
    // auth/history isolated. Only links when the user source exists and the
    // destination is absent — never clobbers a real dir.
    await linkUserClaudeAssets({
      configDir: env.CLAUDE_CONFIG_DIR,
      ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
    });
  }
  // Launch signature must stay stable across turns of the same conversation.
  // Several values change every turn and would otherwise force a kill +
  // recreate even though the running Claude is perfectly usable:
  //   1. The system prompt (rebuilt with date/context each turn).
  //   2. `--session-id <uuid>` — turn 1 has no Claude session id yet, turn 2
  //      onward carries the id Claude itself produced; only meaningful at
  //      first launch anyway because we paste follow-ups into the running
  //      REPL via tmux.
  //   3. `--mcp-config <path>` — prepareCliBundleMcpConfig writes the bundled
  //      MCP config to a fresh mkdtemp path every turn. The *path* is pure
  //      per-turn noise; the *content* is already guarded separately via
  //      metadata.mcpConfigHash (compared in metadataMismatchReasons), so a
  //      genuine MCP change still recreates.
  // Strip those values from the hash. Model / settings args still
  // participate, so a genuine launch-affecting change still recreates.
  const systemPromptFlag = input.backend.systemPromptArg?.trim() || "--append-system-prompt";
  const sessionIdFlag = input.backend.sessionArg?.trim();
  const VOLATILE_PATH_FLAGS = new Set(["--mcp-config", "--settings"]);
  const maskStableArgs = (rawArgs: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < rawArgs.length; i += 1) {
      const arg = rawArgs[i] ?? "";
      if (arg === systemPromptFlag) {
        out.push(arg, "<system-prompt>");
        i += 1;
        continue;
      }
      if (sessionIdFlag && arg === sessionIdFlag) {
        // Drop the flag AND its value entirely. Turn 1 (fresh) emits no
        // --session-id arg at all; turn 2 onward emits one. Including either
        // form (with or without a placeholder) would still differ across
        // turns. The flag is meaningful only at first launch — once the
        // tmux Claude is running we paste follow-ups, never relaunch.
        i += 1;
        continue;
      }
      if (VOLATILE_PATH_FLAGS.has(arg) && i + 1 < rawArgs.length) {
        // Keep the flag (a genuine add/remove of MCP/settings still shifts
        // the hash) but replace its per-turn temp path with a stable
        // placeholder.
        out.push(arg, `<${arg.replace(/^-+/, "")}>`);
        i += 1;
        continue;
      }
      if (arg === "--resume" && i + 1 < rawArgs.length) {
        // Keep the `--resume` flag (fresh vs resume IS a real launch
        // difference and must shift the hash) but mask the volatile session
        // id value so steady-state resume turns reuse the warm REPL instead
        // of churn-recreating. Mode stability is separately guaranteed by
        // launchMode in metadataMismatchReasons.
        out.push(arg, "<resume-session-id>");
        i += 1;
        continue;
      }
      out.push(arg);
    }
    return out;
  };
  const stableEnvJson = stableJson(env);
  const computeLaunchHash = (rawArgs: string[]): string =>
    sha256Hex(input.backend.command, JSON.stringify(maskStableArgs(rawArgs)), stableEnvJson);
  let stableArgs = maskStableArgs(args);
  let launchHash = sha256Hex(input.backend.command, JSON.stringify(stableArgs), stableEnvJson);
  // Resume-on-mismatch escalation: a routing-context env change (e.g.
  // OPENCLAW_MCP_ACCOUNT_ID / _CURRENT_CHANNEL / _MESSAGE_CHANNEL) shifts
  // launchHash, which makes ensureSession kill the live tmux pane. If we
  // relaunched fresh, Claude would start with no memory of prior turns
  // (root cause of the duplicate-issue bug: Ada created #323, env shifted,
  // tmux killed, fresh Claude re-created the same task as #324). When a
  // prior-bound Claude session id exists, prefer relaunching with
  // `claude --resume <id>` so the disk transcript is replayed and
  // conversation context survives the recreate.
  if (
    sessionAliveAtStart &&
    canResumeAtLaunch &&
    launchMode === "fresh" &&
    persistedMeta &&
    persistedMeta.launchHash !== launchHash
  ) {
    input.onDiagnostic?.("tmux.launchMode.escalateToResume", {
      sessionName,
      priorBoundClaudeId,
      persistedLaunchHash: persistedMeta.launchHash,
      freshLaunchHash: launchHash,
    });
    launchMode = "resume";
    args = buildArgsForMode(launchMode);
    stableArgs = maskStableArgs(args);
    launchHash = computeLaunchHash(args);
  }
  const metadata = buildMetadata({
    input,
    config,
    sessionName,
    systemPromptHash,
    launchHash,
    launchMode,
    // Only carry a prior-bound id forward. The real discovered id is
    // persisted at run end; persisting input.cliSessionId here would make
    // the next run falsely believe a resumable session exists.
    ...(resumableClaudeId ? { claudeSessionId: resumableClaudeId } : {}),
  });
  const diag = input.onDiagnostic;
  // Persist signature inputs alongside metadata so a future launchHash
  // mismatch is diffable from the file system without rerunning under a
  // debugger. File is small (args + filtered env) and overwritten each turn.
  const signatureFile = path.join(paths.rootDir, "launch-signature.json");
  const prevSignatureFile = path.join(paths.rootDir, "launch-signature.prev.json");
  try {
    await fs.rename(signatureFile, prevSignatureFile);
  } catch {
    // no prior turn signature yet
  }
  try {
    await fs.writeFile(
      signatureFile,
      `${JSON.stringify(
        {
          command: input.backend.command,
          stableArgs,
          stableEnv: JSON.parse(stableEnvJson),
          launchHash,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch {
    // best-effort diagnostic only
  }
  diag?.("tmux.run.start", {
    runId: input.runId,
    sessionName,
    backendId: input.backendId,
    model: input.modelId,
    promptChars: input.prompt.length,
    cliSessionIdProvided: Boolean(input.cliSessionId),
    launchHash,
    systemPromptHash,
    stableArgsHash: sha256Hex(JSON.stringify(stableArgs)),
    stableEnvHash: sha256Hex(stableEnvJson),
    stableEnvKeys: Object.keys(JSON.parse(stableEnvJson) as Record<string, string>).join(","),
    signatureFile,
  });
  const sessionState = await manager.ensureSession({
    paths,
    metadata,
    command: input.backend.command,
    args,
    cwd: input.workspaceDir,
    env,
    config,
    ...(diag ? { onDiagnostic: diag } : {}),
  });
  let startupSessionId: string | undefined;
  if (!sessionState || sessionState.created) {
    diag?.("tmux.run.waitForStartup", { sessionName });
    const startupResult = await waitForStartup({
      manager,
      sessionName,
      paths,
      config,
      startedAt: Date.now(),
      input,
    });
    startupSessionId = startupResult.claudeSessionId;
    if (startupSessionId) {
      // Now resumable: a mid-turn death can replay the session we just made.
      resumableClaudeId = startupSessionId;
    }
    diag?.("tmux.run.waitForStartup.done", {
      sessionName,
      claudeSessionId: startupSessionId,
    });
  } else {
    diag?.("tmux.run.reusedSession", { sessionName });
  }

  const startedAt = Date.now();
  const activeRun: TmuxActiveRun = {
    runId: input.runId,
    openclawSessionId: input.sessionId,
    ...(input.cliSessionId ? { cliSessionId: input.cliSessionId } : {}),
    startedAt,
    promptHash: sha256Hex(input.prompt),
    turnIndex: startedAt,
  };
  await writeActiveRun(paths, activeRun);

  const MAX_RECOVERY_ATTEMPTS = 3;
  let recoveryAttempts = 0;
  // True on a turn where the REPL was (re)launched in resume mode: the
  // resumed process never received --append-system-prompt (Claude CLI
  // rejects it on resume), so the loader must ride in front of this turn's
  // user prompt to restore the authoritative system prompt. Steady-state
  // warm turns keep this false — that is the whole fast-path benefit.
  let loaderInjectionPending = launchMode === "resume" && Boolean(sessionState?.created);

  // Bytes actually pasted into the REPL this turn. pendingPromptEcho must
  // mirror these (NOT input.prompt) so the echoed prompt — loader prefix
  // included on a recovered turn — is stripped from the pane stream.
  // Trailing newline stripped: the TUI ingests via bracketed paste, so a
  // trailing "\n" would sit as a literal newline; submission is the explicit
  // Enter in pastePrompt.
  const composePasteBuffer = (): string => {
    const body = loaderInjectionPending
      ? `${buildLoaderPrompt(launchMode)}\n${input.prompt}`
      : input.prompt;
    return body.replace(/\n+$/, "");
  };

  // Self-heal a dead REPL. If a resumable Claude id is known (prior-bound or
  // discovered live this run) and the backend has a resume template, RESUME
  // from disk so conversation context survives; otherwise FRESH relaunch so
  // tmux at least restarts (a brand-new session has no history to lose).
  // Bounded; only attempt exhaustion escalates to FailoverError so upstream
  // failover / profile-downgrade still engages.
  const healViaResume = async (phase: string): Promise<void> => {
    if (input.abortSignal?.aborted) {
      if (config.stopOnAbort) {
        await manager.interrupt(sessionName);
      }
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      diag?.("tmux.recovery.exhausted", { sessionName, phase, attempts: recoveryAttempts });
      throw new FailoverError(
        `CLI tmux session died (${phase}); exhausted ${MAX_RECOVERY_ATTEMPTS} recovery attempts.`,
        {
          reason: "unknown",
          provider: input.backendId,
          model: input.modelId,
          status: resolveFailoverStatus("unknown"),
        },
      );
    }
    recoveryAttempts += 1;
    const healMode: TmuxMetadata["launchMode"] =
      resumableClaudeId && resumeTemplateAvailable ? "resume" : "fresh";
    diag?.("tmux.recovery.detected", {
      sessionName,
      phase,
      attempt: recoveryAttempts,
      healMode,
      claudeSessionId: resumableClaudeId,
    });
    await manager.killSession(sessionName);
    const healMeta = buildMetadata({
      input,
      config,
      sessionName,
      systemPromptHash,
      launchHash,
      launchMode: healMode,
      ...(healMode === "resume" && resumableClaudeId ? { claudeSessionId: resumableClaudeId } : {}),
    });
    diag?.("tmux.recovery.relaunch", { sessionName, attempt: recoveryAttempts, healMode });
    await manager.ensureSession({
      paths,
      metadata: healMeta,
      command: input.backend.command,
      args: buildArgsForMode(healMode),
      cwd: input.workspaceDir,
      env,
      config,
      ...(diag ? { onDiagnostic: diag } : {}),
    });
    await waitForStartup({
      manager,
      sessionName,
      paths,
      config,
      startedAt: Date.now(),
      input,
    });
    // Only a resumed REPL lacks the system prompt (no --append-system-prompt
    // on resume); a fresh relaunch already carries it via args.
    loaderInjectionPending = healMode === "resume";
    diag?.("tmux.recovery.healed", {
      sessionName,
      attempt: recoveryAttempts,
      healMode,
      claudeSessionId: resumableClaudeId,
    });
  };

  // Pre-paste liveness: a dead/missing pane here means the warm REPL we
  // expected to reuse is gone. Heal before pasting instead of pasting into
  // the void (the old code only logged this).
  const alivePrePaste =
    (await manager.hasSession(sessionName)) && (await manager.isPaneAlive(sessionName));
  diag?.("tmux.run.pastePrompt", {
    sessionName,
    promptChars: input.prompt.length,
    aliveBeforePaste: alivePrePaste,
  });
  if (!alivePrePaste) {
    diag?.("tmux.run.pastePrompt.sessionMissing", { sessionName });
    await healViaResume("pre-paste");
  }

  // Sample offsets AFTER any heal: ensureSession truncates the pane log +
  // events file and re-runs pipe-pane, so pre-heal sizes would skip the
  // relaunched session's output (or replay stale bytes).
  let paneOffset = await fileSize(paths.paneLogFile);
  let eventOffset = await fileSize(paths.eventsFile);
  let pastedBuffer = composePasteBuffer();
  await fs.writeFile(paths.promptBufferFile, pastedBuffer, { mode: 0o600 });
  await manager.pastePrompt({
    sessionName,
    bufferName: `openclaw-${input.runId.slice(0, 12)}`,
    promptFile: paths.promptBufferFile,
  });

  let terminal = new TerminalDeltaTracker();
  let pendingPromptEcho = pastedBuffer;
  let sawStop = false;
  let sawCurrentRunHook = false;
  let compactionStallExtensions = 0;
  // Set by the PreCompact hook, cleared by Stop. While true, an all-channel
  // silence is Claude busy compacting context (30–120 s) — NOT a crashed hook
  // script — so the hook-stall fallback is allowed to wait it out.
  let compactionInProgress = false;
  // Fresh sessions: SessionStart hook fires during waitForStartup and gets
  // consumed there, so the main loop's event reader (starting at
  // initialEventOffset) never sees it. Carry the discovered sessionId
  // forward so the transcript tailer can be instantiated before any tool
  // events arrive — otherwise we fall back to hook-driven tool dispatch
  // and lose canonical ordering.
  let cliSessionId = input.cliSessionId ?? startupSessionId;
  let lastActivityAt = Date.now();
  let lastPressEnterAt = 0;
  // Rolling tail so a "Press Enter to continue…" prompt split across two
  // pane reads is still detected. 256 chars >> marker length.
  let pressEnterScanBuffer = "";
  // Throttle mid-turn liveness probes (tmux list-panes is cheap but not
  // free, and the loop ticks every 100ms).
  let lastLivenessProbeAt = Date.now();
  const LIVENESS_PROBE_INTERVAL_MS = 1_500;
  const deadline = Date.now() + Math.min(input.timeoutMs, config.turnTimeoutMs);
  // Claude Code session JSONL transcript carries structured assistant text
  // blocks. Prefer it over the noisy TUI pane log so downstream surfaces
  // (e.g. Feishu cards) get clean output. Pane log still drives startup
  // detection, press-enter handling, and acts as a fallback when no
  // transcript file is available (older Claude versions / non-managed auth).
  const transcriptConfigDir = env.CLAUDE_CONFIG_DIR;
  // When managed hooks are active, SessionStart will deliver a sessionId and
  // the JSONL transcript becomes the canonical source for assistant text.
  // We buffer pane deltas until either the transcript produces anything
  // (then we drop the buffer as duplicate TUI noise) or the run ends without
  // a transcript (then we flush the buffer as a best-effort fallback). With
  // hookMode=off, hooks never fire so the pane is canonical from the start.
  const transcriptIsAuthoritative = config.hookMode !== "off";
  const bufferedPaneDeltas: string[] = [];
  let transcriptEmitted = false;
  let transcript: TranscriptTailer | undefined = cliSessionId
    ? new TranscriptTailer(
        resolveTranscriptPath({
          configDir: transcriptConfigDir,
          workspaceDir: input.workspaceDir,
          sessionId: cliSessionId,
        }),
        startedAt,
      )
    : undefined;

  const dispatchTranscriptSegments = (segments: readonly TranscriptSegment[]): void => {
    for (const segment of segments) {
      if (segment.kind === "text") {
        if (!transcriptEmitted) {
          transcriptEmitted = true;
          bufferedPaneDeltas.length = 0;
        }
        input.onAssistantTurn?.(segment.text);
      } else if (segment.kind === "tool_use") {
        input.onToolUseEvent?.({
          name: segment.name,
          ...(segment.toolUseId ? { toolUseId: segment.toolUseId } : {}),
          ...(segment.input !== undefined ? { input: segment.input } : {}),
        });
      } else if (segment.kind === "tool_result") {
        input.onToolResult?.({
          ...(segment.toolUseId ? { toolUseId: segment.toolUseId } : {}),
          ...(segment.text !== undefined ? { text: segment.text } : {}),
          ...(segment.isError ? { isError: true } : {}),
        });
      }
      // thinking segments not surfaced through the tmux callbacks today.
    }
  };

  while (!sawStop) {
    if (input.abortSignal?.aborted) {
      if (config.stopOnAbort) {
        await manager.interrupt(sessionName);
      }
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }

    const pane = await readFromOffset(paths.paneLogFile, paneOffset);
    paneOffset = pane.offset;
    if (pane.text) {
      lastActivityAt = Date.now();
      const rawText = pane.text.replaceAll("\r", "");
      pressEnterScanBuffer = (pressEnterScanBuffer + rawText).slice(-256);
      if (
        looksLikePressEnterToContinue(pressEnterScanBuffer) &&
        Date.now() - lastPressEnterAt > PRESS_ENTER_DEBOUNCE_MS
      ) {
        await manager.sendEnter(sessionName);
        lastPressEnterAt = Date.now();
        pressEnterScanBuffer = "";
      }
      const paneText = (() => {
        if (!pendingPromptEcho) {
          return rawText;
        }
        if (pendingPromptEcho.startsWith(rawText)) {
          pendingPromptEcho = pendingPromptEcho.slice(rawText.length);
          return "";
        }
        if (rawText.startsWith(pendingPromptEcho)) {
          const stripped = rawText.slice(pendingPromptEcho.length);
          pendingPromptEcho = "";
          return stripped;
        }
        const promptIndex = rawText.indexOf(pendingPromptEcho);
        if (promptIndex >= 0) {
          const lineStart = rawText.lastIndexOf("\n", Math.max(0, promptIndex - 1)) + 1;
          const afterPromptIndex = promptIndex + pendingPromptEcho.length;
          const afterEchoIndex =
            rawText[afterPromptIndex] === "\n" ? afterPromptIndex + 1 : afterPromptIndex;
          const stripped = rawText.slice(0, lineStart) + rawText.slice(afterEchoIndex);
          pendingPromptEcho = "";
          return stripped;
        }
        pendingPromptEcho = "";
        return rawText;
      })();
      const delta = terminal.push(paneText);
      if (delta) {
        if (transcriptEmitted) {
          // Transcript is canonical; drop the pane copy.
        } else if (transcriptIsAuthoritative) {
          bufferedPaneDeltas.push(delta);
        } else {
          input.onAssistantTurn?.(delta);
        }
      }
    }

    if (transcript) {
      const segments = await transcript.poll();
      if (segments.length > 0) {
        lastActivityAt = Date.now();
        dispatchTranscriptSegments(segments);
      }
    }

    const events = await readFromOffset(paths.eventsFile, eventOffset);
    eventOffset = events.offset;
    if (events.text) {
      lastActivityAt = Date.now();
      for (const line of events.text.split("\n")) {
        const event = parseHookEventLine(line);
        if (!event || event.runId !== input.runId || event.timestamp < startedAt) {
          continue;
        }
        sawCurrentRunHook = true;
        if (event.claudeSessionId && event.claudeSessionId !== cliSessionId) {
          cliSessionId = event.claudeSessionId;
          // Keep the recoverable id current so a mid-turn death resumes the
          // session in flight rather than starting blank.
          resumableClaudeId = event.claudeSessionId;
        }
        if (!transcript && cliSessionId) {
          transcript = new TranscriptTailer(
            resolveTranscriptPath({
              configDir: transcriptConfigDir,
              workspaceDir: input.workspaceDir,
              sessionId: cliSessionId,
            }),
            startedAt,
          );
        }
        dispatchHookEvent(input, event, {
          // After SessionStart establishes the JSONL transcript as the source
          // of truth, all subsequent tool events flow from there in the
          // correct order. Dropping the hook copy avoids duplicate /
          // misordered inline tool stats downstream.
          suppressToolEvents: Boolean(transcript),
        });
        if (event.event === "PreCompact") {
          compactionInProgress = true;
        }
        if (event.event === "Stop") {
          sawStop = true;
          compactionInProgress = false;
        }
      }
    }

    if (sawStop) {
      break;
    }
    if (Date.now() > deadline) {
      const tail = await manager.captureTail(sessionName, config.captureLines);
      throw new FailoverError(
        `CLI exceeded timeout (${Math.round(input.timeoutMs / 1000)}s) in tmux session.${tail ? `\n\nPane tail:\n${tail}` : ""}`,
        {
          reason: "timeout",
          provider: input.backendId,
          model: input.modelId,
          status: resolveFailoverStatus("timeout"),
        },
      );
    }
    // Mid-turn death: the REPL exited before emitting Stop. Detect via a
    // throttled pane-liveness probe and resume-relaunch + re-paste the same
    // turn so the user still gets a reply with full context. Bounded inside
    // healViaResume; exhaustion throws FailoverError.
    if (
      !sawStop &&
      Date.now() - lastLivenessProbeAt >= LIVENESS_PROBE_INTERVAL_MS &&
      Date.now() - lastActivityAt >= LIVENESS_PROBE_INTERVAL_MS
    ) {
      lastLivenessProbeAt = Date.now();
      const aliveMidTurn =
        (await manager.hasSession(sessionName)) && (await manager.isPaneAlive(sessionName));
      if (!aliveMidTurn) {
        await healViaResume("mid-turn");
        // Fresh pane log / events file after relaunch — reset trackers so we
        // do not replay stale bytes or mis-diff against the dead session.
        paneOffset = await fileSize(paths.paneLogFile);
        eventOffset = await fileSize(paths.eventsFile);
        terminal = new TerminalDeltaTracker();
        bufferedPaneDeltas.length = 0;
        pressEnterScanBuffer = "";
        pastedBuffer = composePasteBuffer();
        pendingPromptEcho = pastedBuffer;
        await fs.writeFile(paths.promptBufferFile, pastedBuffer, { mode: 0o600 });
        await manager.pastePrompt({
          sessionName,
          bufferName: `openclaw-${input.runId.slice(0, 12)}`,
          promptFile: paths.promptBufferFile,
        });
        lastActivityAt = Date.now();
        await sleep(100);
        continue;
      }
    }
    const idleFor = Date.now() - lastActivityAt;
    const noHookYet = config.hookMode === "off" || !sawCurrentRunHook;
    // Fast path: no managed hooks (or none seen yet) — short idle ends the turn.
    // Stall path: hooks were seen but the Stop hook never arrived (crashed/timed
    // out hook script); fall back after a longer silence so the turn does not
    // hang until the overall deadline.
    const idleThreshold = noHookYet ? config.turnIdleMs : config.hookStallMs;
    if (terminal.getText() && idleFor >= idleThreshold) {
      // Context compaction silences ALL channels for 30–120 s while Claude
      // summarises history. Only extend the stall when the PreCompact hook
      // told us compaction is actually running — otherwise an all-channel
      // silence with an alive pane is a crashed hook script / idle Claude and
      // must fall back fast (the hook-stall completion path). Cap extensions
      // so a process that hangs without ever emitting Stop still terminates.
      if (
        !noHookYet &&
        compactionInProgress &&
        compactionStallExtensions < DEFAULT_COMPACTION_STALL_EXTENSIONS
      ) {
        const paneAlive =
          (await manager.hasSession(sessionName)) && (await manager.isPaneAlive(sessionName));
        if (paneAlive) {
          compactionStallExtensions++;
          lastActivityAt = Date.now();
          continue;
        }
      }
      break;
    }
    await sleep(100);
  }

  // Post-run transcript discovery fallback: SessionStart hook may not have
  // delivered a claude session id, so `transcript` is undefined even though
  // Claude wrote a JSONL on disk. Find the freshest project JSONL touched
  // during this run and replay it; otherwise the only available output would
  // be raw TUI noise (bracketed-paste placeholders + box-drawing tables).
  if (!transcript && transcriptIsAuthoritative) {
    const fallback = await findLatestTranscriptFile({
      configDir: transcriptConfigDir,
      workspaceDir: input.workspaceDir,
      sinceMs: startedAt,
    });
    if (fallback) {
      transcript = new TranscriptTailer(fallback, startedAt);
      diag?.("tmux.transcript.fallback", { sessionName, transcriptFile: fallback });
      // Bind the discovered session id (filename = `<id>.jsonl`) so it gets
      // persisted into metadata for next-turn resume.
      const discovered = path.basename(fallback, ".jsonl");
      if (discovered && !cliSessionId) {
        cliSessionId = discovered;
        resumableClaudeId = discovered;
      }
    }
  }

  if (transcript) {
    // Drain phase: Claude Code may flush the final assistant message to the
    // JSONL transcript right around the Stop hook. Keep polling until the
    // transcript goes quiet or the total budget elapses.
    //
    // Compaction / long generation tolerance: the 3s short cap is enough for
    // the normal "Stop hook arrives, final block lands within a beat" path.
    // But when the main loop already had to extend past a hook stall
    // (compactionStallExtensions > 0) and the final reply has STILL not
    // landed, Claude is likely mid-compaction or mid-generation — truncating
    // here drops the real deliverable from the Feishu card. In that case keep
    // polling while the pane stays alive, capped to the same window the main
    // loop tolerates so total runner-side patience is consistent.
    const extendedDrain = compactionStallExtensions > 0;
    const drainHardCapMs = extendedDrain
      ? DEFAULT_COMPACTION_STALL_EXTENSIONS * config.hookStallMs
      : TRANSCRIPT_DRAIN_TOTAL_MS;
    const drainStart = Date.now();
    let lastDeltaAt = drainStart;
    while (Date.now() - drainStart < drainHardCapMs) {
      const segments = await transcript.poll();
      if (segments.length > 0) {
        dispatchTranscriptSegments(segments);
        lastDeltaAt = Date.now();
        await sleep(100);
        continue;
      }
      const elapsed = Date.now() - drainStart;
      const quietFor = Date.now() - lastDeltaAt;
      if (quietFor < TRANSCRIPT_DRAIN_QUIET_MS) {
        await sleep(100);
        continue;
      }
      // Quiet long enough. Default behavior: exit (original short-cap path).
      // Only the extended-drain case keeps waiting, and only while there is
      // no final reply yet AND the pane is still alive (compaction running).
      if (!extendedDrain || elapsed < TRANSCRIPT_DRAIN_TOTAL_MS) {
        break;
      }
      // Stop already fired: the turn is genuinely over. The long extension
      // only exists to wait for a STILL-MISSING Stop while compaction runs;
      // once Stop is seen there is no further output coming, so do not keep
      // probing the (persistent) REPL pane for up to drainHardCapMs.
      if (sawStop) {
        break;
      }
      if (transcript.getFinalReplyText().length > 0) {
        break;
      }
      const paneAlive =
        (await manager.hasSession(sessionName)) && (await manager.isPaneAlive(sessionName));
      if (!paneAlive) {
        break;
      }
      await sleep(100);
    }
    // The final assistant message has no successor record to seal it, so
    // flush whatever blocks are still buffered (canonical order preserved).
    dispatchTranscriptSegments(transcript.flushPending());
  }

  // Pane fallback rules:
  //   - hookMode=off: pane IS canonical → flush.
  //   - authoritative + a transcript file exists on disk (whether we read
  //     anything from it or not): transcript is the source of truth →
  //     suppress pane (TUI noise: bracketed-paste placeholders, box-drawing
  //     tables, prompt echo). The on-disk presence is the signal; even if
  //     parsing yielded nothing, falling back to pane garbage is worse.
  //   - authoritative but NO transcript on disk (rare): pane is the only
  //     signal → flush as last resort.
  let transcriptOnDisk = false;
  if (transcript) {
    transcriptOnDisk = (await fileSize(transcript.getFilePath())) > 0;
  }
  // Defense in depth: even when neither the transcript handle nor on-disk
  // discovery succeeded, if the pane content carries the OpenClaw conversation
  // envelope (Feishu "[Pasted text #N +M lines]" placeholders, <message>,
  // <messageindex=>, <atid=>, <at user_id=>) it is the pasted prompt being
  // rendered back by the TUI — never user-deliverable content. Treat that as
  // authoritative signal to suppress pane fallback regardless of transcript
  // discovery state. This catches the race where SessionStart hook never
  // delivered a session id and the project dir was empty at fallback time.
  const ENVELOPE_RE =
    // NOTE: `<at user_id="...">Name</at>` is a legitimate Feishu @mention
    // and must NOT be stripped. The envelope-specific tag is `<atid=ou_...>`
    // (no `user_id=`, no quotes) — that one is unambiguous noise.
    /\[Pasted\s*text\s*#\d+\s*\+\s*\d+\s*lines?\]|<\/?messa?ge?\b|<messageindex=|<atid=/i;
  const rawPaneText = terminal.getText();
  const paneLooksLikeEnvelope = ENVELOPE_RE.test(rawPaneText);
  const suppressPaneFallback =
    transcriptIsAuthoritative && (transcriptOnDisk || paneLooksLikeEnvelope);
  let paneActuallyFlushed = false;
  if (!transcriptEmitted && !suppressPaneFallback && bufferedPaneDeltas.length > 0) {
    for (const delta of bufferedPaneDeltas) {
      const cleaned = stripPromptEnvelopeArtifacts(delta);
      if (cleaned) {
        input.onAssistantTurn?.(cleaned);
        paneActuallyFlushed = true;
      }
    }
  }

  const aliveAtEnd = await manager.hasSession(sessionName);
  // Persist the bound Claude session id so a cold gateway restart (which
  // loses the in-memory binding) can still resume this conversation. Best
  // effort: merge into the on-disk metadata without disturbing identity
  // fields. Only write when we actually know the id.
  const finalClaudeSessionId = cliSessionId ?? resumableClaudeId;
  if (finalClaudeSessionId) {
    const onDisk = await readJsonFile<TmuxMetadata>(paths.metadataFile);
    if (onDisk && onDisk.claudeSessionId !== finalClaudeSessionId) {
      try {
        await fs.writeFile(
          paths.metadataFile,
          `${JSON.stringify({ ...onDisk, claudeSessionId: finalClaudeSessionId, lastUsedAt: Date.now() }, null, 2)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // best-effort durability only
      }
    }
  }
  diag?.("tmux.run.complete", {
    sessionName,
    aliveAtEnd,
    sawStop,
    transcriptEmitted,
    // True only if pane deltas were actually emitted to the consumer
    // (previously this lied — it reported buffer non-emptiness, not the
    // suppression-gated flush). False here ≠ pane is in card.
    bufferedPaneFlushed: paneActuallyFlushed,
    suppressPaneFallback,
    paneLooksLikeEnvelope,
    recoveryAttempts,
    launchMode,
    durationMs: Date.now() - startedAt,
  });

  // The returned text is the turn's deliverable: prefer the final (end_turn)
  // assistant message. Interim narration ("Now I'll read…") was streamed live
  // via onAssistantTurn for progress, but it must NOT become the reply body —
  // otherwise a NO_REPLY final disposition can't suppress the card. Fall back
  // to all accumulated text only when no final message was produced (e.g. the
  // run was cut off mid-narration), then the pane text.
  const finalReplyText = transcriptEmitted ? (transcript?.getFinalReplyText() ?? "") : "";
  const accumulatedText = transcriptEmitted ? (transcript?.getText() ?? "") : "";
  // Lift the latest assistant message.usage off the Claude transcript so
  // /status can render real Context numbers. Without this CliOutput.usage is
  // undefined and the status renderer falls back to the openclaw session
  // transcript, which shows 0/200k for the tmux flow.
  const usage = transcript?.getLastUsage();
  // When transcript is authoritative AND a transcript was found, the pane
  // is TUI noise and must NEVER fall through as the reply body. If no
  // transcript exists anywhere (rare), pane is the only available signal.
  // Final-text pane fallback: same sanitize-or-suppress rule. Reuse the
  // already-captured rawPaneText, run it through the envelope stripper so a
  // mixed-content pane only contributes its real content.
  const paneFallback = suppressPaneFallback ? "" : stripPromptEnvelopeArtifacts(rawPaneText);
  const outputText = finalReplyText || accumulatedText || paneFallback;
  if (!outputText && !transcriptEmitted) {
    const emptyReason = paneLooksLikeEnvelope
      ? "envelope-without-transcript"
      : "transcript-and-pane-empty";
    const diagnostic = {
      runId: input.runId,
      sessionName,
      launchMode,
      reason: emptyReason,
      transcriptPath: transcript?.getFilePath() ?? "(not-discovered)",
      paneTailSize: rawPaneText.length,
      retryAttempt: emptyOutputRetryAttempt,
    };
    if (emptyOutputRetryAttempt < 1) {
      diag?.("tmux.empty-output.retry", diagnostic);
      await manager.killSession(sessionName).catch(() => {});
      // Strip the persisted claudeSessionId so the retry launches fresh rather
      // than --resume into the same (possibly corrupt) session that produced
      // empty output. Without this the next call reads the old id from
      // metadata.json and canResumeAtLaunch becomes true, re-binding the bad
      // session and potentially replaying the same prompt against stale history.
      try {
        const onDisk = await readJsonFile<TmuxMetadata>(paths.metadataFile);
        if (onDisk?.claudeSessionId) {
          const { claudeSessionId: _dropped, ...rest } = onDisk;
          await fs.writeFile(
            paths.metadataFile,
            `${JSON.stringify({ ...rest, lastUsedAt: Date.now() }, null, 2)}\n`,
            { mode: 0o600 },
          );
        }
      } catch {
        // best-effort; the next run will overwrite on success
      }
      await Promise.all([
        fs.writeFile(paths.paneLogFile, ""),
        fs.writeFile(paths.eventsFile, ""),
        fs.writeFile(paths.promptBufferFile, ""),
      ]).catch(() => {});
      return executeTmuxCliRun(
        { ...input, cliSessionId: undefined },
        manager,
        emptyOutputRetryAttempt + 1,
      );
    }
    diag?.("tmux.empty-output.failure", diagnostic);
    throw new FailoverError(
      `CLI tmux run produced empty output (transcriptEmitted=false, chars=0, reason=${emptyReason})`,
      {
        reason: "unknown",
        provider: input.backendId,
        model: input.modelId,
        status: resolveFailoverStatus("unknown"),
      },
    );
  }
  return {
    text: outputText,
    ...((cliSessionId ?? input.cliSessionId)
      ? { sessionId: cliSessionId ?? input.cliSessionId }
      : {}),
    ...(usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)
      ? { usage }
      : {}),
  };
}
