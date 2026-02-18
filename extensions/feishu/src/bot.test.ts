import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockCreateReplyDispatcherWithTyping,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: vi.fn(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockCreateReplyDispatcherWithTyping: vi.fn(() => ({
    dispatcher: {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => false),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: mockGetMessageFeishu,
}));

describe("handleFeishuMessage command authorization", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");

  beforeEach(() => {
    vi.clearAllMocks();
    setFeishuRuntime({
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:feishu:dm:ou-attacker",
            matchedBy: "default",
          })),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
          formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
          finalizeInboundContext: mockFinalizeInboundContext,
          dispatchReplyFromConfig: mockDispatchReplyFromConfig,
          createReplyDispatcherWithTyping: mockCreateReplyDispatcherWithTyping,
        },
        commands: {
          shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
          resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
        },
        pairing: {
          readAllowFromStore: mockReadAllowFromStore,
          upsertPairingRequest: mockUpsertPairingRequest,
          buildPairingReply: mockBuildPairingReply,
        },
      },
    } as unknown as PluginRuntime);
  });

  it("uses authorizer resolution instead of hardcoded CommandAuthorized=true", async () => {
    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["ou-admin"],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-auth-bypass-regression",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        }),
      } as RuntimeEnv,
    });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        CommandAuthorized: false,
        SenderId: "ou-attacker",
        Surface: "feishu",
      }),
    );
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-read-store-non-command",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello there" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        }),
      } as RuntimeEnv,
    });

    expect(mockReadAllowFromStore).toHaveBeenCalledWith("feishu");
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-unapproved",
        },
      },
      message: {
        message_id: "msg-pairing-flow",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        }),
      } as RuntimeEnv,
    });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockBuildPairingReply).toHaveBeenCalledWith({
      channel: "feishu",
      idLine: "Your Feishu user id: ou-unapproved",
      code: "ABCDEFGH",
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou-unapproved",
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-command-auth",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        }),
      } as RuntimeEnv,
    });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: false, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: false,
        SenderId: "ou-attacker",
      }),
    );
  });

  it("bypasses requireMention gate when dispatchMode=plugin and dispatches in plugin mode", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dispatchMode: "plugin",
          groups: {
            "oc-group-plugin": {
              requireMention: true,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-plugin-no-mention",
        chat_id: "oc-group-plugin",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello everyone" }),
        mentions: [],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        }),
      } as RuntimeEnv,
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        replyResolver: expect.any(Function),
      }),
    );
  });

  it("keeps DM auto reply path when dispatchMode=plugin", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dispatchMode: "plugin",
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-dm-user",
        },
      },
      message: {
        message_id: "msg-plugin-dm",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello in dm" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        }),
      } as RuntimeEnv,
    });

    expect(mockCreateReplyDispatcherWithTyping).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockDispatchReplyFromConfig.mock.calls[0]?.[0] as
      | { replyResolver?: unknown }
      | undefined;
    expect(dispatchArgs?.replyResolver).toBeUndefined();
  });

  it("always marks dispatch idle in plugin mode even when dispatch throws", async () => {
    const markDispatchIdle = vi.fn();
    mockCreateReplyDispatcherWithTyping.mockReturnValueOnce({
      dispatcher: {
        sendToolResult: vi.fn(() => false),
        sendBlockReply: vi.fn(() => false),
        sendFinalReply: vi.fn(() => false),
        waitForIdle: vi.fn(async () => {}),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle,
    });
    mockDispatchReplyFromConfig.mockRejectedValueOnce(new Error("plugin dispatch failed"));

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dispatchMode: "plugin",
          groups: {
            "oc-group-plugin-fail": {
              requireMention: true,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user",
        },
      },
      message: {
        message_id: "msg-plugin-fail",
        chat_id: "oc-group-plugin-fail",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello everyone" }),
        mentions: [],
      },
    };

    await expect(
      handleFeishuMessage({
        cfg,
        event,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new Error(`exit ${code}`);
          }),
        } as RuntimeEnv,
      }),
    ).resolves.toBeUndefined();

    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("injects ChannelData into finalized inbound context for plugin hooks", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group-channeldata": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-user-channeldata",
        },
        sender_type: "user",
      },
      message: {
        message_id: "msg-channel-data",
        chat_id: "oc-group-channeldata",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello channel data" }),
        root_id: "om-root",
        parent_id: "om-parent",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou-bot" },
            name: "Bot",
          },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        }),
      } as RuntimeEnv,
    });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChannelData: expect.objectContaining({
          messageId: "msg-channel-data",
          chatId: "oc-group-channeldata",
          chatType: "group",
          messageType: "text",
          rootId: "om-root",
          parentId: "om-parent",
          senderType: "user",
          senderOpenId: "ou-user-channeldata",
          mentions: expect.any(Array),
        }),
      }),
    );
  });
});
