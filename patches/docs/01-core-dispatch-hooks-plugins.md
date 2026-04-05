# Patch 01: 核心分发管道 channelData 传递、Hook 元数据增强与插件基础设施加固

## 为什么要改 (Why)

### 问题 1: 分发管道缺少稳定的频道元数据透传

outbound 消息分发管道需要同时处理两类频道级信息：
- `payload.channelData` 这类发给频道适配器的原始频道负载
- 发送成功后才知道的 `messageId`、`chatId`、`channelId`、`threadId` 等投递结果元数据

之前这两部分信息没有形成完整闭环。这导致：
- `message_sending` hook 只能拿到有限的预发送上下文，无法稳定看到回复目标元数据
- `message_sent` hook 和 session transcript 无法拿到完整的投递结果元数据
- session mirror 无法稳定写入 `providerMessageId`、`providerMessageIds`、`chatId`、`threadId` 等信息

### 问题 2: LLM slug 生成器不支持 hook 级模型覆盖

`llm-slug-generator.ts` 直接使用 `parseModelRef` 解析模型，无法感知别名系统。当用户配置了 CLI 后端（如 `claude-cli`）作为主模型时，slug 生成失败，因为 CLI 后端不支持嵌入式 LLM 调用。

### 问题 3: 延迟插件重载销毁全局 hook runner

频道引导路径（channel-resolution.ts）在发现缺失频道时会尝试重新加载插件。新注册表替换全局 hook runner 后，启动时注册的 `message_received` 等 hook 被静默丢弃。

### 问题 4: 回退频道解析策略过于激进

`channel-selection.ts` 中的回退逻辑使用 `resolveAvailableKnownChannel`（检查频道是否"可用"），但这在频道插件还未完全加载时会误判，应退化为仅检查频道是否为已知频道。

---

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/infra/outbound/deliver.ts` | 新增 `buildMirrorMessageMeta()`、`buildDeliveryResultMetadata()` 函数；`emitMessageSent` 增加 `metadata` 字段；transcript mirror 写入时附带 `messageMeta` |
| `src/hooks/message-hook-mappers.ts` | `CanonicalInboundMessageHookContext` 新增 `channelData` 字段；`CanonicalSentMessageHookContext` 新增 `metadata` 字段 |
| `src/plugins/hooks.ts` | `runMessageSending` 合并结果时新增 `metadata` 合并逻辑；新增 `chat_member_user_added` 等 hook |
| `src/plugins/hook-runner-global.ts` | `initializeGlobalHookRunner` 检测新注册表是否缺少旧注册表的 hook，缺失时合并保留 |
| `src/infra/outbound/channel-resolution.ts` | 移除 `resolveDirectFromActiveRegistry`；当已有频道插件加载时跳过引导，避免重载 |
| `src/infra/outbound/channel-selection.ts` | 回退频道解析从 `resolveAvailableKnownChannel` 改为 `resolveKnownChannel` |
| `src/hooks/llm-slug-generator.ts` | 引入 `buildModelAliasIndex` + `resolveModelRefFromString`；支持 hook 级 model 覆盖；CLI 后端自动回退到默认嵌入式提供商 |
| `src/config/sessions/types.ts` | 新增 `CliSessionBinding`、`CliPromptLoadStatus` 类型 |
| `src/config/sessions/transcript.ts` | 新增 `appendCliTurnToSessionTranscript`；`appendAssistantMessageToSessionTranscript` 增加 `messageMeta` 参数 + leafId 保护 |
| `src/plugins/runtime/types-core.ts` | 新增运行时类型定义（`PluginHookChatMemberBotEvent`、`PluginHookChatMemberUserEvent`） |
| `src/channels/plugins/registry.ts` | 频道插件缓存增加 `sourceSignature` 防止虚假缓存命中 |

---

## 伪代码 (Pseudocode)

### 频道元数据在分发管道中的传递

```
function deliverOutboundPayloadsCore(params):
    normalizedPayloads = normalizePayloadsForChannelDelivery(payloads, channel)
    mirrorFallback = resolveMirrorFallbackContent(normalizedPayloads)
    
    for each payload in normalizedPayloads:
        hookResult = applyMessageSendingHook({
            payload, to, channel, accountId,
            replyToId: params.replyToId,   // 新增: 传递 replyToId
            threadId: params.threadId       // 新增: 传递 threadId
        })
        if hookResult.cancelled: continue
        
        delivery = sendPayload(payload)
        emitMessageSent({
            success: true,
            content: text,
            messageId: delivery.messageId,
            metadata: buildDeliveryResultMetadata(delivery)  // 新增: 从投递结果提取 chatId/channelId/meta
        })
    
    if mirror and results.length > 0:
        messageMeta = buildMirrorMessageMeta({
            channel, accountId, replyToId, threadId,
            mirror, results
        })
        appendAssistantMessageToSessionTranscript({
            sessionKey, text, messageMeta  // 新增: 元数据写入转录
        })
