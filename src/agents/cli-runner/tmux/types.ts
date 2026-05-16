import type { CliBackendConfig, CliTmuxExecutionConfig } from "../../../config/types.js";

export type NormalizedTmuxConfig = Required<
  Pick<
    CliTmuxExecutionConfig,
    | "sessionNamePrefix"
    | "startupTimeoutMs"
    | "turnIdleMs"
    | "hookStallMs"
    | "captureLines"
    | "stopOnAbort"
    | "memoryMode"
    | "hookMode"
    | "authMode"
  >
> &
  Pick<CliTmuxExecutionConfig, "runtimeDir"> & {
    turnTimeoutMs: number;
  };

export type TmuxRuntimePaths = {
  rootDir: string;
  activeRunFile: string;
  eventsFile: string;
  paneLogFile: string;
  launcherFile: string;
  settingsFile: string;
  hookWriterFile: string;
  promptBufferFile: string;
  metadataFile: string;
};

export type TmuxMetadata = {
  backendId: string;
  workspaceDir: string;
  sessionName: string;
  launchHash: string;
  model: string;
  systemPromptHash: string;
  mcpConfigHash?: string;
  authProfileId?: string;
  memoryMode: NormalizedTmuxConfig["memoryMode"];
  hookMode: NormalizedTmuxConfig["hookMode"];
  // How the persistent REPL was launched. A fresh launch owns the Claude
  // session id via `--session-id`; a resume launch replays an existing
  // Claude session from disk via the backend resume template. fresh<->resume
  // is a real launch difference and must force exactly one recreate, so it is
  // compared in metadataMismatchReasons (unlike claudeSessionId below).
  // Optional: legacy metadata.json predating this field has none — that
  // counts as a one-time mismatch (recreate) on first upgrade, then stable.
  launchMode?: "fresh" | "resume";
  // The Claude-owned session id bound to this tmux session. Persisted so a
  // cold gateway restart (which loses the in-memory cliSessionId binding) can
  // still resume the right conversation. Recovery data, NOT identity — it is
  // deliberately excluded from metadataMismatchReasons.
  claudeSessionId?: string;
  createdAt: number;
  lastUsedAt: number;
};

export type TmuxEnsureSessionResult = {
  created: boolean;
  // Claude session id persisted in the reused session's metadata. Lets a
  // cold-restarted gateway (which lost the in-memory binding) recover the
  // bound conversation id without re-discovering it from a hook.
  persistedClaudeSessionId?: string;
};

export type TmuxActiveRun = {
  runId: string;
  openclawSessionId: string;
  cliSessionId?: string;
  startedAt: number;
  promptHash: string;
  turnIndex: number;
};

export type TmuxHookEvent = {
  event: string;
  runId?: string;
  openclawSessionId?: string;
  claudeSessionId?: string;
  timestamp: number;
  stdin?: Record<string, unknown>;
};

export type TmuxCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export type TmuxExecutionInput = {
  backend: CliBackendConfig;
  backendId: string;
  workspaceDir: string;
  sessionId: string;
  sessionFile: string;
  cliSessionId?: string;
  runId: string;
  modelId: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  env: Record<string, string>;
  mcpConfigHash?: string;
  authProfileId?: string;
  abortSignal?: AbortSignal;
  onSystemInit?: (payload: { subtype: string; sessionId?: string }) => void;
  onAssistantTurn?: (text: string) => void;
  onToolUseEvent?: (payload: { name: string; toolUseId?: string; input?: unknown }) => void;
  onToolResult?: (payload: { toolUseId?: string; text?: string; isError?: boolean }) => void;
  /** Lifecycle diagnostics for tmux session reuse/recreate, startup, drain. */
  onDiagnostic?: (event: string, data?: Record<string, unknown>) => void;
};
