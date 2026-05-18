import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CliSessionBinding } from "../config/sessions.js";
import { drainCliRunSends } from "../gateway/cli-run-sends.js";
import { executeWithOverflowProtection } from "./cli-runner/execute.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { clearCliSessionFromStore, persistCliSessionBindingToStore } from "./cli-session.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { applySkillEnvOverridesFromSnapshot } from "./skills.js";

/**
 * Returns true if the model sent a message to the current session's channel
 * via the MCP message tool during this run, meaning output.text should be
 * suppressed to avoid double-posting.
 */
function didSendToCurrentChannelViaCliRun(params: RunCliAgentParams): boolean {
  if (!params.currentChannelId) {
    return false;
  }
  const sends = drainCliRunSends(params.runId);
  return sends.includes(params.currentChannelId);
}

function buildCliSessionBinding(params: {
  effectiveCliSessionId: string;
  runParams: RunCliAgentParams;
  context: PreparedCliRunContext;
  resultBinding?: {
    systemPromptFile?: string;
    systemPromptHash?: string;
    systemPromptCompactionCount?: number;
    semanticContextFiles?: string[];
    semanticSessionFile?: string;
    semanticSessionHash?: string;
    semanticCompactionCount?: number;
  };
}): CliSessionBinding {
  const { effectiveCliSessionId, runParams, context, resultBinding } = params;
  return {
    sessionId: effectiveCliSessionId,
    ...(runParams.authProfileId ? { authProfileId: runParams.authProfileId } : {}),
    ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
    ...(context.extraSystemPromptHash
      ? { extraSystemPromptHash: context.extraSystemPromptHash }
      : {}),
    ...(context.preparedBackend.mcpConfigHash
      ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
      : {}),
    ...(resultBinding?.systemPromptFile
      ? {
          systemPromptFile: resultBinding.systemPromptFile,
          systemPromptHash: resultBinding.systemPromptHash,
          systemPromptCompactionCount: resultBinding.systemPromptCompactionCount,
        }
      : {}),
    ...(resultBinding?.semanticSessionFile
      ? {
          semanticContextFiles: resultBinding.semanticContextFiles,
          semanticSessionFile: resultBinding.semanticSessionFile,
          semanticSessionHash: resultBinding.semanticSessionHash,
          semanticCompactionCount: resultBinding.semanticCompactionCount,
        }
      : {}),
  };
}

/**
 * Persist `cliSessionBindings[provider]` to the on-disk session store as soon
 * as the cli-runner has discovered the physical session id. This makes
 * `entry.cliSessionBindings["claude-cli"].sessionId` available to downstream
 * consumers (e.g. the bot-company Feishu plugin's
 * `resolvePhysicalContextIdFromRuntime`) without depending on the end-of-run
 * usage persistence path firing.
 */
async function persistCliRunSessionBinding(params: {
  runParams: RunCliAgentParams;
  binding: CliSessionBinding;
}): Promise<void> {
  await persistCliSessionBindingToStore({
    sessionKey: params.runParams.sessionKey,
    agentId: params.runParams.agentId,
    storeConfig: params.runParams.config?.session?.store,
    provider: params.runParams.provider,
    binding: params.binding,
  });
}

