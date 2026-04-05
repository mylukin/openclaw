import crypto from "node:crypto";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { normalizeProviderId } from "./model-selection.js";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = trimOptional(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

export function getCliSessionBinding(
  entry: SessionEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = trimOptional(fromBindings?.sessionId);
  if (bindingSessionId) {
    return {
      sessionId: bindingSessionId,
      systemPromptFile: trimOptional(fromBindings?.systemPromptFile),
      systemPromptHash: trimOptional(fromBindings?.systemPromptHash),
      systemPromptCompactionCount:
        typeof fromBindings?.systemPromptCompactionCount === "number" &&
        Number.isFinite(fromBindings.systemPromptCompactionCount) &&
        fromBindings.systemPromptCompactionCount >= 0
          ? fromBindings.systemPromptCompactionCount
          : undefined,
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  if (fromMap?.trim()) {
    return { sessionId: fromMap.trim() };
  }
  if (normalized === "claude-cli") {
    const legacy = entry.claudeCliSessionId?.trim();
    if (legacy) {
      return { sessionId: legacy };
    }
  }
  return undefined;
}

export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}

export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  setCliSessionBinding(entry, provider, { sessionId });
}

export function setCliSessionBinding(
  entry: SessionEntry,
  provider: string,
  binding: CliSessionBinding,
): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = binding.sessionId.trim();
  if (!trimmed) {
    return;
  }
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(trimOptional(binding.systemPromptFile)
        ? { systemPromptFile: trimOptional(binding.systemPromptFile) }
        : {}),
      ...(trimOptional(binding.systemPromptHash)
        ? { systemPromptHash: trimOptional(binding.systemPromptHash) }
        : {}),
      ...(typeof binding.systemPromptCompactionCount === "number" &&
      Number.isFinite(binding.systemPromptCompactionCount) &&
      binding.systemPromptCompactionCount >= 0
        ? {
            systemPromptCompactionCount: Math.floor(binding.systemPromptCompactionCount),
          }
        : {}),
    },
  };
  const existing = entry.cliSessionIds ?? {};
  entry.cliSessionIds = { ...existing };
  entry.cliSessionIds[normalized] = trimmed;
  if (normalized === "claude-cli") {
    entry.claudeCliSessionId = trimmed;
  }
}

export function clearCliSession(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliSessionBindings?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionBindings };
    delete next[normalized];
    entry.cliSessionBindings = Object.keys(next).length > 0 ? next : undefined;
  }
  if (entry.cliSessionIds?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionIds };
    delete next[normalized];
    entry.cliSessionIds = Object.keys(next).length > 0 ? next : undefined;
  }
  if (normalized === "claude-cli") {
    delete entry.claudeCliSessionId;
  }
}
