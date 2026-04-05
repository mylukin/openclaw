# Patch 07: 飞书原生回复分发器与流式卡片

## 为什么要改 (Why)

这是飞书插件最核心的变更，解决了回复管线中多个长期问题：

1. **流式卡片缺乏思考面板和工具追踪**：原实现仅支持文本流式输出，用户在 agent 推理或调用工具时只看到静态"Thinking..."。需要可折叠的思考面板（collapsible panel）和工具执行状态的实时显示。

2. **流式模式 10 分钟超时**：飞书 Card Kit 的 `streaming_mode` 在最后一次 open 后 10 分钟自动关闭。长时间的 agent 调用（如代码执行）会导致流式更新静默失败，卡片停留在最后一次更新的状态。

3. **onIdle/deliver 竞态去重**：核心回复管线的 `onIdle` 和 `deliver` 回调可能几乎同时触发。没有去重机制会导致同一条回复被发送两次（一次通过流式卡片关闭，一次通过非流式发送）。

4. **Hook 改写后的 mention 格式变体**：`message_sending` hook 可能改写最终文本（如追加 @mention），导致去重比较失败。需要在比较前剥离 mention 标签。

5. **非流式路径缺少 message_sent 事件**：飞书回复分发器绕过了核心的 `deliverOutboundPayloads` 管线，导致 `message_sent` hook 没有被触发，下游消费者（如 bot-company journal）无法记录出站消息。

6. **流式卡片从原始 HTTP 迁移到 Lark SDK Card Kit API**：原实现直接构造 HTTP 请求，缺乏错误处理和类型安全。需要迁移到 Lark SDK 的 `cardkit.v1.card.*` 和 `cardkit.v1.cardElement.*` API。

---

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `extensions/feishu/src/reply-dispatcher.ts` | 核心回复分发器：新增思考面板追踪、工具计数、去重逻辑、message_sending hook 集成、media 事件发射 |
| `extensions/feishu/src/streaming-card.ts` | `FeishuStreamingSession` 类重构：Card Kit API 集成、`updateThinking()` 方法、8 分钟续期定时器、超时恢复、`discard()` 方法 |
| `extensions/feishu/src/send.ts` | 新增 `shouldUseFeishuMarkdownCard()` 导出、结构化卡片构建增强 |
| `extensions/feishu/src/send-result.ts` | 发送结果类型增强 |
| `extensions/feishu/src/reply-dispatcher.test.ts` | 大量新增测试：思考面板、工具追踪、hook 集成、去重 |
| `extensions/feishu/src/streaming-card.test.ts` | 大量新增测试：Card Kit API 调用、续期、超时恢复 |
| `extensions/feishu/src/send.test.ts` | 新增卡片构建和 mention 规范化测试 |

---

## 伪代码 (Pseudocode)

### 1. 回复分发器生命周期

```
function createFeishuReplyDispatcher(params):
    # --- 初始化 ---
    streaming = null
    streamText = ""
    reasoningText = ""
    toolCallCount = 0
    activeTools = []
    deliveredFinalTexts = Set()
    streamPhase = "idle"  # idle | thinking | tool | streaming
    finalTextEmitted = false

    # --- 回调注册 ---
    replyOptions = {
        onReasoningStream: (event) =>
            reasoningText = mergeReasoningDisplayText(reasoningText, event.text)
            queueThinkingPanelUpdate()

        onToolStart: (event) =>
            toolCallCount++
            activeTools.push({ toolCallId, name })
            streamPhase = "tool"
            startStreaming()  # 确保流式卡片已创建
            queueThinkingPanelUpdate()

        onToolResult: (event) =>
            removeActiveTool(event.toolCallId)
            queueThinkingPanelUpdate()

        onPartialReply: (event) =>
            startStreaming()
            streamPhase = "streaming"
            queueStreamingUpdate(event.text)

        onReasoningEnd: () =>
            markThinkingDone()
    }

    # --- deliver 回调（核心路径）---
    deliver = async (payload, info) =>
        if info.kind == "final":
            await deliverFinalPayload(payload)
        elif info.kind == "block":
            queueStreamingUpdate(payload.text)

    # --- onIdle 回调（流式结束）---
    onIdle = async () =>
        if deliverInFlight: return  # 避免与 deliver 竞态
        await closeStreaming(emitFinalText=true)
```

### 2. 流式卡片生命周期（FeishuStreamingSession）

