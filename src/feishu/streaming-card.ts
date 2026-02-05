/**
 * Feishu Streaming Card Support
 *
 * Implements typing indicator and streaming text output for Feishu using
 * the Card Kit streaming API.
 *
 * Flow:
 * 1. Create a card entity with streaming_mode: true
 * 2. Send the card as a message (shows "[Generating...]" in chat preview)
 * 3. Stream text updates to the card using the cardkit API
 * 4. Close streaming mode when done
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { getChildLogger } from "../logging.js";
import { resolveFeishuApiBase, resolveFeishuDomain } from "./domain.js";

const logger = getChildLogger({ module: "feishu-streaming" });

const STREAM_UPDATE_INTERVAL_MS = 500;

const MENTION_ALL_TEXT_REGEX = /@_?all\b/gi;
const MENTION_EVERYONE_TEXT_REGEX = /@everyone\b/gi;
const MENTION_ALL_CN_TEXT_REGEX = /@所有人/g;
const MENTION_ALL_TAG_REGEX = /<at\s+user_id=("|')all\1>[^<]*<\/at>/gi;
const MENTION_ALL_CARD_TAG_REGEX = /<at\s+id=("|')?all\1?\s*>\s*<\/at>/gi;
const MENTION_ALL_DISPLAY = "@所有人";

function normalizeStreamingCardText(text: string): string {
  if (!text) {
    return text;
  }
  let updated = text;
  updated = updated.replace(MENTION_ALL_TAG_REGEX, MENTION_ALL_DISPLAY);
  updated = updated.replace(MENTION_ALL_CARD_TAG_REGEX, MENTION_ALL_DISPLAY);
  updated = updated.replace(MENTION_ALL_TEXT_REGEX, MENTION_ALL_DISPLAY);
  updated = updated.replace(MENTION_EVERYONE_TEXT_REGEX, MENTION_ALL_DISPLAY);
  updated = updated.replace(MENTION_ALL_CN_TEXT_REGEX, MENTION_ALL_DISPLAY);
  return updated;
}

export type FeishuStreamingCredentials = {
  appId: string;
  appSecret: string;
  domain?: string;
};

export type FeishuStreamingCardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  elementId: string;
  currentText: string;
};

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

const getTokenCacheKey = (credentials: FeishuStreamingCredentials) =>
  `${resolveFeishuDomain(credentials.domain)}|${credentials.appId}`;

/**
 * Get tenant access token (with caching)
 */
async function getTenantAccessToken(credentials: FeishuStreamingCredentials): Promise<string> {
  const cacheKey = getTokenCacheKey(credentials);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const apiBase = resolveFeishuApiBase(credentials.domain);
  const response = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    }),
  });

  const result = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (result.code !== 0 || !result.tenant_access_token) {
    throw new Error(`Failed to get tenant access token: ${result.msg}`);
  }

  // Cache token (expire 2 hours, we refresh 1 minute early)
  tokenCache.set(cacheKey, {
    token: result.tenant_access_token,
    expiresAt: Date.now() + (result.expire ?? 7200) * 1000,
  });

  return result.tenant_access_token;
}

/**
 * Create a streaming card entity
 */
export async function createStreamingCard(
  credentials: FeishuStreamingCredentials,
  title?: string,
): Promise<{ cardId: string }> {
  const cardJson = {
    schema: "2.0",
    ...(title
      ? {
          header: {
            title: {
              content: title,
              tag: "plain_text",
            },
          },
        }
      : {}),
    config: {
      streaming_mode: true,
      summary: {
        content: "[Generating...]",
      },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 2 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "⏳ Thinking...",
          element_id: "streaming_content",
        },
      ],
    },
  };

  const apiBase = resolveFeishuApiBase(credentials.domain);
  const response = await fetch(`${apiBase}/cardkit/v1/cards`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getTenantAccessToken(credentials)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "card_json",
      data: JSON.stringify(cardJson),
    }),
  });

  const result = (await response.json()) as {
    code: number;
    msg: string;
    data?: { card_id: string };
  };

  if (result.code !== 0 || !result.data?.card_id) {
    throw new Error(`Failed to create streaming card: ${result.msg}`);
  }

  logger.debug(`Created streaming card: ${result.data.card_id}`);
  return { cardId: result.data.card_id };
}

