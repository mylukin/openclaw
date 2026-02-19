import type { ChannelOutboundAdapter, ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function resolveUseCard(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  text: string;
}): boolean {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const renderMode = account.config?.renderMode ?? "auto";
  return renderMode === "card" || (renderMode === "auto" && shouldUseCard(params.text));
}

async function sendTextByRenderMode(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
}) {
  if (resolveUseCard(params)) {
    return sendMarkdownCardFeishu({
      cfg: params.cfg,
      to: params.to,
      text: params.text,
      accountId: params.accountId,
    });
  }
  return sendMessageFeishu({
    cfg: params.cfg,
    to: params.to,
    text: params.text,
    accountId: params.accountId,
  });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await sendTextByRenderMode({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendTextByRenderMode({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendTextByRenderMode({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendTextByRenderMode({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
