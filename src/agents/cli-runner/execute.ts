import path from "node:path";
import { shouldLogVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { requestHeartbeatNow as requestHeartbeatNowImpl } from "../../infra/heartbeat-wake.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import { scopedHeartbeatWakeOptions } from "../../routing/session-key.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  prependBootstrapPromptWarning,
} from "../bootstrap-budget.js";
import { makeBootstrapWarn } from "../bootstrap-files.js";
import { createCliJsonlStreamingParser, parseCliOutput, type CliOutput } from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  buildBootstrapContextFiles,
  classifyFailoverReason,
  getBootstrapProfileConfig,
  isContextOverflowError,
} from "../pi-embedded-helpers.js";
import {
  appendImagePathsToPrompt,
  buildCliSupervisorScopeKey,
  buildCliArgs,
  buildSystemPrompt,
  resolveCliRunQueueKey,
  enqueueCliRun,
  loadPromptRefImages,
  resolveCliNoOutputTimeoutMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./helpers.js";
import {
  cliBackendLog,
  CLI_BACKEND_LOG_OUTPUT_ENV,
  LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV,
} from "./log.js";
import {
  resolveClaudeSystemPromptFilePath,
  writeClaudeSystemPromptFile,
  buildClaudeSystemPromptLoaderPrompt,
  PromptFileReadRequiredError,
  resolveReadToolFilePath,
  estimatePromptTokens,
  ESTIMATED_TOKENS_PER_IMAGE,
} from "./prepare.js";
import type { PreparedCliRunContext } from "./types.js";

const executeDeps = {
  getProcessSupervisor: getProcessSupervisorImpl,
  enqueueSystemEvent: enqueueSystemEventImpl,
  requestHeartbeatNow: requestHeartbeatNowImpl,
};

export function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void {
  Object.assign(executeDeps, overrides);
}

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  sessionArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.sessionArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.imageArg) {
      logArgs.push(arg, "<image>");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  if (params.argsPrompt) {
    const promptIndex = logArgs.indexOf(params.argsPrompt);
    if (promptIndex >= 0) {
      logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
    }
  }
  return logArgs;
}

