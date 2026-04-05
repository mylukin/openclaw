import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import {
  getCliSessionBinding,
  setCliSessionBinding,
  setCliSessionId,
} from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveNestedAgentLane } from "../../agents/lanes.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider, resolveThinkingDefault } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import {
  countActiveDescendantRuns,
  listDescendantRunsForRequester,
} from "../../agents/subagent-registry.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
  type ThinkLevel,
} from "../../auto-reply/thinking.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob, CronRunOutcome, CronRunTelemetry } from "../types.js";
import {
  dispatchCronDelivery,
  matchesMessagingToolDeliveryTarget,
  resolveCronDeliveryBestEffort,
} from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import {
  isHeartbeatOnlyResponse,
  resolveCronPayloadOutcome,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";
import { executeCronRun, type CronExecutionResult } from "./run-executor.js";
import {
  createPersistCronSessionEntry,
  markCronSessionPreRun,
  persistCronSkillsSnapshotIfChanged,
  type CronLiveSelection,
  type MutableCronSession,
  type PersistCronSessionEntry,
} from "./run-session-state.js";
import { setSessionRuntimeModel } from "../../config/sessions.js";
import { logWarn } from "../../logger.js";
import {
  buildSafeExternalPrompt,
  detectSuspiciousPatterns,
  isExternalHookSession,
  mapHookExternalContentSource,
  resolveHookExternalContentSource,
} from "../../security/external-content.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { resolveCronSession } from "./session.js";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

let sessionStoreRuntimePromise:
  | Promise<typeof import("../../config/sessions/store.runtime.js")>
  | undefined;

async function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return await sessionStoreRuntimePromise;
}

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export type RunCronAgentTurnResult = {
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /**
   * `true` when the isolated runner already handled the run's user-visible
   * delivery outcome. Cron-owned callers use this for cron delivery or
   * explicit suppression; shared callers may also use it for a matching
   * message-tool send that already reached the target.
   */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
} & CronRunOutcome &
  CronRunTelemetry;

type ResolvedCronDeliveryTarget = Awaited<ReturnType<typeof resolveDeliveryTarget>>;

type IsolatedDeliveryContract = "cron-owned" | "shared";

function resolveCronToolPolicy(params: {
  deliveryRequested: boolean;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  deliveryContract: IsolatedDeliveryContract;
}) {
  return {
    // Only enforce an explicit message target when the cron delivery target
    // was successfully resolved. When resolution fails the agent should not
    // be blocked by a target it cannot satisfy (#27898).
    requireExplicitMessageTarget: params.deliveryRequested && params.resolvedDelivery.ok,
    // Cron-owned runs always route user-facing delivery through the runner
    // itself. Shared callers keep the previous behavior so non-cron paths do
    // not silently lose the message tool when no explicit delivery is active.
    disableMessageTool: params.deliveryContract === "cron-owned" ? true : params.deliveryRequested,
  };
}

async function resolveCronDeliveryContext(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  deliveryContract: IsolatedDeliveryContract;
}) {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  if (!deliveryPlan.requested) {
    const resolvedDelivery = {
      ok: false as const,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit" as const,
      error: new Error("cron delivery not requested"),
    };
    return {
      deliveryPlan,
      deliveryRequested: false,
      resolvedDelivery,
      toolPolicy: resolveCronToolPolicy({
        deliveryRequested: false,
        resolvedDelivery,
        deliveryContract: params.deliveryContract,
      }),
    };
  }
  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    threadId: deliveryPlan.threadId,
    accountId: deliveryPlan.accountId,
    sessionKey: params.job.sessionKey,
  });
  return {
    deliveryPlan,
    deliveryRequested: deliveryPlan.requested,
    resolvedDelivery,
    toolPolicy: resolveCronToolPolicy({
      deliveryRequested: deliveryPlan.requested,
      resolvedDelivery,
      deliveryContract: params.deliveryContract,
    }),
  };
}

