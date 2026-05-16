import type { CliBackendConfig } from "../../../config/types.js";

const FLAGS_WITH_VALUE = new Set([
  "-p",
  "--print",
  "--output-format",
  "--input-format",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--system-prompt",
  "--system-prompt-file",
  "--setting-sources",
  "--settings",
  "--managed-settings",
  "--permission-mode",
  "--session-id",
  "--model",
]);

const DROP_FLAGS = new Set([
  "-p",
  "--print",
  "--bare",
  "--include-partial-messages",
  "--verbose",
  "--dangerously-skip-permissions",
  "--replay-user-messages",
  "--no-session-persistence",
]);

function shouldDropEqualsArg(arg: string): boolean {
  return (
    arg.startsWith("--output-format=") ||
    arg.startsWith("--input-format=") ||
    arg.startsWith("--append-system-prompt=") ||
    arg.startsWith("--append-system-prompt-file=") ||
    arg.startsWith("--system-prompt=") ||
    arg.startsWith("--system-prompt-file=") ||
    arg.startsWith("--setting-sources=") ||
    arg.startsWith("--settings=") ||
    arg.startsWith("--managed-settings=") ||
    arg.startsWith("--permission-mode=") ||
    arg.startsWith("--session-id=") ||
    arg.startsWith("--model=")
  );
}

export type TmuxLaunchSpec =
  | { mode: "fresh"; sessionId?: string }
  | { mode: "resume"; claudeSessionId: string };

function filterBaseArgs(source: readonly string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const arg = source[i] ?? "";
    if (DROP_FLAGS.has(arg) || shouldDropEqualsArg(arg)) {
      continue;
    }
    if (FLAGS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    args.push(arg);
  }
  return args;
}

export function buildClaudeTmuxArgs(params: {
  backend: CliBackendConfig;
  baseArgs?: string[];
  modelId: string;
  settingsFile: string;
  systemPrompt: string;
  launch: TmuxLaunchSpec;
}): string[] {
  if (params.launch.mode === "resume") {
    // Resume an existing Claude session from disk. The base comes from the
    // backend resume template so `--resume <id>` is carried through; the
    // shared filter drops `-p`/`--bare`/stream-json/etc. just like fresh.
    // Claude CLI rejects `--append-system-prompt` on resume (see non-tmux
    // cli-runner/execute.ts), so it is intentionally NOT added here — the
    // caller re-injects the loader as the first pasted message on the
    // recovered turn instead.
    const claudeSessionId = params.launch.claudeSessionId;
    const resumeTemplate = params.backend.resumeArgs ?? params.backend.args ?? [];
    const substituted = resumeTemplate.map((entry) =>
      entry.replaceAll("{sessionId}", claudeSessionId),
    );
    const args = filterBaseArgs(substituted);
    // Defensive: if the template lacked an explicit resume flag, add one.
    if (!args.includes("--resume")) {
      args.push("--resume", claudeSessionId);
    }
    args.push("--settings", params.settingsFile);
    args.push("--setting-sources", "");
    args.push("--permission-mode", "bypassPermissions");
    if (params.backend.modelArg && params.modelId) {
      args.push(params.backend.modelArg, params.modelId);
    }
    return args;
  }

  const args = filterBaseArgs(params.baseArgs ?? []);
  args.push("--settings", params.settingsFile);
  args.push("--setting-sources", "");
  const systemPromptArg = params.backend.systemPromptArg?.trim() || "--append-system-prompt";
  args.push(systemPromptArg, params.systemPrompt);
  args.push("--permission-mode", "bypassPermissions");
  if (params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (params.backend.sessionArg && params.launch.sessionId) {
    args.push(params.backend.sessionArg, params.launch.sessionId);
  }
  return args;
}
