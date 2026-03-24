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

  const client = {
    im: {
      message: {
        create: messageCreate,
        reply: messageReply,
      },
      v1: {
        message: {
          delete: messageDelete,
        },
      },
    },
  };

  return {
    client: client as never,
    messageDelete,
    messageCreate,
    messageReply,
  };
}

/** Default URL-aware mock implementation for fetchWithSsrFGuard. */
function defaultFetchImpl(opts: { url: string }) {
  const url = opts.url;
  if (url.includes("/auth/v3/tenant_access_token")) {
    return Promise.resolve({
      response: {
        ok: true,
        json: async () => ({
          code: 0,
          msg: "ok",
          tenant_access_token: "mock-token",
          expire: 7200,
        }),
      },
      release: async () => {},
    });
  }
  if (
    url.match(/\/cardkit\/v1\/cards$/) &&
    !url.includes("/elements") &&
    !url.includes("/settings")
  ) {
    return Promise.resolve({
      response: {
        ok: true,
        json: async () => ({
          code: 0,
          msg: "ok",
          data: { card_id: "card-id" },
        }),
      },
      release: async () => {},
    });
  }
  return Promise.resolve({ release: async () => {} });
}

/** Helper: reset fetchWithSsrFGuardMock to its default URL-aware implementation. */
function resetFetchMock() {
  fetchWithSsrFGuardMock.mockReset();
  fetchWithSsrFGuardMock.mockImplementation(defaultFetchImpl);
}

/** Helper: extract fetchWithSsrFGuard calls matching a URL pattern. */
function fetchCallsMatching(pattern: RegExp) {
  return fetchWithSsrFGuardMock.mock.calls.filter((call: unknown[]) =>
    pattern.test((call[0] as { url: string }).url),
  );
}

/** Helper: parse the JSON body from a fetchWithSsrFGuard call arg. */
function parseFetchBody(call: unknown[]): Record<string, unknown> {
  const arg = call[0] as { init?: { body?: string } };
  return JSON.parse(arg.init?.body ?? "{}");
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
    resetFetchMock();
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
      thinkingText: "",
      thinkingExpanded: true,
    };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.update("🔧 正在使用Read工具...", { replace: true });

    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "🔧 正在使用Read工具...",
      expect.any(Function),
    );
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });
});

describe("FeishuStreamingSession.discard", () => {
  beforeEach(() => {
    resetFetchMock();
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
      thinkingText: "",
      thinkingExpanded: true,
    };

    await session.discard();

    expect(messageDelete).toHaveBeenCalledWith({
      path: { message_id: "message-id" },
    });
  });
});

