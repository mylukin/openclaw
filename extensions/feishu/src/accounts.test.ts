import { describe, expect, it } from "vitest";
import { resolveFeishuAccount } from "./accounts.js";

describe("resolveFeishuAccount renderMode fallback", () => {
  it("falls back to top-level renderMode when account override is missing", () => {
    const cfg = {
      channels: {
        feishu: {
          appId: "cli_xxx",
          appSecret: "secret_xxx",
          renderMode: "card",
          accounts: {
            pm: {
              appId: "cli_pm",
              appSecret: "secret_pm",
            },
          },
        },
      },
    } as any;

    const resolved = resolveFeishuAccount({ cfg, accountId: "architect" });
    expect(resolved.config.renderMode).toBe("card");
  });

  it("prefers account-level renderMode when present", () => {
    const cfg = {
      channels: {
        feishu: {
          appId: "cli_xxx",
          appSecret: "secret_xxx",
          renderMode: "card",
          accounts: {
            pm: {
              appId: "cli_pm",
              appSecret: "secret_pm",
              renderMode: "raw",
            },
          },
        },
      },
    } as any;

    const resolved = resolveFeishuAccount({ cfg, accountId: "pm" });
    expect(resolved.config.renderMode).toBe("raw");
  });
});