```
class FeishuStreamingSession:
    state: { cardId, messageId, sequence, currentText,
             thinkingTitle, thinkingText, thinkingExpanded }
    renewTimer: interval

    async start(receiveId, receiveIdType, options):
        # 1. 创建卡片实体
        cardId = cardkit.v1.card.create({
            type: "card_json",
            data: JSON.stringify({
                schema: "2.0",
                config: { streaming_mode: true, summary: { content: "[Generating...]" } },
                body: { elements: [
                    { tag: "markdown", content: "⏳ Thinking...", element_id: "content" },
                    ...noteElements
                ] },
                header: options.header
            })
        })

        # 2. 发送消息（reply 或 create）
        messageId = im.message.reply/create(cardContent)

        # 3. 启动 8 分钟续期定时器
        startRenewTimer()

    async update(text, { replace }):
        # 节流：100ms 内最多一次更新
        if throttled: pendingText = text; scheduleFlush(); return
        # 通过 element-level API 推送
        cardkit.v1.cardElement.content(card_id, "content", text)

    async updateThinking(text, { title }):
        state.thinkingTitle = title
        state.thinkingText = text
        if needsFullCardUpdate:  # panel 首次渲染或 title 变化
            updateCardFull(currentText, keepStreaming=true)
        else:
            cardkit.v1.cardElement.content(card_id, "thinking_content", text)

    async close(finalText, { note }):
        stopRenewTimer()
        # 折叠思考面板
        state.thinkingExpanded = false
        # 最终全量卡片更新（streaming_mode=false）
        updateCardFull(finalText, keepStreaming=false, note)

    # --- 8 分钟续期 ---
    private renewStreamingMode():
        cardkit.v1.card.settings(card_id, { streaming_mode: true })

    # --- 超时恢复 ---
    private updateElementContent(elementId, text):
        try: pushElementContent(elementId, text)
        catch StreamingModeClosedError:
            # 重新打开 streaming_mode 并重试一次
            setStreamingModeEnabled(force=true, reason="reopen")
            pushElementContent(elementId, text)
```

### 3. 思考面板内容组合

```
function composeThinkingContent({ final }):
    sections = []
    toolOnlyPanel = !hasReasoningText AND toolCallCount > 0

    if reasoningText:
        sections.push(reasoningText)

    if toolCallCount > 0:
        currentTool = final ? null : getActiveRunningToolName()
        if currentTool:
            toolStatus = "⏳ Running " + currentTool + "..."
        else:
            toolStatus = ""

        if toolOnlyPanel:
            sections.push(toolStatus OR "✓ N completed")
        else:
            sections.push("🔧 Tool calls (N)\n\n" + toolStatus)

    title = toolOnlyPanel ? "🔧 Tool calls (N)" : "💭 Thinking"
    return { title, text: sections.join("\n\n") }
```

### 4. 去重系统

```
async function deliverFinalPayload(payload):
    deliverInFlight = true
    try:
        finalText = payload.text
        hookResult = await runMessageSending(finalText)
        if hookResult.cancelled: return

        effectiveText = hookResult.content ?? finalText

        if streaming?.isActive():
            # 流式路径：关闭卡片作为最终发送
            await closeStreamingWithFinalText(effectiveText)
        else:
            # 非流式路径：检查去重
            normalizedForDedup = stripMentionTags(effectiveText)
            if deliveredFinalTexts has normalizedForDedup:
                return  # 已通过流式卡片发送，跳过
            sendMessageOrCard(effectiveText)

        deliveredFinalTexts.add(stripMentionTags(effectiveText))
    finally:
        deliverInFlight = false
```

### 5. 工具追踪状态机

```
# 工具开始
onToolStart({ name: "Read", toolCallId: "tool-1" }):
    toolCallCount++  # 全局累加，不重置
    activeTools.push({ toolCallId: "tool-1", name: "Read" })
    streamPhase = "tool"
    --> 面板显示: "⏳ Running Read..."  title="🔧 Tool calls (1)"

# 第二个工具开始
onToolStart({ name: "Grep", toolCallId: "tool-2" }):
    toolCallCount++
    activeTools.push({ toolCallId: "tool-2", name: "Grep" })
    --> 面板显示: "⏳ Running Grep..."  title="🔧 Tool calls (2)"

# 第一个工具完成（乱序）
onToolResult({ toolCallId: "tool-1" }):
    activeTools.remove("tool-1")  # Grep 仍在运行
    --> 面板显示: "⏳ Running Grep..."  title="🔧 Tool calls (2)"

# 文本开始流式输出
onPartialReply({ text: "答案" }):
    streamPhase = "streaming"
    --> 面板显示: "✓ 2 completed"  # 所有工具标记完成
    --> 主内容显示: "答案"

# 流式结束
onIdle():
    --> 折叠思考面板
    --> 最终卡片: 思考面板(折叠) + "答案" + 脚注
```

