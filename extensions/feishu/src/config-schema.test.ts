import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";

describe("FeishuConfigSchema dispatchMode", () => {
  it("accepts dispatchMode at account level", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      accounts: {
        alpha: {
          appId: "app",
          appSecret: "secret",
          dispatchMode: "plugin",
        },
      },
    });

    expect(parsed.accounts?.alpha?.dispatchMode).toBe("plugin");
  });

  it("rejects invalid dispatchMode values", () => {
    expect(() =>
      FeishuConfigSchema.parse({
        accounts: {
          alpha: {
            appId: "app",
            appSecret: "secret",
            // oxlint-disable-next-line typescript/no-explicit-any
            dispatchMode: "invalid" as any,
          },
        },
      }),
    ).toThrow();
  });
});