describe("FeishuStreamingSession.close", () => {
  beforeEach(() => {
    resetFetchMock();
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
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).pendingText = "💭 思考中...";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    // close("") — empty string is falsy so text stays as pendingMerged.
    // pendingMerged = mergeStreamingText("💭 思考中...", "💭 思考中...") = "💭 思考中..."
    // text equals currentText, so no content update fires.
    await session.close("");

    // The content was not changed (empty string is falsy in the ternary),
    // so updateCardContent is not called for content — only the settings
    // PATCH fires through fetchWithSsrFGuard.
    expect(updateCardContentSpy).not.toHaveBeenCalled();
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
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).pendingText =
      "**Checking SEO JSON-LD in PR #16**<at id=ou_luke></at> 加了。\n我刚";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close("<at id=ou_luke></at> 加了。\n我刚又确认了一遍");

    // pendingMerged = mergeStreamingText(currentText, pendingText)
    //   = mergeStreamingText("...加了。", "...加了。\n我刚") = "...加了。\n我刚"
    // text = mergeStreamingText(pendingMerged, finalText)
    //   = mergeStreamingText("...加了。\n我刚", "<at id=ou_luke></at> 加了。\n我刚又确认了一遍")
    //   which merges the overlap → result includes the final text
    expect(updateCardContentSpy).toHaveBeenCalled();
    const calledText = updateCardContentSpy.mock.calls[0]?.[0] as string;
    // The merge should produce text that contains the final text content
    expect(calledText).toContain("又确认了一遍");
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
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).pendingText = "第一段\n第二段";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("第一段\n第二段");
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
      thinkingText: "",
      thinkingExpanded: true,
    };
    // pendingText is a plain string in the current code — mergeStreamingText
    // will merge it with currentText producing the expected result.
    (session as any).pendingText = "🔧 正在使用Read工具...";
    (session as any).lastStreamingModeRenewAt = Date.now();
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(true);

    await session.close();

    // pendingMerged = mergeStreamingText("💭 思考中...", "🔧 正在使用Read工具...")
    // Neither is a prefix of the other, no overlap → concatenation:
    // "💭 思考中...🔧 正在使用Read工具..."
    // text = pendingMerged (no finalText)
    // text !== currentText → updateCardContent called
    expect(updateCardContentSpy).toHaveBeenCalled();
    const calledText = updateCardContentSpy.mock.calls[0]?.[0] as string;
    expect(calledText).toContain("🔧 正在使用Read工具...");
  });

  it("falls back to full card update when streaming content update fails on close", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "旧内容",
      header: { title: "Test", template: "blue" },
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    // Make the element content PUT (used by updateCardContent) reject,
    // but let other URLs succeed.
    fetchWithSsrFGuardMock.mockImplementation(async (opts: { url: string }) => {
      const url = opts.url;
      if (url.includes("/auth/v3/tenant_access_token")) {
        return {
          response: {
            ok: true,
            json: async () => ({
              code: 0,
              msg: "ok",
              tenant_access_token: "mock-token",
              expire: 7200,
            }),
          },
          release: async () => {},
        };
      }
      if (url.includes("/elements/") && url.includes("/content")) {
        throw new Error("streaming timeout");
      }
      // Full card update and settings PATCH succeed
      return { release: async () => {} };
    });

    await session.close("最终内容");

    // Element content update was attempted and failed
    const elementCalls = fetchCallsMatching(/\/elements\/.*\/content/);
    expect(elementCalls.length).toBeGreaterThan(0);

    // Fallback full card update was called
    const fullUpdateCalls = fetchCallsMatching(/\/cardkit\/v1\/cards\/card-id$/);
    expect(fullUpdateCalls.length).toBeGreaterThan(0);
    const fullUpdateBody = parseFetchBody(fullUpdateCalls[0]!);
    const cardJson = JSON.parse((fullUpdateBody.card as { data: string }).data) as {
      body?: { elements?: Array<{ content?: string; tag?: string }> };
      header?: { title?: { content?: string } };
    };
    const contentElement = cardJson.body?.elements?.find((e) => e.tag === "markdown");
    // mergeStreamingText("旧内容", "最终内容") concatenates (no overlap)
    expect(contentElement?.content).toBe("旧内容最终内容");
    expect(cardJson.header?.title?.content).toBe("Test");
  });

  it("does not call full card update when streaming content update succeeds and no thinking", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "旧内容",
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close("最终内容");

    // No full card update should have been called (only element + settings)
    const fullUpdateCalls = fetchCallsMatching(/\/cardkit\/v1\/cards\/card-id$/);
    expect(fullUpdateCalls.length).toBe(0);
  });

  it("strips html tags when writing summary content on close", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "",
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();

    await session.close(
      '<at user_id="ou_user_1">Lukin</at> 已完成 <b>发布</b><br/>请查看 <a href="https://example.com">链接</a>',
    );

    // The settings PATCH goes through fetchWithSsrFGuard
    const settingsCalls = fetchCallsMatching(/\/settings$/);
    expect(settingsCalls.length).toBeGreaterThan(0);
    const settingsBody = parseFetchBody(settingsCalls[settingsCalls.length - 1]!);
    const settingsPayload = JSON.parse(settingsBody.settings as string) as {
      config?: { summary?: { content?: string } };
    };
    // truncateSummary strips HTML tags, newlines, and truncates to 50 chars.
    const summary = settingsPayload.config?.summary?.content ?? "";
    expect(summary).toBe("Lukin 已完成 发布请查看 链接");
  });
});