```

### 防止延迟插件重载销毁 hook runner

```
function initializeGlobalHookRunner(newRegistry):
    prev = state.registry
    if prev exists and prev != newRegistry and prev.typedHooks not empty:
        newPluginIds = Set(newRegistry.typedHooks.map(h => h.pluginId))
        missingPluginIds = Set()
        for each hook in prev.typedHooks:
            if hook.pluginId not in newPluginIds:
                missingPluginIds.add(hook.pluginId)
        
        if missingPluginIds not empty:
            // 合并: 新注册表 hook + 旧注册表中缺失的 hook
            mergedTypedHooks = [...newRegistry.typedHooks,
                                ...prev.typedHooks.filter(h => h.pluginId in missingPluginIds)]
            mergedPlugins = [...newRegistry.plugins,
                            ...prev.plugins.filter(p => p.id in missingPluginIds)]
            newRegistry = { ...newRegistry, typedHooks: mergedTypedHooks, plugins: mergedPlugins }
    
    state.registry = newRegistry
    state.hookRunner = createHookRunner(newRegistry, options)
```

### Hook 级模型覆盖 (LLM slug 生成器)

```
function generateSlugViaLLM(params):
    aliasIndex = buildModelAliasIndex(cfg)
    
    // 1. 尝试 hook 级 model 覆盖
    hookModelRaw = cfg.hooks.internal.entries["session-memory"].model
    if hookModelRaw is valid string:
        hookResolved = resolveModelRefFromString(hookModelRaw, aliasIndex)
        if hookResolved and not isCliProvider(hookResolved.provider):
            provider = hookResolved.provider
            model = hookResolved.model
            -> 使用 hook 配置的模型
    
    // 2. 回退到 agent 主模型
    modelRef = resolveAgentEffectiveModelPrimary(cfg, agentId)
    resolved = resolveModelRefFromString(modelRef, aliasIndex)
    
    // 3. CLI 后端回退到默认嵌入式提供商
    if isCliProvider(resolved.provider):
        provider = DEFAULT_PROVIDER  // "anthropic"
        model = DEFAULT_MODEL
    
    timeoutMs = resolveSlugTimeoutMs(cfg)  // 从 hook 配置读取, 限制在 5s~300s
    return runEmbeddedPiAgent({ provider, model, timeoutMs, trigger: "memory", ... })
```

---

## 数据流程图 (Data Flow Diagram)

### 频道元数据分发管道

```
消息发送请求
     |
     v
+---------------------------+
| deliverOutboundPayloadsCore|
| (deliver.ts:683)          |
+---------------------------+
     |
     | 1. 规范化 payloads
     v
+----------------------------+
| applyMessageSendingHook    |
| - replyToId/threadId 传入  |  <-- 新增
| - mediaUrls 传入           |
+----------------------------+
     |
     | 2. 将 payload.channelData / interactive
     |    继续传给频道适配器
     v
