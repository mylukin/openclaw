import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import type {
  NormalizedTmuxConfig,
  TmuxCommandRunner,
  TmuxEnsureSessionResult,
  TmuxMetadata,
  TmuxRuntimePaths,
} from "./types.js";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The Claude TUI ingests a bracketed paste asynchronously while it is still
// rendering (most visible right after the startup banner on a fresh session).
// Sending Enter immediately races that ingest and the submit is dropped, so
// the prompt is left sitting in the input box. A short settle delay before
// Enter makes submission reliable.
const PASTE_SUBMIT_DELAY_MS = 200;

export const defaultTmuxCommandRunner: TmuxCommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function writeLauncher(params: {
  file: string;
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
}): Promise<void> {
  const script = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const command = ${JSON.stringify(params.command)};
const args = ${JSON.stringify(params.args)};
const cwd = ${JSON.stringify(params.cwd)};
const envKeys = ${JSON.stringify(params.envKeys)};
const env = {};
for (const key of envKeys) {
  if (process.env[key] !== undefined) {
    env[key] = process.env[key];
  }
}

const child = spawn(command, args, {
  cwd,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(127);
});
`;
  await fs.writeFile(params.file, script, { mode: 0o700 });
  await fs.chmod(params.file, 0o700);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function metadataMismatchReasons(existing: TmuxMetadata | null, expected: TmuxMetadata): string[] {
  if (!existing) {
    return ["missing-existing-metadata"];
  }
  // NOTE: systemPromptHash is intentionally NOT compared. It changes every
  // turn (date + rotating context), and a persistent tmux Claude REPL fixes
  // its system prompt at launch — follow-up turns just paste the new user
  // message. Comparing it would kill + re-bootstrap the session every turn.
  const reasons: string[] = [];
  if (existing.backendId !== expected.backendId) {
    reasons.push("backendId");
  }
  if (existing.workspaceDir !== expected.workspaceDir) {
    reasons.push("workspaceDir");
  }
  if (existing.sessionName !== expected.sessionName) {
    reasons.push("sessionName");
  }
  if (existing.launchHash !== expected.launchHash) {
    reasons.push("launchHash");
  }
  if (existing.model !== expected.model) {
    reasons.push("model");
  }
  if ((existing.mcpConfigHash ?? "") !== (expected.mcpConfigHash ?? "")) {
    reasons.push("mcpConfigHash");
  }
  if ((existing.authProfileId ?? "") !== (expected.authProfileId ?? "")) {
    reasons.push("authProfileId");
  }
  if (existing.memoryMode !== expected.memoryMode) {
    reasons.push("memoryMode");
  }
  if (existing.hookMode !== expected.hookMode) {
    reasons.push("hookMode");
  }
  // launchMode IS identity for the running process: a fresh REPL owns its
  // session id, a resumed REPL replayed history from disk. Switching between
  // them must recreate exactly once. claudeSessionId is intentionally NOT
  // compared — it is recovery data, not launch identity, and comparing it
  // would kill+recreate every time the bound id is discovered/changes.
  if (existing.launchMode !== expected.launchMode) {
    reasons.push("launchMode");
  }
  return reasons;
}

export class TmuxSessionManager {
  constructor(private readonly runCommand: TmuxCommandRunner = defaultTmuxCommandRunner) {}

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      await this.runCommand("tmux", ["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  // `hasSession` only proves the tmux session object exists — the pane's
  // child (the Claude REPL) may have already exited while tmux keeps a dead
  // pane around. This checks the pane is genuinely alive: not flagged dead
  // and carrying a live child pid. A dead/missing pane (or any tmux error)
  // reports not-alive so callers can trigger resume-based recovery.
  async isPaneAlive(sessionName: string): Promise<boolean> {
    try {
      const result = await this.runCommand("tmux", [
        "list-panes",
        "-t",
        `${sessionName}:0.0`,
        "-F",
        "#{pane_dead} #{pane_pid}",
      ]);
      const line = result.stdout.split("\n").find((entry) => entry.trim().length > 0);
      if (!line) {
        return false;
      }
      const [dead, pid] = line.trim().split(/\s+/);
      if (dead !== "0") {
        return false;
      }
      return Boolean(pid && Number.parseInt(pid, 10) > 0);
    } catch {
      return false;
    }
  }

  async killSession(sessionName: string): Promise<void> {
    try {
      await this.runCommand("tmux", ["kill-session", "-t", sessionName]);
    } catch {
      // Session cleanup is best-effort; callers can recreate on the next run.
    }
  }

  async ensureSession(params: {
    paths: TmuxRuntimePaths;
    metadata: TmuxMetadata;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    config: NormalizedTmuxConfig;
    onDiagnostic?: (event: string, data?: Record<string, unknown>) => void;
  }): Promise<TmuxEnsureSessionResult> {
    const exists = await this.hasSession(params.metadata.sessionName);
    const existingMetadata = await readJsonFile<TmuxMetadata>(params.paths.metadataFile);
    const reasons = metadataMismatchReasons(existingMetadata, params.metadata);
    params.onDiagnostic?.("tmux.ensureSession.start", {
      sessionName: params.metadata.sessionName,
      exists,
      hasMetadata: existingMetadata !== null,
      mismatchReasons: reasons,
    });
    if (exists && reasons.length === 0) {
      await fs.writeFile(
        params.paths.metadataFile,
        `${JSON.stringify({ ...existingMetadata, lastUsedAt: Date.now() }, null, 2)}\n`,
      );
      params.onDiagnostic?.("tmux.ensureSession.reuse", {
        sessionName: params.metadata.sessionName,
        persistedClaudeSessionId: existingMetadata?.claudeSessionId,
      });
      return {
        created: false,
        ...(existingMetadata?.claudeSessionId
          ? { persistedClaudeSessionId: existingMetadata.claudeSessionId }
          : {}),
      };
    }
    if (exists) {
      params.onDiagnostic?.("tmux.ensureSession.killing", {
        sessionName: params.metadata.sessionName,
        mismatchReasons: reasons,
        existingLaunchHash: existingMetadata?.launchHash,
        expectedLaunchHash: params.metadata.launchHash,
        existingModel: existingMetadata?.model,
        expectedModel: params.metadata.model,
      });
      await this.killSession(params.metadata.sessionName);
    }
    const envEntries = Object.entries(params.env).filter(
      (entry): entry is [string, string] =>
        ENV_KEY_RE.test(entry[0]) && typeof entry[1] === "string" && !entry[1].includes("\0"),
    );
    const envKeys = envEntries.map(([key]) => key);
    await fs.writeFile(params.paths.paneLogFile, "", { mode: 0o600 });
    await fs.writeFile(params.paths.eventsFile, "", { mode: 0o600 });
    await writeLauncher({
      file: params.paths.launcherFile,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      envKeys,
    });
    await this.runCommand(
      "tmux",
      [
        "new-session",
        "-d",
        ...envEntries.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "-s",
        params.metadata.sessionName,
        "-c",
        params.cwd,
        "--",
        "node",
        params.paths.launcherFile,
      ],
      { cwd: params.cwd },
    );
    await this.runCommand("tmux", [
      "pipe-pane",
      "-o",
      "-t",
      `${params.metadata.sessionName}:0.0`,
      `cat >> ${shellQuote(params.paths.paneLogFile)}`,
    ]);
    await fs.writeFile(params.paths.metadataFile, `${JSON.stringify(params.metadata, null, 2)}\n`, {
      mode: 0o600,
    });
    params.onDiagnostic?.("tmux.ensureSession.created", {
      sessionName: params.metadata.sessionName,
    });
    return { created: true };
  }

  async pastePrompt(params: {
    sessionName: string;
    bufferName: string;
    promptFile: string;
  }): Promise<void> {
    await this.runCommand("tmux", ["load-buffer", "-b", params.bufferName, params.promptFile]);
    await this.runCommand("tmux", [
      "paste-buffer",
      "-b",
      params.bufferName,
      "-t",
      `${params.sessionName}:0.0`,
    ]);
    await sleep(PASTE_SUBMIT_DELAY_MS);
    await this.runCommand("tmux", ["send-keys", "-t", `${params.sessionName}:0.0`, "Enter"]);
  }

  async sendEnter(sessionName: string): Promise<void> {
    await this.runCommand("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "Enter"]);
  }

  async sendKey(sessionName: string, key: string): Promise<void> {
    await this.runCommand("tmux", ["send-keys", "-t", `${sessionName}:0.0`, key]);
  }

  async captureTail(sessionName: string, lines: number): Promise<string> {
    try {
      const result = await this.runCommand("tmux", [
        "capture-pane",
        "-p",
        "-J",
        "-S",
        `-${Math.max(1, lines)}`,
        "-t",
        `${sessionName}:0.0`,
      ]);
      return result.stdout;
    } catch {
      return "";
    }
  }

  async interrupt(sessionName: string): Promise<void> {
    try {
      await this.runCommand("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "C-c"]);
    } catch {
      await this.killSession(sessionName);
    }
  }
}
