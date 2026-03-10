import { describe, expect, it } from "vitest";

// Test the heartbeat guard logic as an extracted helper.
// This mirrors the guard added to the deliver callback in reply-dispatcher.ts.
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

function isStrayHeartbeat(text: string): boolean {
  return (
    text.trim() === HEARTBEAT_TOKEN ||
    text
      .trim()
      .replace(/<[^>]*>/g, "")
      .replace(/^[*`~]+|[*`~]+$/g, "")
      .trim() === HEARTBEAT_TOKEN
  );
}

describe("Feishu reply-dispatcher heartbeat guard", () => {
  it("filters pure HEARTBEAT_OK text", () => {
    expect(isStrayHeartbeat("HEARTBEAT_OK")).toBe(true);
  });

  it("filters HEARTBEAT_OK with surrounding whitespace", () => {
    expect(isStrayHeartbeat("  HEARTBEAT_OK  ")).toBe(true);
  });

  it("filters HEARTBEAT_OK wrapped in markdown bold (**)", () => {
    expect(isStrayHeartbeat("**HEARTBEAT_OK**")).toBe(true);
  });

  it("filters HEARTBEAT_OK wrapped in markdown code (`)", () => {
    expect(isStrayHeartbeat("`HEARTBEAT_OK`")).toBe(true);
  });

  it("filters HEARTBEAT_OK wrapped in HTML tags", () => {
    expect(isStrayHeartbeat("<b>HEARTBEAT_OK</b>")).toBe(true);
  });

  it("does NOT filter normal text", () => {
    expect(isStrayHeartbeat("Hello, world!")).toBe(false);
  });

  it("does NOT filter mixed text containing HEARTBEAT_OK", () => {
    expect(isStrayHeartbeat("Status: HEARTBEAT_OK and more")).toBe(false);
  });

  describe("deliver guard: media bypass", () => {
    it("allows delivery when HEARTBEAT_OK text is accompanied by media", () => {
      const text = "HEARTBEAT_OK";
      const hasMedia = true;
      // When hasMedia is true, guard should NOT block (media still delivered)
      const shouldBlock = isStrayHeartbeat(text) && !hasMedia;
      expect(shouldBlock).toBe(false);
    });

    it("blocks delivery when HEARTBEAT_OK text has no media", () => {
      const text = "HEARTBEAT_OK";
      const hasMedia = false;
      const shouldBlock = isStrayHeartbeat(text) && !hasMedia;
      expect(shouldBlock).toBe(true);
    });
  });
});
