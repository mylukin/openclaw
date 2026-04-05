# Patch 02: Gateway 安全加固 — Node 覆盖策略、MCP HTTP 桥接与安全审计开关

## 为什么要改 (Why)

### 问题 1: 节点命令策略只支持全局级别

`node-command-policy.ts` 只支持全局 `allowCommands` / `denyCommands`，无法按节点粒度控制命令权限。运维场景中，不同节点（如开发机 vs 生产手机）需要不同的命令策略。例如：开发节点允许 `browser.proxy`，但生产手机需要禁止 `camera.snap`。

### 问题 2: 缺少 MCP HTTP 桥接

外部 AI 客户端（如 Claude Code）需要通过 MCP 协议调用 OpenClaw 工具。原有的 WebSocket 通道需要 TLS 证书，在本地环回（loopback）场景下不必要且增加配置复杂度。需要一个无状态 HTTP 传输层。

### 问题 3: 安全审计不覆盖节点级覆盖配置

`audit-extra.sync.ts` 中的 `collectNodeDenyCommandPatternFindings` 和 `collectNodeDangerousAllowCommandFindings` 只检查全局 `denyCommands` / `allowCommands`，忽略了 `overrides.*` 下的配置，导致错误配置的节点级策略不被发现。

### 问题 4: chat-sanitize 遗漏 input_text/output_text 格式

`stripEnvelopeFromMessage` 只处理 `type: "text"` 的内容块，忽略了 `input_text` 和 `output_text` 类型（Anthropic Responses API 格式），导致元数据未被清理。

---

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/gateway/mcp-http.ts` + 子模块 | MCP HTTP 桥接服务器，拆分为多个子模块：`mcp-http.ts` (114行, 主服务器)、`mcp-http.handlers.ts` (JSON-RPC 分发)、`mcp-http.runtime.ts` (工具缓存/配置)、`mcp-http.schema.ts` (schema 扁平化)、`mcp-http.request.ts` (请求解析)、`mcp-http.protocol.ts` (协议类型) |
| `src/gateway/node-command-policy.ts` | 新增 `resolveNodeOverride()` 函数实现三级匹配优先级（nodeId 精确 > displayName 精确 > nodeId 前缀最长匹配）；`resolveNodeCommandAllowlist` 签名扩展 |
| `src/security/audit-extra.sync.ts` | 重构为遍历全局 + per-node override 的命令列表，审计发现覆盖所有层级 |
| `src/gateway/server.impl.ts` | 启动时创建 MCP loopback 服务器 (动态端口)；配置通过 `createMcpLoopbackServerConfig()` 在 `mcp-http.runtime.ts` 中生成 |
| `src/gateway/chat-sanitize.ts` | `stripEnvelopeFromContentWithRole` 现在处理 `input_text` 和 `output_text` 类型 |
| `src/gateway/node-connect-reconcile.ts` 和 `src/gateway/server-methods/nodes.ts` | `resolveNodeCommandAllowlist` 调用处传入 `nodeId` 和 `displayName` |
| `src/gateway/session-archive.fs.ts` | 归档转录文件时同时归档关联的 prompt 文件 |

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

### MCP HTTP 桥接服务器

```
function startMcpLoopbackServer(port = 0):
    // 工具缓存: 按 (sessionKey, messageProvider, accountId, messageTo, messageThreadId) 分组, 30s TTL
    toolCache = Map<cacheKey, { tools, schema, time }>
    configRef = null
    
    httpServer = createHttpServer((req, res) =>
        if req.url != "/mcp" or req.method != "POST":
            return 404/405
        
        body = readBody(req)  // 1MB 限制, 10s 超时
        parsed = JSON.parse(body)
        
        // 从 HTTP 头提取上下文
        cfg = loadConfig()
        sessionKey = header("x-session-key") ?? resolveMainSessionKey(cfg)
        messageProvider = header("x-openclaw-message-channel")
        accountId = header("x-openclaw-account-id")
        
        // 获取/缓存工具列表 (配置变更时清空缓存)
        if configRef != cfg:
            toolCache.clear()
        { tools, toolSchema } = getOrCacheTools({ cfg, sessionKey, ... })
        
        // 处理 JSON-RPC 请求
        for msg in messages:
            switch msg.method:
                "initialize"  -> 协商协议版本, 返回服务器信息
                "tools/list"  -> 返回 toolSchema (过滤掉 NATIVE_TOOL_EXCLUDE)
                "tools/call"  -> 查找 tool, 执行 tool.execute(), 返回结果
                notification  -> return null (不需要响应)
        
        // 通知无响应 -> 202; 其他 -> 200 + JSON
    )
    
    httpServer.listen(port, "127.0.0.1")

