import type { Client } from "@larksuiteoapi/node-sdk";
import type { OpenClawConfig } from "../config/config.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { isSenderAllowed, normalizeAllowFromWithStore, resolveSenderAllowMatch } from "./access.js";
import {
  resolveFeishuConfig,
  resolveFeishuGroupConfig,
  resolveFeishuGroupEnabled,
  type ResolvedFeishuConfig,
} from "./config.js";
import { resolveFeishuMedia, type FeishuMediaRef } from "./download.js";
import { readFeishuAllowFromStore, upsertFeishuPairingRequest } from "./pairing-store.js";
import { sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";

const logger = getChildLogger({ module: "feishu-message" });

type FeishuSender = {
  sender_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
};

type FeishuMention = {
  key?: string;
  id?:
    | {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      }
    | string;
  id_type?: string;
  name?: string;
};

const MENTION_ALL_ID = "all";

function normalizeMentionId(value?: string): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase();
}

function parseMessageContent(rawContent: string | undefined): unknown {
  if (!rawContent) {
    return undefined;
  }
  try {
    return JSON.parse(rawContent);
  } catch {
    return undefined;
  }
}

function isMentionAllId(mention: FeishuMention): boolean {
  if (!mention) {
    return false;
  }
  if (typeof mention.id === "string") {
    return normalizeMentionId(mention.id) === MENTION_ALL_ID;
  }
  if (mention.id) {
    const openId = normalizeMentionId(mention.id.open_id);
    const userId = normalizeMentionId(mention.id.user_id);
    return openId === MENTION_ALL_ID || userId === MENTION_ALL_ID;
  }
  return false;
}

function hasMentionAllTag(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    text.includes('<at user_id="all">') ||
    text.includes("<at user_id='all'>") ||
    text.includes("<at id=all>") ||
    text.includes('<at id="all">')
  );
}

function hasMentionAllNode(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasMentionAllNode(entry));
  }

  const record = value as Record<string, unknown>;
  const tag = typeof record.tag === "string" ? record.tag : undefined;
  if (tag === "at") {
    const userId = normalizeMentionId(record.user_id as string | undefined);
    const id = normalizeMentionId(record.id as string | undefined);
    if (userId === MENTION_ALL_ID || id === MENTION_ALL_ID) {
      return true;
    }
  }

  for (const entry of Object.values(record)) {
    if (hasMentionAllNode(entry)) {
      return true;
    }
  }

  return false;
}

function extractContentText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  return undefined;
}

function isMentionAll(mentions: FeishuMention[], parsedContent: unknown): boolean {
  if (mentions.some((mention) => isMentionAllId(mention))) {
    return true;
  }

  const text = extractContentText(parsedContent);
  if (text && hasMentionAllTag(text)) {
    return true;
  }

  return hasMentionAllNode(parsedContent);
}

function isBotMentioned(mention: FeishuMention, botOpenId: string): boolean {
  if (!mention || !botOpenId) {
    return false;
  }
  if (typeof mention.id === "string") {
    return mention.id === botOpenId;
  }
  return mention.id?.open_id === botOpenId;
}

type FeishuMessage = {
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
  create_time?: string | number;
  message_id?: string;
};

type FeishuEventPayload = {
  message?: FeishuMessage;
  event?: {
    message?: FeishuMessage;
    sender?: FeishuSender;
  };
  sender?: FeishuSender;
  mentions?: FeishuMention[];
};

// Supported message types for processing
const SUPPORTED_MSG_TYPES = new Set(["text", "image", "file", "audio", "media", "sticker"]);

export type ProcessFeishuMessageOptions = {
  cfg?: OpenClawConfig;
  accountId?: string;
  resolvedConfig?: ResolvedFeishuConfig;
  /** Feishu app credentials for streaming card API */
  credentials?: { appId: string; appSecret: string; domain?: string };
  /** Bot name for streaming card title (optional, defaults to no title) */
  botName?: string;
  /** Bot open_id for mention filtering (cached at startup) */
  botOpenId?: string;
};