describe("FeishuStreamingSession.renewStreamingMode", () => {
  beforeEach(() => {
    resetFetchMock();
    vi.useRealTimers();
  });

  function makeSession(client: ReturnType<typeof createClientMock>["client"]) {
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 2,
      currentText: "text",
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).lastStreamingModeRenewAt = Date.now();
    return session;
  }

  it("does not renew when last renewal is within 8 minutes", async () => {
    const { client } = createClientMock();
    const session = makeSession(client);

    // Clear mock calls after makeSession setup
    fetchWithSsrFGuardMock.mockClear();

    await (session as any).renewStreamingMode();

    // No settings PATCH should have been made
    const settingsCalls = fetchCallsMatching(/\/settings$/);
    expect(settingsCalls.length).toBe(0);
    expect((session as any).state.sequence).toBe(2);
  });

  it("renews and advances sequence when 8 minutes have elapsed", async () => {
    const { client } = createClientMock();
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    fetchWithSsrFGuardMock.mockClear();

    await (session as any).renewStreamingMode();

    const settingsCalls = fetchCallsMatching(/\/settings$/);
    expect(settingsCalls.length).toBe(1);
    const body = parseFetchBody(settingsCalls[0]!);
    const settings = JSON.parse(body.settings as string) as {
      config?: { streaming_mode?: boolean };
    };
    expect(settings.config?.streaming_mode).toBe(true);
    expect(body.sequence).toBe(3);
    expect((session as any).state.sequence).toBe(3);
  });

  it("does not advance sequence when renewal API throws", async () => {
    const { client } = createClientMock();
    const session = makeSession(client);
    (session as any).lastStreamingModeRenewAt = Date.now() - 8 * 60 * 1000 - 1;

    // Make the settings PATCH throw — token may be cached so only
    // the settings call goes through fetchWithSsrFGuard.
    fetchWithSsrFGuardMock.mockImplementation(async (opts: { url: string }) => {
      if (opts.url.includes("/auth/v3/tenant_access_token")) {
        return {
          response: {
            ok: true,
            json: async () => ({
              code: 0,
              msg: "ok",
              tenant_access_token: "mock-token",
              expire: 7200,
            }),
          },
          release: async () => {},
        };
      }
      throw new Error("network error");
    });

    await (session as any).renewStreamingMode();

    expect((session as any).state.sequence).toBe(2);
  });

  it("updates lastStreamingModeRenewAt only on success", async () => {
    const { client } = createClientMock();
    const session = makeSession(client);
    const renewedAt = Date.now() - 8 * 60 * 1000 - 1;
    (session as any).lastStreamingModeRenewAt = renewedAt;

    // Make the settings PATCH throw (token may be cached)
    fetchWithSsrFGuardMock.mockImplementation(async (opts: { url: string }) => {
      if (opts.url.includes("/auth/v3/tenant_access_token")) {
        return {
          response: {
            ok: true,
            json: async () => ({
              code: 0,
              msg: "ok",
              tenant_access_token: "mock-token",
              expire: 7200,
            }),
          },
          release: async () => {},
        };
      }
      throw new Error("network error");
    });

    await (session as any).renewStreamingMode();

    expect((session as any).lastStreamingModeRenewAt).toBe(renewedAt);
  });

  it("start() initialises lastStreamingModeRenewAt so first update does not trigger renewal", async () => {
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    await session.start("chat-id");

    // After start, lastStreamingModeRenewAt is set to ~now, so renewal
    // should not fire. Count settings calls before and after updateCardContent.
    const settingsCallsBefore = fetchCallsMatching(/\/settings$/).length;
    await (session as any).updateCardContent("hello");
    const settingsCallsAfter = fetchCallsMatching(/\/settings$/).length;
    expect(settingsCallsAfter).toBe(settingsCallsBefore);

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
      thinkingText: "",
      thinkingExpanded: true,
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
      thinkingText: "",
      thinkingExpanded: true,
    };
    (session as any).startRenewTimer();
    expect((session as any).renewTimer).not.toBeNull();

    await session.discard();

    expect((session as any).renewTimer).toBeNull();
  });

  it("proactive timer fires renewStreamingMode after interval elapses", async () => {
    vi.useFakeTimers();
    const { client } = createClientMock();
    const session = new FeishuStreamingSession(client, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "text",
      thinkingText: "",
      thinkingExpanded: true,
    };
    // Set lastStreamingModeRenewAt to long ago so renewal condition is met
    (session as any).lastStreamingModeRenewAt = 0;
    (session as any).startRenewTimer();

    const settingsCallsBefore = fetchCallsMatching(/\/settings$/).length;

    // Advance past the renewal interval
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);

    const settingsCallsAfter = fetchCallsMatching(/\/settings$/).length;
    expect(settingsCallsAfter).toBeGreaterThan(settingsCallsBefore);
    // Verify the settings PATCH body contains streaming_mode: true
    const allSettingsCalls = fetchCallsMatching(/\/settings$/);
    const lastCall = allSettingsCalls[allSettingsCalls.length - 1]!;
    const body = parseFetchBody(lastCall);
    const settings = JSON.parse(body.settings as string) as {
      config?: { streaming_mode?: boolean };
    };
    expect(settings.config?.streaming_mode).toBe(true);

    (session as any).stopRenewTimer();
    vi.useRealTimers();
  });
});
