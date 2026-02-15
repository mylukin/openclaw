import { beforeEach, describe, expect, it, vi } from "vitest";

const emitMessageSent = vi.fn();

const sendMessageFeishu = vi.fn();
const sendMarkdownCardFeishu = vi.fn();
const editMessageFeishu = vi.fn();
const createCardEntityFeishu = vi.fn();
const sendCardByCardIdFeishu = vi.fn();
const updateCardElementContentFeishu = vi.fn();
const updateCardSummaryFeishu = vi.fn();
const closeStreamingModeFeishu = vi.fn();
const deleteMessageFeishu = vi.fn();

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    emitMessageSent: (...args: unknown[]) => emitMessageSent(...args),
    createReplyPrefixContext: () => ({
      responsePrefix: undefined,
      responsePrefixContextProvider: () => ({}),
      onModelSelected: () => {},
    }),
    createTypingCallbacks: () => ({
      onReplyStart: async () => {},
      onIdle: () => {},
      onCleanup: () => {},
    }),
    logTypingFailure: vi.fn(),
  };
});

vi.mock("./send.js", () => ({
  sendMessageFeishu: (...args: unknown[]) => sendMessageFeishu(...args),
  sendMarkdownCardFeishu: (...args: unknown[]) => sendMarkdownCardFeishu(...args),
  editMessageFeishu: (...args: unknown[]) => editMessageFeishu(...args),
  createCardEntityFeishu: (...args: unknown[]) => createCardEntityFeishu(...args),
  sendCardByCardIdFeishu: (...args: unknown[]) => sendCardByCardIdFeishu(...args),
  updateCardElementContentFeishu: (...args: unknown[]) => updateCardElementContentFeishu(...args),
  updateCardSummaryFeishu: (...args: unknown[]) => updateCardSummaryFeishu(...args),
  closeStreamingModeFeishu: (...args: unknown[]) => closeStreamingModeFeishu(...args),
  deleteMessageFeishu: (...args: unknown[]) => deleteMessageFeishu(...args),
}));

const { createFeishuReplyDispatcher } = await import("./reply-dispatcher.js");
const { setFeishuRuntime } = await import("./runtime.js");

function createRuntime(chunkTextWithModeImpl?: (text: string) => string[]) {
  const pending: Array<Promise<void>> = [];
  const chunkTextWithMode = chunkTextWithModeImpl ?? ((text: string) => [text]);

  return {
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
        resolveChunkMode: () => "text",
        resolveMarkdownTableMode: () => "preserve",
        convertMarkdownTables: (text: string) => text,
        chunkTextWithMode: (text: string) => chunkTextWithMode(text),
      },
      reply: {
        resolveHumanDelayConfig: () => ({ mode: "off" }),
        createReplyDispatcherWithTyping: (options: {
          deliver: (
            payload: { text?: string },
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        }) => {
          const enqueue = (payload: { text?: string }, kind: "tool" | "block" | "final") => {
            const job = options.deliver(payload, { kind });
            pending.push(job);
          };

          return {
            dispatcher: {
              sendToolResult: (payload: { text?: string }) => {
                enqueue(payload, "tool");
                return true;
              },
              sendBlockReply: (payload: { text?: string }) => {
                enqueue(payload, "block");
                return true;
              },
              sendFinalReply: (payload: { text?: string }) => {
                enqueue(payload, "final");
                return true;
              },
              waitForIdle: async () => {
                await Promise.all(pending);
              },
              getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            },
            replyOptions: {},
            markDispatchIdle: () => {},
          };
        },
      },
    },
  };
}

beforeEach(() => {
  emitMessageSent.mockReset();
  sendMessageFeishu.mockReset();
  sendMarkdownCardFeishu.mockReset();
  editMessageFeishu.mockReset();
  createCardEntityFeishu.mockReset();
  sendCardByCardIdFeishu.mockReset();
  updateCardElementContentFeishu.mockReset();
  updateCardSummaryFeishu.mockReset();
  closeStreamingModeFeishu.mockReset();
  deleteMessageFeishu.mockReset();
});