export type SendStreamingCardOpts = {
  receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  replyToId?: string | null;
  isGroup?: boolean;
  threadId?: string | null;
};

export async function sendStreamingCard(
  client: Client,
  receiveId: string,
  cardId: string,
  opts: SendStreamingCardOpts = {},
): Promise<{ messageId: string }> {
  const receiveIdType = opts.receiveIdType ?? "chat_id";
  const content = JSON.stringify({
    type: "card",
    data: { card_id: cardId },
  });

  const shouldReply =
    opts.isGroup === true && typeof opts.replyToId === "string" && opts.replyToId.trim().length > 0;
  const replyMessageId = shouldReply ? opts.replyToId!.trim() : undefined;
  const replyInThread = Boolean(opts.threadId);

  let res;
  if (replyMessageId) {
    res = await client.im.message.reply({
      path: { message_id: replyMessageId },
      data: {
        content,
        msg_type: "interactive",
        reply_in_thread: replyInThread,
      },
    });
  } else {
    res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "interactive",
        content,
      },
    });
  }

  if (res.code !== 0 || !res.data?.message_id) {
    throw new Error(`Failed to send streaming card: ${res.msg}`);
  }

  logger.debug(`Sent streaming card message: ${res.data.message_id}`);
  return { messageId: res.data.message_id };
}

/**
 * Update streaming card text content
 */
