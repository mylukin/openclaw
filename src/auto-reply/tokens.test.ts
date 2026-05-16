import { describe, it, expect } from "vitest";
import {
  couldBeSilentTokenStart,
  isAutonomousSilentReply,
  isSilentReplyPrefixText,
  isSilentReplyTailFragmentText,
  isSilentReplyText,
  stripSilentToken,
} from "./tokens.js";

describe("isSilentReplyText", () => {
  it("returns true for exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("\nNO_REPLY\n")).toBe(true);
  });

  it("returns true for mixed-case token", () => {
    expect(isSilentReplyText("no_reply")).toBe(true);
    expect(isSilentReplyText("  No_RePlY  ")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("")).toBe(false);
  });

  it("returns false for substantive text ending with token (#19537)", () => {
    const text = "Here is a helpful response.\n\nNO_REPLY";
    expect(isSilentReplyText(text)).toBe(false);
  });

  describe("isAutonomousSilentReply", () => {
    it("matches exact token like isSilentReplyText", () => {
      expect(isAutonomousSilentReply("NO_REPLY")).toBe(true);
      expect(isAutonomousSilentReply("  no_reply  ")).toBe(true);
      expect(isAutonomousSilentReply(undefined)).toBe(false);
      expect(isAutonomousSilentReply("")).toBe(false);
    });

    it("treats a trailing standalone NO_REPLY line as silent (the repro)", () => {
      const text =
        "Final audit exit=0, cleanup completed without errors. Archive at\n" +
        "/Users/lukin/AgentData/shared/archives/monitor-state-cleanup/20260516T090400Z.json\n" +
        "(archived 2 tasks + 1 promise from chief).\n\nNO_REPLY";
      expect(isAutonomousSilentReply(text)).toBe(true);
      // Interactive path must still deliver this (#19537 preserved).
      expect(isSilentReplyText(text)).toBe(false);
    });

    it("unwraps markdown emphasis around the trailing token", () => {
      expect(isAutonomousSilentReply("done.\n\n**NO_REPLY**")).toBe(true);
      expect(isAutonomousSilentReply("done.\n*NO_REPLY*")).toBe(true);
    });

    it("does NOT match when token is mid-text, not the last line", () => {
      expect(isAutonomousSilentReply("NO_REPLY\nbut actually here is the answer")).toBe(false);
      expect(isAutonomousSilentReply("see NO_REPLY in docs for details")).toBe(false);
    });

    it("does NOT match a last line that merely contains the token", () => {
      expect(isAutonomousSilentReply("status\nthe result was NO_REPLY today")).toBe(false);
    });
  });

  it("returns false for substantive text starting with token", () => {
    const text = "NO_REPLY but here is more content";
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("returns false for token embedded in text", () => {
    expect(isSilentReplyText("Please NO_REPLY to this")).toBe(false);
  });

  it("works with custom token", () => {
    expect(isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyText("Checked inbox. HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(false);
  });
});

describe("stripSilentToken", () => {
  it("strips token from end of text", () => {
    expect(stripSilentToken("Done.\n\nNO_REPLY")).toBe("Done.");
  });

  it("does not strip token from start of text", () => {
    expect(stripSilentToken("NO_REPLY 👍")).toBe("NO_REPLY 👍");
  });

  it("strips token with emoji (#30916)", () => {
    expect(stripSilentToken("😄 NO_REPLY")).toBe("😄");
  });

  it("does not strip embedded token suffix without whitespace delimiter", () => {
    expect(stripSilentToken("interject.NO_REPLY")).toBe("interject.NO_REPLY");
  });

  it("strips only trailing occurrence", () => {
    expect(stripSilentToken("NO_REPLY ok NO_REPLY")).toBe("NO_REPLY ok");
  });

  it("returns empty string when only token remains", () => {
    expect(stripSilentToken("NO_REPLY")).toBe("");
    expect(stripSilentToken("  NO_REPLY  ")).toBe("");
  });

  it("strips token preceded by bold markdown formatting", () => {
    expect(stripSilentToken("**NO_REPLY")).toBe("");
    expect(stripSilentToken("some text **NO_REPLY")).toBe("some text");
    expect(stripSilentToken("reasoning**NO_REPLY")).toBe("reasoning");
  });

  it("works with custom token", () => {
    expect(stripSilentToken("done HEARTBEAT_OK", "HEARTBEAT_OK")).toBe("done");
  });
});

describe("isSilentReplyPrefixText", () => {
  it("matches uppercase token lead fragments", () => {
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPrefixText("  HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects ambiguous natural-language prefixes", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
  });

  it("keeps underscore guard for non-NO_REPLY tokens", () => {
    expect(isSilentReplyPrefixText("HE", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEART", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });
});

describe("couldBeSilentTokenStart", () => {
  it("matches uppercase-only prefixes shorter than token", () => {
    expect(couldBeSilentTokenStart("N")).toBe(true);
    expect(couldBeSilentTokenStart("NO")).toBe(true);
    expect(couldBeSilentTokenStart("NO_")).toBe(true);
    expect(couldBeSilentTokenStart("NO_RE")).toBe(true);
  });

  it("returns false for exact full token (not a strict prefix)", () => {
    expect(couldBeSilentTokenStart("NO_REPLY")).toBe(false);
  });

  it("rejects lowercase / mixed case", () => {
    expect(couldBeSilentTokenStart("No")).toBe(false);
    expect(couldBeSilentTokenStart("no")).toBe(false);
    expect(couldBeSilentTokenStart("No_Reply")).toBe(false);
  });

  it("rejects non-prefix matches", () => {
    expect(couldBeSilentTokenStart("NO_X")).toBe(false);
    expect(couldBeSilentTokenStart("NX")).toBe(false);
    expect(couldBeSilentTokenStart("HELLO")).toBe(false);
  });

  it("rejects text with non-token characters", () => {
    expect(couldBeSilentTokenStart("NO ")).toBe(false);
    expect(couldBeSilentTokenStart("NO:")).toBe(false);
    expect(couldBeSilentTokenStart("NO_REPLY: reason")).toBe(false);
  });

  it("works with HEARTBEAT_OK token", () => {
    expect(couldBeSilentTokenStart("HEART", "HEARTBEAT_OK")).toBe(true);
    expect(couldBeSilentTokenStart("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(false);
  });

  it("handles undefined/empty", () => {
    expect(couldBeSilentTokenStart(undefined)).toBe(false);
    expect(couldBeSilentTokenStart("")).toBe(false);
  });
});

describe("isSilentReplyTailFragmentText", () => {
  it("matches standalone silent-token tail fragments", () => {
    expect(isSilentReplyTailFragmentText("_REPLY")).toBe(true);
    expect(isSilentReplyTailFragmentText("  _REPLY  ")).toBe(true);
  });

  it("rejects full tokens and regular text", () => {
    expect(isSilentReplyTailFragmentText("NO_REPLY")).toBe(false);
    expect(isSilentReplyTailFragmentText("REPLY")).toBe(false);
    expect(isSilentReplyTailFragmentText("x_REPLY")).toBe(false);
    expect(isSilentReplyTailFragmentText("_REPLY done")).toBe(false);
  });
});