export async function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult> {
  const context = await prepareCliRunContext(params);

  // When the session is explicitly invalidated (auth/system-prompt/MCP change),
  // clear the old binding from the store immediately so the next
  // resolvePhysicalContextIdFromRuntime call returns undefined and bot-company
  // triggers a fresh snapshot injection rather than a stale delta.
  if (context.reusableCliSession.invalidatedReason && params.sessionKey) {
    void clearCliSessionFromStore({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      storeConfig: params.config?.session?.store,
      provider: params.provider,
    });
  }

  const restoreSkillEnv =
    params.disableTools !== true
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: context.effectiveSkillsSnapshot,
          config: params.config,
        })
      : () => {};

  // Try with the provided CLI session ID first
  try {
    try {
      const result = await executeWithOverflowProtection(
        context,
        context.reusableCliSession.sessionId,
      );
      const effectiveCliSessionId =
        result.cliSessionBinding?.sessionId ??
        result.output.sessionId ??
        context.reusableCliSession.sessionId;
      const text = result.output.text?.trim();
      // Suppress output.text when the model already sent a message to the
      // current session's channel via the MCP message tool — prevents the
      // double-message problem where both the tool send and output.text reach
      // the channel.
      const payloads = text && !didSendToCurrentChannelViaCliRun(params) ? [{ text }] : undefined;

      const cliSessionBinding = effectiveCliSessionId
        ? buildCliSessionBinding({
            effectiveCliSessionId,
            runParams: params,
            context,
            resultBinding: result.cliSessionBinding,
          })
        : undefined;

      // Eagerly persist the binding so the next dispatch (e.g. bot-company's
      // resolvePhysicalContextIdFromRuntime) can resolve the physicalContextId
      // without waiting for the end-of-run usage persistence path.
      if (cliSessionBinding) {
        await persistCliRunSessionBinding({ runParams: params, binding: cliSessionBinding });
      }

      return {
        payloads,
        meta: {
          durationMs: Date.now() - context.started,
          systemPromptReport: result.systemPromptReport,
          agentMeta: {
            sessionId: effectiveCliSessionId ?? params.sessionId ?? "",
            provider: params.provider,
            model: context.modelId,
            usage: result.output.usage,
            ...(context.physicalContextId ? { physicalContextId: context.physicalContextId } : {}),
            ...(result.compactionsThisRun > 0
              ? { compactionCount: result.compactionsThisRun }
              : {}),
            ...(cliSessionBinding ? { cliSessionBinding } : {}),
            ...(result.cliPromptLoad ? { cliPromptLoad: result.cliPromptLoad } : {}),
          },
        },
      };
    } catch (err) {
      if (err instanceof FailoverError) {
        // Check if this is a session expired error and we have a session to clear
        if (
          err.reason === "session_expired" &&
          context.reusableCliSession.sessionId &&
          params.sessionKey
        ) {
          // Retry without the session ID to create a new session
          const result = await executeWithOverflowProtection(context, undefined);
          const effectiveCliSessionId =
            result.cliSessionBinding?.sessionId ?? result.output.sessionId;
          const text = result.output.text?.trim();
          const payloads =
            text && !didSendToCurrentChannelViaCliRun(params) ? [{ text }] : undefined;

          const cliSessionBinding = effectiveCliSessionId
            ? buildCliSessionBinding({
                effectiveCliSessionId,
                runParams: params,
                context,
                resultBinding: result.cliSessionBinding,
              })
            : undefined;

          if (cliSessionBinding) {
            await persistCliRunSessionBinding({ runParams: params, binding: cliSessionBinding });
          }

          return {
            payloads,
            meta: {
              durationMs: Date.now() - context.started,
              systemPromptReport: result.systemPromptReport,
              agentMeta: {
                sessionId: effectiveCliSessionId ?? params.sessionId ?? "",
                provider: params.provider,
                model: context.modelId,
                usage: result.output.usage,
                ...(context.physicalContextId
                  ? { physicalContextId: context.physicalContextId }
                  : {}),
                ...(result.compactionsThisRun > 0
                  ? { compactionCount: result.compactionsThisRun }
                  : {}),
                ...(cliSessionBinding ? { cliSessionBinding } : {}),
                ...(result.cliPromptLoad ? { cliPromptLoad: result.cliPromptLoad } : {}),
              },
            },
          };
        }
        throw err;
      }
      // AbortError (user /stop) must pass through unchanged so that the
      // higher-level runner recognises it via `err.name === "AbortError"`.
      // Without this early return, a future addition to the failover
      // classifier could accidentally rewrap an AbortError as FailoverError
      // and lose the name.
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isFailoverErrorMessage(message, { provider: params.provider })) {
        const reason = classifyFailoverReason(message, { provider: params.provider }) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(message, {
          reason,
          provider: params.provider,
          model: context.modelId,
          status,
        });
      }
      throw err;
    }
  } finally {
    restoreSkillEnv();
    await context.preparedBackend.cleanup?.();
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
  });
}
