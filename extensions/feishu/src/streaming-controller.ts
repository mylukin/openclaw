import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent, buildMentionedMessage } from "./mention.js";
import {
  closeStreamingModeFeishu,
  createCardEntityFeishu,
  deleteMessageFeishu,
  editMessageFeishu,
  sendCardByCardIdFeishu,
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  updateCardElementContentFeishu,
  updateCardSummaryFeishu,
} from "./send.js";

const STREAM_THROTTLE_MS = 500;
const STREAM_UPDATE_MAX_RETRIES = 3;
const STREAM_SEQUENCE_MAX_RETRIES = 8;
const STREAM_PREFIX_SIMILARITY_MIN = 0.85;
const STREAM_MIN_LENGTH_RATIO = 0.85;
const STREAM_DIVERGENCE_CONFIRMATION_COUNT = 2;
const STREAM_ROTATION_MIN_LENGTH = 32;
const STREAM_NOISE_TOKEN_MAX_LENGTH = 6;

type StreamingBackend = "none" | "cardkit" | "raw" | "stopped";

function isRetryableStreamError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("too many") ||
    msg.includes("timeout") ||
    msg.includes("temporar") ||
    msg.includes("econn") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("5xx")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type FeishuStreamingControllerParams = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId?: string;
  accountLabel: string;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  streamRenderMode: "card" | "raw";
  trueStreamingEnabled: boolean;
  blockStreamingEnabled: boolean;
  thinkingCardEnabled: boolean;
  summarize: (text: string) => string;
  onSegmentFinalized?: (payload: {
    messageId: string;
    content: string;
    cause: "segment_rotation";
  }) => void | Promise<void>;
};

