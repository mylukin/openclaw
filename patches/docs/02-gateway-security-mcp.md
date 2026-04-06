# Patch 02: Gateway 安全加固 — Node 覆盖策略、会话归档重写与安全审计开关

## 为什么要改 (Why)

### 问题 1: 节点命令策略只支持全局级别

`node-command-policy.ts` 只支持全局 `allowCommands` / `denyCommands`，无法按节点粒度控制命令权限。运维场景中，不同节点（如开发机 vs 生产手机）需要不同的命令策略。例如：开发节点允许 `browser.proxy`，但生产手机需要禁止 `camera.snap`。

### 问题 2: 安全审计不覆盖节点级覆盖配置

`audit-extra.sync.ts` 中的 `collectNodeDenyCommandPatternFindings` 和 `collectNodeDangerousAllowCommandFindings` 只检查全局 `denyCommands` / `allowCommands`，忽略了 `overrides.*` 下的配置，导致错误配置的节点级策略不被发现。

### 问题 3: chat-sanitize 遗漏 input_text/output_text 格式

`stripEnvelopeFromMessage` 只处理 `type: "text"` 的内容块，忽略了 `input_text` 和 `output_text` 类型（Anthropic Responses API 格式），导致元数据未被清理。

---

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/gateway/node-command-policy.ts` | 新增 `resolveNodeOverride()` 函数实现三级匹配优先级（nodeId 精确 > displayName 精确 > nodeId 前缀最长匹配）；`resolveNodeCommandAllowlist` 签名扩展；新增 `NodeCommandConfigEntry` 类型和 `formatNodeOverrideConfigPath()` 辅助函数 |
| `src/security/audit-extra.sync.ts` | 重构为遍历全局 + per-node override 的命令列表，审计发现覆盖所有层级 |
| `src/gateway/chat-sanitize.ts` | `stripEnvelopeFromContentWithRole` 现在处理 `input_text` 和 `output_text` 类型 |
| `src/gateway/session-archive.fs.ts` | 全面重写：新增 `canonicalizePathForComparison()`、`resolveSessionTranscriptCandidates()`、`archiveFileOnDisk()`、`archiveSessionTranscripts()`、`cleanupArchivedSessionTranscripts()`；归档转录文件时同时归档关联的 prompt 文件 |
| `src/gateway/session-archive.runtime.ts` | 重新导出源变更，对齐 `session-archive.fs.ts` 的新公共接口 |
| `src/gateway/chat-sanitize.test.ts` | `input_text` / `output_text` 类型清理的单元测试 |
| `src/gateway/gateway-misc.test.ts` | Gateway 杂项功能（含节点覆盖策略）的单元测试 |
| `src/security/audit.test.ts` | 节点级 override 审计发现覆盖的单元测试 |

---

## 伪代码 (Pseudocode)

### 节点命令覆盖策略解析

```
function resolveNodeCommandAllowlist(cfg, node):
    platformId = normalizePlatformId(node.platform, node.deviceFamily)
    base = PLATFORM_DEFAULTS[platformId]
    
    // 全局配置
    extraGlobal = cfg.gateway.nodes.allowCommands ?? []
    denyGlobal  = cfg.gateway.nodes.denyCommands ?? []
    
    // 节点级覆盖查找
    override = resolveNodeOverride(cfg, node)
    extraNode = override?.allowCommands ?? []
    denyNode  = override?.denyCommands ?? []
    
    // 合并: 平台默认 + 全局允许 + 节点允许
    allow = Set([...base, ...extraGlobal, ...extraNode])
    
    // 删除: 全局拒绝 + 节点拒绝 (deny 优先于 allow)
    for cmd in [...denyGlobal, ...denyNode]:
        allow.delete(cmd)
    
    return allow

