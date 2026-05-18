import path from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CliBackendConfig } from "../../config/types.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  analyzeBootstrapBudget,
  prependBootstrapPromptWarning,
} from "../bootstrap-budget.js";
import {
  COMPACTION_SYSTEM_PROMPT,
  compactBootstrapFiles,
  resolveCompactionConfig,
} from "../bootstrap-compaction.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import {
  hashCliSessionStablePrompt,
  hashCliSessionText,
  resolveCliSessionReuse,
} from "../cli-session.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import {
  getApiKeyForModel,
  requireApiKey,
  resolveApiKeyForProvider,
  resolveUsableCustomProviderApiKey,
} from "../model-auth.js";
import {
  isCliProvider,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveNonCliModelRef,
} from "../model-selection.js";
import {
  buildBootstrapContextFiles,
  getBootstrapProfileConfig,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
  type BootstrapProfile,
} from "../pi-embedded-helpers.js";
import { resolveModel } from "../pi-embedded-runner/model.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { buildWorkspaceSkillSnapshot, resolveSkillsPromptForRun } from "../skills.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { buildSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
};

export function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

function hasCliFlag(args: string[] | undefined, flag: string): boolean {
  return args?.some((entry) => entry === flag || entry.startsWith(`${flag}=`)) ?? false;
}

function resolveProviderBaseUrl(
  config: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const providers = config?.models?.providers ?? {};
  const normalizedProvider = normalizeProviderId(provider);
  for (const [key, value] of Object.entries(providers)) {
    if (normalizeProviderId(key) !== normalizedProvider) {
      continue;
    }
    const baseUrl =
      value &&
      typeof value === "object" &&
      typeof (value as { baseUrl?: unknown }).baseUrl === "string"
        ? (value as { baseUrl: string }).baseUrl.trim()
        : "";
    if (baseUrl) {
      return baseUrl;
    }
  }
  return undefined;
}

async function resolveClaudeBareManagedEnv(params: {
  config: OpenClawConfig | undefined;
  backendId: string;
  backendConfig: CliBackendConfig;
  authProfileId?: string;
}): Promise<Record<string, string> | undefined> {
  // `claude --bare` ignores Claude's local OAuth/keychain state, and tmux
  // non-bare mode defaults to OpenClaw-owned auth. Pipe Anthropic API auth
  // into the Claude process explicitly for both modes.
  if (params.backendId !== "claude-cli") {
    return undefined;
  }
  const tmuxOpenClawAuth =
    params.backendConfig.execution?.mode === "tmux" &&
    (params.backendConfig.execution.tmux?.authMode ?? "openclaw") === "openclaw";
  if (
    !tmuxOpenClawAuth &&
    !hasCliFlag(params.backendConfig.args, "--bare") &&
    !hasCliFlag(params.backendConfig.resumeArgs, "--bare")
  ) {
    return undefined;
  }

  // If the user already pinned Anthropic credentials in
  // `cliBackends.claude-cli.env` (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY),
  // respect that override and skip auto-injection. Otherwise claude subprocess
  // receives two conflicting credentials at once and routing relays may pick
  // the stale one (e.g. Bearer from backend.env + x-api-key from the generic
  // anthropic provider auto-inject), producing opaque upstream failures.
  const explicitBackendEnv = params.backendConfig.env ?? {};
  if (explicitBackendEnv.ANTHROPIC_AUTH_TOKEN || explicitBackendEnv.ANTHROPIC_API_KEY) {
    return undefined;
  }

  const explicitProviderKey = resolveUsableCustomProviderApiKey({
    cfg: params.config,
    provider: "anthropic",
  });

  let managedApiKey = explicitProviderKey?.apiKey;
  if (!managedApiKey) {
    const resolvedAuth =
      (await resolveApiKeyForProvider({
        provider: "anthropic",
        cfg: params.config,
        ...(params.authProfileId ? { profileId: params.authProfileId } : {}),
      }).catch(() => null)) ??
      (await resolveApiKeyForProvider({
        provider: "anthropic",
        cfg: params.config,
      }).catch(() => null));
    if (resolvedAuth?.mode === "api-key") {
      managedApiKey = resolvedAuth.apiKey;
    }
  }

  if (!managedApiKey) {
    return undefined;
  }

  const managedEnv: Record<string, string> = {
    ANTHROPIC_API_KEY: managedApiKey,
  };
  const providerBaseUrl = resolveProviderBaseUrl(params.config, "anthropic");
  if (providerBaseUrl) {
    managedEnv.ANTHROPIC_BASE_URL = providerBaseUrl;
  }
  return managedEnv;
}

