import { describe, expect, it } from "vitest";
import { enrichMentionPlaceholders } from "./send.js";

describe("enrichMentionPlaceholders", () => {
  it("replaces @_user_N placeholders with @name", () => {
    const content = "@_user_1 登陆了，@_user_2 也来了";
    const mentions = [
      { key: "@_user_1", name: "张三" },
      { key: "@_user_2", name: "李四" },
    ];
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@张三 登陆了，@李四 也来了");
  });

  it("handles prefix collision: @_user_1 vs @_user_10", () => {
    const content = "@_user_1 和 @_user_10 都在";
    const mentions = [
      { key: "@_user_1", name: "Alice" },
      { key: "@_user_10", name: "Bob" },
    ];
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@Alice 和 @Bob 都在");
  });

  it("returns content unchanged when mentions is empty or undefined", () => {
    expect(enrichMentionPlaceholders("hello @_user_1", undefined)).toBe("hello @_user_1");
    expect(enrichMentionPlaceholders("hello @_user_1", [])).toBe("hello @_user_1");
  });

  it("skips entries with missing key or name", () => {
    const content = "@_user_1 和 @_user_2 在";
    const mentions = [
      { key: "@_user_1", name: "Alice" },
      { key: "@_user_2", name: undefined },
      { key: undefined, name: "Ghost" },
    ] as Array<{ key?: string; name?: string }>;
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@Alice 和 @_user_2 在");
  });

  it("trims whitespace-only keys and names", () => {
    const content = "@_user_1 hi";
    const mentions = [
      { key: "  ", name: "Alice" },
      { key: "@_user_1", name: "  " },
    ];
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@_user_1 hi");
  });
});
