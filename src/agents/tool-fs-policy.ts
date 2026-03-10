import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  allowReadOutsideWorkspace?: boolean;
};

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  allowReadOutsideWorkspace?: boolean;
}): ToolFsPolicy {
  return {
    workspaceOnly: params.workspaceOnly === true,
    allowReadOutsideWorkspace: params.allowReadOutsideWorkspace === true,
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  allowReadOutsideWorkspace?: boolean;
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
    allowReadOutsideWorkspace:
      agentFs?.allowReadOutsideWorkspace ?? globalFs?.allowReadOutsideWorkspace,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}
