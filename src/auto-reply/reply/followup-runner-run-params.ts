import type { FollowupRun } from "./queue.js";

export function buildFollowupStablePromptParams(
  run: Pick<FollowupRun["run"], "extraSystemPrompt" | "stableExtraSystemPrompt">,
): {
  extraSystemPrompt?: string;
  stableExtraSystemPrompt?: string;
} {
  return {
    extraSystemPrompt: run.extraSystemPrompt,
    stableExtraSystemPrompt: run.stableExtraSystemPrompt,
  };
}