export async function processFeishuMessage(
  client: Client,
  data: unknown,
  appId: string,
  options: ProcessFeishuMessageOptions = {},
) {
  const cfg = options.cfg ?? loadConfig();
  const accountId = options.accountId ?? appId;
  const feishuCfg = options.resolvedConfig ?? resolveFeishuConfig({ cfg, accountId });

  const payload = data as FeishuEventPayload;

  // SDK 2.0 schema: data directly contains message, sender, etc.
  const message = payload.message ?? payload.event?.message;
  const sender = payload.sender ?? payload.event?.sender;

  if (!message) {
    logger.warn(`Received event without message field`);
    return;
  }

  const chatId = message.chat_id;
  if (!chatId) {
    logger.warn("Received message without chat_id");
    return;
  }
  const isGroup = message.chat_type === "group";
  const msgType = message.message_type;
  const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || "unknown";
  const senderUnionId = sender?.sender_id?.union_id;
  const maxMediaBytes = feishuCfg.mediaMaxMb * 1024 * 1024;

  // Check if this is a supported message type
  if (!msgType || !SUPPORTED_MSG_TYPES.has(msgType)) {
    logger.debug(`Skipping unsupported message type: ${msgType ?? "unknown"}`);
    return;
  }

  // Load allowlist from store
  const storeAllowFrom = await readFeishuAllowFromStore().catch(() => []);
  const effectiveDmAllow = normalizeAllowFromWithStore({
    allowFrom: feishuCfg.allowFrom,
    storeAllowFrom,
  });
  let effectiveGroupAllow = effectiveDmAllow;
  let groupConfig: ReturnType<typeof resolveFeishuGroupConfig>["groupConfig"] | undefined;

  // ===== Access Control =====

  // Group access control
  if (isGroup) {
    // Check if group is enabled
    if (!resolveFeishuGroupEnabled({ cfg, accountId, chatId })) {
      logVerbose(`Blocked feishu group ${chatId} (group disabled)`);
      return;
    }

    const resolved = resolveFeishuGroupConfig({ cfg, accountId, chatId });
    groupConfig = resolved.groupConfig;
    const groupAllowOverride = groupConfig?.allowFrom;
    effectiveGroupAllow = normalizeAllowFromWithStore({
      allowFrom:
        groupAllowOverride ??
        (feishuCfg.groupAllowFrom.length > 0 ? feishuCfg.groupAllowFrom : feishuCfg.allowFrom),
      storeAllowFrom,
    });

    // Check group-level allowFrom override
    if (groupAllowOverride) {
      if (!isSenderAllowed({ allow: effectiveGroupAllow, senderId })) {
        logVerbose(`Blocked feishu group sender ${senderId} (group allowFrom override)`);
        return;
      }
    }

    // Apply groupPolicy
    const groupPolicy = feishuCfg.groupPolicy;
    if (groupPolicy === "disabled") {
      logVerbose(`Blocked feishu group message (groupPolicy: disabled)`);
      return;
    }

    if (groupPolicy === "allowlist") {
      if (!effectiveGroupAllow.hasEntries) {
        logVerbose(`Blocked feishu group message (groupPolicy: allowlist, no entries)`);
        return;
      }
      if (!isSenderAllowed({ allow: effectiveGroupAllow, senderId })) {
        logVerbose(`Blocked feishu group sender ${senderId} (groupPolicy: allowlist)`);
        return;
      }
    }
  }

  // DM access control
  if (!isGroup) {
    const dmPolicy = feishuCfg.dmPolicy;

    if (dmPolicy === "disabled") {
      logVerbose(`Blocked feishu DM (dmPolicy: disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowMatch = resolveSenderAllowMatch({ allow: effectiveDmAllow, senderId });
      const allowed =
        effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);

      if (!allowed) {
        if (dmPolicy === "pairing") {
          // Generate pairing code for unknown sender
          try {
            const { code, created } = await upsertFeishuPairingRequest({
              openId: senderId,
              unionId: senderUnionId,
              name: sender?.sender_id?.user_id,
            });
            if (created) {
              logger.info({ openId: senderId, unionId: senderUnionId }, "feishu pairing request");
              await sendMessageFeishu(
                client,
                senderId,
                {
                  text: [
                    "OpenClaw access not configured.",
                    "",
                    `Your Feishu Open ID: ${senderId}`,
                    "",
                    `Pairing code: ${code}`,
                    "",
                    "Ask the OpenClaw admin to approve with:",
                    `openclaw pairing approve feishu ${code}`,
                  ].join("\n"),
                },
                { receiveIdType: "open_id" },
              );
            }
          } catch (err) {
            logger.error(`Failed to create pairing request: ${formatErrorMessage(err)}`);
          }
          return;
        }

        // allowlist policy: silently block
        logVerbose(`Blocked feishu DM from ${senderId} (dmPolicy: allowlist)`);
        return;
      }
    }
  }

  // Handle @mentions for group chats
  const mentions = message.mentions ?? payload.mentions ?? [];
  const botOpenId = options.botOpenId?.trim();
  const parsedContent = parseMessageContent(message.content);
  const mentionsAll = isMentionAll(mentions, parsedContent);

  // Check if this bot was specifically mentioned (by open_id match)
  const wasMentioned = botOpenId
    ? mentions.some((mention) => isBotMentioned(mention, botOpenId))
    : mentions.length > 0;
  const allowGroupMention = wasMentioned || mentionsAll;

  // Log warning if mentions exist but botOpenId is missing (cannot filter accurately)
  if (mentions.length > 0 && !botOpenId) {
    logger.warn(
      "Feishu mentions detected but botOpenId not available - cannot verify bot-specific mention",
    );
  }

  // In group chat, check requireMention setting
  if (isGroup) {
    const requireMention = groupConfig?.requireMention ?? true;
    if (requireMention && !allowGroupMention) {
      logger.debug(`Ignoring group message without @mention (requireMention: true)`);
      return;
    }
  }

  // Extract text content (for text messages or captions)
  let text = "";
  if (msgType === "text") {
    const contentText = extractContentText(parsedContent);
    if (contentText) {
      text = contentText;
    } else if (message.content) {
      try {
        const content = JSON.parse(message.content);
        text = content.text || "";
      } catch (err) {
        logger.error(`Failed to parse text message content: ${formatErrorMessage(err)}`);
      }
    }
  }

  // Remove @mention placeholders from text
  for (const mention of mentions) {
    if (mention.key) {
      text = text.replace(mention.key, "").trim();
    }
  }

  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const senderAllowedForCommands = isSenderAllowed({ allow: allowForCommands, senderId });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommandInMessage = hasControlCommand(text, cfg);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: allowForCommands.hasEntries || allowForCommands.hasWildcard,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  // Resolve media if present
  let media: FeishuMediaRef | null = null;
  if (msgType !== "text") {
    try {
      media = await resolveFeishuMedia(client, message, maxMediaBytes);
    } catch (err) {
      logger.error(`Failed to download media: ${formatErrorMessage(err)}`);
    }
  }

  // Build body text
  let bodyText = text;
  if (!bodyText && media) {
    bodyText = media.placeholder;
  }

  // Skip if no content
  if (!bodyText && !media) {
    logger.debug(`Empty message after processing, skipping`);
    return;
  }

  const senderName = sender?.sender_id?.user_id || "unknown";

  // Streaming mode support
  const streamingEnabled = (feishuCfg.streaming ?? true) && Boolean(options.credentials);
  const streamingSession =
    streamingEnabled && options.credentials
      ? new FeishuStreamingSession(client, options.credentials)
      : null;
  let streamingStarted = false;
  let lastPartialText = "";

  const route = resolveAgentRoute({
    cfg,
    channel: "feishu",
    accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? chatId : senderId,
    },
  });

  // Context construction
  const ctx = {
    Body: bodyText,
    RawBody: text || media?.placeholder || "",
    From: senderId,
    To: chatId,
    SessionKey: route.sessionKey,
    SenderId: senderId,
    SenderName: senderName,
    ChatType: isGroup ? "group" : "dm",
    Provider: "feishu",
    Surface: "feishu",
    Timestamp: Number(message.create_time),
    MessageSid: message.message_id,
    AccountId: route.accountId,
    OriginatingChannel: "feishu",
    OriginatingTo: chatId,
    // Media fields (similar to Telegram)
    MediaPath: media?.path,
    MediaType: media?.contentType,
    MediaUrl: media?.path,
    WasMentioned: isGroup ? wasMentioned : undefined,
    CommandAuthorized: commandAuthorized,
  };

  await dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        const hasMedia = payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0);
        if (!payload.text && !hasMedia) {
          return;
        }

        // Handle block replies - update streaming card with partial text
        if (streamingSession?.isActive() && info?.kind === "block" && payload.text) {
          logger.debug(`Updating streaming card with block text: ${payload.text.length} chars`);
          await streamingSession.update(payload.text);
          return;
        }

        // If streaming was active, close it with the final text
        if (streamingSession?.isActive() && info?.kind === "final") {
          await streamingSession.close(payload.text);
          streamingStarted = false;
          return; // Card already contains the final text
        }

        // Handle media URLs
        const mediaUrls = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];

        if (mediaUrls.length > 0) {
          // Close streaming session before sending media
          if (streamingSession?.isActive()) {
            await streamingSession.close();
            streamingStarted = false;
          }
          // Send each media item
          for (let i = 0; i < mediaUrls.length; i++) {
            const mediaUrl = mediaUrls[i];
            const caption = i === 0 ? payload.text || "" : "";
            await sendMessageFeishu(
              client,
              chatId,
              { text: caption },
              {
                mediaUrl,
                receiveIdType: "chat_id",
              },
            );
          }
        } else if (payload.text) {
          // If streaming wasn't used, send as regular message
          if (!streamingSession?.isActive()) {
            await sendMessageFeishu(
              client,
              chatId,
              { text: payload.text },
              {
                msgType: "text",
                receiveIdType: "chat_id",
              },
            );
          }
        }
      },
      onError: (err) => {
        logger.error(`Reply error: ${formatErrorMessage(err)}`);
        // Clean up streaming session on error
        if (streamingSession?.isActive()) {
          streamingSession.close().catch(() => {});
        }
      },
      onReplyStart: async () => {
        // Start streaming card when reply generation begins
        if (streamingSession && !streamingStarted) {
          try {
            await streamingSession.start(chatId, "chat_id", options.botName);
            streamingStarted = true;
            logger.debug(`Started streaming card for chat ${chatId}`);
          } catch (err) {
            logger.warn(`Failed to start streaming card: ${formatErrorMessage(err)}`);
            // Continue without streaming
          }
        }
      },
    },
    replyOptions: {
      disableBlockStreaming: !feishuCfg.blockStreaming,
      onPartialReply: streamingSession
        ? async (payload) => {
            if (!streamingSession.isActive() || !payload.text) {
              return;
            }
            if (payload.text === lastPartialText) {
              return;
            }
            lastPartialText = payload.text;
            await streamingSession.update(payload.text);
          }
        : undefined,
      onReasoningStream: streamingSession
        ? async (payload) => {
            // Also update on reasoning stream for extended thinking models
            if (!streamingSession.isActive() || !payload.text) {
              return;
            }
            if (payload.text === lastPartialText) {
              return;
            }
            lastPartialText = payload.text;
            await streamingSession.update(payload.text);
          }
        : undefined,
    },
  });

  // Ensure streaming session is closed on completion
  if (streamingSession?.isActive()) {
    await streamingSession.close();
  }
}
