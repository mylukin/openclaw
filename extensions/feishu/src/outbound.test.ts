import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const sendText = feishuOutbound.sendText!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    resolveFeishuAccountMock.mockReturnValue({
      config: { renderMode: "auto" },
    });
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  });

  async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-outbound-"));
    const file = path.join(dir, `sample${ext}`);
    await fs.writeFile(file, "image-data");
    return { dir, file };
  }

  it("sends an absolute existing local image path as media", async () => {
    const { dir, file } = await createTmpImage();
    try {
      const result = await sendText({
        cfg: {} as never,
        to: "chat_1",
        text: file,
        accountId: "main",
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          mediaUrl: file,
          accountId: "main",
        }),
      );
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ channel: "feishu", messageId: "media_msg" }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps non-path text on the text-send path", async () => {
    await sendText({
      cfg: {} as never,
      to: "chat_1",
      text: "please upload /tmp/example.png",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "please upload /tmp/example.png",
        accountId: "main",
      }),
    );
  });

  it("falls back to plain text if local-image media send fails", async () => {
    const { dir, file } = await createTmpImage();
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    try {
      await sendText({
        cfg: {} as never,
        to: "chat_1",
        text: file,
        accountId: "main",
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          text: file,
          accountId: "main",
        }),
      );
      expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

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
