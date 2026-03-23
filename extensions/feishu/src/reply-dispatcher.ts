import path from "node:path";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import {
  createChannelReplyPipeline,
  createReplyPrefixContext,
  logTypingFailure,
  type ClawdbotConfig,
  type OutboundIdentity,
  type ReplyPayload,
  type RuntimeEnv,
} from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveMediaContentType } from "./media-types.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent, normalizeMentionTagsForCard } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendStructuredCardFeishu, type CardHeaderConfig } from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function resolveFinalDeliveryContent(text: string, mediaUrls: string[]): string {
  const normalized = text.trim();
  if (normalized) {
    return normalized;
  }
  if (mediaUrls.length === 0) {
    return normalized;
  }
  const names = mediaUrls
    .map((mediaUrl) => {
      const trimmed = mediaUrl.trim();
      if (!trimmed) {
        return null;
      }
      const withoutHash = trimmed.split("#")[0] ?? trimmed;
      const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
      try {
        const parsed = new URL(withoutQuery);
        return path.basename(parsed.pathname) || null;
      } catch {
        const base = path.basename(withoutQuery);
        return base && base !== "." && base !== "/" ? base : null;
      }
    })
    .filter((value): value is string => Boolean(value));
  return names.length > 0 ? names.join(", ") : "media";
}

function resolveMediaFileName(mediaUrl: string): string {
  const trimmed = mediaUrl.trim();
  if (!trimmed) return "media";
  const withoutHash = trimmed.split("#")[0] ?? trimmed;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  try {
    const parsed = new URL(withoutQuery);
    return path.basename(parsed.pathname) || "media";
  } catch {
    const base = path.basename(withoutQuery);
    return base && base !== "." && base !== "/" ? base : "media";
  }
}

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

/** Build a card header from agent identity config. */
function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig {
  const name = identity?.name?.trim() || agentId;
  const emoji = identity?.emoji?.trim();
  return {
    title: emoji ? `${emoji} ${name}` : name,
    template: identity?.theme ?? "blue",
  };
}