// ---------------------------------------------------------------------------
// Session prompt file management
//
// Implementations live in the leaf module ./system-prompt-file.js so the tmux
// execution path can reuse them without importing this heavy module. Re-export
// here to preserve the existing public import surface.
// ---------------------------------------------------------------------------

export {
  type ClaudeSystemPromptChunk,
  resolveClaudeSystemPromptFilePath,
  splitClaudeSystemPromptIntoChunks,
  buildClaudeSystemPromptFileContents,
  writeClaudeSystemPromptFile,
  buildClaudeSystemPromptLoaderPrompt,
  buildClaudeSystemPromptCompletionPrompt,
} from "./system-prompt-file.js";

export class PromptFileReadRequiredError extends Error {
  readonly reason: "not-read" | "partial-read" | "read-error";
  readonly sessionId?: string;
  readonly promptFile?: string;
  readonly unverifiedPaths?: string[];

  constructor(params: {
    message: string;
    reason: "not-read" | "partial-read" | "read-error";
    sessionId?: string;
    promptFile?: string;
    unverifiedPaths?: string[];
  }) {
    super(params.message);
    this.name = "PromptFileReadRequiredError";
    this.reason = params.reason;
    this.sessionId = params.sessionId;
    this.promptFile = params.promptFile;
    this.unverifiedPaths = params.unverifiedPaths;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveReadToolRequest(input: unknown): {
  filePath?: string;
  offset?: number;
  limit?: number;
} {
  if (!isRecord(input)) {
    return {};
  }
  const nestedArguments = isRecord(input.arguments) ? input.arguments : undefined;
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    nestedArguments?.file_path,
    nestedArguments?.filePath,
    nestedArguments?.path,
  ];
  const pickNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
  const offset = pickNumber(input.offset) ?? pickNumber(nestedArguments?.offset);
  const limit = pickNumber(input.limit) ?? pickNumber(nestedArguments?.limit);
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return { filePath: path.resolve(candidate.trim()), offset, limit };
    }
  }
  return { offset, limit };
}

/**
 * Rough token estimate. Smoothly interpolates chars-per-token between 4
 * (pure Latin) and 1.5 (pure CJK) using a quadratic curve that is
 * deliberately conservative for mixed-language text. At 30% CJK the
 * estimate is ~2.63 chars/token, avoiding the binary jump while staying
 * protective for Feishu-style mixed Chinese/English prompts.
 *
 * Curve: charsPerToken = 4 - 2.5 * cjkRatio^0.5  (clamped to [1.5, 4])
 */
export function estimatePromptTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkCount =
    text.match(/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff\uff00-\uffef]/g)
      ?.length ?? 0;
  const cjkRatio = cjkCount / text.length;
  // Quadratic curve: drops fast with even small CJK ratios, staying
  // conservative for mixed-language content (the primary risk case).
  const charsPerToken = Math.max(1.5, Math.min(4, 4 - 2.5 * Math.sqrt(cjkRatio)));
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate image token cost for pre-flight context window guard.
 * Uses a rough average of ~1000 tokens per image (standard resolution).
 */
export const ESTIMATED_TOKENS_PER_IMAGE = 1000;

