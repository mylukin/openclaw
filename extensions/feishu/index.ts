import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { feishuPlugin } from "./src/channel.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { createFeishuReplyDispatcher } from "./src/reply-dispatcher.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerFeishuSubagentHooks } from "./src/subagent-hooks.js";
import { registerFeishuWikiTools } from "./src/wiki.js";

export { feishuPlugin } from "./src/channel.js";
export { setFeishuRuntime } from "./src/runtime.js";
export { monitorFeishuProvider } from "./src/monitor.js";
export { getBotOpenId } from "./src/monitor.js";
export { createFeishuReplyDispatcher } from "./src/reply-dispatcher.js";
export {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  getMessageFeishu,
} from "./src/send.js";
export {
  uploadImageFeishu,
  uploadFileFeishu,
  sendImageFeishu,
  sendFileFeishu,
  sendMediaFeishu,
} from "./src/media.js";
export { probeFeishu } from "./src/probe.js";
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
} from "./src/reactions.js";
export {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionTarget,
} from "./src/mention.js";

export default defineChannelPluginEntry({
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  plugin: feishuPlugin,
  setRuntime: setFeishuRuntime,
  registerFull(api) {
    // Expose the native feishu reply dispatcher on the runtime so external
    // plugins (e.g. bot-company) can create streaming-card capable dispatchers
    // instead of falling back to the generic route-reply path.
    const replyRuntime = (api.runtime as { channel?: { reply?: Record<string, unknown> } })?.channel
      ?.reply;
    if (replyRuntime && typeof replyRuntime.createFeishuReplyDispatcher !== "function") {
      replyRuntime.createFeishuReplyDispatcher = createFeishuReplyDispatcher;
    }

    registerFeishuSubagentHooks(api);
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
  },
});
