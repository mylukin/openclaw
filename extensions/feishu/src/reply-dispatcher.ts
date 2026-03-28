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

let replyDispatcherDebugSeq = 0;

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
  sessionKey?: string;
  isGroup?: boolean;
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
    sessionKey,
    isGroup,
    identity,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const dispatcherDebugId = `fd-${++replyDispatcherDebugSeq}`;
  const logDispatcher = (message: string) => {
    params.runtime.log?.(`feishu[${account.accountId}] ${dispatcherDebugId} ${message}`);
  };
  logDispatcher(
    `create chat=${chatId} replyTo=${sendReplyToMessageId ?? "none"} root=${rootId ?? "none"} threadReply=${threadReplyMode ? "true" : "false"} replyInThread=${replyInThread === true ? "true" : "false"} effectiveReplyInThread=${effectiveReplyInThread === true ? "true" : "false"} streamingInThread=${streamingInThread === true ? "true" : "false"} sessionKey=${sessionKey ?? "none"}`,
  );

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
        metadata: {
          chatId,
          ...(sendReplyToMessageId ? { replyToId: sendReplyToMessageId } : {}),
          ...(mentionTargets?.length
            ? { mentions: mentionTargets.map((m) => ({ id: m.openId, name: m.name })) }
            : {}),
          ...(event.metadata ?? {}),
        },
      },
      {
        channelId: "feishu",
        accountId: accountId ?? account.accountId,
        conversationId: chatId,
        sessionKey,
        isGroup,
        groupId: isGroup ? chatId : undefined,
      },
    );
  };
  const runMessageSending = async (params: {
    content: string;
    mediaUrls?: string[];
  }): Promise<{ cancelled: boolean; content: string; metadata?: Record<string, unknown> }> => {
    const hookResult = await core.hooks.runMessageSending(
      {
        to: chatId,
        content: params.content,
        metadata: {
          channel: "feishu",
          accountId: accountId ?? account.accountId,
          ...(params.mediaUrls?.length ? { mediaUrls: params.mediaUrls } : {}),
          ...(sendReplyToMessageId ? { replyToId: sendReplyToMessageId } : {}),
          ...(effectiveReplyInThread && (rootId ?? sendReplyToMessageId)
            ? { threadId: rootId ?? sendReplyToMessageId }
            : {}),
        },
      },
      {
        channelId: "feishu",
        accountId: accountId ?? account.accountId,
        conversationId: chatId,
      },
    );
    if (hookResult?.cancel) {
      return { cancelled: true, content: params.content };
    }
    return {
      cancelled: false,
      content: typeof hookResult?.content === "string" ? hookResult.content : params.content,
      metadata:
        hookResult?.metadata && typeof hookResult.metadata === "object"
          ? hookResult.metadata
          : undefined,
    };
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
  const showCardHeader = account.config?.cardHeader ?? true;
  const showCardNote = account.config?.cardNote ?? true;
  const renderMode = account.config?.renderMode ?? "auto";
  const hasMessageSendingHooks = core.hooks.hasMessageSendingHooks();
  // Keep assistant text streaming enabled by default, but suppress it for
  // reply-targeted turns when message_sending hooks are active. Those hooks may
  // rewrite the final visible content (for example appending an @mention to the
  // replied sender), and streaming the pre-rewrite body can leave an old card
  // alive while the rewritten final reply creates a second card.
  const suppressAssistantTextStreaming = hasMessageSendingHooks && Boolean(sendReplyToMessageId);
  const streamingEnabled =
    account.config?.streaming !== false &&
    renderMode !== "raw" &&
    (!threadReplyMode || streamingInThread === true);
  // Reasoning callbacks should fire even when streaming is disabled (e.g. thread
  // replies without streamingInThread) so reasoningText gets accumulated and can
  // be included in non-streaming card output.  Only skip for raw text mode.
  const reasoningEnabled = renderMode !== "raw";

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
  const activeTools: Array<{ toolCallId?: string; name: string }> = [];
  let toolCallCount = 0;
  let lastRenderedStreamContent = "";
  let hasThinkingPrelude = false;
  let thinkingCollapsed = false;
  let replyCycleInitialized = false;
  const deliveredFinalContentKeys = new Set<string>();

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

  const logStreamingDecision = (
    stage: string,
    details: {
      finalText?: string;
      thinkingText?: string;
      toolCalls?: number;
      emitFinalText?: boolean;
      action?: string;
      messageId?: string;
    },
  ) => {
    params.runtime.log?.(
      `feishu[${account.accountId}] streaming ${stage}: action=${details.action ?? "unknown"} finalTextChars=${details.finalText?.trim().length ?? 0} thinkingChars=${details.thinkingText?.trim().length ?? 0} toolCalls=${details.toolCalls ?? toolCallCount} emitFinalText=${details.emitFinalText === true ? "true" : "false"}${details.messageId ? ` messageId=${details.messageId}` : ""}`,
    );
  };

  const buildFinalDeliveryContentKey = (params: { text: string; useCard: boolean }): string => {
    const normalized = params.useCard ? normalizeMentionTagsForCard(params.text) : params.text;
    return normalized.trim();
  };

  const TOOL_DISPLAY_NAMES: Record<string, string> = {
    feishu_chat_history: "Chat History",
    feishu_chat_info: "Chat Info",
    feishu_chat_members: "Chat Members",
    feishu_member_chats: "Member Chats",
  };

  const normalizeToolName = (name: string | undefined): string | undefined => {
    const trimmed = name?.trim();
    if (!trimmed) {
      return undefined;
    }
    const stripped = trimmed.replace("mcp__openclaw__", "");
    return TOOL_DISPLAY_NAMES[stripped] ?? stripped.replace(/\s+/g, " ");
  };

  const resolveTrackedToolName = (name: string | undefined): string =>
    normalizeToolName(name) ?? "tool";

  const getActiveRunningToolName = (): string | undefined => {
    const current = activeTools[activeTools.length - 1];
    return current?.name?.trim() ? current.name.trim() : undefined;
  };

  const removeActiveTool = (toolCallId: string | undefined): void => {
    if (activeTools.length === 0) {
      return;
    }
    const normalizedId = toolCallId?.trim();
    if (normalizedId) {
      const index = activeTools.findIndex((entry) => entry.toolCallId === normalizedId);
      if (index >= 0) {
        activeTools.splice(index, 1);
        return;
      }
    }
    activeTools.pop();
  };

  const hasReasoningText = (): boolean => reasoningText.trim().length > 0;

  const resolveThinkingPanelTitle = (): string => {
    if (!hasReasoningText() && toolCallCount > 0) {
      return `🔧 Tool calls (${toolCallCount})`;
    }
    return "💭 Thinking";
  };

  /** Build the full thinking panel content from reasoning text and tool status. */
  const composeThinkingContent = (options?: {
    final?: boolean;
  }): { title: string; text: string } => {
    const sections: string[] = [];
    const toolOnlyPanel = !hasReasoningText() && toolCallCount > 0;
    if (reasoningText) {
      const withoutLabel = reasoningText.replace(/^Reasoning:\n/, "");
      const plain = withoutLabel.replace(/^_(.*)_$/gm, "$1");
      sections.push(plain);
    }
    if (toolCallCount > 0) {
      const currentRunningTool =
        !options?.final && streamPhase === "tool" ? getActiveRunningToolName() : undefined;
      const toolStatus = currentRunningTool
        ? `⏳ Running ${currentRunningTool}...`
        : !options?.final && streamPhase === "tool" && activeTools.length > 0
          ? "⏳ Running tool..."
          : "";
      if (toolOnlyPanel) {
        // Show a completed summary when no tool is actively running, instead
        // of a zero-width space that renders as a blank panel.
        sections.push(toolStatus || `✓ ${toolCallCount} completed`);
      } else {
        sections.push(
          [`🔧 Tool calls (${toolCallCount})`, ...(toolStatus ? ["", toolStatus] : [])].join("\n"),
        );
      }
    }
    return {
      title: resolveThinkingPanelTitle(),
      text: sections.join("\n\n"),
    };
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

  /** Queue an update to the main content element only. */
  const queueStreamingRender = () => {
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (!streaming?.isActive()) {
        return;
      }
      const safeRendered = stripIncompleteAtTag(streamText);
      const renderedForCard = normalizeMentionTagsForCard(safeRendered);
      if (!renderedForCard || renderedForCard === lastRenderedStreamContent) {
        return;
      }
      lastRenderedStreamContent = renderedForCard;
      await streaming.update(renderedForCard, { replace: true });
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
    hasThinkingPrelude = true;
    return true;
  };

  /** Queue an update to the thinking panel content. */
  const queueThinkingPanelUpdate = () => {
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        const panel = composeThinkingContent();
        await streaming.updateThinking(panel.text, { title: panel.title });
      }
    });
  };

  /** Mark that assistant text has started flowing — thinking panel will be
   *  collapsed on close() rather than mid-stream to avoid Feishu full-card
   *  update flickering during streaming. */
  const markThinkingDone = () => {
    thinkingCollapsed = true;
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
    if (shouldResetAfterTool) {
      // Post-tool text doesn't continue from existing stream — replace entirely
      streamText = nextText;
      replaceNextPartialAfterTool = false;
    } else {
      streamText = mergeStreamingText(streamText, nextText);
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    if (activeTools.length > 0) {
      streamPhase = "streaming";
      queueThinkingPanelUpdate();
    }
    // Collapse thinking panel when first assistant text arrives
    markThinkingDone();
    queueStreamingRender();
  };

  const queueReasoningUpdate = (nextThinking: string) => {
    if (!nextThinking) return;
    reasoningText = nextThinking;
    queueThinkingPanelUpdate();
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    logDispatcher(
      `startStreaming requested replyTo=${replyToMessageId ?? "none"} effectiveReplyInThread=${effectiveReplyInThread ? "true" : "false"} root=${rootId ?? "none"}`,
    );
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
        const cardHeader = showCardHeader ? resolveCardHeader(agentId, identity) : undefined;
        const cardNote = showCardNote
          ? resolveCardNote(agentId, identity, prefixContext.prefixContext)
          : undefined;
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: cardNote,
        });
        logDispatcher(`startStreaming active messageId=${streaming.getMessageId() ?? "unknown"}`);
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
        streamingStartPromise = null; // allow retry on next deliver
      }
    })();
  };

  const closeStreaming = async (options?: {
    emitFinalText?: boolean;
    reason?: "idle" | "error";
  }) => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    const streamMessageId = streaming?.getMessageId();
    if (streaming?.isActive()) {
      const finalText = streamText;
      const finalThinking = composeThinkingContent({ final: true });
      const hasFinalText = finalText.trim().length > 0;
      const hasFinalThinking = finalThinking.text.trim().length > 0;
      const closeReason = options?.reason ?? "idle";
      if (!hasFinalText) {
        if (hasFinalThinking && closeReason === "idle") {
          logStreamingDecision("close", {
            action: "preserve-thinking-only-card",
            finalText,
            thinkingText: finalThinking.text,
            emitFinalText: options?.emitFinalText,
            messageId: streamMessageId,
          });
          await streaming.updateThinking(finalThinking.text, { title: finalThinking.title });
          const finalNote = showCardNote
            ? resolveCardNote(agentId, identity, prefixContext.prefixContext)
            : undefined;
          await streaming.close("", {
            ...(finalNote !== undefined ? { note: finalNote } : {}),
          });
        } else {
          // No final user-visible text and no reasoning/tool content left to preserve.
          logStreamingDecision("close", {
            action:
              hasFinalThinking && closeReason === "error"
                ? "discard-error-thinking-only-card"
                : "discard-empty-card",
            finalText,
            thinkingText: finalThinking.text,
            emitFinalText: options?.emitFinalText,
            messageId: streamMessageId,
          });
          await streaming.discard(
            hasFinalThinking && closeReason === "error"
              ? "error-without-final-text"
              : "empty-final-and-empty-thinking",
          );
        }
      } else {
        logStreamingDecision("close", {
          action: "close-final-card",
          finalText,
          thinkingText: finalThinking.text,
          emitFinalText: options?.emitFinalText,
          messageId: streamMessageId,
        });
        logDispatcher(
          `closeStreaming final path streamMessageId=${streamMessageId ?? "unknown"} finalChars=${finalText.trim().length} thinkingChars=${finalThinking.text.trim().length}`,
        );
        // Store thinking content for the collapsed panel in the final card
        if (finalThinking.text) {
          await streaming.updateThinking(finalThinking.text, { title: finalThinking.title });
        }
        let text = finalText;
        if (mentionTargets?.length) {
          text = buildMentionedCardContent(mentionTargets, text);
        }
        const finalNote = showCardNote
          ? resolveCardNote(agentId, identity, prefixContext.prefixContext)
          : undefined;
        await streaming.close(text, {
          ...(finalNote !== undefined ? { note: finalNote } : {}),
        });
        hasVisibleTextInReply = true;
        deliveredFinalTexts.add(finalText);
        const deliveredKey = buildFinalDeliveryContentKey({
          text: finalText,
          useCard: true,
        });
        if (deliveredKey) {
          deliveredFinalContentKeys.add(deliveredKey);
        }
        if (options?.emitFinalText && finalText.trim()) {
          emitMessageSent({ content: finalText, success: true, messageId: streamMessageId });
          await emitFinalTextIfNeeded(
            finalText,
            streamMessageId ? { messageId: streamMessageId } : undefined,
          );
        }
      }
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
    reasoningText = "";
    thinkingCollapsed = false;
    activeTools.length = 0;
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
    return { lastMessageId, deliveredMessageIds };
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: async () => {
        if (!replyCycleInitialized) {
          replyCycleInitialized = true;
          deliveredFinalTexts.clear();
          deliveredFinalContentKeys.clear();
          hasVisibleTextInReply = false;
          finalTextEmitted = false;
          hasThinkingPrelude = false;
          thinkingCollapsed = false;
          streamPhase = "idle";
          activeTools.length = 0;
          toolCallCount = 0;
          lastRenderedStreamContent = "";
          replaceNextPartialAfterTool = false;
        }
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        await typingCallbacks?.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const originalReply = resolveSendableOutboundReplyParts(payload);
        const shouldRunSendingHook =
          originalReply.hasMedia || !streaming?.isActive() || info?.kind === "final";
        let text = originalReply.text;
        let hookMetadata: Record<string, unknown> | undefined;
        if (shouldRunSendingHook) {
          const hookResult = await runMessageSending({
            content: text,
            mediaUrls: originalReply.mediaUrls,
          });
          if (hookResult.cancelled) {
            if (info?.kind === "final" && (streaming?.isActive() || streamingStartPromise)) {
              streamText = "";
              await closeStreaming({ emitFinalText: false, reason: "error" });
            }
            return;
          }
          text = hookResult.content;
          hookMetadata =
            hookResult.metadata && typeof hookResult.metadata === "object"
              ? hookResult.metadata
              : undefined;
        }
        const hasText = text.trim().length > 0;
        const hasMedia = originalReply.hasMedia;
        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
        const finalDeliveryKey =
          info?.kind === "final" && hasText ? buildFinalDeliveryContentKey({ text, useCard }) : "";
        const skipTextForDuplicateFinal =
          info?.kind === "final" &&
          hasText &&
          (deliveredFinalTexts.has(text) ||
            (finalDeliveryKey.length > 0 && deliveredFinalContentKeys.has(finalDeliveryKey)));
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (info?.kind === "final" && hasText) {
          params.runtime.log?.(
            `feishu[${account.accountId}] final deliver candidate: chars=${text.trim().length} useCard=${useCard ? "true" : "false"} key=${finalDeliveryKey.slice(0, 120)} skipDuplicate=${skipTextForDuplicateFinal ? "true" : "false"}`,
          );
          logDispatcher(
            `deliver final hasText=true useCard=${useCard ? "true" : "false"} skipDuplicate=${skipTextForDuplicateFinal ? "true" : "false"} streamingActive=${streaming?.isActive() ? "true" : "false"} streamMessageId=${streaming?.getMessageId() ?? "none"} hookTextChanged=${text !== originalReply.text ? "true" : "false"} originalChars=${originalReply.text.trim().length} finalChars=${text.trim().length}`,
          );
        }

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        if (shouldDeliverText) {
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
              if (!suppressAssistantTextStreaming) {
                // Some runtimes emit block payloads without onPartial/final callbacks.
                // Mirror block text into streamText so onIdle close still sends content.
                // hasVisibleTextInReply is set by queueStreamingRender on successful update.
                queueThinkingPrelude();
                queueStreamingUpdate(text);
              }
            }
            if (info?.kind === "final") {
              logDispatcher(
                `deliver final -> streaming close streamMessageId=${streaming.getMessageId() ?? "unknown"} finalChars=${text.trim().length}`,
              );
              streamText = text;
              await closeStreaming({ emitFinalText: true, reason: "idle" });
              // Mark visible only after closeStreaming succeeds — text is now delivered.
              hasVisibleTextInReply = true;
              deliveredFinalTexts.add(text);
              if (finalDeliveryKey) {
                deliveredFinalContentKeys.add(finalDeliveryKey);
              }
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              await deliverMediaAndEmitIfNeeded(originalReply.mediaUrls, text, info, hasText);
            }
            return;
          }

          const finalThinking =
            useCard && info?.kind === "final" ? composeThinkingContent({ final: true }) : undefined;
          const cardText = text;

          let chunkResult: { lastMessageId?: string; deliveredMessageIds: string[] };
          if (useCard) {
            if (info?.kind === "final") {
              logDispatcher(
                `deliver final -> sendStructuredCardFeishu non-streaming finalChars=${cardText.trim().length} replyTo=${sendReplyToMessageId ?? "none"} effectiveReplyInThread=${effectiveReplyInThread ? "true" : "false"}`,
              );
            }
            const cardHeader = showCardHeader ? resolveCardHeader(agentId, identity) : undefined;
            const cardNote = showCardNote
              ? resolveCardNote(agentId, identity, prefixContext.prefixContext)
              : undefined;
            chunkResult = await sendChunkedTextReply({
              text: cardText,
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
                  ...(isFirst && finalThinking?.text
                    ? {
                        thinkingTitle: finalThinking.title,
                        thinkingText: finalThinking.text,
                        thinkingExpanded: false,
                      }
                    : {}),
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
            const deliveredContent = useCard ? normalizeMentionTagsForCard(cardText) : text;
            const deliveredKey = buildFinalDeliveryContentKey({
              text: deliveredContent,
              useCard,
            });
            deliveredFinalTexts.add(text);
            if (deliveredKey) {
              deliveredFinalContentKeys.add(deliveredKey);
            }
            emitMessageSent({
              content: deliveredContent,
              success: true,
              messageId: chunkResult.lastMessageId,
              metadata: {
                finalContent: deliveredContent,
                contentType: useCard ? "interactive" : "post",
                ...(hookMetadata ?? {}),
              },
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
          await deliverMediaAndEmitIfNeeded(originalReply.mediaUrls, text, info, hasText);
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming({ emitFinalText: false, reason: "error" });
        replyCycleInitialized = false;
        typingCallbacks?.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming({ emitFinalText: true, reason: "idle" });
        replyCycleInitialized = false;
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
            queueThinkingPrelude();
            startStreaming();
          }
        : undefined,
      onReasoningStream: reasoningEnabled
        ? (payload?: { text?: string; mediaUrls?: string[]; isReasoning?: boolean }) => {
            queueThinkingPrelude();
            streamPhase = "thinking";
            if (payload?.text) {
              reasoningText = payload.text;
              if (streamingEnabled) {
                startStreaming();
                queueReasoningUpdate(payload.text);
              }
            }
          }
        : undefined,
      onReasoningEnd: reasoningEnabled
        ? () => {
            if (streamPhase !== "thinking") {
              return;
            }
            streamPhase = streamText ? "streaming" : "idle";
          }
        : undefined,
      onToolStart: streamingEnabled
        ? (payload: { name?: string; phase?: string; toolCallId?: string }) => {
            const isStartPhase = !payload?.phase || payload.phase === "start";
            if (isStartPhase) {
              const trackedName = resolveTrackedToolName(payload?.name);
              activeTools.push({
                name: trackedName,
                toolCallId: payload.toolCallId?.trim() || undefined,
              });
              toolCallCount += 1;
              replaceNextPartialAfterTool = Boolean(streamText);
            }
            queueThinkingPrelude();
            streamPhase = "tool";
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            startStreaming();
            queueThinkingPanelUpdate();
          }
        : undefined,
      onToolResult: streamingEnabled
        ? (payload: ReplyPayload) => {
            removeActiveTool(payload.toolCallId);
            if (activeTools.length === 0 && streamPhase === "tool") {
              streamPhase = streamText ? "streaming" : "idle";
            }
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            queueThinkingPanelUpdate();
          }
        : undefined,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            if (suppressAssistantTextStreaming) {
              params.runtime.log?.(
                `feishu[${account.accountId}] streaming partial suppressed by message_sending hooks: textChars=${payload.text.trim().length}`,
              );
              return;
            }
            queueThinkingPrelude();
            startStreaming();
            queueStreamingUpdate(payload.text, { dedupeWithLastPartial: true });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
