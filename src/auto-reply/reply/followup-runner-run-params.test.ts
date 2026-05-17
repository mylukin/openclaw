import { describe, expect, it } from "vitest";
import { buildFollowupStablePromptParams } from "./followup-runner-run-params.js";

describe("buildFollowupStablePromptParams", () => {
  it("keeps queued stable prompt separate from dynamic turn context", () => {
    expect(
      buildFollowupStablePromptParams({
        extraSystemPrompt: "DYNAMIC_RECENT_GROUP_CONTEXT",
        stableExtraSystemPrompt: "STABLE_GROUP_SYSTEM_PROMPT",
      }),
    ).toEqual({
      extraSystemPrompt: "DYNAMIC_RECENT_GROUP_CONTEXT",
      stableExtraSystemPrompt: "STABLE_GROUP_SYSTEM_PROMPT",
    });
  });
});
