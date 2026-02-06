import { afterEach, describe, expect, it, vi } from "vitest";

let mockConfig: Record<string, unknown> = {};

vi.mock("../config/config.js", () => ({
  loadConfig: () => mockConfig,
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class MockClient {
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  }

  return {
    Client: MockClient,
  };
});

describe("getFeishuClient default account resolution", () => {
  afterEach(() => {
    mockConfig = {};
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });

  it("uses first configured account when no default account key exists", async () => {
    mockConfig = {
      channels: {
        feishu: {
          accounts: {
            pm: {
              appId: "cli_pm",
              appSecret: "pm_secret",
            },
            architect: {
              appId: "cli_architect",
              appSecret: "arch_secret",
            },
          },
        },
      },
    };

    const { getFeishuClient } = await import("./client.js");
    const client = getFeishuClient() as { options?: { appId?: string; appSecret?: string } };

    expect(client.options?.appId).toBe("cli_pm");
    expect(client.options?.appSecret).toBe("pm_secret");
  });
});