export async function prepareCliRunContext(
  params: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    cliBackendLog.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const isClaude = backendResolved.id === "claude-cli";
  const authEpoch = await resolveCliAuthEpoch({
    provider: params.provider,
    authProfileId: params.authProfileId,
  });
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  const extraSystemPromptHash = hashCliSessionStablePrompt({
    extraSystemPrompt,
    extraSystemPromptStatic: params.stableExtraSystemPrompt,
  });
  const fullExtraSystemPromptHash = hashCliSessionText(extraSystemPrompt);
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backendResolved.config);
  const modelDisplay = `${params.provider}/${modelId}`;

  // Resolve context window early -- needed by Layer 3 (dynamic budget).
  let contextWindowRef = resolveNonCliModelRef(
    { provider: params.provider, model: modelId },
    params.config,
  );
  if (isCliProvider(contextWindowRef.provider, params.config)) {
    const agentDefault = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: params.agentId,
    });
    contextWindowRef = resolveNonCliModelRef(agentDefault, params.config);
  }
  const contextWindowInfo = resolveContextWindowInfo({
    cfg: params.config,
    provider: contextWindowRef.provider,
    modelId: contextWindowRef.model,
    defaultTokens: 200_000,
  });
  const contextWindowTokens = contextWindowInfo.tokens;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await prepareDeps.resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: prepareDeps.makeBootstrapWarn({
      sessionLabel,
      warn: (message) => cliBackendLog.warn(message),
    }),
    contextWindowTokens,
  });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, contextWindowTokens);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const mcpLoopbackRuntime =
    backendResolved.id === "claude-cli" ? prepareDeps.getActiveMcpLoopbackRuntime() : undefined;
  const managedClaudeBareEnv = await resolveClaudeBareManagedEnv({
    config: params.config,
    backendId: backendResolved.id,
    backendConfig: backendResolved.config,
    authProfileId: params.authProfileId,
  });
  const preparedBackend = await prepareCliBundleMcpConfig({
    enabled: backendResolved.bundleMcp && params.disableTools !== true,
    backend: backendResolved.config,
    workspaceDir,
    config: params.config,
    additionalConfig: mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined,
    env: {
      ...managedClaudeBareEnv,
      ...(mcpLoopbackRuntime
        ? {
            OPENCLAW_MCP_TOKEN: mcpLoopbackRuntime.token,
            OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
            OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
            OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
            OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageProvider ?? "",
            OPENCLAW_MCP_MODEL: `${params.provider}/${modelId}`,
            OPENCLAW_MCP_RUN_ID: params.runId,
            OPENCLAW_MCP_CURRENT_CHANNEL: params.currentChannelId ?? "",
          }
        : {}),
    },
    warn: (message) => cliBackendLog.warn(message),
  });
  const reusableCliSession = resolveCliSessionReuse({
    binding:
      params.cliSessionBinding ??
      (params.cliSessionId ? { sessionId: params.cliSessionId } : undefined),
    authProfileId: params.authProfileId,
    authEpoch,
    extraSystemPromptHash,
    mcpConfigHash: preparedBackend.mcpConfigHash,
  });
  if (reusableCliSession.invalidatedReason) {
    const resetReason =
      reusableCliSession.invalidatedReason === "system-prompt"
        ? "stable-system-change"
        : reusableCliSession.invalidatedReason === "mcp"
          ? "mcp-change"
          : "auth-change";
    cliBackendLog.info(`cli session reset: provider=${params.provider} reason=${resetReason}`);
  } else if (
    params.stableExtraSystemPrompt !== undefined &&
    fullExtraSystemPromptHash !== extraSystemPromptHash
  ) {
    cliBackendLog.info(
      `cli session reuse: provider=${params.provider} reason=turn-context-change-ignored`,
    );
  }
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const promptTools =
    params.disableTools !== true &&
    backendResolved.bundleMcp &&
    backendResolved.config.mcp?.enabled !== false
      ? createOpenClawCodingTools({
          agentId: sessionAgentId,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          workspaceDir,
          config: params.config,
          abortSignal: params.abortSignal,
          modelProvider: params.provider,
          modelId,
        })
      : [];
  const effectiveSkillsSnapshot =
    params.skillsSnapshot ??
    (() => {
      try {
        return buildWorkspaceSkillSnapshot(workspaceDir, {
          config: params.config,
          agentId: sessionAgentId,
        });
      } catch {
        return undefined;
      }
    })();
  const skillsPrompt = resolveSkillsPromptForRun({
    skillsSnapshot: params.disableTools === true ? undefined : effectiveSkillsSnapshot,
    config: params.config,
    workspaceDir,
    agentId: sessionAgentId,
  });
  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  let systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    skillsPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: promptTools,
    contextFiles,
    modelDisplay,
    agentId: sessionAgentId,
  });

  let activeProfile: BootstrapProfile = "normal";
  let activeContextFiles = contextFiles;

  // Layer 3: Pre-flight context window guard (dynamic budget).
  // Only charge multimodal token cost when the backend sends images via imageArg.
  const backend = backendResolved.config;
  const imageTokenEstimate = backend.imageArg
    ? (params.images?.length ?? 0) * ESTIMATED_TOKENS_PER_IMAGE
    : 0;

  {
    const hardLimitTokens = Math.floor(contextWindowTokens * 0.7);

    // For very small context windows (<30K tokens), force the budget guard to trigger
    // immediately. The reserve=max(tokens*0.3, 30K) formula produces negative available
    // budget for windows <30K, so dynamic sizing is meaningless — go straight to profiles.
    let estimatedTokens =
      estimatePromptTokens(systemPrompt) + estimatePromptTokens(params.prompt) + imageTokenEstimate;

    if (estimatedTokens > hardLimitTokens) {
      const warnForProfile = prepareDeps.makeBootstrapWarn({
        sessionLabel,
        warn: (message) => cliBackendLog.warn(message),
      });

      let lastProfileContextFiles = contextFiles;
      // Skip "reduced" for very small context windows — go straight to "minimal"
      const profilesToTry: BootstrapProfile[] =
        contextWindowTokens < 30_000 ? ["minimal"] : ["reduced", "minimal"];
      let compactionDone = false;

      for (const profile of profilesToTry) {
        // Compaction step: run once, between "reduced" and "minimal"
        if (!compactionDone && profile === "minimal") {
          compactionDone = true;
          const compactionCfg = resolveCompactionConfig(params.config);
          let compactionProvider: string;
          let compactionModelRef: string;
          if (compactionCfg.model?.includes("/")) {
            compactionProvider = compactionCfg.model.split("/")[0];
            compactionModelRef = compactionCfg.model.split("/").slice(1).join("/");
          } else if (compactionCfg.model) {
            compactionProvider = params.provider;
            compactionModelRef = compactionCfg.model;
          } else {
            compactionProvider = params.provider;
            compactionModelRef = modelId;
          }

          if (isCliProvider(compactionProvider, params.config)) {
            const currentRunRef = resolveNonCliModelRef(
              { provider: compactionProvider, model: compactionModelRef },
              params.config,
            );
            if (!isCliProvider(currentRunRef.provider, params.config)) {
              compactionProvider = currentRunRef.provider;
              compactionModelRef = currentRunRef.model;
            } else {
              const agentDefault = resolveDefaultModelForAgent({
                cfg: params.config ?? {},
                agentId: params.agentId,
              });
              const resolved = resolveNonCliModelRef(agentDefault, params.config);
              compactionProvider = resolved.provider;
              compactionModelRef = resolved.model;
            }
          }

          try {
            const resolved = resolveModel(
              compactionProvider,
              compactionModelRef,
              undefined,
              params.config,
            );
            if (!resolved.model) {
              throw new Error(
                resolved.error ??
                  `Unknown compaction model: ${compactionProvider}/${compactionModelRef}`,
              );
            }
            const apiKey = requireApiKey(
              await getApiKeyForModel({ model: resolved.model, cfg: params.config }),
              compactionProvider,
            );

            const isTextBlock = (b: { type: string }): b is { type: "text"; text: string } =>
              b.type === "text";
            const { contextFiles: compactedContextFiles, results } = await compactBootstrapFiles({
              contextFiles: lastProfileContextFiles,
              config: compactionCfg,
              modelRef: `${compactionProvider}/${compactionModelRef}`,
              llmFn: async (userPrompt, signal) => {
                const res = await completeSimple(
                  resolved.model!,
                  {
                    systemPrompt: COMPACTION_SYSTEM_PROMPT,
                    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
                  },
                  { apiKey, maxTokens: 4096, temperature: 0, signal },
                );
                const texts = res.content.filter(isTextBlock);
                if (texts.length === 0) {
                  throw new Error("No text content in compaction response");
                }
                return texts.map((b) => b.text).join("\n");
              },
              signal: params.abortSignal,
            });

            const compactedFilesList = results.filter((r) => r.success).map((r) => r.path);
            if (compactedFilesList.length > 0) {
              const compactedBudget =
                activeProfile === "normal"
                  ? { maxCharsPerFile: bootstrapMaxChars, totalMaxChars: bootstrapTotalMaxChars }
                  : getBootstrapProfileConfig(activeProfile);
              const compactedWarning = buildBootstrapPromptWarning({
                analysis: analyzeBootstrapBudget({
                  files: buildBootstrapInjectionStats({
                    bootstrapFiles,
                    injectedFiles: compactedContextFiles,
                  }),
                  bootstrapMaxChars: compactedBudget.maxCharsPerFile,
                  bootstrapTotalMaxChars: compactedBudget.totalMaxChars,
                }),
                mode: bootstrapPromptWarningMode,
                seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
                previousSignature: params.bootstrapPromptWarningSignature,
              });
              const compactedSystemPrompt = prependBootstrapPromptWarning(
                buildSystemPrompt({
                  workspaceDir,
                  config: params.config,
                  defaultThinkLevel: params.thinkLevel,
                  extraSystemPrompt,
                  skillsPrompt,
                  ownerNumbers: params.ownerNumbers,
                  heartbeatPrompt,
                  docsPath: docsPath ?? undefined,
                  tools: promptTools,
                  contextFiles: compactedContextFiles,
                  modelDisplay,
                  agentId: sessionAgentId,
                }),
                compactedWarning.lines,
              );
              const compactedTokens =
                estimatePromptTokens(compactedSystemPrompt) +
                estimatePromptTokens(params.prompt) +
                imageTokenEstimate;
              if (compactedTokens <= hardLimitTokens) {
                systemPrompt = compactedSystemPrompt;
                activeContextFiles = compactedContextFiles;
                estimatedTokens = compactedTokens;
                break;
              }
            }
          } catch (err) {
            cliBackendLog.warn(
              `cli-runner: bootstrap compaction failed, falling back to minimal profile: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const profileConfig = getBootstrapProfileConfig(profile);
        const profileContextFiles = buildBootstrapContextFiles(bootstrapFiles, {
          maxChars: profileConfig.maxCharsPerFile,
          totalMaxChars: profileConfig.totalMaxChars,
          warn: warnForProfile,
        });
        lastProfileContextFiles = profileContextFiles;
        const profileWarning = buildBootstrapPromptWarning({
          analysis: analyzeBootstrapBudget({
            files: buildBootstrapInjectionStats({
              bootstrapFiles,
              injectedFiles: profileContextFiles,
            }),
            bootstrapMaxChars: profileConfig.maxCharsPerFile,
            bootstrapTotalMaxChars: profileConfig.totalMaxChars,
          }),
          mode: bootstrapPromptWarningMode,
          seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
          previousSignature: params.bootstrapPromptWarningSignature,
        });
        const profileSystemPrompt = prependBootstrapPromptWarning(
          buildSystemPrompt({
            workspaceDir,
            config: params.config,
            defaultThinkLevel: params.thinkLevel,
            extraSystemPrompt,
            skillsPrompt,
            ownerNumbers: params.ownerNumbers,
            heartbeatPrompt,
            docsPath: docsPath ?? undefined,
            tools: promptTools,
            contextFiles: profileContextFiles,
            modelDisplay,
            agentId: sessionAgentId,
          }),
          profileWarning.lines,
        );
        activeProfile = profile;
        systemPrompt = profileSystemPrompt;
        activeContextFiles = profileContextFiles;
        estimatedTokens =
          estimatePromptTokens(profileSystemPrompt) +
          estimatePromptTokens(params.prompt) +
          imageTokenEstimate;
        if (estimatedTokens <= hardLimitTokens) {
          break;
        }
      }
      if (estimatedTokens > hardLimitTokens) {
        cliBackendLog.error(
          `cli-runner: system prompt exceeds context limit after minimal profile (estimated=${estimatedTokens} tokens, limit=${hardLimitTokens}); proceeding anyway`,
        );
      }
    }
  }

  // Build report from the final active context files so metadata reflects
  // the actual profile used (not the initial "normal" profile).
  const buildReportForActiveContext = () => {
    const activeBudget =
      activeProfile === "normal"
        ? { maxCharsPerFile: bootstrapMaxChars, totalMaxChars: bootstrapTotalMaxChars }
        : getBootstrapProfileConfig(activeProfile);
    const analysis =
      activeContextFiles !== contextFiles
        ? analyzeBootstrapBudget({
            files: buildBootstrapInjectionStats({
              bootstrapFiles,
              injectedFiles: activeContextFiles,
            }),
            bootstrapMaxChars: activeBudget.maxCharsPerFile,
            bootstrapTotalMaxChars: activeBudget.totalMaxChars,
          })
        : bootstrapAnalysis;
    const warning =
      activeContextFiles !== contextFiles
        ? buildBootstrapPromptWarning({
            analysis,
            mode: bootstrapPromptWarningMode,
            seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
            previousSignature: params.bootstrapPromptWarningSignature,
          })
        : bootstrapPromptWarning;
    return buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: modelId,
      workspaceDir,
      bootstrapMaxChars: activeBudget.maxCharsPerFile,
      bootstrapTotalMaxChars: activeBudget.totalMaxChars,
      bootstrapTruncation: buildBootstrapTruncationReportMeta({
        analysis,
        warningMode: bootstrapPromptWarningMode,
        warning,
      }),
      sandbox: { mode: "off", sandboxed: false },
      systemPrompt,
      bootstrapFiles,
      injectedFiles: activeContextFiles,
      skillsPrompt,
      tools: promptTools,
    });
  };
  const systemPromptReport = buildReportForActiveContext();

  return {
    params,
    started,
    workspaceDir,
    backendResolved,
    preparedBackend,
    reusableCliSession,
    modelId,
    normalizedModel,
    systemPrompt,
    systemPromptReport,
    promptTools,
    bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
    heartbeatPrompt,
    authEpoch,
    extraSystemPromptHash,
    contextWindowTokens,
    activeProfile,
    activeContextFiles,
    bootstrapFiles,
    bootstrapPromptWarningMode,
    sessionAgentId,
    defaultAgentId,
    isClaude,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    skillsPrompt,
    effectiveSkillsSnapshot,
    docsPath: docsPath ?? undefined,
    extraSystemPrompt,
    physicalContextId: reusableCliSession.sessionId || undefined,
  };
}