function resolveGatewayScopedTools(params):
    // 完整的工具策略管道: 全局/Agent/提供商/群组/子代理策略
    effectivePolicy = resolveEffectiveToolPolicy(cfg, sessionKey)
    groupPolicy = resolveGroupToolPolicy(cfg, sessionKey, messageProvider, accountId)
    
    allTools = createOpenClawTools({ sessionKey, channel, accountId, ... })
    filtered = applyToolPolicyPipeline(allTools, [
        profilePolicy, providerProfilePolicy,
        globalPolicy, globalProviderPolicy,
        agentPolicy, agentProviderPolicy,
        groupPolicy, subagentPolicy
    ])
    
    // 排除 Claude Code 原生工具 (read, write, edit, exec, ...)
    return filtered.filter(t => !NATIVE_TOOL_EXCLUDE.has(t.name))
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

### MCP HTTP 桥接架构

```
Claude Code / 外部 AI 客户端
     |
     | POST http://127.0.0.1:{mcpPort}/mcp
     | Headers: x-session-key, x-openclaw-message-channel, ...
     | Body: JSON-RPC { method: "tools/list" | "tools/call", ... }
     |
     v
+-----------------------------------+
| MCP Loopback HTTP Server          |
| (mcp-http.ts, 127.0.0.1 only)    |
+-----------------------------------+
     |
     | 1. readBody (1MB 限制, 10s 超时)
     | 2. 从 HTTP 头提取上下文
     v
+-----------------------------------+
| 工具缓存层 (30s TTL)             |
| Key: sessionKey + provider + ...  |
| 配置变更时全量清空                |
+-----------------------------------+
     |
     | 3. resolveGatewayScopedTools()
     v
+-----------------------------------+
| 工具策略管道                      |
| profile -> providerProfile ->     |
| global -> globalProvider ->       |
| agent -> agentProvider -> group ->|
| subagent                          |
| 过滤: NATIVE_TOOL_EXCLUDE        |
+-----------------------------------+
     |
     | 4. flattenUnionSchema()
     |    (anyOf/oneOf -> 合并为单个 object)
     v
+-----------------------------------+
| handleJsonRpc()                   |
| initialize / tools/list /         |
| tools/call -> tool.execute()      |
+-----------------------------------+
     |
     | JSON-RPC 响应
     v
Claude Code / 外部客户端
```

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

### Gateway 启动集成

```
startGatewayServer(port)
     |
     +-- 启动 WSS 服务器 (port)
     |
     +-- 启动 MCP HTTP 服务器 (动态端口)    <-- 新增
     |      |
     |      +-- startMcpLoopbackServer(0)  // 端口由 OS 分配
     |      +-- createMcpLoopbackServerConfig(mcpPort)
     |      |      -> 生成配置对象
     |      |         { mcpServers: { openclaw: { type: "http", url: "..." } } }
     |
     +-- 关闭时: mcpServer.close()
```

---

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/gateway/mcp-http.runtime.ts` | 10 | `NATIVE_TOOL_EXCLUDE` 集合定义 |
| `src/gateway/mcp-http.runtime.ts` | 9 | `TOOL_CACHE_TTL_MS = 30_000` 工具缓存 TTL |
| `src/gateway/mcp-http.runtime.ts` | 81-97 | `createMcpLoopbackServerConfig()` 生成 MCP 配置对象 |
| `src/gateway/mcp-http.schema.ts` | 12-73 | `flattenUnionSchema()` anyOf/oneOf 扁平化 |
| `src/gateway/mcp-http.handlers.ts` | 33 | `handleMcpJsonRpc()` JSON-RPC 分发逻辑 |
| `src/gateway/mcp-http.request.ts` | 7 | `MAX_MCP_BODY_BYTES` (1MB) |
| `src/gateway/mcp-http.request.ts` | 72 | `readMcpHttpBody()` 请求体读取 |
| `src/gateway/mcp-http.ts` | 22-114 | `startMcpLoopbackServer()` 服务器实现 |
| `src/gateway/node-command-policy.ts` | 177-204 | `resolveNodeCommandAllowlist()` 签名扩展 + 合并逻辑 |
| `src/gateway/node-command-policy.ts` | 232-260 | `resolveNodeOverride()` 三级匹配优先级 |
| `src/gateway/node-command-policy.ts` | 240-246 | nodeId 精确匹配 + displayName 精确匹配 |
| `src/gateway/node-command-policy.ts` | 248-260 | nodeId 前缀最长匹配逻辑 |
| `src/security/audit-extra.sync.ts` | 213-281 | `listConfiguredNodeAllowCommandEntries()` 和 `listConfiguredNodeDenyCommandEntries()` |
| `src/security/audit-extra.sync.ts` | 1065-1133 | `collectNodeDenyCommandPatternFindings()` 重构为遍历所有层级 |
| `src/security/audit-extra.sync.ts` | 1135-1183 | `collectNodeDangerousAllowCommandFindings()` 重构为遍历所有层级 |
| `src/gateway/server.impl.ts` | 93 | 导入 MCP 模块 |
| `src/gateway/server.impl.ts` | 889-893 | 启动 MCP 服务器 |
| `src/gateway/server.impl.ts` | 1574 | 关闭时清理 MCP 服务器 |
| `src/gateway/chat-sanitize.ts` | 47-50 | 扩展为处理 `input_text` / `output_text` 类型 |