describe("createFeishuReplyDispatcher message_sent hooks", () => {
  it("emits one message_sent with conversationId and first non-streaming messageId", async () => {
    setFeishuRuntime(createRuntime(() => ["part-1", "part-2"]) as never);
    sendMessageFeishu
      .mockResolvedValueOnce({ messageId: "om_first", chatId: "oc_chat" })
      .mockResolvedValueOnce({ messageId: "om_second", chatId: "oc_chat" });

    const { dispatcher } = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "app",
            appSecret: "secret",
            renderMode: "raw",
            streaming: false,
            blockStreaming: false,
          },
        },
      } as never,
      agentId: "agent-main",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc_chat",
      chatType: "p2p",
    });

    dispatcher.sendFinalReply({ text: "hello world" });
    await dispatcher.waitForIdle();

    expect(emitMessageSent).toHaveBeenCalledTimes(1);
    expect(emitMessageSent).toHaveBeenCalledWith(
      {
        to: "oc_chat",
        content: "hello world",
        success: true,
        messageId: "om_first",
        metadata: { msgType: "post" },
      },
      {
        channelId: "feishu",
        accountId: "default",
        conversationId: "oc_chat",
        chatType: "p2p",
      },
    );
  });

  it("does not emit message_sent when block streaming only updates existing card", async () => {
    setFeishuRuntime(createRuntime() as never);
    createCardEntityFeishu.mockResolvedValue({ cardId: "card_1" });
    sendCardByCardIdFeishu.mockResolvedValue({ messageId: "om_card", chatId: "oc_chat" });
    updateCardElementContentFeishu.mockResolvedValue(undefined);

    const { dispatcher } = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "app",
            appSecret: "secret",
            renderMode: "card",
            streaming: false,
            blockStreaming: true,
          },
        },
      } as never,
      agentId: "agent-main",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc_chat",
    });

    dispatcher.sendBlockReply({ text: "first block" });
    await dispatcher.waitForIdle();
    dispatcher.sendBlockReply({ text: "second block" });
    await dispatcher.waitForIdle();

    expect(emitMessageSent).toHaveBeenCalledTimes(1);
    expect(emitMessageSent).toHaveBeenCalledWith(
      {
        to: "oc_chat",
        content: "first block",
        success: true,
        messageId: "om_card",
        metadata: { msgType: "interactive" },
      },
      {
        channelId: "feishu",
        accountId: "default",
        conversationId: "oc_chat",
      },
    );
    expect(updateCardElementContentFeishu).toHaveBeenCalledTimes(1);
  });
});

describe("createFeishuReplyDispatcher summary sanitization", () => {
  it("filters <at ...> tags from card.summary while keeping card content unchanged", async () => {
    setFeishuRuntime(createRuntime() as never);
    createCardEntityFeishu.mockResolvedValue({ cardId: "card_1" });
    sendCardByCardIdFeishu.mockResolvedValue({ messageId: "om_card", chatId: "oc_chat" });
    updateCardElementContentFeishu.mockResolvedValue(undefined);
    updateCardSummaryFeishu.mockResolvedValue(undefined);
    closeStreamingModeFeishu.mockResolvedValue(undefined);

    const { dispatcher, replyOptions } = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "app",
            appSecret: "secret",
            renderMode: "card",
            streaming: true,
            blockStreaming: false,
          },
        },
      } as never,
      agentId: "agent-main",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    await replyOptions.onModelSelected?.({} as never);

    const text =
      '<at id=ou_emma></at> <at user_id="ou_eric"/> 第2轮：先声夺人（人）\n到你了，接"人"！';
    dispatcher.sendFinalReply({ text });
    await dispatcher.waitForIdle();

    expect(updateCardSummaryFeishu).toHaveBeenCalledTimes(1);
    const summaryPayload = updateCardSummaryFeishu.mock.calls[0]?.[0] as {
      summaryText: string;
      content: string;
    };
    expect(summaryPayload.summaryText).not.toContain("<at");
    expect(summaryPayload.summaryText).toContain("第2轮：先声夺人");
    expect(summaryPayload.content).toContain("<at id=ou_emma></at>");
  });

  it("keeps inner mention text when stripping paired at-tags", async () => {
    setFeishuRuntime(createRuntime() as never);
    createCardEntityFeishu.mockResolvedValue({ cardId: "card_2" });
    sendCardByCardIdFeishu.mockResolvedValue({ messageId: "om_card_2", chatId: "oc_chat" });
    updateCardElementContentFeishu.mockResolvedValue(undefined);
    updateCardSummaryFeishu.mockResolvedValue(undefined);
    closeStreamingModeFeishu.mockResolvedValue(undefined);

    const { dispatcher, replyOptions } = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "app",
            appSecret: "secret",
            renderMode: "card",
            streaming: true,
            blockStreaming: false,
          },
        },
      } as never,
      agentId: "agent-main",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    await replyOptions.onModelSelected?.({} as never);

    dispatcher.sendFinalReply({ text: '<at id="ou_emma">Emma</at> 开始吧。' });
    await dispatcher.waitForIdle();

    const summaryPayload = updateCardSummaryFeishu.mock.calls[0]?.[0] as {
      summaryText: string;
    };
    expect(summaryPayload.summaryText).toBe("Emma 开始吧。");
  });
});