function appendCronDeliveryInstruction(params: {
  commandBody: string;
  deliveryRequested: boolean;
}) {
  if (!params.deliveryRequested) {
    return params.commandBody;
  }
  return `${params.commandBody}\n\nReturn your summary as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
}

function resolvePositiveContextTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function loadCliRunnerRuntime() {
  return await import("../../agents/cli-runner.runtime.js");
}

async function loadUsageFormatRuntime() {
  return await import("../../utils/usage-format.js");
}

type RunCronAgentTurnParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deliveryContract?: IsolatedDeliveryContract;
};

type WithRunSession = (
  result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
) => RunCronAgentTurnResult;

type PreparedCronRunContext = {
  input: RunCronAgentTurnParams;
  cfgWithAgentDefaults: OpenClawConfig;
  agentId: string;
  agentCfg: AgentDefaultsConfig;
  agentDir: string;
  agentSessionKey: string;
  runSessionId: string;
  runSessionKey: string;
  workspaceDir: string;
  commandBody: string;
  cronSession: MutableCronSession;
  persistSessionEntry: PersistCronSessionEntry;
  withRunSession: WithRunSession;
  agentPayload: Extract<CronJob["payload"], { kind: "agentTurn" }> | null;
  resolvedDelivery: Awaited<ReturnType<typeof resolveDeliveryTarget>>;
  deliveryRequested: boolean;
  toolPolicy: ReturnType<typeof resolveCronToolPolicy>;
  skillsSnapshot: SkillSnapshot;
  liveSelection: CronLiveSelection;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
};

type CronPreparationResult =
  | { ok: true; context: PreparedCronRunContext }
  | { ok: false; result: RunCronAgentTurnResult };

async function prepareCronRunContext(params: {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
}): Promise<CronPreparationResult> {
  const { input } = params;
  const defaultAgentId = resolveDefaultAgentId(input.cfg);
  const requestedAgentId =
    typeof input.agentId === "string" && input.agentId.trim()
      ? input.agentId
      : typeof input.job.agentId === "string" && input.job.agentId.trim()
        ? input.job.agentId
        : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(input.cfg, normalizedRequested)
    : undefined;
  const agentId = normalizedRequested ?? defaultAgentId;
  const agentCfg: AgentDefaultsConfig = buildCronAgentDefaultsConfig({
    defaults: input.cfg.agents?.defaults,
    agentConfigOverride,
  });
  const cfgWithAgentDefaults: OpenClawConfig = {
    ...input.cfg,
    agents: Object.assign({}, input.cfg.agents, { defaults: agentCfg }),
  };
  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: cfgWithAgentDefaults });
    }
    return catalog;
  };

  const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: baseSessionKey,
    agentId,
    mainKey: input.cfg.session?.mainKey,
    cfg: input.cfg,
  });
  const payloadHookExternalContentSource =
    input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : undefined;
  const hookExternalContentSource =
    payloadHookExternalContentSource ?? resolveHookExternalContentSource(baseSessionKey);

  const workspaceDirRaw = resolveAgentWorkspaceDir(input.cfg, agentId);
  const agentDir = resolveAgentDir(input.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !params.isFastTestEnv,
  });
  const workspaceDir = workspace.dir;

  const isGmailHook = hookExternalContentSource === "gmail";
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: input.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
    forceNew: input.job.sessionTarget === "isolated",
  });
  const runSessionId = cronSession.sessionEntry.sessionId;
  const runSessionKey = baseSessionKey.startsWith("cron:")
    ? `${agentSessionKey}:run:${runSessionId}`
    : agentSessionKey;
  const persistSessionEntry = createPersistCronSessionEntry({
    isFastTestEnv: params.isFastTestEnv,
    cronSession,
    agentSessionKey,
    runSessionKey,
    updateSessionStore: async (storePath, update) => {
      const { updateSessionStore } = await loadSessionStoreRuntime();
      await updateSessionStore(storePath, update);
    },
  });
  const withRunSession: WithRunSession = (result) => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: runSessionKey,
  });
  if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
    const labelSuffix =
      typeof input.job.name === "string" && input.job.name.trim()
        ? input.job.name.trim()
        : input.job.id;
    cronSession.sessionEntry.label = `Cron: ${labelSuffix}`;
  }

  const resolvedModelSelection = await resolveCronModelSelection({
    cfg: input.cfg,
    cfgWithAgentDefaults,
    agentConfigOverride,
    sessionEntry: cronSession.sessionEntry,
    payload: input.job.payload,
    isGmailHook,
  });
  if (!resolvedModelSelection.ok) {
    return {
      ok: false,
      result: withRunSession({ status: "error", error: resolvedModelSelection.error }),
    };
  }
  let provider = resolvedModelSelection.provider;
  let model = resolvedModelSelection.model;
  if (resolvedModelSelection.warning) {
    logWarn(resolvedModelSelection.warning);
  }

  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(input.cfg.hooks?.gmail?.thinking)
    : undefined;
  const jobThink = normalizeThinkLevel(
    (input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : undefined) ?? undefined,
  );
  let thinkLevel: ThinkLevel | undefined = jobThink ?? hooksGmailThinking;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      catalog: await loadCatalog(),
    });
  }
  if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    logWarn(
      `[cron:${input.job.id}] Thinking level "xhigh" is not supported for ${provider}/${model}; downgrading to "high".`,
    );
    thinkLevel = "high";
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : undefined,
  });
  const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
  const { deliveryRequested, resolvedDelivery, toolPolicy } = await resolveCronDeliveryContext({
    cfg: cfgWithAgentDefaults,
    job: input.job,
    agentId,
    deliveryContract: input.deliveryContract ?? "cron-owned",
  });

  const { formattedTime, timeLine } = resolveCronStyleNow(input.cfg, now);
  const base = `[cron:${input.job.id} ${input.job.name}] ${input.message}`.trim();
  const isExternalHook =
    hookExternalContentSource !== undefined || isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    agentPayload?.allowUnsafeExternalContent === true ||
    (isGmailHook && input.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    const suspiciousPatterns = detectSuspiciousPatterns(input.message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
    const safeContent = buildSafeExternalPrompt({
      content: input.message,
      source: hookType,
      jobName: input.job.name,
      jobId: input.job.id,
      timestamp: formattedTime,
    });
    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    commandBody = `${base}\n${timeLine}`.trim();
  }
  commandBody = appendCronDeliveryInstruction({ commandBody, deliveryRequested });

  const skillsSnapshot = resolveCronSkillsSnapshot({
    workspaceDir,
    config: cfgWithAgentDefaults,
    agentId,
    existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
    isFastTestEnv: params.isFastTestEnv,
  });
  await persistCronSkillsSnapshotIfChanged({
    isFastTestEnv: params.isFastTestEnv,
    cronSession,
    skillsSnapshot,
    nowMs: Date.now(),
    persistSessionEntry,
  });

  markCronSessionPreRun({ entry: cronSession.sessionEntry, provider, model });
  try {
    await persistSessionEntry();
  } catch (err) {
    logWarn(`[cron:${input.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
  }

  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg: cfgWithAgentDefaults,
    provider,
    agentDir,
    sessionEntry: cronSession.sessionEntry,
    sessionStore: cronSession.store,
    sessionKey: agentSessionKey,
    storePath: cronSession.storePath,
    isNewSession: cronSession.isNewSession,
  });
  const liveSelection: CronLiveSelection = {
    provider,
    model,
    authProfileId,
    authProfileIdSource: authProfileId
      ? cronSession.sessionEntry.authProfileOverrideSource
      : undefined,
  };

  return {
    ok: true,
    context: {
      input,
      cfgWithAgentDefaults,
      agentId,
      agentCfg,
      agentDir,
      agentSessionKey,
      runSessionId,
      runSessionKey,
      workspaceDir,
      commandBody,
      cronSession,
      persistSessionEntry,
      withRunSession,
      agentPayload,
      resolvedDelivery,
      deliveryRequested,
      toolPolicy,
      skillsSnapshot,
      liveSelection,
      thinkLevel,
      timeoutMs,
    },
  };
}

