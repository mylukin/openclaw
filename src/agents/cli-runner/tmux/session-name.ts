import crypto from "node:crypto";

const SAFE_TMUX_NAME_RE = /[^A-Za-z0-9_.-]+/g;

export function sha256Hex(...parts: Array<string | undefined>): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sanitizeTmuxNamePart(value: string): string {
  return value
    .trim()
    .replace(SAFE_TMUX_NAME_RE, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildTmuxSessionName(params: {
  prefix: string;
  backendId: string;
  workspaceDir: string;
  sessionKey: string;
  modelId: string;
  mcpConfigHash?: string;
  authProfileId?: string;
  memoryMode: string;
  hookMode: string;
}): string {
  const prefix = sanitizeTmuxNamePart(params.prefix) || "openclaw-claude";
  // The session name keys on the *stable* conversation identity only. The
  // system prompt is rebuilt every turn (it embeds the date and rotating
  // context), so including it would make every follow-up DM turn spin up a
  // fresh Claude process instead of pasting into the persistent tmux REPL.
  const digest = sha256Hex(
    params.backendId,
    params.workspaceDir,
    params.sessionKey,
    params.modelId,
    params.mcpConfigHash,
    params.authProfileId,
    params.memoryMode,
    params.hookMode,
  ).slice(0, 12);
  return `${prefix}-${digest}`;
}