describe("createFeishuReplyDispatcher partial streaming guard", () => {
  it("ignores short markdown noise tokens and keeps streaming in the same card", async () => {
    vi.useFakeTimers();
    try {
      setFeishuRuntime(createRuntime() as never);
      createCardEntityFeishu.mockResolvedValue({ cardId: "card_stream_1" });
      sendCardByCardIdFeishu.mockResolvedValue({ messageId: "om_stream_1", chatId: "oc_chat" });
      updateCardElementContentFeishu.mockResolvedValue(undefined);

      const { replyOptions } = createFeishuReplyDispatcher({
        cfg: {
          channels: {
            feishu: {
              appId: "app",
              appSecret: "secret",
              renderMode: "card",
              streaming: true,
              blockStreaming: false,
            },
          },
        } as never,
        agentId: "agent-main",
        runtime: { log: () => {}, error: () => {} } as never,
        chatId: "oc_chat",
      });

      const first = "GitHub Profile 和 Git commit 记录都只显示 ";
      const second = "**";
      const third = 'GitHub Profile 和 Git commit 记录都只显示 "Lukin"，没有中文名信息。';

      replyOptions.onPartialReply?.({ text: first } as never);
      await vi.advanceTimersByTimeAsync(600);
      replyOptions.onPartialReply?.({ text: second } as never);
      await vi.advanceTimersByTimeAsync(600);
      replyOptions.onPartialReply?.({ text: third } as never);
      await vi.advanceTimersByTimeAsync(600);

      expect(createCardEntityFeishu).toHaveBeenCalledTimes(1);
      expect(sendCardByCardIdFeishu).toHaveBeenCalledTimes(1);
      expect(updateCardElementContentFeishu).toHaveBeenCalledTimes(1);
      const updatedCardIds = updateCardElementContentFeishu.mock.calls.map(
        (args) => (args[0] as { cardId: string }).cardId,
      );
      expect(updatedCardIds).toEqual(["card_stream_1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps updating the same card when prefix similarity stays above threshold", async () => {
    vi.useFakeTimers();
    try {
      setFeishuRuntime(createRuntime() as never);
      createCardEntityFeishu.mockResolvedValue({ cardId: "card_stream_1" });
      sendCardByCardIdFeishu.mockResolvedValue({ messageId: "om_stream_1", chatId: "oc_chat" });
      updateCardElementContentFeishu.mockResolvedValue(undefined);

      const { replyOptions } = createFeishuReplyDispatcher({
        cfg: {
          channels: {
            feishu: {
              appId: "app",
              appSecret: "secret",
              renderMode: "card",
              streaming: true,
              blockStreaming: false,
            },
          },
        } as never,
        agentId: "agent-main",
        runtime: { log: () => {}, error: () => {} } as never,
        chatId: "oc_chat",
      });

      const first = `${"A".repeat(95)}${"B".repeat(15)}`;
      const second = `${"A".repeat(95)}X${"B".repeat(14)}-extended`;

      replyOptions.onPartialReply?.({ text: first } as never);
      await vi.advanceTimersByTimeAsync(600);
      replyOptions.onPartialReply?.({ text: second } as never);
      await vi.advanceTimersByTimeAsync(600);

      expect(createCardEntityFeishu).toHaveBeenCalledTimes(1);
      expect(sendCardByCardIdFeishu).toHaveBeenCalledTimes(1);
      expect(updateCardElementContentFeishu).toHaveBeenCalledTimes(1);
      expect(closeStreamingModeFeishu).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates to a new card segment and keeps final updates on the latest card", async () => {
    vi.useFakeTimers();
    try {
      setFeishuRuntime(createRuntime() as never);
      createCardEntityFeishu
        .mockResolvedValueOnce({ cardId: "card_stream_1" })
        .mockResolvedValueOnce({ cardId: "card_stream_2" });
      sendCardByCardIdFeishu
        .mockResolvedValueOnce({ messageId: "om_stream_1", chatId: "oc_chat" })
        .mockResolvedValueOnce({ messageId: "om_stream_2", chatId: "oc_chat" });
      updateCardElementContentFeishu.mockResolvedValue(undefined);
      updateCardSummaryFeishu.mockResolvedValue(undefined);
      closeStreamingModeFeishu.mockResolvedValue(undefined);

      const { dispatcher, replyOptions } = createFeishuReplyDispatcher({
        cfg: {
          channels: {
            feishu: {
              appId: "app",
              appSecret: "secret",
              renderMode: "card",
              streaming: true,
              blockStreaming: false,
            },
          },
        } as never,
        agentId: "agent-main",
        runtime: { log: () => {}, error: () => {} } as never,
        chatId: "oc_chat",
      });

      const first = "A".repeat(50);
      const divergedOne = "B".repeat(45);
      const divergedTwo = "C".repeat(46);
      const continued = `${divergedTwo} plus`;

      replyOptions.onPartialReply?.({ text: first } as never);
      await vi.advanceTimersByTimeAsync(600);

      replyOptions.onPartialReply?.({ text: divergedOne } as never);
      await vi.advanceTimersByTimeAsync(600);

      expect(sendCardByCardIdFeishu).toHaveBeenCalledTimes(1);

      replyOptions.onPartialReply?.({ text: divergedTwo } as never);
      await vi.advanceTimersByTimeAsync(600);

      replyOptions.onPartialReply?.({ text: continued } as never);
      await vi.advanceTimersByTimeAsync(600);

      dispatcher.sendFinalReply({ text: `${continued} final` });
      await dispatcher.waitForIdle();

      expect(createCardEntityFeishu).toHaveBeenCalledTimes(2);
      expect(sendCardByCardIdFeishu).toHaveBeenCalledTimes(2);
      expect(closeStreamingModeFeishu).toHaveBeenCalledTimes(2);

      expect(updateCardElementContentFeishu).toHaveBeenCalledTimes(2);
      const updatedCardIds = updateCardElementContentFeishu.mock.calls.map(
        (args) => (args[0] as { cardId: string }).cardId,
      );
      expect(updatedCardIds).toEqual(["card_stream_2", "card_stream_2"]);

      const summaryCardIds = updateCardSummaryFeishu.mock.calls.map(
        (args) => (args[0] as { cardId: string }).cardId,
      );
      expect(summaryCardIds).toEqual(["card_stream_2"]);

      const closedCardIds = closeStreamingModeFeishu.mock.calls.map(
        (args) => (args[0] as { cardId: string }).cardId,
      );
      expect(closedCardIds).toEqual(["card_stream_1", "card_stream_2"]);

      expect(emitMessageSent).toHaveBeenCalledTimes(2);
      const sentMessageIds = emitMessageSent.mock.calls.map(
        (args) => (args[0] as { messageId?: string }).messageId,
      );
      expect(sentMessageIds).toEqual(["om_stream_1", "om_stream_2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses latest segment accumulated text when final snapshot regresses", async () => {
    vi.useFakeTimers();
    try {
      setFeishuRuntime(createRuntime() as never);
      createCardEntityFeishu
        .mockResolvedValueOnce({ cardId: "card_stream_1" })
        .mockResolvedValueOnce({ cardId: "card_stream_2" });
      sendCardByCardIdFeishu
        .mockResolvedValueOnce({ messageId: "om_stream_1", chatId: "oc_chat" })
        .mockResolvedValueOnce({ messageId: "om_stream_2", chatId: "oc_chat" });
      updateCardElementContentFeishu.mockResolvedValue(undefined);
      updateCardSummaryFeishu.mockResolvedValue(undefined);
      closeStreamingModeFeishu.mockResolvedValue(undefined);

      const { dispatcher, replyOptions } = createFeishuReplyDispatcher({
        cfg: {
          channels: {
            feishu: {
              appId: "app",
              appSecret: "secret",
              renderMode: "card",
              streaming: true,
              blockStreaming: false,
            },
          },
        } as never,
        agentId: "agent-main",
        runtime: { log: () => {}, error: () => {} } as never,
        chatId: "oc_chat",
      });

      const first = "A".repeat(50);
      const divergedOne = "B".repeat(45);
      const divergedTwo = "C".repeat(46);
      const latestAccumulated = `${divergedTwo} carried forward`;

      replyOptions.onPartialReply?.({ text: first } as never);
      await vi.advanceTimersByTimeAsync(600);

      replyOptions.onPartialReply?.({ text: divergedOne } as never);
      await vi.advanceTimersByTimeAsync(600);

      replyOptions.onPartialReply?.({ text: divergedTwo } as never);
      await vi.advanceTimersByTimeAsync(600);

      replyOptions.onPartialReply?.({ text: latestAccumulated } as never);
      await vi.advanceTimersByTimeAsync(600);

      dispatcher.sendFinalReply({ text: first });
      await dispatcher.waitForIdle();

      expect(createCardEntityFeishu).toHaveBeenCalledTimes(2);
      expect(updateCardElementContentFeishu).toHaveBeenCalledTimes(1);

      const summaryPayload = updateCardSummaryFeishu.mock.calls[0]?.[0] as {
        cardId: string;
        content: string;
        summaryText: string;
      };
      expect(summaryPayload.cardId).toBe("card_stream_2");
      expect(summaryPayload.content).toContain(latestAccumulated);
      expect(summaryPayload.summaryText).toContain(latestAccumulated);
    } finally {
      vi.useRealTimers();
    }
  });
});