async function finalizeCronRun(params: {
  prepared: PreparedCronRunContext;
  execution: CronExecutionResult;
  abortReason: () => string;
  isAborted: () => boolean;
}): Promise<RunCronAgentTurnResult> {
  const { prepared, execution } = params;
  const finalRunResult = execution.runResult;
  const payloads = finalRunResult.payloads ?? [];
  let telemetry: CronRunTelemetry | undefined;

  if (finalRunResult.meta?.systemPromptReport) {
    prepared.cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
  }
  const usage = finalRunResult.meta?.agentMeta?.usage;
  const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
  const modelUsed =
    finalRunResult.meta?.agentMeta?.model ??
    execution.fallbackModel ??
    execution.liveSelection.model;
  const providerUsed =
    finalRunResult.meta?.agentMeta?.provider ??
    execution.fallbackProvider ??
    execution.liveSelection.provider;
  const contextTokens =
    resolvePositiveContextTokens(prepared.agentCfg?.contextTokens) ??
    lookupContextTokens(modelUsed, { allowAsyncLoad: false }) ??
    resolvePositiveContextTokens(prepared.cronSession.sessionEntry.contextTokens) ??
    DEFAULT_CONTEXT_TOKENS;

  setSessionRuntimeModel(prepared.cronSession.sessionEntry, {
    provider: providerUsed,
    model: modelUsed,
  });
  prepared.cronSession.sessionEntry.contextTokens = contextTokens;
  if (isCliProvider(providerUsed, prepared.cfgWithAgentDefaults)) {
    const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
    if (cliSessionId) {
      const { setCliSessionId } = await loadCliRunnerRuntime();
      setCliSessionId(prepared.cronSession.sessionEntry, providerUsed, cliSessionId);
    }
  }
  if (hasNonzeroUsage(usage)) {
    const { estimateUsageCost, resolveModelCostConfig } = await loadUsageFormatRuntime();
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage,
      contextTokens,
      promptTokens,
    });
    const runEstimatedCostUsd = resolveNonNegativeNumber(
      estimateUsageCost({
        usage,
        cost: resolveModelCostConfig({
          provider: providerUsed,
          model: modelUsed,
          config: prepared.cfgWithAgentDefaults,
        }),
      }),
    );
    prepared.cronSession.sessionEntry.inputTokens = input;
    prepared.cronSession.sessionEntry.outputTokens = output;
    const telemetryUsage: NonNullable<CronRunTelemetry["usage"]> = {
      input_tokens: input,
      output_tokens: output,
    };
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      prepared.cronSession.sessionEntry.totalTokens = totalTokens;
      prepared.cronSession.sessionEntry.totalTokensFresh = true;
      telemetryUsage.total_tokens = totalTokens;
    } else {
      prepared.cronSession.sessionEntry.totalTokens = undefined;
      prepared.cronSession.sessionEntry.totalTokensFresh = false;
    }
    prepared.cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
    prepared.cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;
    if (runEstimatedCostUsd !== undefined) {
      prepared.cronSession.sessionEntry.estimatedCostUsd =
        (resolveNonNegativeNumber(prepared.cronSession.sessionEntry.estimatedCostUsd) ?? 0) +
        runEstimatedCostUsd;
    }
    telemetry = {
      model: modelUsed,
      provider: providerUsed,
      usage: telemetryUsage,
    };
  } else {
    telemetry = { model: modelUsed, provider: providerUsed };
  }
  await prepared.persistSessionEntry();

  if (params.isAborted()) {
    return prepared.withRunSession({ status: "error", error: params.abortReason(), ...telemetry });
  }
  let {
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
    deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    embeddedRunError,
  } = resolveCronPayloadOutcome({
    payloads,
    runLevelError: finalRunResult.meta?.error,
  });
  const resolveRunOutcome = (result?: { delivered?: boolean; deliveryAttempted?: boolean }) =>
    prepared.withRunSession({
      status: hasFatalErrorPayload ? "error" : "ok",
      ...(hasFatalErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: result?.delivered,
      deliveryAttempted: result?.deliveryAttempted,
      ...telemetry,
    });

  const skipHeartbeatDelivery =
    prepared.deliveryRequested &&
    isHeartbeatOnlyResponse(payloads, resolveHeartbeatAckMaxChars(prepared.agentCfg));
  const skipMessagingToolDelivery =
    (prepared.input.deliveryContract ?? "cron-owned") === "shared" &&
    prepared.deliveryRequested &&
    finalRunResult.didSendViaMessagingTool === true &&
    (finalRunResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: prepared.resolvedDelivery.channel,
        to: prepared.resolvedDelivery.to,
        accountId: prepared.resolvedDelivery.accountId,
      }),
    );
  const deliveryResult = await dispatchCronDelivery({
    cfg: prepared.input.cfg,
    cfgWithAgentDefaults: prepared.cfgWithAgentDefaults,
    deps: prepared.input.deps,
    job: prepared.input.job,
    agentId: prepared.agentId,
    agentSessionKey: prepared.agentSessionKey,
    runSessionId: prepared.runSessionId,
    runStartedAt: execution.runStartedAt,
    runEndedAt: execution.runEndedAt,
    timeoutMs: prepared.timeoutMs,
    resolvedDelivery: prepared.resolvedDelivery,
    deliveryRequested: prepared.deliveryRequested,
    skipHeartbeatDelivery,
    skipMessagingToolDelivery,
    deliveryBestEffort: resolveCronDeliveryBestEffort(prepared.input.job),
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    summary,
    outputText,
    telemetry,
    abortSignal: prepared.input.abortSignal ?? prepared.input.signal,
    isAborted: params.isAborted,
    abortReason: params.abortReason,
    withRunSession: prepared.withRunSession,
  });
  if (deliveryResult.result) {
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
    };
    if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
    });
  }
  summary = deliveryResult.summary;
  outputText = deliveryResult.outputText;
  return resolveRunOutcome({
    delivered: deliveryResult.delivered,
    deliveryAttempted: deliveryResult.deliveryAttempted,
  });
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deliveryContract?: IsolatedDeliveryContract;
}): Promise<RunCronAgentTurnResult> {
  const abortSignal = params.abortSignal ?? params.signal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => {
    const reason = abortSignal?.reason;
    return typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "cron: job execution timed out";
  };
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const prepared = await prepareCronRunContext({ input: params, isFastTestEnv });
  if (!prepared.ok) {
    return prepared.result;
  }

  try {
    const execution = await executeCronRun({
      cfg: params.cfg,
      cfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,
      job: params.job,
      agentId: prepared.context.agentId,
      agentDir: prepared.context.agentDir,
      agentSessionKey: prepared.context.agentSessionKey,
      workspaceDir: prepared.context.workspaceDir,
      lane: params.lane,
      resolvedDelivery: {
        channel: prepared.context.resolvedDelivery.channel,
        accountId: prepared.context.resolvedDelivery.accountId,
      },
      toolPolicy: prepared.context.toolPolicy,
      skillsSnapshot: prepared.context.skillsSnapshot,
      agentPayload: prepared.context.agentPayload,
      agentVerboseDefault: prepared.context.agentCfg?.verboseDefault,
      liveSelection: prepared.context.liveSelection,
      cronSession: prepared.context.cronSession,
      commandBody: prepared.context.commandBody,
      persistSessionEntry: prepared.context.persistSessionEntry,
      abortSignal,
      abortReason,
      isAborted,
      thinkLevel: prepared.context.thinkLevel,
      timeoutMs: prepared.context.timeoutMs,
    });
    if (isAborted()) {
      return prepared.context.withRunSession({ status: "error", error: abortReason() });
    }
    return await finalizeCronRun({
      prepared: prepared.context,
      execution,
      abortReason,
      isAborted,
    });
  } catch (err) {
    return prepared.context.withRunSession({ status: "error", error: String(err) });
  }


  // Resolve auth profile for the session, mirroring the inbound auto-reply path
  // (get-reply-run.ts). Without this, isolated cron sessions fall back to env-var
  // auth which may not match the configured auth-profiles, causing 401 errors.
  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg: cfgWithAgentDefaults,
    provider,
    agentDir,
    sessionEntry: cronSession.sessionEntry,
    sessionStore: cronSession.store,
    sessionKey: agentSessionKey,
    storePath: cronSession.storePath,
    isNewSession: cronSession.isNewSession,
  });
  const authProfileIdSource = cronSession.sessionEntry.authProfileOverrideSource;

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>> | undefined;
  let fallbackProvider = provider;
  let fallbackModel = model;
  const runStartedAt = Date.now();
  let runEndedAt = runStartedAt;
  try {
    const sessionFile = resolveSessionTranscriptPath(cronSession.sessionEntry.sessionId, agentId);
    const resolvedVerboseLevel =
      normalizeVerboseLevel(cronSession.sessionEntry.verboseLevel) ??
      normalizeVerboseLevel(agentCfg?.verboseDefault) ??
      "off";
    registerAgentRunContext(cronSession.sessionEntry.sessionId, {
      sessionKey: agentSessionKey,
      verboseLevel: resolvedVerboseLevel,
    });
    const messageChannel = resolvedDelivery.channel;
    // Per-job payload.fallbacks takes priority over agent-level fallbacks.
    const payloadFallbacks =
      params.job.payload.kind === "agentTurn" && Array.isArray(params.job.payload.fallbacks)
        ? params.job.payload.fallbacks
        : undefined;
    let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
      cronSession.sessionEntry.systemPromptReport,
    );

    const runPrompt = async (promptText: string) => {
      const fallbackResult = await runWithModelFallback({
        cfg: cfgWithAgentDefaults,
        provider,
        model,
        runId: cronSession.sessionEntry.sessionId,
        agentDir,
        fallbacksOverride:
          payloadFallbacks ?? resolveAgentModelFallbacksOverride(params.cfg, agentId),
        run: async (providerOverride, modelOverride, runOptions) => {
          if (abortSignal?.aborted) {
            throw new Error(abortReason());
          }
          const bootstrapPromptWarningSignature =
            bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
          // Fresh isolated cron sessions must not reuse a stored CLI session ID.
          // Passing an existing ID activates the resume watchdog profile
          // (noOutputTimeoutRatio 0.3, maxMs 180 s) instead of the fresh profile
          // (ratio 0.8, maxMs 600 s), causing jobs to time out at roughly 1/3 of
          // the configured timeoutSeconds. See: https://github.com/openclaw/openclaw/issues/29774
          const cliSessionBinding = cronSession.isNewSession
            ? undefined
            : getCliSessionBinding(cronSession.sessionEntry, providerOverride);
          const cliSessionId = cliSessionBinding?.sessionId;
          if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
            const result = await runCliAgent({
              sessionId: cronSession.sessionEntry.sessionId,
              sessionKey: agentSessionKey,
              agentId,
              sessionFile,
              workspaceDir,
              config: cfgWithAgentDefaults,
              prompt: promptText,
              provider: providerOverride,
              model: modelOverride,
              thinkLevel,
              timeoutMs,
              runId: cronSession.sessionEntry.sessionId,
              cliSessionId,
              cliSessionBinding,
              sessionCompactionCount: cronSession.sessionEntry.compactionCount,
              bootstrapPromptWarningSignaturesSeen,
              bootstrapPromptWarningSignature,
            });
            bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
              result.meta?.systemPromptReport,
            );
            return result;
          }
          const result = await runEmbeddedPiAgent({
            sessionId: cronSession.sessionEntry.sessionId,
            sessionKey: agentSessionKey,
            agentId,
            trigger: "cron",
            // Cron runs execute inside the gateway process and need the same
            // explicit subagent late-binding as other gateway-owned runners.
            allowGatewaySubagentBinding: true,
            // Cron jobs are trusted local automation, so isolated runs should
            // inherit owner-only tooling like local `openclaw agent` runs.
            senderIsOwner: true,
            messageChannel,
            agentAccountId: resolvedDelivery.accountId,
            sessionFile,
            agentDir,
            workspaceDir,
            config: cfgWithAgentDefaults,
            skillsSnapshot,
            prompt: promptText,
            lane: resolveNestedAgentLane(params.lane),
            provider: providerOverride,
            model: modelOverride,
            authProfileId,
            authProfileIdSource,
            thinkLevel,
            fastMode: resolveFastModeState({
              cfg: cfgWithAgentDefaults,
              provider: providerOverride,
              model: modelOverride,
              agentId,
              sessionEntry: cronSession.sessionEntry,
            }).enabled,
            verboseLevel: resolvedVerboseLevel,
            timeoutMs,
            bootstrapContextMode: agentPayload?.lightContext ? "lightweight" : undefined,
            bootstrapContextRunKind: "cron",
            runId: cronSession.sessionEntry.sessionId,
            requireExplicitMessageTarget: toolPolicy.requireExplicitMessageTarget,
            disableMessageTool: toolPolicy.disableMessageTool,
            allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
            abortSignal,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature,
          });
          bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
            result.meta?.systemPromptReport,
          );
          return result;
        },
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      provider = fallbackResult.provider;
      model = fallbackResult.model;
      runEndedAt = Date.now();
    };

    await runPrompt(commandBody);
    if (!runResult) {
      throw new Error("cron isolated run returned no result");
    }

    // Guardrail for cron jobs: if the first turn is only an interim ack
    // (e.g. "on it") and no descendants are active, run one focused follow-up
    // turn so the cron run returns an actual completion.
    if (!isAborted()) {
      const interimRunResult = runResult;
      const interimPayloads = interimRunResult.payloads ?? [];
      const {
        deliveryPayloadHasStructuredContent: interimPayloadHasStructuredContent,
        outputText: interimOutputText,
      } = resolveCronPayloadOutcome({
        payloads: interimPayloads,
        runLevelError: interimRunResult.meta?.error,
      });
      const interimText = interimOutputText?.trim() ?? "";
      const hasDescendantsSinceRunStart = listDescendantRunsForRequester(agentSessionKey).some(
        (entry) => {
          const descendantStartedAt =
            typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
          return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
        },
      );
      const shouldRetryInterimAck =
        !interimRunResult.meta?.error &&
        !interimRunResult.didSendViaMessagingTool &&
        !interimPayloadHasStructuredContent &&
        !interimPayloads.some((payload) => payload?.isError === true) &&
        countActiveDescendantRuns(agentSessionKey) === 0 &&
        !hasDescendantsSinceRunStart &&
        isLikelyInterimCronMessage(interimText);

      if (shouldRetryInterimAck) {
        const continuationPrompt = [
          "Your previous response was only an acknowledgement and did not complete this cron task.",
          "Complete the original task now.",
          "Do not send a status update like 'on it'.",
          "Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary.",
        ].join(" ");
        await runPrompt(continuationPrompt);
      }
    }
  } catch (err) {
    return withRunSession({ status: "error", error: String(err) });
  }

  if (isAborted()) {
    return withRunSession({ status: "error", error: abortReason() });
  }
  if (!runResult) {
    return withRunSession({ status: "error", error: "cron isolated run returned no result" });
  }
  const finalRunResult = runResult;
  const payloads = finalRunResult.payloads ?? [];

  // Update token+model fields in the session store.
  // Also collect best-effort telemetry for the cron run log.
  let telemetry: CronRunTelemetry | undefined;
  {
    if (finalRunResult.meta?.systemPromptReport) {
      cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
    }
    const usage = finalRunResult.meta?.agentMeta?.usage;
    const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
    const modelUsed = finalRunResult.meta?.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed = finalRunResult.meta?.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ??
      lookupContextTokens(modelUsed, { allowAsyncLoad: false }) ??
      DEFAULT_CONTEXT_TOKENS;

    setSessionRuntimeModel(cronSession.sessionEntry, {
      provider: providerUsed,
      model: modelUsed,
    });
    cronSession.sessionEntry.contextTokens = contextTokens;
    if (isCliProvider(providerUsed, cfgWithAgentDefaults)) {
      const cliSessionBinding = finalRunResult.meta?.agentMeta?.cliSessionBinding;
      if (cliSessionBinding?.sessionId?.trim()) {
        setCliSessionBinding(cronSession.sessionEntry, providerUsed, cliSessionBinding);
      } else {
        const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
        if (cliSessionId) {
          setCliSessionId(cronSession.sessionEntry, providerUsed, cliSessionId);
        }
      }
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const totalTokens = deriveSessionTotalTokens({
        usage,
        contextTokens,
        promptTokens,
      });
      const runEstimatedCostUsd = resolveNonNegativeNumber(
        estimateUsageCost({
          usage,
          cost: resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfgWithAgentDefaults,
          }),
        }),
      );
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      const telemetryUsage: NonNullable<CronRunTelemetry["usage"]> = {
        input_tokens: input,
        output_tokens: output,
      };
      if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
        cronSession.sessionEntry.totalTokens = totalTokens;
        cronSession.sessionEntry.totalTokensFresh = true;
        telemetryUsage.total_tokens = totalTokens;
      } else {
        cronSession.sessionEntry.totalTokens = undefined;
        cronSession.sessionEntry.totalTokensFresh = false;
      }
      cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
      cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;
      if (runEstimatedCostUsd !== undefined) {
        cronSession.sessionEntry.estimatedCostUsd =
          (resolveNonNegativeNumber(cronSession.sessionEntry.estimatedCostUsd) ?? 0) +
          runEstimatedCostUsd;
      }

      telemetry = {
        model: modelUsed,
        provider: providerUsed,
        usage: telemetryUsage,
      };
    } else {
      telemetry = {
        model: modelUsed,
        provider: providerUsed,
      };
    }
    await persistSessionEntry();
  }

  if (isAborted()) {
    return withRunSession({ status: "error", error: abortReason(), ...telemetry });
  }
  let {
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
    deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    embeddedRunError,
  } = resolveCronPayloadOutcome({
    payloads,
    runLevelError: finalRunResult.meta?.error,
  });
  const deliveryBestEffort = resolveCronDeliveryBestEffort(params.job);
  const resolveRunOutcome = (params?: { delivered?: boolean; deliveryAttempted?: boolean }) =>
    withRunSession({
      status: hasFatalErrorPayload ? "error" : "ok",
      ...(hasFatalErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: params?.delivered,
      deliveryAttempted: params?.deliveryAttempted,
      ...telemetry,
    });

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  const ackMaxChars = resolveHeartbeatAckMaxChars(agentCfg);
  const skipHeartbeatDelivery = deliveryRequested && isHeartbeatOnlyResponse(payloads, ackMaxChars);
  const skipMessagingToolDelivery =
    deliveryContract === "shared" &&
    deliveryRequested &&
    finalRunResult.didSendViaMessagingTool === true &&
    (finalRunResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
      }),
    );
  const deliveryResult = await dispatchCronDelivery({
    cfg: params.cfg,
    cfgWithAgentDefaults,
    deps: params.deps,
    job: params.job,
    agentId,
    agentSessionKey,
    runSessionId,
    runStartedAt,
    runEndedAt,
    timeoutMs,
    resolvedDelivery,
    deliveryRequested,
    skipHeartbeatDelivery,
    skipMessagingToolDelivery,
    deliveryBestEffort,
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    summary,
    outputText,
    telemetry,
    abortSignal,
    isAborted,
    abortReason,
    withRunSession,
  });
  if (deliveryResult.result) {
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
    };
    if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
    });
  }
  const delivered = deliveryResult.delivered;
  const deliveryAttempted = deliveryResult.deliveryAttempted;
  summary = deliveryResult.summary;
  outputText = deliveryResult.outputText;

  return resolveRunOutcome({ delivered, deliveryAttempted });
}