export async function executePreparedCliRun(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): Promise<CliOutput> {
  const params = context.params;
  const backend = context.preparedBackend.backend;
  const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: cliSessionIdToUse,
  });
  const useResume = Boolean(
    cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
  );
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew,
    systemPrompt: context.systemPrompt,
  });

  let imagePaths: string[] | undefined;
  let cleanupImages: (() => Promise<void>) | undefined;
  let prompt = prependBootstrapPromptWarning(params.prompt, context.bootstrapPromptWarningLines, {
    preserveExactPrompt: context.heartbeatPrompt,
  });
  const resolvedImages =
    params.images && params.images.length > 0
      ? params.images
      : await loadPromptRefImages({ prompt, workspaceDir: context.workspaceDir });
  if (resolvedImages.length > 0) {
    const imagePayload = await writeCliImages(resolvedImages);
    imagePaths = imagePayload.paths;
    cleanupImages = imagePayload.cleanup;
    if (!backend.imageArg) {
      prompt = appendImagePathsToPrompt(prompt, imagePaths);
    }
  }

  const { argsPrompt, stdin } = resolvePromptInput({
    backend,
    prompt,
  });
  const stdinPayload = stdin ?? "";
  const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
    : baseArgs;
  const args = buildCliArgs({
    backend,
    baseArgs: resolvedArgs,
    modelId: context.normalizedModel,
    sessionId: resolvedSessionId,
    systemPrompt: systemPromptArg,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
  });

  const queueKey = resolveCliRunQueueKey({
    backendId: context.backendResolved.id,
    serialize: backend.serialize,
    runId: params.runId,
    workspaceDir: context.workspaceDir,
    cliSessionId: useResume ? resolvedSessionId : undefined,
  });

  try {
    return await enqueueCliRun(queueKey, async () => {
      cliBackendLog.info(
        `cli exec: provider=${params.provider} model=${context.normalizedModel} promptChars=${params.prompt.length}`,
      );
      const logOutputText =
        isTruthyEnvValue(process.env[CLI_BACKEND_LOG_OUTPUT_ENV]) ||
        isTruthyEnvValue(process.env[LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV]);
      if (logOutputText) {
        const logArgs = buildCliLogArgs({
          args,
          systemPromptArg: backend.systemPromptArg,
          sessionArg: backend.sessionArg,
          modelArg: backend.modelArg,
          imageArg: backend.imageArg,
          argsPrompt,
        });
        cliBackendLog.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
      }

      const env = (() => {
        const next = sanitizeHostExecEnv({
          baseEnv: process.env,
          blockPathOverrides: true,
        });
        for (const key of backend.clearEnv ?? []) {
          delete next[key];
        }
        if (backend.env && Object.keys(backend.env).length > 0) {
          Object.assign(
            next,
            sanitizeHostExecEnv({
              baseEnv: {},
              overrides: backend.env,
              blockPathOverrides: true,
            }),
          );
        }
        Object.assign(next, context.preparedBackend.env);
        return next;
      })();
      const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
        backend,
        timeoutMs: params.timeoutMs,
        useResume,
      });
      const streamingParser =
        backend.output === "jsonl"
          ? createCliJsonlStreamingParser({
              backend,
              providerId: context.backendResolved.id,
              onAssistantDelta: ({ text, delta }) => {
                emitAgentEvent({
                  runId: params.runId,
                  stream: "assistant",
                  data: {
                    text,
                    delta,
                  },
                });
              },
            })
          : null;
      const supervisor = executeDeps.getProcessSupervisor();
      const scopeKey = buildCliSupervisorScopeKey({
        backend,
        backendId: context.backendResolved.id,
        cliSessionId: useResume ? resolvedSessionId : undefined,
      });

      const managedRun = await supervisor.spawn({
        sessionId: params.sessionId,
        backendId: context.backendResolved.id,
        scopeKey,
        replaceExistingScope: Boolean(useResume && scopeKey),
        mode: "child",
        argv: [backend.command, ...args],
        timeoutMs: params.timeoutMs,
        noOutputTimeoutMs,
        cwd: context.workspaceDir,
        env,
        input: stdinPayload,
        onStdout: streamingParser ? (chunk: string) => streamingParser.push(chunk) : undefined,
      });
      const result = await managedRun.wait();
      streamingParser?.finish();

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (logOutputText) {
        if (stdout) {
          cliBackendLog.info(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          cliBackendLog.info(`cli stderr:\n${stderr}`);
        }
      }
      if (shouldLogVerbose()) {
        if (stdout) {
          cliBackendLog.debug(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          cliBackendLog.debug(`cli stderr:\n${stderr}`);
        }
      }

      if (result.exitCode !== 0 || result.reason !== "exit") {
        if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
          const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
          cliBackendLog.warn(
            `cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
          );
          if (params.sessionKey) {
            const stallNotice = [
              `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
              "It may have been waiting for interactive input or an approval prompt.",
              "For Claude Code, prefer --permission-mode bypassPermissions --print.",
            ].join(" ");
            executeDeps.enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
            executeDeps.requestHeartbeatNow(
              scopedHeartbeatWakeOptions(params.sessionKey, { reason: "cli:watchdog:stall" }),
            );
          }
          throw new FailoverError(timeoutReason, {
            reason: "timeout",
            provider: params.provider,
            model: context.modelId,
            status: resolveFailoverStatus("timeout"),
          });
        }
        if (result.reason === "overall-timeout") {
          const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
          throw new FailoverError(timeoutReason, {
            reason: "timeout",
            provider: params.provider,
            model: context.modelId,
            status: resolveFailoverStatus("timeout"),
          });
        }
        const err = stderr || stdout || "CLI failed.";
        const reason = classifyFailoverReason(err, { provider: params.provider }) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(err, {
          reason,
          provider: params.provider,
          model: context.modelId,
          status,
        });
      }

      return parseCliOutput({
        raw: stdout,
        backend,
        providerId: context.backendResolved.id,
        outputMode: useResume ? (backend.resumeOutput ?? backend.output) : backend.output,
        fallbackSessionId: resolvedSessionId,
      });
    });
  } finally {
    if (cleanupImages) {
      await cleanupImages();
    }
  }
}

// ---------------------------------------------------------------------------
// Session prompt file state (Layer 1)
// ---------------------------------------------------------------------------

export type CliSessionBindingResult = {
  sessionId: string;
  systemPromptFile?: string;
  systemPromptHash?: string;
  systemPromptCompactionCount?: number;
};

