import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

import { feishuOutbound } from "./outbound.js";

describe("feishuOutbound renderMode routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    resolveFeishuAccountMock.mockReturnValue({
      config: { renderMode: "auto" },
    });
    sendMessageFeishuMock.mockResolvedValue({ messageId: "msg_text", chatId: "chat_1" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "msg_card", chatId: "chat_1" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "msg_media", chatId: "chat_1" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses markdown card when renderMode=card", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      config: { renderMode: "card" },
    });

    const sendText = feishuOutbound.sendText;
    if (!sendText) {
      throw new Error("feishuOutbound.sendText is not configured");
    }
    await sendText({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "plain text",
      accountId: "pm",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_xxx",
        text: "plain text",
        accountId: "pm",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("uses text send when renderMode=raw", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      config: { renderMode: "raw" },
    });

    const sendText = feishuOutbound.sendText;
    if (!sendText) {
      throw new Error("feishuOutbound.sendText is not configured");
    }
    await sendText({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "plain text",
      accountId: "pm",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("uses markdown card in auto mode when message contains markdown block", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      config: { renderMode: "auto" },
    });

    const sendText = feishuOutbound.sendText;
    if (!sendText) {
      throw new Error("feishuOutbound.sendText is not configured");
    }
    await sendText({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "```ts\nconst x = 1\n```",
      accountId: "pm",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps media fallback aligned with renderMode=card", async () => {
    resolveFeishuAccountMock
      .mockReturnValueOnce({ config: { renderMode: "card" } })
      .mockReturnValueOnce({ config: { renderMode: "card" } });
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    const sendMedia = feishuOutbound.sendMedia;
    if (!sendMedia) {
      throw new Error("feishuOutbound.sendMedia is not configured");
    }
    await sendMedia({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "",
      mediaUrl: "https://example.com/a.png",
      accountId: "pm",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "📎 https://example.com/a.png",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