export async function updateStreamingCardText(
  credentials: FeishuStreamingCredentials,
  cardId: string,
  elementId: string,
  text: string,
  sequence: number,
): Promise<void> {
  const normalizedText = normalizeStreamingCardText(text);
  const apiBase = resolveFeishuApiBase(credentials.domain);
  const response = await fetch(
    `${apiBase}/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await getTenantAccessToken(credentials)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: normalizedText,
        sequence,
        uuid: `stream_${cardId}_${sequence}`,
      }),
    },
  );

  const result = (await response.json()) as { code: number; msg: string };

  if (result.code !== 0) {
    logger.warn(`Failed to update streaming card text: ${result.msg}`);
    // Don't throw - streaming updates can fail occasionally
  }
}

/**
 * Close streaming mode on a card
 */
export async function closeStreamingMode(
  credentials: FeishuStreamingCredentials,
  cardId: string,
  sequence: number,
  finalSummary?: string,
): Promise<void> {
  const normalizedSummary = normalizeStreamingCardText(finalSummary || "");
  // Build config object - summary must be set to clear "[Generating...]"
  const configObj: Record<string, unknown> = {
    streaming_mode: false,
    summary: { content: normalizedSummary },
  };

  const settings = { config: configObj };

  const apiBase = resolveFeishuApiBase(credentials.domain);
  const response = await fetch(`${apiBase}/cardkit/v1/cards/${cardId}/settings`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${await getTenantAccessToken(credentials)}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      settings: JSON.stringify(settings),
      sequence,
      uuid: `close_${cardId}_${sequence}`,
    }),
  });

  // Check response
  const result = (await response.json()) as { code: number; msg: string };

  if (result.code !== 0) {
    logger.warn(`Failed to close streaming mode: ${result.msg}`);
  } else {
    logger.debug(`Closed streaming mode for card: ${cardId}`);
  }
}

/**
 * High-level streaming card manager
 */
export class FeishuStreamingSession {
  private client: Client;
  private credentials: FeishuStreamingCredentials;
  private state: FeishuStreamingCardState | null = null;
  private updateQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private lastUpdateAt = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingText: string | null = null;

  constructor(client: Client, credentials: FeishuStreamingCredentials) {
    this.client = client;
    this.credentials = credentials;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    title?: string,
    opts?: { replyToId?: string | null; isGroup?: boolean; threadId?: string | null },
  ): Promise<void> {
    if (this.state) {
      logger.warn("Streaming session already started");
      return;
    }

    try {
      const { cardId } = await createStreamingCard(this.credentials, title);
      const { messageId } = await sendStreamingCard(this.client, receiveId, cardId, {
        receiveIdType,
        replyToId: opts?.replyToId,
        isGroup: opts?.isGroup,
        threadId: opts?.threadId,
      });

      this.state = {
        cardId,
        messageId,
        sequence: 1,
        elementId: "streaming_content",
        currentText: "",
      };

      logger.info(`Started streaming session: cardId=${cardId}, messageId=${messageId}`);
    } catch (err) {
      logger.error(`Failed to start streaming session: ${String(err)}`);
      throw err;
    }
  }

  /**
   * Update the streaming card with new text (appends to existing)
   */
  async update(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    const mergedText = this.mergeText(text);
    if (!mergedText) {
      return;
    }
    if (mergedText === this.state.currentText) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastUpdateAt;
    if (elapsed >= STREAM_UPDATE_INTERVAL_MS) {
      this.clearPendingUpdate();
      this.lastUpdateAt = now;
      await this.queueUpdate(mergedText);
      return;
    }

    this.pendingText = mergedText;
    if (!this.pendingTimer) {
      const delay = Math.max(0, STREAM_UPDATE_INTERVAL_MS - elapsed);
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        const nextText = this.pendingText;
        this.pendingText = null;
        if (!nextText || this.closed) {
          return;
        }
        this.lastUpdateAt = Date.now();
        void this.queueUpdate(nextText);
      }, delay);
    }
  }

  private clearPendingUpdate(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private queueUpdate(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return this.updateQueue;
    }

    // Queue updates to ensure order
    this.updateQueue = this.updateQueue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }

      this.state.currentText = text;
      this.state.sequence += 1;

      try {
        await updateStreamingCardText(
          this.credentials,
          this.state.cardId,
          this.state.elementId,
          text,
          this.state.sequence,
        );
      } catch (err) {
        logger.debug(`Streaming update failed (will retry): ${String(err)}`);
      }
    });
    return this.updateQueue;
  }

  private mergeText(next: string): string {
    if (!this.state) {
      return next;
    }
    const prev = this.state.currentText;
    if (!prev) {
      return next;
    }
    if (next.startsWith(prev)) {
      return next;
    }
    return prev + next;
  }

  /**
   * Finalize and close the streaming session
   */
  async close(finalText?: string, summary?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;

    const pendingText = this.pendingText;
    this.pendingText = null;
    this.clearPendingUpdate();

    // Wait for pending updates
    await this.updateQueue;

    const mergedFinal = typeof finalText === "string" ? this.mergeText(finalText) : undefined;
    const text = mergedFinal ?? pendingText ?? this.state.currentText;
    this.state.sequence += 1;

    try {
      // Update final text
      if (text) {
        await updateStreamingCardText(
          this.credentials,
          this.state.cardId,
          this.state.elementId,
          text,
          this.state.sequence,
        );
      }

      // Close streaming mode
      this.state.sequence += 1;
      await closeStreamingMode(
        this.credentials,
        this.state.cardId,
        this.state.sequence,
        summary ?? truncateForSummary(text),
      );

      logger.info(`Closed streaming session: cardId=${this.state.cardId}`);
    } catch (err) {
      logger.error(`Failed to close streaming session: ${String(err)}`);
    }
  }

  /**
   * Check if session is active
   */
  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  /**
   * Get the message ID of the streaming card
   */
  getMessageId(): string | null {
    return this.state?.messageId ?? null;
  }
}

/**
 * Truncate text to create a summary for chat preview
 */
function truncateForSummary(text: string, maxLength: number = 50): string {
  if (!text) {
    return "";
  }
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength - 3) + "...";
}
