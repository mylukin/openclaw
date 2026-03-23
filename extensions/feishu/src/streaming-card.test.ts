import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/feishu", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  FeishuStreamingSession,
  mergeStreamingText,
  resolveStreamingCardSendMode,
} from "./streaming-card.js";

function createClientMock() {
  const messageDelete = vi.fn(async () => ({ code: 0, msg: "ok" }));
  const messageCreate = vi.fn(async () => ({
    code: 0,
    msg: "ok",
    data: { message_id: "message-id" },
  }));
  const messageReply = vi.fn(async () => ({
    code: 0,
    msg: "ok",
    data: { message_id: "message-id" },
  }));
  const cardCreate = vi.fn(async () => ({ code: 0, msg: "ok", data: { card_id: "card-id" } }));
  const cardSettings = vi.fn(async (_arg: { path?: unknown; data?: { settings?: string } }) => ({
    code: 0,
    msg: "ok",
  }));
  const cardUpdate = vi.fn(async () => ({ code: 0, msg: "ok" }));
  const cardElementContent = vi.fn(async () => ({ code: 0, msg: "ok" }));

  const client = {
    im: {
      message: {
        delete: messageDelete,
        create: messageCreate,
        reply: messageReply,
      },
    },
    cardkit: {
      v1: {
        card: {
          create: cardCreate,
          settings: cardSettings,
          update: cardUpdate,
        },
        cardElement: {
          content: cardElementContent,
        },
      },
    },
  };

  return {
    client: client as never,
    messageDelete,
    messageCreate,
    messageReply,
    cardCreate,
    cardSettings,
    cardUpdate,
    cardElementContent,
  };
}

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });

  it("merges overlap between adjacent partial snapshots", () => {
    expect(mergeStreamingText("好的，让我", "让我再读取一遍")).toBe("好的，让我再读取一遍");
    expect(mergeStreamingText("revision_id: 552", "2，一点变化都没有")).toBe(
      "revision_id: 552，一点变化都没有",
    );
    expect(mergeStreamingText("abc", "cabc")).toBe("cabc");
  });
});

describe("resolveStreamingCardSendMode", () => {
  it("prefers message.reply when reply target and root id both exist", () => {
    expect(
      resolveStreamingCardSendMode({
        replyToMessageId: "om_parent",
        rootId: "om_topic_root",
      }),
    ).toBe("reply");
  });

  it("falls back to root create when reply target is absent", () => {
    expect(
      resolveStreamingCardSendMode({
        rootId: "om_topic_root",
      }),
    ).toBe("root_create");
  });

  it("uses create mode when no reply routing fields are provided", () => {
    expect(resolveStreamingCardSendMode()).toBe("create");
    expect(
      resolveStreamingCardSendMode({
        replyInThread: true,
      }),
    ).toBe("create");
  });
});

describe("FeishuStreamingSession.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports replace mode to overwrite transient status text", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.update("🔧 正在使用Read工具...", { mode: "replace" });

    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "🔧 正在使用Read工具...",
      expect.any(Function),
    );
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });
});

describe("FeishuStreamingSession.discard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the interactive message instead of leaving an empty card", async () => {
    const { client, messageDelete } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };

    await session.discard();

    expect(messageDelete).toHaveBeenCalledWith({
      path: { message_id: "message-id" },
    });
  });
});

describe("FeishuStreamingSession.close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats explicit empty final text as authoritative", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    (session as any).pendingUpdate = { text: "💭 思考中...", mode: "replace" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close("");

    expect(updateCardContentSpy).toHaveBeenCalledWith("");
    expect((session as any).state.currentText).toBe("");
  });

  it("treats explicit non-empty final text as authoritative", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "**Checking SEO JSON-LD in PR #16**<at id=ou_luke></at> 加了。",
    };
    (session as any).pendingUpdate = {
      text: "**Checking SEO JSON-LD in PR #16**<at id=ou_luke></at> 加了。\n我刚",
      mode: "replace",
    };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close("<at id=ou_luke></at> 加了。\n我刚又确认了一遍");

    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "<at id=ou_luke></at> 加了。\n我刚又确认了一遍",
    );
    expect((session as any).state.currentText).toBe(
      "<at id=ou_luke></at> 加了。\n我刚又确认了一遍",
    );
  });

  it("keeps pending merge behavior when final text is omitted", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "第一段",
    };
    (session as any).pendingUpdate = { text: "第一段\n第二段", mode: "merge" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("第一段\n第二段");
    expect((session as any).state.currentText).toBe("第一段\n第二段");
  });

  it("respects pending replace updates when final text is omitted", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    (session as any).pendingUpdate = { text: "🔧 正在使用Read工具...", mode: "replace" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("🔧 正在使用Read工具...");
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });

  it("falls back to full card update when streaming content update fails on close", async () => {
    const { client, cardElementContent, cardUpdate } = createClientMock();
    // Simulate streaming_mode expired — element content API rejects
    cardElementContent.mockRejectedValueOnce(new Error("streaming timeout"));

    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "旧内容",
      header: { title: "Test", template: "blue" },
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close("最终内容");

    // Streaming update was attempted and failed
    expect(cardElementContent).toHaveBeenCalled();
    // Fallback card.update was called with full card JSON
    expect(cardUpdate).toHaveBeenCalledOnce();
    const updateArg = (cardUpdate.mock.calls[0] as unknown[])?.[0] as {
      path?: { card_id?: string };
      data?: { card?: { data?: string } };
    };
    expect(updateArg.path?.card_id).toBe("card-id");
    const cardJson = JSON.parse(updateArg.data?.card?.data ?? "{}") as {
      body?: { elements?: Array<{ content?: string }> };
      header?: { title?: { content?: string } };
    };
    expect(cardJson.body?.elements?.[0]?.content).toBe("最终内容");
    expect(cardJson.header?.title?.content).toBe("Test");
    expect((session as any).state.currentText).toBe("最终内容");
  });

  it("does not call full card update when streaming content update succeeds on close", async () => {
    const { client, cardUpdate } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "旧内容",
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close("最终内容");

    expect(cardUpdate).not.toHaveBeenCalled();
  });

  it("strips html tags when writing summary content on close", async () => {
    const { client, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "",
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close(
      '<at user_id="ou_user_1">Lukin</at> 已完成 <b>发布</b><br/>请查看 <a href="https://example.com">链接</a>',
    );

    expect(cardSettings).toHaveBeenCalled();
    const cardSettingsArg = cardSettings.mock.calls[0]?.[0] as {
      data?: { settings?: string };
    };
    const settingsPayload = JSON.parse(cardSettingsArg.data?.settings ?? "{}") as {
      config?: { summary?: { content?: string } };
    };
    expect(settingsPayload.config?.summary?.content).toBe("Lukin 已完成 发布 请查看 链接");
  });
});