/** Build a card note footer from agent identity and model context. */
function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** Whether card streaming status is allowed in thread/topic replies (default: false). */
  streamingInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  identity?: OutboundIdentity;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
  /** Callback fired when a final visible text reply has been delivered. */
  onFinalTextDelivered?: (params: {
    text: string;
    messageId?: string;
    messageIds?: string[];
    chatId: string;
    accountId?: string;
  }) => Promise<void> | void;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    streamingInThread,
    threadReply,
    rootId,
    mentionTargets,
    accountId,
    identity,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });

  // Emit message_sent plugin hooks via the runtime SDK so downstream consumers
  // (e.g. bot-company journal) can record outbound messages. The feishu reply
  // dispatcher bypasses the core deliverOutboundPayloads pipeline, so hooks
  // must be emitted explicitly here. Using core.hooks avoids the bundle singleton
  // splitting issue that makes direct getGlobalHookRunner() imports fail.
  const emitMessageSent = (event: {
    content: string;
    success: boolean;
    messageId?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }) => {
    core.hooks.emitMessageSent(
      {
        to: chatId,
        content: event.content,
        success: event.success,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(event.error ? { error: event.error } : {}),
        metadata: { chatId, ...(event.metadata ?? {}) },
      },
      {
        channelId: "feishu",
        accountId: accountId ?? account.accountId,
        conversationId: chatId,
      },
    );
  };
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const { typingCallbacks } = createChannelReplyPipeline({
    cfg,
    agentId,
    channel: "feishu",
    accountId,
    typing: {
      start: async () => {
        // Check if typing indicator is enabled (default: true)
        if (!(account.config.typingIndicator ?? true)) {
          return;
        }
        if (!replyToMessageId) {
          return;
        }
        // Skip typing indicator for old messages — likely replays after context
        // compaction that would flood users with stale notifications (#30418).
        const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
        if (
          messageCreateTimeMs !== undefined &&
          Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
        ) {
          return;
        }
        // Feishu reactions persist until explicitly removed, so skip keepalive
        // re-adds when a reaction already exists. Re-adding the same emoji
        // triggers a new push notification for every call (#28660).
        if (typingState?.reactionId) {
          return;
        }
        typingState = await addTypingIndicator({
          cfg,
          messageId: replyToMessageId,
          accountId,
          runtime: params.runtime,
        });
      },
      stop: async () => {
        if (!typingState) {
          return;
        }
        await removeTypingIndicator({
          cfg,
          state: typingState,
          accountId,
          runtime: params.runtime,
        });
        typingState = null;
      },
      onStartError: (err) =>
        logTypingFailure({
          log: (message) => params.runtime.log?.(message),
          channel: "feishu",
          action: "start",
          error: err,
        }),
      onStopError: (err) =>
        logTypingFailure({
          log: (message) => params.runtime.log?.(message),
          channel: "feishu",
          action: "stop",
          error: err,
        }),
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled =
    account.config?.streaming !== false &&
    renderMode !== "raw" &&
    (!threadReplyMode || streamingInThread === true);

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let reasoningText = "";
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let finalTextEmitted = false;
  /** Tracks whether any visible text was delivered during this reply cycle
   *  (via streaming partial, block, or final text). Used to avoid emitting
   *  a synthetic media filename as "final text" when real text was already
   *  delivered through the streaming card. */
  let hasVisibleTextInReply = false;
  let replaceNextPartialAfterTool = false;
  let streamPhase: "idle" | "thinking" | "tool" | "streaming" = "idle";
  let toolUseCount = 0;
  let lastToolName: string | undefined;
  let lastRenderedStreamContent = "";
  let hasThinkingPrelude = false;
  let stagedStatusLine: string | undefined;

  /**
   * Deliver media files and emit persistence signals for media-only final payloads.
   * Extracted to avoid duplicating this logic across streaming/non-streaming paths.
   */
  const deliverMediaAndEmitIfNeeded = async (
    mediaList: string[],
    text: string,
    info: { kind?: string } | undefined,
    hasText: boolean,
  ): Promise<void> => {
    const deliveredMediaMessageIds: string[] = [];
    for (const mediaUrl of mediaList) {
      const sent = await sendMediaFeishu({
        cfg,
        to: chatId,
        mediaUrl,
        replyToMessageId: sendReplyToMessageId,
        replyInThread: effectiveReplyInThread,
        accountId,
      });
      if (typeof sent?.messageId === "string" && sent.messageId.trim()) {
        deliveredMediaMessageIds.push(sent.messageId);
        // Emit a separate message_sent event for each media message so
        // downstream consumers (e.g. bot-company journal) can record them
        // with the correct content type and individual message IDs.
        const mediaName = resolveMediaFileName(mediaUrl);
        const mediaContentType = resolveMediaContentType(path.extname(mediaName).toLowerCase());
        emitMessageSent({
          content: `[${mediaContentType}: ${mediaName}]`,
          success: true,
          messageId: sent.messageId,
          metadata: { chatId, contentType: mediaContentType, mediaUrl },
        });
      }
    }
    // For media-only finals with no visible text, fire the onFinalTextDelivered
    // callback so replay synthetic outbound triggers correctly.
    if (info?.kind === "final" && !hasText && !hasVisibleTextInReply) {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue.catch(() => undefined);
      if (deliveredMediaMessageIds.length > 0) {
        const finalContent = resolveFinalDeliveryContent(text, mediaList);
        await emitFinalTextIfNeeded(finalContent, {
          messageId: deliveredMediaMessageIds.at(-1),
          messageIds: deliveredMediaMessageIds,
        });
      }
    }
  };

  const emitFinalTextIfNeeded = async (
    text: string,
    delivery?: { messageId?: string; messageIds?: string[] },
  ) => {
    const normalized = text.trim();
    if (!normalized || finalTextEmitted || typeof params.onFinalTextDelivered !== "function") {
      return;
    }
    finalTextEmitted = true;
    try {
      await params.onFinalTextDelivered({
        text: normalized,
        ...(delivery?.messageId ? { messageId: delivery.messageId } : {}),
        ...(delivery?.messageIds && delivery.messageIds.length > 0
          ? { messageIds: delivery.messageIds }
          : {}),
        chatId,
        accountId: accountId ?? account.accountId,
      });
    } catch (error) {
      params.runtime.error?.(
        `feishu[${account.accountId}] onFinalTextDelivered failed: ${String(error)}`,
      );
    }
  };

  const TOOL_DISPLAY_NAMES: Record<string, string> = {
    feishu_chat_history: "聊天记录",
    feishu_chat_info: "群信息",
    feishu_chat_members: "群成员",
    feishu_member_chats: "成员群列表",
  };

  const normalizeToolName = (name: string | undefined): string | undefined => {
    const trimmed = name?.trim();
    if (!trimmed) {
      return undefined;
    }
    const stripped = trimmed.replace("mcp__openclaw__", "");
    return TOOL_DISPLAY_NAMES[stripped] ?? stripped.replace(/\s+/g, " ");
  };

  const resolveStatusLine = (): string | undefined => {
    if (streamPhase === "thinking") {
      return "💭 思考中...";
    }
    if (streamPhase === "tool") {
      if (toolUseCount >= 2) {
        return `🔧 已使用 ${toolUseCount} 个工具，正在处理...`;
      }
      const toolName = lastToolName?.trim();
      return toolName ? `🔧 正在使用${toolName}工具...` : "🔧 正在使用工具...";
    }
    return undefined;
  };

  const composeStreamingContent = (mode: "live" | "final" = "live"): string => {
    const assistantText = streamText;
    if (mode === "final") {
      return assistantText;
    }
    const statusLine = resolveStatusLine();
    if (!statusLine) {
      return assistantText;
    }
    if (!assistantText) {
      return statusLine;
    }
    return `${statusLine}\n---\n${assistantText}`;
  };

  /** Strip trailing incomplete <at ...> tag to prevent streaming card corruption. */
  const stripIncompleteAtTag = (text: string): string => {
    const lastAtIdx = text.lastIndexOf("<at");
    if (lastAtIdx === -1) {
      return text;
    }
    const tail = text.substring(lastAtIdx);
    if (/<\/at>/i.test(tail) || /\/>/i.test(tail)) {
      return text;
    }
    return text.substring(0, lastAtIdx);
  };

  const queueStreamingRender = (renderedSnapshot?: string) => {
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (!streaming?.isActive()) {
        return;
      }
      const rendered = renderedSnapshot ?? composeStreamingContent("live");
      const safeRendered = stripIncompleteAtTag(rendered);
      const renderedForCard = normalizeMentionTagsForCard(safeRendered);
      if (!renderedForCard || renderedForCard === lastRenderedStreamContent) {
        return;
      }
      lastRenderedStreamContent = renderedForCard;
      await streaming.update(renderedForCard);
      // Only mark visible when real assistant text exists — status-only renders
      // (e.g. "💭 思考中...") are discarded by closeStreaming() and should not
      // suppress media-only final persistence.
      if (streamText.trim()) {
        hasVisibleTextInReply = true;
      }
    });
  };

  const shouldRenderStreamingStatus = (): boolean =>
    renderMode === "card" || Boolean(streamingStartPromise) || Boolean(streaming?.isActive());

  const queueThinkingPrelude = (): boolean => {
    if (hasThinkingPrelude) {
      return false;
    }
    streamPhase = "thinking";
    stagedStatusLine = resolveStatusLine();
    hasThinkingPrelude = true;
    return true;
  };

  const formatReasoningPrefix = (thinking: string): string => {
    if (!thinking) return "";
    const withoutLabel = thinking.replace(/^Reasoning:\n/, "");
    const plain = withoutLabel.replace(/^_(.*)_$/gm, "$1");
    const lines = plain.split("\n").map((line) => `> ${line}`);
    return `> 💭 **Thinking**\n${lines.join("\n")}`;
  };

  const buildCombinedStreamText = (thinking: string, answer: string): string => {
    const parts: string[] = [];
    if (thinking) parts.push(formatReasoningPrefix(thinking));
    if (thinking && answer) parts.push("\n\n---\n\n");
    if (answer) parts.push(answer);
    return parts.join("");
  };

  const flushStreamingCardUpdate = (combined: string) => {
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(combined);
      }
    });
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
    },
  ) => {
    if (!nextText) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    const shouldResetAfterTool =
      replaceNextPartialAfterTool &&
      options?.dedupeWithLastPartial === true &&
      Boolean(streamText) &&
      !nextText.startsWith(streamText);
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    streamText = mergeStreamingText(streamText, nextText);
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const queueReasoningUpdate = (nextThinking: string) => {
    if (!nextThinking) return;
    reasoningText = nextThinking;
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: cardNote,
        });
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
        streamingStartPromise = null; // allow retry on next deliver
      }
    })();
  };

  const closeStreaming = async (options?: { emitFinalText?: boolean }) => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    const streamMessageId = streaming?.getMessageId();
    if (streaming?.isActive()) {
      let text = buildCombinedStreamText(reasoningText, streamText);
      const finalText = text;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
      await streaming.close(text, { note: finalNote });
      hasVisibleTextInReply = true;
      // Emit hooks for non-discarded streaming cards so downstream consumers
      // (e.g. bot-company journal) can record the delivered text.
      if (options?.emitFinalText && finalText.trim()) {
        emitMessageSent({ content: finalText, success: true, messageId: streamMessageId });
        await emitFinalTextIfNeeded(
          finalText,
          streamMessageId ? { messageId: streamMessageId } : undefined,
        );
      }
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
    reasoningText = "";
  };

  const sendChunkedTextReply = async (params: {
    text: string;
    useCard: boolean;
    infoKind?: string;
    sendChunk: (params: {
      chunk: string;
      isFirst: boolean;
    }) => Promise<{ messageId?: string } | void>;
  }): Promise<{ lastMessageId?: string; deliveredMessageIds: string[] }> => {
    const deliveredMessageIds: string[] = [];
    let lastMessageId: string | undefined;
    const chunkSource = params.useCard
      ? params.text
      : core.channel.text.convertMarkdownTables(params.text, tableMode);
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      core.channel.text.chunkTextWithMode(chunkSource, textChunkLimit, chunkMode),
    );
    for (const [index, chunk] of chunks.entries()) {
      const result = await params.sendChunk({
        chunk,
        isFirst: index === 0,
      });
      const sentId = result?.messageId;
      if (typeof sentId === "string" && sentId.trim()) {
        lastMessageId = sentId;
        deliveredMessageIds.push(sentId);
      }
    }
    if (params.infoKind === "final") {
      deliveredFinalTexts.add(params.text);
    }
    return { lastMessageId, deliveredMessageIds };
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: async () => {
        deliveredFinalTexts.clear();
        hasVisibleTextInReply = false;
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        await typingCallbacks?.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const reply = resolveSendableOutboundReplyParts(payload);
        const text = reply.text;
        const hasText = reply.hasText;
        const hasMedia = reply.hasMedia;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        if (shouldDeliverText) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content.
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              // hasVisibleTextInReply is set by queueStreamingRender on successful update.
              queueThinkingPrelude();
              queueStreamingUpdate(text);
            }
            if (info?.kind === "final") {
              streamText = text;
              await closeStreaming({ emitFinalText: true });
              // Mark visible only after closeStreaming succeeds — text is now delivered.
              hasVisibleTextInReply = true;
              deliveredFinalTexts.add(text);
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              await deliverMediaAndEmitIfNeeded(reply.mediaUrls, text, info, hasText);
            }
            return;
          }

          let chunkResult: { lastMessageId?: string; deliveredMessageIds: string[] };
          if (useCard) {
            const cardHeader = resolveCardHeader(agentId, identity);
            const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
            chunkResult = await sendChunkedTextReply({
              text,
              useCard: true,
              infoKind: info?.kind,
              sendChunk: async ({ chunk, isFirst }) => {
                const sent = await sendStructuredCardFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: isFirst ? mentionTargets : undefined,
                  accountId,
                  header: cardHeader,
                  note: cardNote,
                });
                return { messageId: sent?.messageId };
              },
            });
          } else {
            chunkResult = await sendChunkedTextReply({
              text,
              useCard: false,
              infoKind: info?.kind,
              sendChunk: async ({ chunk, isFirst }) => {
                const sent = await sendMessageFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: isFirst ? mentionTargets : undefined,
                  accountId,
                });
                return { messageId: sent?.messageId };
              },
            });
          }
          if (chunkResult.deliveredMessageIds.length > 0) {
            hasVisibleTextInReply = true;
          }
          if (info?.kind === "final") {
            emitMessageSent({
              content: text,
              success: true,
              messageId: chunkResult.lastMessageId,
            });
            await emitFinalTextIfNeeded(text, {
              ...(chunkResult.lastMessageId ? { messageId: chunkResult.lastMessageId } : {}),
              ...(chunkResult.deliveredMessageIds.length > 0
                ? { messageIds: chunkResult.deliveredMessageIds }
                : {}),
            });
          }
        }

        if (hasMedia) {
          await deliverMediaAndEmitIfNeeded(reply.mediaUrls, text, info, hasText);
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming({ emitFinalText: false });
        typingCallbacks?.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming({ emitFinalText: true });
        typingCallbacks?.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks?.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onAssistantMessageStart: streamingEnabled
        ? () => {
            if (renderMode !== "card") {
              return;
            }
            queueThinkingPrelude();
          }
        : undefined,
      onReasoningStream: streamingEnabled
        ? (payload?: { text?: string; mediaUrls?: string[]; isReasoning?: boolean }) => {
            queueThinkingPrelude();
            streamPhase = "thinking";
            stagedStatusLine = resolveStatusLine();
            // Update reasoning text if provided
            if (payload?.text) {
              startStreaming();
              queueReasoningUpdate(payload.text);
            }
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            if (!streaming?.isActive()) {
              return;
            }
            queueStreamingRender();
          }
        : undefined,
      onReasoningEnd: streamingEnabled
        ? () => {
            if (streamPhase !== "thinking") {
              return;
            }
            streamPhase = streamText ? "streaming" : "idle";
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            queueStreamingRender();
          }
        : undefined,
      onToolStart: streamingEnabled
        ? (payload: { name?: string; phase?: string }) => {
            const isStartPhase = !payload?.phase || payload.phase === "start";
            if (isStartPhase) {
              toolUseCount += 1;
              lastToolName = normalizeToolName(payload?.name) ?? lastToolName;
              replaceNextPartialAfterTool = Boolean(streamText);
            }
            queueThinkingPrelude();
            streamPhase = "tool";
            stagedStatusLine = resolveStatusLine();
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            if (!streaming?.isActive()) {
              return;
            }
            queueStreamingRender();
          }
        : undefined,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            // Ensure streaming card is started when partial text arrives.
            // In embedded mode with block streaming, the card is started by the
            // deliver handler on the first block reply. CLI mode has no block
            // streaming — text arrives as complete chunks via onPartialReply —
            // so the card must be started here. startStreaming() is idempotent
            // (guarded by streamingStartPromise), so calling it here is safe
            // even when the card was already started by deliver.
            queueThinkingPrelude();
            startStreaming();
            queueStreamingUpdate(payload.text, { dedupeWithLastPartial: true });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