function resolveNodeOverride(cfg, node):
    overrides = cfg.gateway.nodes.overrides
    if !overrides or !node: return undefined
    
    // 优先级 1: nodeId 精确匹配
    if node.nodeId and overrides[node.nodeId]:
        return overrides[node.nodeId]
    
    // 优先级 2: displayName 精确匹配
    if node.displayName and overrides[node.displayName]:
        return overrides[node.displayName]
    
    // 优先级 3: nodeId 前缀最长匹配 (跳过空键)
    bestKey = undefined
    for key in overrides.keys():
        if key and node.nodeId.startsWith(key):
            if !bestKey or key.length > bestKey.length:
                bestKey = key
    
    return bestKey ? overrides[bestKey] : undefined
```

### 安全审计 - 节点级覆盖检查

```
function collectNodeDenyCommandPatternFindings(cfg):
    // 收集所有层级的 deny 条目 (全局 + 每个 override)
    denyEntries = listConfiguredNodeDenyCommandEntries(cfg)
    // 收集所有层级的 allow 条目 (补充已知命令集)
    allowEntries = listConfiguredNodeAllowCommandEntries(cfg)
    knownCommands = listKnownNodeCommands(cfg)
    for entry in allowEntries:
        knownCommands.addAll(entry.values)
    
    for entry in denyEntries:
        for value in entry.values:
            if looksLikePattern(value):
                patternLike.push("{entry.path}: {value}")
            elif value not in knownCommands:
                unknownExact.push("{entry.path}: {value}")
    
    // 报告: 包含完整路径, 如 'gateway.nodes.overrides["node-a"].denyCommands: camera.*'
```

---

## 数据流程图 (Data Flow Diagram)

### 节点命令策略解析优先级

```
配置输入:
  gateway.nodes:
    allowCommands: [A]         ── 全局允许
    denyCommands: [B]          ── 全局拒绝
    overrides:
      "node-abc":              ── nodeId 精确匹配
        allowCommands: [C]
        denyCommands: [D]
      "node-":                 ── nodeId 前缀匹配
        denyCommands: [E]
      "my-display":            ── displayName 精确匹配
        allowCommands: [F]

节点 { nodeId: "node-abc", displayName: "my-display" } 的解析:

  匹配优先级:
  1. nodeId="node-abc" 精确匹配 ✓  -> 使用 overrides["node-abc"]
  2. displayName="my-display" (跳过, 已有更高优先级匹配)
  3. nodeId 前缀 "node-" (跳过)

  最终结果:
  allow = PLATFORM_DEFAULTS + [A] + [C]
  deny  = [B] + [D]
  有效集 = allow - deny
```

---

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/gateway/node-command-policy.ts` | 177-204 | `resolveNodeCommandAllowlist()` 签名扩展 + 合并逻辑 |
| `src/gateway/node-command-policy.ts` | 232-260 | `resolveNodeOverride()` 三级匹配优先级 |
| `src/gateway/node-command-policy.ts` | 240-246 | nodeId 精确匹配 + displayName 精确匹配 |
| `src/gateway/node-command-policy.ts` | 248-260 | nodeId 前缀最长匹配逻辑 |
| `src/security/audit-extra.sync.ts` | 213-281 | `listConfiguredNodeAllowCommandEntries()` 和 `listConfiguredNodeDenyCommandEntries()` |
| `src/security/audit-extra.sync.ts` | 1065-1133 | `collectNodeDenyCommandPatternFindings()` 重构为遍历所有层级 |
| `src/security/audit-extra.sync.ts` | 1135-1183 | `collectNodeDangerousAllowCommandFindings()` 重构为遍历所有层级 |
| `src/gateway/chat-sanitize.ts` | 47-50 | 扩展为处理 `input_text` / `output_text` 类型 |

---

## 后续修正 (Follow-up Fixes)

> **Commit 12 补充**: `resolveNodeCommandAllowlist` 调用处（`src/gateway/node-connect-reconcile.ts` 和 `src/gateway/server-methods/nodes.ts`）需要传入 `nodeId` 和 `displayName` 参数。此修正不属于本 patch，已在后续 commit 12 中完成。