+----------------------------+
| sendPayload / sendText     |
| -> OutboundDeliveryResult  |
|    { messageId, chatId,    |
|      channelId, meta }     |
+----------------------------+
     |
     | 3a. 触发 message_sent hook           3b. 写入转录 mirror
     v                                       v
+----------------------------+    +----------------------------------+
| emitMessageSent()          |    | appendAssistantMessageToSession  |
| - messageId                |    |   Transcript()                   |
| - metadata (chatId,        |    | - messageMeta: {                 |
|   channelId, result.meta)  |    |     channel, chatId, chatType,   |
+----------------------------+    |     providerMessageId,            |
                                  |     providerMessageIds,           |
                                  |     parentId, threadId }          |
                                  +----------------------------------+
```

### 插件重载 Hook 保护

```
Gateway 启动
     |
     v
loadOpenClawPlugins()
     |
     v
initializeGlobalHookRunner(registry_A)
  -> state.registry = registry_A
  -> hook runner 持有: [message_received, ...]
     |
     ~~~~ 运行时 ~~~~
     |
     v
频道引导 / 提供商发现
     |
     v
loadOpenClawPlugins() -> registry_B (可能缺少 hook)
     |
     v
initializeGlobalHookRunner(registry_B)
  -> 检测 registry_A 中有 hook 在 registry_B 中缺失
  -> 合并: merged_registry = registry_B + 缺失的 hook from registry_A
  -> state.hookRunner = createHookRunner(merged_registry)
  -> message_received hook 得到保留 ✓
```

---

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/infra/outbound/deliver.ts` | 317 | `MessageSentEvent` 新增 `metadata` 字段 |
| `src/infra/outbound/deliver.ts` | 325-370 | `buildMirrorMessageMeta()` 函数定义 |
| `src/infra/outbound/deliver.ts` | 380-400 | `buildDeliveryResultMetadata()` 函数定义 |
| `src/infra/outbound/deliver.ts` | 827-847 | `emitMessageSent` 调用处附加 `metadata` |
| `src/infra/outbound/deliver.ts` | 922-935 | transcript mirror 写入时附加 `messageMeta` |
| `src/plugins/hook-runner-global.ts` | 38-71 | `initializeGlobalHookRunner` 合并保护逻辑 |
| `src/plugins/hook-runner-global.ts` | 87 | `hookCount` 从 `registry.typedHooks.length` 读取 |
| `src/plugins/hooks.ts` | 706-712 | `runMessageSending` 结果合并新增 `metadata` |
| `src/hooks/llm-slug-generator.ts` | 33-51 | `resolveSlugTimeoutMs()` 从 hook 配置读取超时 |
| `src/hooks/llm-slug-generator.ts` | 78-117 | hook 级模型覆盖 + CLI 回退逻辑 |
| `src/hooks/message-hook-mappers.ts` | 45 | `CanonicalInboundMessageHookContext` 新增 `channelData` |
| `src/hooks/message-hook-mappers.ts` | 59 | `CanonicalSentMessageHookContext` 新增 `metadata` |
| `src/infra/outbound/channel-resolution.ts` | 44-48 | 已有频道插件时跳过引导（early return） |
| `src/infra/outbound/channel-selection.ts` | 161 | 回退改为 `resolveKnownChannel` |
| `src/config/sessions/types.ts` | 68-83 | `CliSessionBinding` 和 `CliPromptLoadStatus` 类型定义 |
| `src/config/sessions/transcript.ts` | 168-216 | `appendCliTurnToSessionTranscript()` 函数定义 |
| `src/config/sessions/transcript.ts` | 277-310 | `appendAssistantMessageToSessionTranscript()` 的 leafId 保护 |
| `src/channels/plugins/registry.ts` | 24 | 频道插件缓存结构增加 `sourceSignature` |
