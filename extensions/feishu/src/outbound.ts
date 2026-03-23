import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/feishu";
import { HEARTBEAT_TOKEN, stripHeartbeatToken } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";

const OUTBOUND_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tiff",
]);
const OUTBOUND_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi"]);
const OUTBOUND_AUDIO_EXTENSIONS = new Set([".opus", ".ogg", ".mp3", ".wav"]);

function resolveOutboundMediaContentType(url: string): string {
  const ext = path.extname(url).toLowerCase();
  if (OUTBOUND_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (OUTBOUND_VIDEO_EXTENSIONS.has(ext)) return "video";
  if (OUTBOUND_AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "file";
}

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;

  const ext = path.extname(raw).toLowerCase();
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) return null;

  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/**
 * Strip HEARTBEAT_TOKEN from outbound text before sending to Feishu.
 * Returns the cleaned text, or null if nothing remains (pure heartbeat ack).
 *
 * HEARTBEAT_OK is an internal protocol token that must never be visible to users
 * as a Feishu group/DM message. This guard is a last-resort safety net in the
 * outbound layer — normalized replies should already have the token stripped by
 * the reply-dispatcher pipeline, but direct deliveries (e.g. heartbeat-runner
 * showOk path) bypass that pipeline and hit this adapter directly.
 */
function normalizeOutboundText(text: string): string | null {
  if (!text.includes(HEARTBEAT_TOKEN)) {
    return text;
  }
  const stripped = stripHeartbeatToken(text, { mode: "message" });
  if (stripped.shouldSkip || !stripped.text) {
    return null;
  }
  return stripped.text;
}

function resolveReplyToMessageId(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return undefined;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || undefined;
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  accountId?: string;
}) {
  const { cfg, to, text, accountId, replyToMessageId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    return sendMarkdownCardFeishu({ cfg, to, text, accountId, replyToMessageId });
  }

  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId, mediaLocalRoots }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });

    // Filter HEARTBEAT_TOKEN before sending. The token is an internal ack signal
    // and must never appear as a visible message in Feishu group chats or DMs.
    const effectiveText = normalizeOutboundText(text);
    if (effectiveText === null) {
      return { channel: "feishu" as const, messageId: "" };
    }

    // Scheme A compatibility shim:
    // when upstream accidentally returns a local image path as plain text,
    // auto-upload and send as Feishu image message instead of leaking path text.
    const localImagePath = normalizePossibleLocalImagePath(effectiveText);
    if (localImagePath) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
          replyToMessageId,
          mediaLocalRoots,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
        // fall through to plain text as last resort
      }
    }

    const result = await sendOutboundText({
      cfg,
      to,
      text: effectiveText,
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    accountId,
    mediaLocalRoots,
    replyToId,
    threadId,
  }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    // Send text first if provided (after stripping any HEARTBEAT_TOKEN)
    const effectiveCaption = text ? normalizeOutboundText(text) : null;
    if (effectiveCaption) {
      await sendOutboundText({
        cfg,
        to,
        text: effectiveCaption,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    }

    // Upload and send media if URL or local path provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
          mediaLocalRoots,
          replyToMessageId,
        });
        const contentType = resolveOutboundMediaContentType(mediaUrl);
        return {
          channel: "feishu",
          ...result,
          meta: {
            contentType,
            rawContent: `[${contentType}: ${mediaUrl}]`,
          },
        };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendOutboundText({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL — use the already-normalized caption; drop stray HEARTBEAT_OK
    const fallbackText = effectiveCaption ?? "";
    if (!fallbackText) {
      return { channel: "feishu", messageId: "", chatId: "" };
    }
    const result = await sendOutboundText({
      cfg,
      to,
      text: fallbackText,
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    return { channel: "feishu", ...result };
  },
};
