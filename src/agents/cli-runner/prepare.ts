import fs from "node:fs/promises";
import path from "node:path";
import { type ImageContent, completeSimple } from "@mariozechner/pi-ai";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
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
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import { getApiKeyForModel, requireApiKey } from "../model-auth.js";
import {
  isCliProvider,
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

// ---------------------------------------------------------------------------
// Session prompt file management
// ---------------------------------------------------------------------------

export function resolveClaudeSystemPromptFilePath(sessionFile: string): string {
  const resolvedSessionFile = path.resolve(sessionFile);
  const sessionDir = path.dirname(resolvedSessionFile);
  const ext = path.extname(resolvedSessionFile);
  const baseName = path.basename(resolvedSessionFile, ext);
  return path.join(sessionDir, `${baseName}.claude-system-prompt.txt`);
}

export async function writeClaudeSystemPromptFile(params: {
  sessionFile: string;
  systemPrompt: string;
}): Promise<{ filePath: string; hash: string }> {
  const filePath = resolveClaudeSystemPromptFilePath(params.sessionFile);
  const normalizedPrompt = params.systemPrompt.endsWith("\n")
    ? params.systemPrompt
    : `${params.systemPrompt}\n`;
  const hash = hashCliSessionText(normalizedPrompt) ?? "";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing === normalizedPrompt) {
      return { filePath, hash };
    }
  } catch {
    // file may not exist yet
  }
  await fs.writeFile(filePath, normalizedPrompt, { mode: 0o600 });
  return { filePath, hash };
}

export function buildClaudeSystemPromptLoaderPrompt(params: {
  filePath: string;
  reason: "new-session" | "prompt-changed" | "compaction";
  strict?: boolean;
}): string {
  const baseLines = [
    `MANDATORY FIRST STEP: use the Read tool to read the full session prompt file at ${params.filePath} before you do anything else.`,
    "Do not answer the user, do not summarize from memory, and do not rely on prior turns until you have read that file in this run.",
    "The file's contents are the authoritative OpenClaw system prompt for this session and override any remembered summaries or stale context.",
    "You must follow that file strictly for this turn and all subsequent turns in the session.",
  ];
  if (params.strict) {
    baseLines.unshift(
      "Your previous attempt did not verify a successful read of the session prompt file. You must read it in this run before you answer.",
    );
  }
  if (params.reason === "compaction") {
    baseLines.unshift(
      "Session context may have been compacted or summarized. You must re-read the session prompt file now before continuing.",
    );
  } else if (params.reason === "prompt-changed") {
    baseLines.unshift(
      "The session prompt file changed. You must re-read it completely before continuing.",
    );
  }
  return baseLines.join("\n");
}

export class PromptFileReadRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptFileReadRequiredError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveReadToolFilePath(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const candidates = [input.file_path, input.filePath, input.path];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return path.resolve(candidate.trim());
    }
  }
  return undefined;
}

/**
 * Rough token estimate. Uses chars/1.5 for CJK-heavy content (>30% CJK chars),
 * chars/4 for English-heavy content. CJK characters typically tokenize at 1-3
 * tokens per character, so chars/4 severely underestimates for Chinese/Japanese
 * text -- which is common in feishu deployments.
 */
export function estimatePromptTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkCount =
    text.match(/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff\uff00-\uffef]/g)
      ?.length ?? 0;
  const cjkRatio = cjkCount / text.length;
  const charsPerToken = cjkRatio > 0.3 ? 1.5 : 4;
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
  const extraSystemPromptHash = hashCliSessionText(extraSystemPrompt);
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
  const preparedBackend = await prepareCliBundleMcpConfig({
    enabled: backendResolved.bundleMcp,
    backend: backendResolved.config,
    workspaceDir,
    config: params.config,
    additionalConfig: mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined,
    env: mcpLoopbackRuntime
      ? {
          OPENCLAW_MCP_TOKEN: mcpLoopbackRuntime.token,
          OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
          OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
          OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
          OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageProvider ?? "",
        }
      : undefined,
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
    cliBackendLog.info(
      `cli session reset: provider=${params.provider} reason=${reusableCliSession.invalidatedReason}`,
    );
  }
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
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
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
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

  if (true) {
    const hardLimitTokens = Math.floor(contextWindowTokens * 0.7);
    let estimatedTokens =
      estimatePromptTokens(systemPrompt) +
      estimatePromptTokens(params.prompt) +
      imageTokenEstimate;

    if (estimatedTokens > hardLimitTokens) {
      const warnForProfile = prepareDeps.makeBootstrapWarn({
        sessionLabel,
        warn: (message) => cliBackendLog.warn(message),
      });

      let lastProfileContextFiles = contextFiles;
      const profilesToTry: BootstrapProfile[] = ["reduced", "minimal"];
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
                  ownerNumbers: params.ownerNumbers,
                  heartbeatPrompt,
                  docsPath: docsPath ?? undefined,
                  tools: [],
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
            ownerNumbers: params.ownerNumbers,
            heartbeatPrompt,
            docsPath: docsPath ?? undefined,
            tools: [],
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
      skillsPrompt: "",
      tools: [],
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
    docsPath: docsPath ?? undefined,
    extraSystemPrompt,
  };
}