---

## 数据流程图 (Data Flow Diagram)

### 回复分发器完整流程

```
Agent 开始回复
    |
    v
onReplyStart() --> typingCallbacks.start()
    |                 (添加 ⌨️ 反应)
    v
+-- onReasoningStream({ text: "思考中..." }) --------+
|   reasoningText = merge(reasoningText, text)        |
|   startStreaming() --> 创建流式卡片                  |
|   queueThinkingPanelUpdate()                        |
|   --> Card: collapsible_panel "💭 Thinking"         |
|       content: "思考中..."                           |
+---------+-------------------------------------------+
          |
          v
+-- onToolStart({ name: "Read" }) -------------------+
|   toolCallCount++                                   |
|   activeTools.push(Read)                            |
|   streamPhase = "tool"                              |
|   queueThinkingPanelUpdate()                        |
|   --> Card: "💭 Thinking"                           |
|       content: "思考中...\n\n🔧 Tool calls (1)\n   |
|                ⏳ Running Read..."                   |
+---------+-------------------------------------------+
          |
          v
+-- onToolResult({}) --------------------------------+
|   activeTools.pop()                                 |
|   queueThinkingPanelUpdate()                        |
|   --> Card: "🔧 Tool calls (1)"                    |
|       content: "✓ 1 completed"                      |
+---------+-------------------------------------------+
          |
          v
+-- onPartialReply({ text: "第一段" }) ---------------+
|   streamPhase = "streaming"                         |
|   streamText = "第一段"                              |
|   markThinkingDone()                                |
|   queueStreamingRender()                            |
|   --> Card 主内容: "第一段"                          |
+---------+-------------------------------------------+
          |
          v
+-- deliver({ text: "完整答案" }, kind="final") ------+
|   deliverInFlight = true                            |
|   hookResult = runMessageSending("完整答案")         |
|   if hookResult.cancelled: return                   |
|   effectiveText = hookResult.content ?? "完整答案"   |
|   closeStreaming(effectiveText)                      |
|   emitMessageSent(effectiveText)                    |
|   emitFinalTextIfNeeded(effectiveText)              |
|   deliverInFlight = false                           |
+---------+-------------------------------------------+
          |
          v
+-- onIdle() -----------------------------------------+
|   if deliverInFlight: return                        |
|   if streaming.isActive():                          |
|     closeStreaming(emitFinalText=true)               |
|     # 去重检查避免重复发送                           |
|   typingCallbacks.stop()                            |
|     (移除 ⌨️ 反应)                                  |
+---------+-------------------------------------------+
          |
          v
最终卡片:
+-----------------------------------------+
| 📌 Agent Name                           | <-- header
+-----------------------------------------+
| ▶ 💭 Thinking (折叠)                    | <-- collapsible_panel
|   思考中...                              |
|   🔧 Tool calls (1)                     |
|   ✓ 1 completed                         |
+-----------------------------------------+
| 完整答案                                 | <-- content
+-----------------------------------------+
| Agent: agent | Model: xxx               | <-- note
+-----------------------------------------+
```

### 流式卡片 8 分钟续期

```
t=0min    创建卡片, streaming_mode=true
          |
          v
t=0~8min  正常 element-level 更新（update/updateThinking）
          |
          v
t=8min    renewTimer 触发
          |
          v
          cardkit.v1.card.settings({
              streaming_mode: true,
              sequence: nextSeq
          })
          |
          v
t=8~16min 继续正常更新
          |
          v
t=16min   renewTimer 再次触发, 续期
          |
          ... (循环直到 close())
```

### 超时恢复流程

```
updateElementContent("content", text)
    |
    v
pushElementContent()
    |
    v
+-- 成功 --> return true
|
+-- 失败 (code=200850 超时 / code=300309 已关闭) ----+
    |                                                  |
    v                                                  |
    setStreamingModeEnabled(force=true, reason="reopen")|
    |                                                  |
    v                                                  |
+-- 重新打开成功 --> 重试 pushElementContent()          |
|                     |                                |
|                     +-- 成功 --> return true          |
|                     +-- 失败 --> requiresFullCardSync |
|                                                      |
+-- 重新打开失败 --> requiresFullCardSync = true        |
                     return false                       |
                                                       |
    close() 时检测 requiresFullCardSync:                |
    --> updateCardFull() 做最终全量同步 <---------------+
```