export function createFeishuStreamingController(params: FeishuStreamingControllerParams) {
  const {
    cfg,
    runtime,
    accountId,
    accountLabel,
    chatId,
    replyToMessageId,
    mentionTargets,
    streamRenderMode,
    trueStreamingEnabled,
    blockStreamingEnabled,
    thinkingCardEnabled,
    summarize,
    onSegmentFinalized,
  } = params;

  // Block streaming state.
  let streamingCardId: string | null = null;
  let accumulatedCardText = "";

  // True streaming state.
  let streamBackend: StreamingBackend = "none";
  let streamCardKitId: string | null = null;
  let streamMessageId: string | null = null;
  let streamSequence = 0;
  let streamLastSentText = "";
  let streamPendingText = "";
  let streamInFlight = false;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let streamPartialCount = 0;
  let streamFlushCount = 0;
  let streamUpdateCount = 0;
  let streamEverUpdated = false;
  let streamClosing = false;
  let streamClosed = false;
  let streamClosePromise: Promise<void> | null = null;
  let cardKitOpQueue: Promise<void> = Promise.resolve();
  let lastPartialQueued = "";
  let streamLastAcceptedPartial = "";
  let streamSegmentRotationRequested = false;
  let streamRotationNextText: string | null = null;
  let streamSegmentAccumulatedText = "";
  let streamDivergenceStreak = 0;
  let streamFinalizing = false;
  let streamNextCardCreateCause: "stream_start" | "segment_rotation" = "stream_start";

  const isSequenceCompareFailedError = (err: unknown): boolean =>
    /sequence\s+number\s+compare\s+failed/i.test(String(err));

  const enqueueCardKitOp = <T>(op: () => Promise<T>): Promise<T> => {
    const run = cardKitOpQueue.then(op, op);
    cardKitOpQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const runCardKitMutation = async (
    label: string,
    mutation: (sequence: number) => Promise<void>,
    options?: { markClosed?: boolean; maxRetries?: number; expectedCardId?: string },
  ): Promise<void> => {
    await enqueueCardKitOp(async () => {
      if (streamBackend !== "cardkit" || !streamCardKitId) {
        return;
      }
      if (options?.expectedCardId && streamCardKitId !== options.expectedCardId) {
        runtime.log?.(
          `feishu[${accountLabel}] ${label} skipped: card switched (expected=${options.expectedCardId}, active=${streamCardKitId})`,
        );
        return;
      }
      if (streamClosed && !options?.markClosed) {
        return;
      }

      const maxRetries = options?.maxRetries ?? STREAM_SEQUENCE_MAX_RETRIES;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        if (options?.expectedCardId && streamCardKitId !== options.expectedCardId) {
          runtime.log?.(
            `feishu[${accountLabel}] ${label} aborted: card switched during retry (expected=${options.expectedCardId}, active=${streamCardKitId ?? "none"})`,
          );
          return;
        }
        const nextSequence = streamSequence + 1;
        try {
          await mutation(nextSequence);
          streamSequence = nextSequence;
          if (options?.markClosed) {
            streamClosed = true;
          }
          return;
        } catch (err) {
          lastError = err;
          const sequenceError = isSequenceCompareFailedError(err);
          const retryable = sequenceError || isRetryableStreamError(err);
          runtime.log?.(
            `feishu[${accountLabel}] ${label} failed (cardId=${streamCardKitId}, sequence=${nextSequence}, attempt=${attempt}, retryable=${retryable}, sequenceError=${sequenceError}): ${String(err)}`,
          );
          if (!retryable || attempt >= maxRetries) {
            throw err;
          }
          if (sequenceError) {
            streamSequence = nextSequence;
          }
          await sleep(100 * attempt);
        }
      }

      throw lastError ?? new Error(`${label} failed without details`);
    });
  };

  const applyMentions = (text: string): string => {
    if (!mentionTargets || mentionTargets.length === 0) {
      return text;
    }
    return streamRenderMode === "card"
      ? buildMentionedCardContent(mentionTargets, text)
      : buildMentionedMessage(mentionTargets, text);
  };

  const normalizeComparisonText = (text: string): string => {
    const trimmed = text.replace(/\s+$/g, "");
    const withoutTrailingMarkdownControl = trimmed.replace(/[\s*_`~|#>\-:.()]+$/g, "");
    return withoutTrailingMarkdownControl.replace(/\s+$/g, "");
  };

  const isShortMarkdownNoiseToken = (text: string): boolean => {
    const candidate = text.trim();
    if (!candidate || candidate.length > STREAM_NOISE_TOKEN_MAX_LENGTH) {
      return false;
    }
    return /^[*_`~|#>\-:.()]+$/.test(candidate);
  };

  const isNonRegressiveStreamUpdate = (previous: string, current: string): boolean => {
    if (!previous) {
      return true;
    }
    if (current.startsWith(previous)) {
      return true;
    }
    const previousNormalized = normalizeComparisonText(previous);
    const currentNormalized = normalizeComparisonText(current);
    if (!previousNormalized) {
      return true;
    }
    if (currentNormalized.startsWith(previousNormalized)) {
      return true;
    }

    const lengthRatio = currentNormalized.length / previousNormalized.length;
    if (lengthRatio < STREAM_MIN_LENGTH_RATIO) {
      return false;
    }

    const compareLen = Math.min(previousNormalized.length, currentNormalized.length);
    let commonPrefixLen = 0;
    while (commonPrefixLen < compareLen) {
      if (
        previousNormalized.charCodeAt(commonPrefixLen) !==
        currentNormalized.charCodeAt(commonPrefixLen)
      ) {
        break;
      }
      commonPrefixLen += 1;
    }

    const preservedPrefixRatio = commonPrefixLen / previousNormalized.length;
    return preservedPrefixRatio >= STREAM_PREFIX_SIMILARITY_MIN;
  };

  const updateCardElementWithRetry = async (cardId: string, content: string): Promise<void> => {
    await runCardKitMutation(
      "stream element update",
      async (sequence) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= STREAM_UPDATE_MAX_RETRIES; attempt += 1) {
          try {
            await updateCardElementContentFeishu({
              cfg,
              cardId,
              content,
              sequence,
              accountId,
            });
            return;
          } catch (err) {
            lastError = err;
            const retryable = isRetryableStreamError(err) && !isSequenceCompareFailedError(err);
            if (!retryable || attempt >= STREAM_UPDATE_MAX_RETRIES) {
              throw err;
            }
            await sleep(250 * attempt);
          }
        }
        throw lastError ?? new Error("Feishu stream update failed without details");
      },
      { expectedCardId: cardId },
    );
  };

  const sendOrUpdateStreamMessage = async (text: string): Promise<boolean> => {
    if (!text || text === streamLastSentText) {
      return true;
    }

    try {
      if (streamRenderMode === "card") {
        if (streamClosing || streamClosed) {
          return true;
        }
        if (streamBackend === "cardkit" && streamCardKitId) {
          await updateCardElementWithRetry(streamCardKitId, applyMentions(text));
          streamUpdateCount += 1;
          streamEverUpdated = true;
        } else if (streamBackend === "none") {
          try {
            const entity = await createCardEntityFeishu({
              cfg,
              initialContent: applyMentions(text),
              accountId,
            });

            const result = await sendCardByCardIdFeishu({
              cfg,
              to: chatId,
              cardId: entity.cardId,
              replyToMessageId,
              accountId,
            });

            streamCardKitId = entity.cardId;
            streamMessageId = result.messageId;
            streamBackend = "cardkit";
            streamSequence = 0;
            runtime.log?.(
              `feishu[${accountLabel}] CardKit stream initialized (method=cardkit.cardElement.content, cause=${streamNextCardCreateCause}): cardId=${entity.cardId}, msgId=${result.messageId}`,
            );
            streamNextCardCreateCause = "stream_start";
          } catch (cardKitErr) {
            runtime.log?.(
              `feishu[${accountLabel}] CardKit stream init failed (cause=${streamNextCardCreateCause}, create-or-bind), streaming unavailable: ${String(cardKitErr)}`,
            );
            streamBackend = "stopped";
            streamNextCardCreateCause = "stream_start";
          }
        }
      } else if (streamBackend === "raw" && streamMessageId) {
        await editMessageFeishu({
          cfg,
          messageId: streamMessageId,
          text: applyMentions(text),
          accountId,
        });
        streamUpdateCount += 1;
        streamEverUpdated = true;
      } else if (streamBackend === "none") {
        const result = await sendMessageFeishu({
          cfg,
          to: chatId,
          text,
          replyToMessageId,
          mentions: mentionTargets,
          accountId,
        });
        streamMessageId = result.messageId;
        streamBackend = "raw";
        runtime.log?.(`feishu[${accountLabel}] raw stream initialized`);
      }

      streamLastSentText = text;
      return true;
    } catch (err) {
      runtime.log?.(
        `feishu[${accountLabel}] streaming update failed (cause=stream_update_failed): ${String(err)}`,
      );
      streamBackend = "stopped";
      return false;
    }
  };

  const flushStream = async (): Promise<void> => {
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    if (streamInFlight) {
      return;
    }

    let text = streamPendingText;
    streamPendingText = "";
    if (!text && !streamSegmentRotationRequested) {
      return;
    }

    streamFlushCount += 1;
    streamInFlight = true;
    try {
      if (streamSegmentRotationRequested) {
        streamSegmentRotationRequested = false;
        streamDivergenceStreak = 0;
        const nextSegmentText = streamRotationNextText;
        streamRotationNextText = null;
        const previousSegmentMessageId = streamMessageId;
        const previousSegmentCardId = streamCardKitId;
        const previousSegmentText = streamSegmentAccumulatedText;

        runtime.log?.(
          `feishu[${accountLabel}] segment rotation begin (cause=segment_rotation): prevCardId=${previousSegmentCardId ?? "none"}, prevMsgId=${previousSegmentMessageId ?? "none"}, prevLen=${previousSegmentText.length}, nextLen=${nextSegmentText?.length ?? 0}`,
        );

        if (streamSegmentAccumulatedText && streamSegmentAccumulatedText !== streamLastSentText) {
          await sendOrUpdateStreamMessage(streamSegmentAccumulatedText);
        }

        if (streamRenderMode === "card" && streamBackend === "cardkit" && streamCardKitId) {
          const previousCardId = streamCardKitId;
          try {
            await runCardKitMutation(
              "segment rotate close streaming mode",
              async (sequence) => {
                await closeStreamingModeFeishu({
                  cfg,
                  cardId: previousCardId,
                  sequence,
                  accountId,
                });
              },
              { markClosed: true, maxRetries: 5, expectedCardId: previousCardId },
            );
          } catch (err) {
            runtime.log?.(
              `feishu[${accountLabel}] segment rotate close failed (cause=segment_rotation, cardId=${previousCardId}): ${String(err)}`,
            );
          }
        }

        if (previousSegmentMessageId && previousSegmentText.trim()) {
          runtime.log?.(
            `feishu[${accountLabel}] segment finalized (cause=segment_rotation, msgId=${previousSegmentMessageId}, textLen=${previousSegmentText.length})`,
          );
          void onSegmentFinalized?.({
            messageId: previousSegmentMessageId,
            content: previousSegmentText,
            cause: "segment_rotation",
          });
        }

        streamBackend = "none";
        streamCardKitId = null;
        streamMessageId = null;
        streamSequence = 0;
        streamLastSentText = "";
        streamClosing = false;
        streamClosed = false;
        streamClosePromise = null;
        streamNextCardCreateCause = "segment_rotation";

        if (nextSegmentText) {
          text = nextSegmentText;
          streamLastAcceptedPartial = nextSegmentText;
          streamSegmentAccumulatedText = nextSegmentText;
        } else {
          streamLastAcceptedPartial = "";
          streamSegmentAccumulatedText = "";
        }
      }
      if (text) {
        await sendOrUpdateStreamMessage(text);
      }
    } finally {
      streamInFlight = false;
      if ((streamPendingText || streamSegmentRotationRequested) && !streamTimer) {
        streamTimer = setTimeout(() => {
          void flushStream();
        }, STREAM_THROTTLE_MS);
      }
    }
  };

  const waitForStreamIdle = async (): Promise<void> => {
    while (streamInFlight) {
      await sleep(50);
    }
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
      await flushStream();
    }
  };

  const closeStreamingIfNeeded = async (): Promise<void> => {
    if (streamBackend !== "cardkit" || !streamCardKitId) {
      return;
    }
    if (streamClosed) {
      return;
    }
    if (streamClosePromise) {
      await streamClosePromise;
      return;
    }

    streamClosing = true;
    const cardId = streamCardKitId;
    streamClosePromise = (async () => {
      await waitForStreamIdle();
      await runCardKitMutation(
        "close streaming mode",
        async (sequence) => {
          await closeStreamingModeFeishu({
            cfg,
            cardId,
            sequence,
            accountId,
          });
        },
        { markClosed: true, expectedCardId: cardId },
      );
    })();

    try {
      await streamClosePromise;
    } catch (err) {
      runtime.log?.(`feishu[${accountLabel}] close streaming mode failed: ${String(err)}`);
    } finally {
      if (!streamClosed) {
        streamClosing = false;
      }
      streamClosePromise = null;
    }
  };

  const clearPendingThinkingCard = async (): Promise<void> => {
    if (!streamCardKitId || streamEverUpdated) {
      return;
    }
    const cardId = streamCardKitId;
    runtime.log?.(`feishu[${accountLabel}] cleaning up orphan thinking card: cardId=${cardId}`);
    try {
      await runCardKitMutation(
        "orphan thinking card clear",
        async (sequence) => {
          await updateCardElementContentFeishu({
            cfg,
            cardId,
            content: " ",
            sequence,
            accountId,
          });
        },
        { maxRetries: 5, expectedCardId: cardId },
      );
      runtime.log?.(`feishu[${accountLabel}] orphan thinking card cleared`);
      return;
    } catch {
      // Fallback to recall below.
    }

    if (!streamMessageId) {
      runtime.log?.(
        `feishu[${accountLabel}] orphan thinking cleanup failed: no messageId for recall`,
      );
      return;
    }

    runtime.log?.(
      `feishu[${accountLabel}] orphan thinking card update failed, recalling message: msgId=${streamMessageId}`,
    );
    try {
      await deleteMessageFeishu({ cfg, messageId: streamMessageId, accountId });
      runtime.log?.(`feishu[${accountLabel}] orphan thinking card message recalled successfully`);
    } catch (recallErr) {
      runtime.log?.(
        `feishu[${accountLabel}] orphan thinking card recall failed: ${String(recallErr)}`,
      );
    }
  };

  const ensureThinkingCardIfNeeded = async (): Promise<void> => {
    if (!thinkingCardEnabled) {
      return;
    }
    if (!trueStreamingEnabled || streamRenderMode !== "card" || streamBackend !== "none") {
      return;
    }
    if (!replyToMessageId) {
      return;
    }
    try {
      const entity = await createCardEntityFeishu({
        cfg,
        initialContent: "⏳ Thinking ...",
        accountId,
      });
      const result = await sendCardByCardIdFeishu({
        cfg,
        to: chatId,
        cardId: entity.cardId,
        replyToMessageId,
        accountId,
      });
      streamCardKitId = entity.cardId;
      streamMessageId = result.messageId;
      streamBackend = "cardkit";
      streamSequence = 0;
      runtime.log?.(
        `feishu[${accountLabel}] eager thinking card: cardId=${entity.cardId}, msgId=${result.messageId}`,
      );
    } catch (err) {
      runtime.log?.(
        `feishu[${accountLabel}] eager thinking card failed (will retry on first partial): ${String(err)}`,
      );
    }
  };

  const queuePartialReply = (text: string): void => {
    if (!trueStreamingEnabled || !text) {
      return;
    }
    if (text === lastPartialQueued) {
      return;
    }
    if (streamFinalizing || streamBackend === "stopped" || streamClosing || streamClosed) {
      lastPartialQueued = text;
      return;
    }

    if (isShortMarkdownNoiseToken(text)) {
      runtime.log?.(
        `feishu[${accountLabel}] stream partial skipped (cause=noise_token, len=${text.length})`,
      );
      lastPartialQueued = text;
      return;
    }

    if (!isNonRegressiveStreamUpdate(streamLastAcceptedPartial, text)) {
      const hasActiveSegment = Boolean(streamMessageId || streamCardKitId);
      const normalizedLen = normalizeComparisonText(text).length;
      streamDivergenceStreak += 1;
      streamRotationNextText = text;
      if (hasActiveSegment) {
        const reachedConfirmation =
          streamDivergenceStreak >= STREAM_DIVERGENCE_CONFIRMATION_COUNT &&
          normalizedLen >= STREAM_ROTATION_MIN_LENGTH;
        if (reachedConfirmation) {
          if (!streamSegmentRotationRequested) {
            runtime.log?.(
              `feishu[${accountLabel}] stream partial diverged (cause=segment_rotation_trigger, streak=${streamDivergenceStreak}, prev=${streamLastAcceptedPartial.length}, next=${text.length}, normalizedNext=${normalizedLen}), rotating to new card segment`,
            );
          }
          streamSegmentRotationRequested = true;
        } else {
          runtime.log?.(
            `feishu[${accountLabel}] stream partial diverged (cause=segment_rotation_deferred, streak=${streamDivergenceStreak}, prev=${streamLastAcceptedPartial.length}, next=${text.length}, normalizedNext=${normalizedLen})`,
          );
        }
      }
      lastPartialQueued = text;
      if (streamSegmentRotationRequested && !streamTimer) {
        streamTimer = setTimeout(() => {
          void flushStream();
        }, STREAM_THROTTLE_MS);
      }
      return;
    }

    streamLastAcceptedPartial = text;
    streamSegmentAccumulatedText = text;
    streamDivergenceStreak = 0;
    lastPartialQueued = text;
    streamPartialCount += 1;
    streamPendingText = text;
    if (!streamTimer) {
      streamTimer = setTimeout(() => {
        void flushStream();
      }, STREAM_THROTTLE_MS);
    }
  };

  const tryDeliverFinalStream = async (
    text: string,
  ): Promise<{ handled: boolean; messageId?: string; msgType?: "post" | "interactive" }> => {
    if (!trueStreamingEnabled || !text) {
      return { handled: false };
    }

    streamFinalizing = true;

    await waitForStreamIdle();
    if (streamBackend === "stopped" || !streamMessageId) {
      runtime.log?.(
        `feishu[${accountLabel}] deliver: streaming unavailable/failed (cause=stream_backend_unavailable, backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}), sending final message`,
      );
      return { handled: false };
    }

    const finalText =
      streamSegmentAccumulatedText &&
      !isNonRegressiveStreamUpdate(streamSegmentAccumulatedText, text)
        ? streamSegmentAccumulatedText
        : text;

    runtime.log?.(
      `feishu[${accountLabel}] final stream delivery via ${streamRenderMode === "card" ? "cardkit.cardElement.content" : "im.message.update"}: backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}`,
    );

    const streamSuccess = await sendOrUpdateStreamMessage(finalText);
    if (!streamSuccess) {
      return { handled: false };
    }

    if (streamRenderMode === "card" && streamCardKitId) {
      const cardId = streamCardKitId;
      const summary = summarize(finalText);
      try {
        await runCardKitMutation(
          "summary update",
          async (sequence) => {
            await updateCardSummaryFeishu({
              cfg,
              cardId,
              summaryText: summary,
              content: applyMentions(finalText),
              sequence,
              accountId,
            });
          },
          { expectedCardId: cardId },
        );
      } catch (err) {
        runtime.log?.(`feishu[${accountLabel}] summary update skipped: ${String(err)}`);
      }
    }

    await closeStreamingIfNeeded();
    runtime.log?.(
      `feishu[${accountLabel}] streaming status: used=${streamEverUpdated}, backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}`,
    );

    return {
      handled: true,
      messageId: streamMessageId ?? undefined,
      msgType: streamRenderMode === "card" ? "interactive" : "post",
    };
  };

  const tryDeliverBlock = async (
    text: string,
  ): Promise<{ handled: boolean; messageId?: string }> => {
    if (!blockStreamingEnabled || streamBackend === "stopped") {
      return { handled: false };
    }

    if (streamingCardId) {
      accumulatedCardText += "\n\n" + text;
      runtime.log?.(`feishu[${accountLabel}] deliver: updating streaming card ${streamingCardId}`);
      if (streamBackend === "cardkit" && streamCardKitId) {
        try {
          await updateCardElementWithRetry(streamCardKitId, accumulatedCardText);
        } catch (err) {
          runtime.log?.(`feishu[${accountLabel}] deliver: CardKit update failed: ${String(err)}`);
          streamBackend = "stopped";
        }
      }
      return { handled: true };
    }

    accumulatedCardText = text;
    runtime.log?.(`feishu[${accountLabel}] deliver: creating streaming card in ${chatId}`);
    try {
      const entity = await createCardEntityFeishu({
        cfg,
        initialContent: applyMentions(text),
        accountId,
      });

      const result = await sendCardByCardIdFeishu({
        cfg,
        to: chatId,
        cardId: entity.cardId,
        replyToMessageId,
        accountId,
      });

      streamingCardId = result.messageId;
      streamCardKitId = entity.cardId;
      streamBackend = "cardkit";
      streamSequence = 0;
      return { handled: true, messageId: result.messageId };
    } catch (cardKitErr) {
      runtime.log?.(
        `feishu[${accountLabel}] deliver: CardKit create failed: ${String(cardKitErr)}`,
      );
      streamBackend = "stopped";
      const result = await sendMarkdownCardFeishu({
        cfg,
        to: chatId,
        text,
        replyToMessageId,
        mentions: mentionTargets,
        accountId,
      });
      return { handled: true, messageId: result.messageId };
    }
  };

  return {
    trueStreamingEnabled,
    blockStreamingEnabled,
    streamRenderMode,
    queuePartialReply,
    ensureThinkingCardIfNeeded,
    tryDeliverFinalStream,
    tryDeliverBlock,
    clearPendingThinkingCard,
    closeStreamingIfNeeded,
    getReplyDisableBlockStreamingFlag: () => (trueStreamingEnabled ? true : undefined),
  };
}