export type CliPromptLoadResult = {
  sessionPromptFile?: string;
  loaderMode: "normal" | "strict" | "disabled";
  verifiedRead: boolean;
  fallbackReason?:
    | "write_failed"
    | "verification_retry"
    | "direct_injection_fallback"
    | "direct_fallback_disabled";
};

const ENABLE_DIRECT_SYSTEM_PROMPT_FALLBACK = false;

/**
 * Wraps executePreparedCliRun with:
 *  - Layer 1: Session prompt file writing + loader prompt + read verification
 *  - Layer 2: Context overflow detection + /compact recovery + profile downgrade
 *
 * This is the function that cli-runner.ts should call instead of raw executePreparedCliRun.
 */
export async function executeWithOverflowProtection(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): Promise<{
  output: CliOutput;
  cliSessionBinding?: CliSessionBindingResult;
  cliPromptLoad?: CliPromptLoadResult;
  compactionsThisRun: number;
  systemPromptReport: typeof context.systemPromptReport;
}> {
  const params = context.params;
  let { systemPrompt, activeProfile, activeContextFiles, systemPromptReport } = context;
  let compactionsThisRun = 0;
  let latestCliSessionBinding: CliSessionBindingResult | undefined;
  let latestCliPromptLoad: CliPromptLoadResult | undefined;

  // Inner function: execute with a given session and loader mode, handling
  // prompt file writing and read verification for Claude CLI.
  const executeCliWithSession = async (
    sessionId: string | undefined,
    promptOverride: string | undefined,
    isSystemCall: boolean,
    forceReloadSystemPromptFile: boolean,
    loaderPromptMode: "normal" | "strict" | "disabled",
  ): Promise<CliOutput> => {
    const backend = context.preparedBackend.backend;
    const currentCompactionCount =
      Math.max(0, params.sessionCompactionCount ?? 0) + compactionsThisRun;
    const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
      backend,
      cliSessionId: sessionId,
    });
    const useResume = Boolean(
      sessionId && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
    );

    let systemPromptToSend: string | undefined = systemPrompt;
    let cliSystemPromptFile:
      | { filePath: string; hash: string }
      | undefined;
    let loaderFallbackReason:
      | "write_failed"
      | "verification_retry"
      | "direct_injection_fallback"
      | "direct_fallback_disabled"
      | undefined;
    let promptFileTrustedFromBinding = false;

    const matchingCliSessionBinding =
      params.cliSessionBinding &&
      params.cliSessionBinding.sessionId?.trim() &&
      params.cliSessionBinding.sessionId.trim() === sessionId?.trim()
        ? params.cliSessionBinding
        : undefined;

    // Layer 1: Write session prompt file and build loader prompt (Claude CLI only)
    if (context.isClaude && !isSystemCall) {
      try {
        cliSystemPromptFile = await writeClaudeSystemPromptFile({
          sessionFile: params.sessionFile,
          systemPrompt,
        });
        const reloadReason = (() => {
          if (!resolvedSessionId || !cliSystemPromptFile) {
            return undefined;
          }
          if (!useResume || !matchingCliSessionBinding?.sessionId?.trim()) {
            return "new-session" as const;
          }
          if (forceReloadSystemPromptFile) {
            return "compaction" as const;
          }
          if (matchingCliSessionBinding.systemPromptFile?.trim() !== cliSystemPromptFile.filePath) {
            return "prompt-changed" as const;
          }
          if (matchingCliSessionBinding.systemPromptHash?.trim() !== cliSystemPromptFile.hash) {
            return "prompt-changed" as const;
          }
          if (
            (matchingCliSessionBinding.systemPromptCompactionCount ?? 0) < currentCompactionCount
          ) {
            return "compaction" as const;
          }
          return undefined;
        })();
        systemPromptToSend =
          loaderPromptMode === "disabled"
            ? systemPrompt
            : reloadReason && cliSystemPromptFile
              ? buildClaudeSystemPromptLoaderPrompt({
                  filePath: cliSystemPromptFile.filePath,
                  reason: reloadReason,
                  strict: loaderPromptMode === "strict",
                })
              : undefined;
        promptFileTrustedFromBinding = Boolean(
          !reloadReason &&
          cliSystemPromptFile &&
          matchingCliSessionBinding?.systemPromptFile?.trim() === cliSystemPromptFile.filePath &&
          matchingCliSessionBinding?.systemPromptHash?.trim() === cliSystemPromptFile.hash,
        );
      } catch (error) {
        cliBackendLog.warn(
          `failed to write claude session prompt file (${resolveClaudeSystemPromptFilePath(params.sessionFile)}); falling back to direct prompt: ${String(error)}`,
        );
        systemPromptToSend = systemPrompt;
        cliSystemPromptFile = undefined;
        loaderFallbackReason = "write_failed";
      }
    }

    // Resolve the system prompt arg based on loader mode
    const systemPromptArg =
      context.isClaude && !isSystemCall
        ? systemPromptToSend?.trim() || null
        : resolveSystemPromptUsage({
            backend,
            isNewSession: isNew,
            systemPrompt: systemPromptToSend,
          });
    const mustVerifyPromptFileRead = Boolean(
      context.isClaude &&
      !isSystemCall &&
      cliSystemPromptFile &&
      systemPromptToSend &&
      loaderPromptMode !== "disabled",
    );
    let promptFileReadToolUseId: string | undefined;
    let promptFileReadVerified = false;

    // Build images and prompt
    let imagePaths: string[] | undefined;
    let cleanupImages: (() => Promise<void>) | undefined;
    let prompt =
      promptOverride ??
      prependBootstrapPromptWarning(params.prompt, context.bootstrapPromptWarningLines, {
        preserveExactPrompt: context.heartbeatPrompt,
      });
    const resolvedImages =
      !promptOverride && params.images && params.images.length > 0
        ? params.images
        : !promptOverride
          ? await loadPromptRefImages({ prompt, workspaceDir: context.workspaceDir })
          : [];
    if (resolvedImages.length > 0) {
      const imagePayload = await writeCliImages(resolvedImages);
      imagePaths = imagePayload.paths;
      cleanupImages = imagePayload.cleanup;
      if (!backend.imageArg) {
        prompt = appendImagePathsToPrompt(prompt, imagePaths);
      }
    }

    const { argsPrompt, stdin } = resolvePromptInput({ backend, prompt });
    const stdinPayload = stdin ?? "";
    const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
    const resolvedArgs = useResume
      ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
      : baseArgs;
    const args = buildCliArgs({
      backend,
      baseArgs: resolvedArgs,
      modelId: context.normalizedModel,
      sessionId: resolvedSessionId,
      systemPrompt: systemPromptArg,
      imagePaths,
      promptArg: argsPrompt,
      useResume,
    });

    const queueKey = resolveCliRunQueueKey({
      backendId: context.backendResolved.id,
      serialize: backend.serialize,
      runId: params.runId,
      workspaceDir: context.workspaceDir,
      cliSessionId: useResume ? resolvedSessionId : undefined,
    });

    try {
      const output = await enqueueCliRun(queueKey, async () => {
        cliBackendLog.info(
          `cli exec: provider=${params.provider} model=${context.normalizedModel} promptChars=${params.prompt.length}`,
        );
        const logOutputText =
          isTruthyEnvValue(process.env[CLI_BACKEND_LOG_OUTPUT_ENV]) ||
          isTruthyEnvValue(process.env[LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV]);
        if (logOutputText) {
          const logArgs = buildCliLogArgs({
            args,
            systemPromptArg: backend.systemPromptArg,
            sessionArg: backend.sessionArg,
            modelArg: backend.modelArg,
            imageArg: backend.imageArg,
            argsPrompt,
          });
          cliBackendLog.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
        }

        const env = (() => {
          const next = sanitizeHostExecEnv({
            baseEnv: process.env,
            blockPathOverrides: true,
          });
          for (const key of backend.clearEnv ?? []) {
            delete next[key];
          }
          if (backend.env && Object.keys(backend.env).length > 0) {
            Object.assign(
              next,
              sanitizeHostExecEnv({
                baseEnv: {},
                overrides: backend.env,
                blockPathOverrides: true,
              }),
            );
          }
          Object.assign(next, context.preparedBackend.env);
          return next;
        })();
        const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
          backend,
          timeoutMs: params.timeoutMs,
          useResume,
        });
        const streamingParser =
          backend.output === "jsonl"
            ? createCliJsonlStreamingParser({
                backend,
                providerId: context.backendResolved.id,
                onAssistantDelta: ({ text, delta }) => {
                  emitAgentEvent({
                    runId: params.runId,
                    stream: "assistant",
                    data: { text, delta },
                  });
                },
              })
            : null;
        const supervisor = executeDeps.getProcessSupervisor();
        const scopeKey = buildCliSupervisorScopeKey({
          backend,
          backendId: context.backendResolved.id,
          cliSessionId: useResume ? resolvedSessionId : undefined,
        });

        const managedRun = await supervisor.spawn({
          sessionId: params.sessionId,
          backendId: context.backendResolved.id,
          scopeKey,
          replaceExistingScope: Boolean(useResume && scopeKey),
          mode: "child",
          argv: [backend.command, ...args],
          timeoutMs: params.timeoutMs,
          noOutputTimeoutMs,
          cwd: context.workspaceDir,
          env,
          input: stdinPayload,
          onStdout: streamingParser ? (chunk: string) => streamingParser.push(chunk) : undefined,
        });
        const result = await managedRun.wait();
        streamingParser?.finish();

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        if (logOutputText) {
          if (stdout) cliBackendLog.info(`cli stdout:\n${stdout}`);
          if (stderr) cliBackendLog.info(`cli stderr:\n${stderr}`);
        }
        if (shouldLogVerbose()) {
          if (stdout) cliBackendLog.debug(`cli stdout:\n${stdout}`);
          if (stderr) cliBackendLog.debug(`cli stderr:\n${stderr}`);
        }

        if (result.exitCode !== 0 || result.reason !== "exit") {
          if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
            const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
            cliBackendLog.warn(
              `cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
            );
            if (params.sessionKey) {
              const stallNotice = [
                `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
                "It may have been waiting for interactive input or an approval prompt.",
                "For Claude Code, prefer --permission-mode bypassPermissions --print.",
              ].join(" ");
              executeDeps.enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
              executeDeps.requestHeartbeatNow(
                scopedHeartbeatWakeOptions(params.sessionKey, { reason: "cli:watchdog:stall" }),
              );
            }
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: context.modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          if (result.reason === "overall-timeout") {
            const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: context.modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          const err = stderr || stdout || "CLI failed.";
          const reason = classifyFailoverReason(err, { provider: params.provider }) ?? "unknown";
          const status = resolveFailoverStatus(reason);
          throw new FailoverError(err, {
            reason,
            provider: params.provider,
            model: context.modelId,
            status,
          });
        }

        const cliOutput = parseCliOutput({
          raw: stdout,
          backend,
          providerId: context.backendResolved.id,
          outputMode: useResume ? (backend.resumeOutput ?? backend.output) : backend.output,
          fallbackSessionId: resolvedSessionId,
        });

        // Layer 1: Verify prompt file was read
        if (mustVerifyPromptFileRead && !promptFileReadVerified) {
          throw new PromptFileReadRequiredError(
            `Claude session did not verify a successful Read of ${cliSystemPromptFile?.filePath ?? "the session prompt file"}.`,
          );
        }

        // Track session binding metadata
        if (!isSystemCall) {
          const persistPromptFileMetadata =
            loaderPromptMode !== "disabled" &&
            Boolean(cliSystemPromptFile) &&
            (promptFileReadVerified ||
              (!mustVerifyPromptFileRead &&
                matchingCliSessionBinding?.systemPromptFile?.trim() ===
                  cliSystemPromptFile?.filePath &&
                matchingCliSessionBinding?.systemPromptHash?.trim() === cliSystemPromptFile?.hash));
          latestCliSessionBinding =
            cliOutput.sessionId || resolvedSessionId
              ? {
                  sessionId: cliOutput.sessionId ?? resolvedSessionId ?? "",
                  ...(persistPromptFileMetadata && cliSystemPromptFile
                    ? {
                        systemPromptFile: cliSystemPromptFile.filePath,
                        systemPromptHash: cliSystemPromptFile.hash,
                        systemPromptCompactionCount:
                          forceReloadSystemPromptFile || currentCompactionCount > 0
                            ? currentCompactionCount
                            : undefined,
                      }
                    : {}),
                }
              : undefined;
          latestCliPromptLoad =
            context.isClaude
              ? {
                  ...(cliSystemPromptFile
                    ? { sessionPromptFile: cliSystemPromptFile.filePath }
                    : {}),
                  loaderMode: loaderPromptMode,
                  verifiedRead: mustVerifyPromptFileRead
                    ? promptFileReadVerified
                    : promptFileTrustedFromBinding,
                  ...(loaderFallbackReason ? { fallbackReason: loaderFallbackReason } : {}),
                }
              : undefined;
        }

        return cliOutput;
      });
      return output;
    } finally {
      if (cleanupImages) {
        await cleanupImages();
      }
    }
  };

  // Layer 1 fallback chain: normal -> strict -> disabled
  const executeCliWithLoaderFallback = async (runParams: {
    cliSessionId?: string;
    promptOverride?: string;
    isSystemCall?: boolean;
    forceReloadSystemPromptFile?: boolean;
  }) => {
    try {
      return await executeCliWithSession(
        runParams.cliSessionId,
        runParams.promptOverride,
        runParams.isSystemCall ?? false,
        runParams.forceReloadSystemPromptFile ?? false,
        "normal",
      );
    } catch (error) {
      if (!(error instanceof PromptFileReadRequiredError)) {
        throw error;
      }
      cliBackendLog.warn(
        `cli loader prompt verification failed; retrying with strict loader prompt (session_prompt_file=${resolveClaudeSystemPromptFilePath(params.sessionFile)}): ${error.message}`,
      );
      latestCliPromptLoad = {
        sessionPromptFile: resolveClaudeSystemPromptFilePath(params.sessionFile),
        loaderMode: "normal",
        verifiedRead: false,
        fallbackReason: "verification_retry",
      };
    }

    try {
      const output = await executeCliWithSession(
        runParams.cliSessionId,
        runParams.promptOverride,
        runParams.isSystemCall ?? false,
        runParams.forceReloadSystemPromptFile ?? false,
        "strict",
      );
      if (latestCliPromptLoad?.loaderMode === "strict") {
        latestCliPromptLoad = {
          ...latestCliPromptLoad,
          fallbackReason: "verification_retry",
        };
      }
      return output;
    } catch (error) {
      if (!(error instanceof PromptFileReadRequiredError)) {
        throw error;
      }
      if (!ENABLE_DIRECT_SYSTEM_PROMPT_FALLBACK) {
        latestCliPromptLoad = {
          sessionPromptFile: resolveClaudeSystemPromptFilePath(params.sessionFile),
          loaderMode: "strict",
          verifiedRead: false,
          fallbackReason: "direct_fallback_disabled",
        };
        cliBackendLog.warn(
          `cli loader prompt verification failed again; direct system prompt injection fallback is disabled (session_prompt_file=${resolveClaudeSystemPromptFilePath(params.sessionFile)}): ${error.message}`,
        );
        throw new FailoverError(
          `Claude session failed to verify a successful Read of ${resolveClaudeSystemPromptFilePath(params.sessionFile)} after strict retry; direct system prompt injection fallback is disabled.`,
          {
            reason: "unknown",
            provider: params.provider,
            model: context.modelId,
            status: resolveFailoverStatus("unknown"),
          },
        );
      }
      cliBackendLog.warn(
        `cli loader prompt verification failed again; falling back to direct system prompt injection: ${error.message}`,
      );
      latestCliPromptLoad = {
        sessionPromptFile: resolveClaudeSystemPromptFilePath(params.sessionFile),
        loaderMode: "strict",
        verifiedRead: false,
        fallbackReason: "direct_injection_fallback",
      };
      const output = await executeCliWithSession(
        runParams.cliSessionId,
        runParams.promptOverride,
        runParams.isSystemCall ?? false,
        runParams.forceReloadSystemPromptFile ?? false,
        "disabled",
      );
      latestCliPromptLoad = {
        ...(latestCliPromptLoad ?? {
          sessionPromptFile: resolveClaudeSystemPromptFilePath(params.sessionFile),
          verifiedRead: false,
        }),
        loaderMode: "disabled",
        verifiedRead: false,
        fallbackReason: "direct_injection_fallback",
      };
      return output;
    }
  };

  // Layer 2: Context overflow recovery
  try {
    const output = await executeCliWithLoaderFallback({ cliSessionId: cliSessionIdToUse });
    return {
      output,
      cliSessionBinding: latestCliSessionBinding,
      cliPromptLoad: latestCliPromptLoad,
      compactionsThisRun,
      systemPromptReport,
    };
  } catch (err) {
    if (err instanceof FailoverError && isContextOverflowError(err.message)) {
      const backend = context.preparedBackend.backend;
      const imageTokenEstimate = backend.imageArg
        ? (params.images?.length ?? 0) * ESTIMATED_TOKENS_PER_IMAGE
        : 0;

      // Step 2a: Send /compact to the existing session
      const sessionToCompact = cliSessionIdToUse;
      let compactSucceeded = false;
      if (sessionToCompact && context.isClaude) {
        try {
          cliBackendLog.warn(
            `cli-runner: context overflow detected, sending /compact to session`,
          );
          await executeCliWithSession(sessionToCompact, "/compact", true, false, "normal");
          compactSucceeded = true;
          compactionsThisRun += 1;
          cliBackendLog.warn("cli-runner: /compact succeeded, will retry with minimal profile");
        } catch (compactErr) {
          if (compactErr instanceof FailoverError && compactErr.reason === "session_expired") {
            throw compactErr;
          }
          cliBackendLog.warn(
            `cli-runner: /compact failed (${compactErr instanceof Error ? compactErr.message : String(compactErr)}), proceeding with profile downgrade only`,
          );
        }
      }

      // Step 2b: Downgrade bootstrap profile to minimal
      if (activeProfile !== "minimal") {
        const sessionLabel = params.sessionKey ?? params.sessionId;
        const minimalConfig = getBootstrapProfileConfig("minimal");
        const minimalContextFiles = buildBootstrapContextFiles(context.bootstrapFiles, {
          maxChars: minimalConfig.maxCharsPerFile,
          totalMaxChars: minimalConfig.totalMaxChars,
          warn: makeBootstrapWarn({
            sessionLabel,
            warn: (message) => cliBackendLog.warn(message),
          }),
        });
        const minimalWarning = buildBootstrapPromptWarning({
          analysis: analyzeBootstrapBudget({
            files: buildBootstrapInjectionStats({
              bootstrapFiles: context.bootstrapFiles,
              injectedFiles: minimalContextFiles,
            }),
            bootstrapMaxChars: minimalConfig.maxCharsPerFile,
            bootstrapTotalMaxChars: minimalConfig.totalMaxChars,
          }),
          mode: context.bootstrapPromptWarningMode,
          seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
          previousSignature: params.bootstrapPromptWarningSignature,
        });
        systemPrompt = prependBootstrapPromptWarning(
          buildSystemPrompt({
            workspaceDir: context.workspaceDir,
            config: params.config,
            defaultThinkLevel: params.thinkLevel,
            extraSystemPrompt: context.extraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            heartbeatPrompt: context.heartbeatPrompt,
            docsPath: context.docsPath,
            tools: [],
            contextFiles: minimalContextFiles,
            modelDisplay: `${params.provider}/${context.modelId}`,
            agentId: context.sessionAgentId,
          }),
          minimalWarning.lines,
        );
        activeContextFiles = minimalContextFiles;
        activeProfile = "minimal";
      }

      // Step 2c: Retry
      const sessionForRetry = compactSucceeded ? cliSessionIdToUse : undefined;
      try {
        const output = await executeCliWithLoaderFallback({
          cliSessionId: sessionForRetry,
          forceReloadSystemPromptFile: compactSucceeded,
        });
        return {
          output,
          cliSessionBinding: latestCliSessionBinding,
          cliPromptLoad: latestCliPromptLoad,
          compactionsThisRun,
          systemPromptReport,
        };
      } catch (retryErr) {
        if (retryErr instanceof FailoverError && isContextOverflowError(retryErr.message)) {
          const estimatedTks =
            estimatePromptTokens(systemPrompt) +
            estimatePromptTokens(params.prompt) +
            imageTokenEstimate;
          throw new FailoverError(
            `Current task exceeds context window for this runtime (estimated=${estimatedTks} tokens, profile=minimal, compact=${compactSucceeded}). Consider switching to the pi-embedded runtime or splitting the task.`,
            {
              reason: "unknown",
              provider: params.provider,
              model: context.modelId,
              status: resolveFailoverStatus("unknown"),
            },
          );
        }
        throw retryErr;
      }
    }
    throw err;
  }
}