describe("FeishuStreamingSession.renewStreamingMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function makeSession(client: ReturnType<typeof createClientMock>["client"]) {
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 2,
      currentText: "text",
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    return session;
  }

  it("does not renew when last renewal is within 8 minutes", async () => {
    const { client, cardSettings } = createClientMock();
    const session = makeSession(client);

    await (session as any).renewStreamingMode();

    expect(cardSettings).not.toHaveBeenCalled();
    expect((session as any).state.sequence).toBe(2);
  });

  it("renews and advances sequence when 8 minutes have elapsed", async () => {
    const { client, cardSettings } = createClientMock();
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    await (session as any).renewStreamingMode();

    expect(cardSettings).toHaveBeenCalledOnce();
    const arg = cardSettings.mock.calls[0]?.[0] as {
      data?: { settings?: string; sequence?: number };
    };
    const settings = JSON.parse(arg.data?.settings ?? "{}") as {
      config?: { streaming_mode?: boolean };
    };
    expect(settings.config?.streaming_mode).toBe(true);
    expect(arg.data?.sequence).toBe(3);
    expect((session as any).state.sequence).toBe(3);
  });

  it("does not advance sequence when renewal API returns non-zero code", async () => {
    const { client, cardSettings } = createClientMock();
    cardSettings.mockResolvedValueOnce({ code: 200850, msg: "Card streaming timeout" });
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    await (session as any).renewStreamingMode();

    expect(cardSettings).toHaveBeenCalledOnce();
    // sequence must not advance on failure — no wasted hole
    expect((session as any).state.sequence).toBe(2);
  });

  it("does not advance sequence when renewal API throws", async () => {
    const { client, cardSettings } = createClientMock();
    cardSettings.mockRejectedValueOnce(new Error("network error"));
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    await (session as any).renewStreamingMode();

    expect((session as any).state.sequence).toBe(2);
  });

  it("updates lastStreamingModeRenewAt only on success", async () => {
    const { client, cardSettings } = createClientMock();
    cardSettings.mockRejectedValueOnce(new Error("network error"));
    const session = makeSession(client);
    const renewedAt = Date.now() - 8 * 60 * 1000 - 1;
    (session as any).lastStreamingModeRenewAt = renewedAt;

    await (session as any).renewStreamingMode();

    expect((session as any).lastStreamingModeRenewAt).toBe(renewedAt);
  });

  it("start() initialises lastStreamingModeRenewAt so first update does not trigger renewal", async () => {
    const { client, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    await session.start("chat-id");

    // Immediately call updateCardContent — renewal must not fire
    const before = cardSettings.mock.calls.length; // calls from start (card.create, not settings)
    await (session as any).updateCardContent("hello");
    expect(cardSettings.mock.calls.length).toBe(before);

    // Clean up timer to avoid leaking
    (session as any).stopRenewTimer();
  });

  it("start() sets up a proactive renew timer", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    await session.start("chat-id");

    expect((session as any).renewTimer).not.toBeNull();

    // Clean up
    (session as any).stopRenewTimer();
  });

  it("close() stops the renew timer", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "text",
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    (session as any).startRenewTimer();
    expect((session as any).renewTimer).not.toBeNull();

    await session.close("final");

    expect((session as any).renewTimer).toBeNull();
  });

  it("discard() stops the renew timer", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "text",
    };
    (session as any).startRenewTimer();
    expect((session as any).renewTimer).not.toBeNull();

    await session.discard();

    expect((session as any).renewTimer).toBeNull();
  });

  it("proactive timer fires renewStreamingMode after interval elapses", async () => {
    vi.useFakeTimers();
    const { client, cardSettings } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "text",
    };
    // Set lastStreamingModeRenewAt to long ago so renewal condition is met
    (session as any).lastStreamingModeRenewAt = 0;
    (session as any).startRenewTimer();

    const before = cardSettings.mock.calls.length;

    // Advance past the renewal interval
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);

    expect(cardSettings.mock.calls.length).toBeGreaterThan(before);
    const arg = cardSettings.mock.calls[cardSettings.mock.calls.length - 1]?.[0] as {
      data?: { settings?: string };
    };
    const settings = JSON.parse(arg.data?.settings ?? "{}") as {
      config?: { streaming_mode?: boolean };
    };
    expect(settings.config?.streaming_mode).toBe(true);

    (session as any).stopRenewTimer();
    vi.useRealTimers();
  });
});