### 去重系统

```
场景: deliver 和 onIdle 几乎同时触发

deliver(text="答案", kind="final")     onIdle()
    |                                     |
    v                                     v
deliverInFlight = true               检查 deliverInFlight
    |                                  = true --> 退出，不重复关闭
    v
closeStreaming("答案")
deliveredFinalTexts.add(strip("答案"))
deliverInFlight = false
emitFinalText("答案")

------

场景: hook 改写添加 mention

deliver(text="答案")
    |
    v
runMessageSending("答案")
    --> hookResult.content = "答案 <at id=ou_123></at>"
    |
    v
closeStreaming("答案 <at id=ou_123></at>")
deliveredFinalTexts.add(strip("答案"))  # 剥离 mention 后比较
    |
    v
后续 onIdle 尝试发送:
    strip("答案") 已在 deliveredFinalTexts 中 --> 跳过
```

---

## 参考代码行号 (Reference Line Numbers)

> 基于当前源码文件。

### `extensions/feishu/src/reply-dispatcher.ts`

| 行号 | 内容 |
|------|------|
| 31 | `stripMentionTags()` — 去重时剥离 mention 标签 |
| 40 | `shouldUseCard()` — markdown 检测 |
| 130 | `CreateFeishuReplyDispatcherParams` 类型定义（含 onFinalTextDelivered 回调） |
| 163 | `createFeishuReplyDispatcher()` 函数入口 |
| 198 | `emitMessageSent()` — 显式发射 message_sent hook |
| 231 | `runMessageSending()` — 调用 message_sending hook 管线 |
| 342-350 | 配置解析：`renderMode`、`hasMessageSendingHooks`、`streamingEnabled` |
| 364 | `deliveredFinalTexts = new Set<string>()` — 去重集合 |
| 374-376 | 流式阶段和工具追踪状态变量：`streamPhase`、`activeTools`、`toolCallCount` |
| 385 | `deliverMediaAndEmitIfNeeded()` — media 发送和事件发射 |
| 433 | `emitFinalTextIfNeeded()` — 最终文本交付回调 |
| 568 | `composeThinkingContent()` — 思考面板内容组合 |
| 601 | `stripIncompleteAtTag()` — 防止不完整标签破坏卡片 |
| 614 | `queueStreamingRender()` — 主内容元素更新队列 |
| 648 | `queueThinkingPanelUpdate()` — 思考面板更新队列 |
| 667 | `queueStreamingUpdate()` — 合并增量文本并触发渲染 |
| 709 | `startStreaming()` — 创建流式卡片会话 |
| 753 | `closeStreaming()` — 关闭流式卡片，处理空文本/仅思考/正常关闭 |

### `extensions/feishu/src/streaming-card.ts`

| 行号 | 内容 |
|------|------|
| 11 | `CardState` 类型定义（含 thinkingTitle/thinkingText/thinkingExpanded） |
| 47-48 | `FEISHU_STREAMING_TIMEOUT_ERROR_CODE = 200850` 和 `CLOSED_ERROR_CODE = 300309` |
| 99 | `isStreamingModeClosedError()` — 检测超时/已关闭错误 |
| 132 | `mergeStreamingText()` — 增量文本合并算法 |
| 179 | `FeishuStreamingSession` 类定义 |
| 193 | `STREAMING_MODE_RENEW_INTERVAL_MS = 8 * 60 * 1000` — 8 分钟续期 |
| 303 | `start()` 末尾调用 `startRenewTimer()` |
| 308-316 | `startRenewTimer()` / `stopRenewTimer()` |
| 335 | `setStreamingModeEnabled()` — 续期/重新打开 streaming_mode |
| 384 | `pushElementContent()` — element-level API 推送 |
| 407 | `updateElementContent()` — element-level API + 超时恢复逻辑 |
| 454 | `buildFullElements()` — 含思考面板的全量元素数组 |
| 491 | `updateCardFull()` — 全量卡片替换（fallback） |
| 542-588 | `update()` 内容合并逻辑（含 `mergeStreamingText`） |
| 600 | `updateThinking()` — 思考面板更新 |
| 679 | `close()` — 最终卡片输出（折叠思考面板） |

### `extensions/feishu/src/send.ts`

| 行号 | 内容 |
|------|------|
| 723 | `shouldUseFeishuMarkdownCard()` — 公共导出 |
| 758 | `resolveFeishuCardTemplate()` — 卡片颜色模板映射 |
