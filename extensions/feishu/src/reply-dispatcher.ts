import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type OpenClawConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { resolveFeishuAccount } from "./accounts.js";
import { buildMentionedCardContent, buildMentionedMessage } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMessageFeishu,
  sendMarkdownCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  buildMarkdownCard,
  createCardEntityFeishu,
  sendCardByCardIdFeishu,
  updateCardElementContentFeishu,
} from "./send.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/**
 * Detect if text contains markdown elements that benefit from card rendering.
 * Used by auto render mode.
 */
function shouldUseCard(text: string): boolean {
  // Code blocks (fenced)
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  // Tables (at least header + separator row with |)
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) {
    return true;
  }
  return false;
}

const STREAM_THROTTLE_MS = 350;

type StreamingBackend =
  | "none" // Initial state, not yet determined
  | "cardkit" // Using CardKit API (cardkit.v1.card.create + cardElement.content)
  | "legacy-card" // Using legacy im.message.patch for card updates
  | "raw" // Using im.message.update for text edits
  | "stopped"; // Failed, stop trying to stream

export type CreateFeishuReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** Mention targets, will be auto-included in replies */
  mentionTargets?: MentionTarget[];
  /** Account ID for multi-account support */
  accountId?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId } = params;

  // Resolve account for config access
  const account = resolveFeishuAccount({ cfg, accountId });

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  // Feishu doesn't have a native typing indicator API.
  // We use message reactions as a typing indicator substitute.
  let typingState: TypingIndicatorState | null = null;

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
      params.runtime.log?.(`feishu[${account.accountId}]: added typing indicator reaction`);
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
      params.runtime.log?.(`feishu[${account.accountId}]: removed typing indicator reaction`);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      });
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", account.accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  const feishuCfg = account.config;
  const blockStreamingEnabled = feishuCfg?.blockStreaming !== false;
  const trueStreamingEnabled = feishuCfg?.streaming !== false;
  const renderMode = feishuCfg?.renderMode ?? "auto";
  const streamRenderMode = renderMode === "raw" ? "raw" : "card";

  // Block streaming state: accumulate blocks into a single card.
  let streamingCardId: string | null = null;
  let accumulatedCardText = "";

  // True streaming state with explicit backend mode.
  let streamBackend: StreamingBackend = "none";
  let streamCardKitId: string | null = null;
  let streamMessageId: string | null = null;
  let streamSequence = 0; // Next sequence to use (starts at 1)
  let streamLastSentText = "";
  let streamPendingText = "";
  let streamInFlight = false;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let streamFinalText: string | null = null; // Store final text for delivery after flush

  const applyMentions = (text: string): string => {
    if (!mentionTargets || mentionTargets.length === 0) {
      return text;
    }
    return streamRenderMode === "card"
      ? buildMentionedCardContent(mentionTargets, text)
      : buildMentionedMessage(mentionTargets, text);
  };

  /**
   * Send or update the streaming message.
   * For CardKit: sequence starts at 1 and strictly increases.
   * Returns true on success, false to trigger fallback.
   */
  const sendOrUpdateStreamMessage = async (text: string): Promise<boolean> => {
    // Don't trim - preserve markdown formatting including leading/trailing whitespace
    if (!text || text === streamLastSentText) {
      return true;
    }

    try {
      if (streamRenderMode === "card") {
        if (streamBackend === "cardkit" && streamCardKitId) {
          // CardKit streaming update — sequence must be strictly increasing
          const nextSequence = streamSequence + 1;
          await updateCardElementContentFeishu({
            cfg,
            cardId: streamCardKitId,
            content: applyMentions(text),
            sequence: nextSequence,
            accountId,
          });
          // Only commit sequence after successful update
          streamSequence = nextSequence;
        } else if (streamBackend === "legacy-card" && streamMessageId) {
          // Legacy fallback using im.message.patch
          await updateCardFeishu({
            cfg,
            messageId: streamMessageId,
            card: buildMarkdownCard(applyMentions(text)),
            accountId,
          });
        } else if (streamBackend === "none") {
          // First partial: try CardKit first
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

            // Only set state after both operations succeed
            streamCardKitId = entity.cardId;
            streamMessageId = result.messageId;
            streamBackend = "cardkit";
            streamSequence = 1; // First update was the initial content (sequence 1)
            params.runtime.log?.(
              `feishu[${account.accountId}] CardKit stream initialized: cardId=${entity.cardId}, msgId=${result.messageId}`,
            );
          } catch (cardKitErr) {
            // CardKit unavailable — fall back to inline card with im.message.patch
            params.runtime.log?.(
              `feishu[${account.accountId}] CardKit create failed, falling back to legacy-card: ${String(cardKitErr)}`,
            );
            const result = await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text,
              replyToMessageId,
              mentions: mentionTargets,
              accountId,
            });
            streamMessageId = result.messageId;
            streamBackend = "legacy-card";
          }
        }
        // If backend is "stopped", do nothing
      } else {
        // Raw mode — use text message edit
        if (streamBackend === "raw" && streamMessageId) {
          const textWithMentions = applyMentions(text);
          await editMessageFeishu({
            cfg,
            messageId: streamMessageId,
            text: textWithMentions,
            accountId,
          });
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
        }
        // If backend is "stopped", do nothing
      }
      streamLastSentText = text;
      return true;
    } catch (err) {
      // Update failed — lock to stopped state and let deliver handle fallback
      params.runtime.log?.(`feishu[${account.accountId}] streaming update failed: ${String(err)}`);
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

    const text = streamPendingText;
    streamPendingText = "";
    if (!text) {
      return;
    }

    streamInFlight = true;
    try {
      const success = await sendOrUpdateStreamMessage(text);
      if (!success && streamFinalText) {
        // Streaming failed but we have final text — deliver will handle it
      }
    } finally {
      streamInFlight = false;
      if (streamPendingText) {
        streamTimer = setTimeout(() => {
          void flushStream();
        }, STREAM_THROTTLE_MS);
      }
    }
  };

  const queueStreamUpdate = (text: string) => {
    if (streamBackend === "stopped") {
      return;
    }
    streamPendingText = text;
    if (!streamTimer) {
      streamTimer = setTimeout(() => {
        void flushStream();
      }, STREAM_THROTTLE_MS);
    }
  };

  const waitForStreamIdle = async (): Promise<void> => {
    // Wait for any in-flight stream operations to complete
    while (streamInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Also flush any pending timer
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
      await flushStream();
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        streamFinalText = text;

        if (trueStreamingEnabled && text) {
          // Wait for any pending stream operations to complete
          await waitForStreamIdle();

          // If streaming succeeded, just send the final update
          if (streamBackend !== "stopped" && streamMessageId) {
            await sendOrUpdateStreamMessage(text);
            return;
          }

          // If streaming failed or never started, continue to send final message below
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: streaming unavailable or failed, sending final message`,
          );
        }

        params.runtime.log?.(
          `feishu[${account.accountId}] deliver called: text=${text.slice(0, 100)}`,
        );
        if (!text) {
          params.runtime.log?.(`feishu[${account.accountId}] deliver: empty text, skipping`);
          return;
        }

        // Determine if we should use card for this message
        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        // Card mode with block streaming: accumulate text and update via CardKit
        if (useCard && blockStreamingEnabled) {
          if (streamingCardId) {
            accumulatedCardText += "\n\n" + text;
            params.runtime.log?.(
              `feishu[${account.accountId}] deliver: updating streaming card ${streamingCardId}`,
            );
            if (streamBackend === "cardkit" && streamCardKitId) {
              // CardKit path — unlimited updates
              try {
                const nextSequence = streamSequence + 1;
                await updateCardElementContentFeishu({
                  cfg,
                  cardId: streamCardKitId,
                  content: accumulatedCardText,
                  sequence: nextSequence,
                  accountId,
                });
                streamSequence = nextSequence;
              } catch (err) {
                params.runtime.log?.(
                  `feishu[${account.accountId}] deliver: CardKit update failed, switching to legacy: ${String(err)}`,
                );
                streamBackend = "legacy-card";
              }
            }

            // If not in cardkit mode (or just switched), use legacy update
            if (streamBackend === "legacy-card" && streamMessageId) {
              try {
                await updateCardFeishu({
                  cfg,
                  messageId: streamMessageId,
                  card: buildMarkdownCard(accumulatedCardText),
                  accountId,
                });
              } catch (err) {
                params.runtime.log?.(
                  `feishu[${account.accountId}] deliver: card update failed, sending new card: ${String(err)}`,
                );
                const result = await sendMarkdownCardFeishu({
                  cfg,
                  to: chatId,
                  text: accumulatedCardText,
                  mentions: mentionTargets,
                  accountId,
                });
                streamingCardId = result.messageId;
              }
            }
          } else {
            accumulatedCardText = text;
            params.runtime.log?.(
              `feishu[${account.accountId}] deliver: creating streaming card in ${chatId}`,
            );
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
              streamSequence = 1;
            } catch (cardKitErr) {
              // CardKit unavailable — fall back to inline card
              params.runtime.log?.(
                `feishu[${account.accountId}] deliver: CardKit create failed, using inline card: ${String(cardKitErr)}`,
              );
              const result = await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text,
                replyToMessageId,
                mentions: mentionTargets,
                accountId,
              });
              streamingCardId = result.messageId;
              streamBackend = "legacy-card";
            }
          }
          return;
        }

        // Non-streaming path: send each delivery as a separate message
        // Only include @mentions in the first chunk (avoid duplicate @s)
        let isFirstChunk = true;

        if (useCard) {
          // Card mode: send as interactive card with markdown rendering
          const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} card chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        } else {
          // Raw mode: send as plain text with table conversion
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} text chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
        );
        typingCallbacks.onIdle?.();
      },
      onIdle: typingCallbacks.onIdle,
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming: trueStreamingEnabled ? true : undefined,
      onPartialReply: trueStreamingEnabled
        ? (payload: ReplyPayload) => {
            const text = payload.text ?? "";
            if (!text) {
              return;
            }
            queueStreamUpdate(text);
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
