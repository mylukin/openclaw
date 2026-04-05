# Patch 05: Auto-Reply 分发管道 — toolCallId 传递、最终回复去重与消息钩子

## 为什么要改 (Why)

1. **toolCallId 缺失**：模型运行器（model runner）在执行 tool call 时产生的 `toolUseId` 没有传递到最终的 `ReplyPayload`。飞书等渠道需要这个 ID 来关联卡片更新与具体的 tool call（例如在流式卡片中显示"正在执行 Read 工具..."）。

2. **最终回复重复发送**：当模型返回多个内容块（content blocks）时，dispatch 管道可能产生内容相同但格式不同的多条最终回复。典型场景是飞书 `@mention` 标签：`<at user_id="ou_xxx">Name</at>` 与 `<at id=ou_xxx></at>` 语义相同但文本不同，导致用户收到两条重复消息。

3. **消息接收钩子缺失**：插件系统没有 `message_received` 钩子。插件无法在消息被路由到模型运行之前执行自定义逻辑（例如记录入站消息、触发外部集成）。

4. **CLI prompt 加载状态不可观测**：`/status` 命令无法显示当前会话的 CLI prompt 文件加载模式（file/direct/strict）和验证状态，不利于排查 prompt 注入失败问题。

5. **流式 silent token 误触发**：BPE 分词器可能将 `NO_REPLY` 拆分为 `"NO"` + `"_REPLY"` 两个 streaming chunk。之前的 `isSilentReplyPrefixText` 只检查包含下划线的前缀（如 `NO_`），漏掉了 `"NO"` 这种没有下划线的合法前缀，导致 `"NO"` 被错误地当作普通文本发送给用户。

6. **Followup runner 未使用 model-aware 路由**：followup runner 仍然直接调用 `runEmbeddedPiAgent`，绕过了 model-aware runner 的 CLI/embedded 路由逻辑。CLI 后端的 followup 运行无法正确分发。

## 改了什么 (What Changed)

### 核心文件

| 文件 | 关键修改 |
|------|---------|
| `src/auto-reply/types.ts` | `ReplyPayload` 新增 `toolCallId?: string`；`onToolStart` 回调新增 `toolCallId` 参数 |
| `src/auto-reply/reply/agent-runner-execution.ts` | CLI 流式路径集成（streaming chain、reasoning、tool events）；toolCallId 传递；AbortError 静默处理；silent token 缓冲 |
| `src/auto-reply/reply/dispatch-from-config.ts` | 最终回复去重逻辑；飞书 mention 标签归一化 |
| `src/auto-reply/reply/followup-runner.ts` | 替换 `runEmbeddedPiAgent` 为 `runModelAwareAgent`；传递 `cliSessionBinding` 和 `cliPromptLoad` |
| `src/auto-reply/reply/message-received-hooks.ts` | 新文件，实现 `emitMessageReceivedHooks` — 插件 + 内部钩子双轨触发 |
| `src/auto-reply/reply/session-usage.ts` | `applyCliSessionStateToSessionPatch` 替代原 `applyCliSessionIdToSessionPatch`，支持富绑定和 prompt load 状态 |
| `src/auto-reply/reply/streaming-directives.ts` | `pendingSilent` 缓冲机制；`couldBeSilentTokenStart` 集成 |
| `src/auto-reply/tokens.ts` | 新增 `couldBeSilentTokenStart()` — 宽松前缀匹配（不要求下划线） |
| `src/auto-reply/status.ts` | 新增 `formatCliPromptLoadLine()` — `/status` 显示 CLI prompt 加载状态 |
| `src/auto-reply/reply/get-reply.ts` | 自动轮换（auto-rotation）时触发 reset hooks |
| `src/auto-reply/reply/session.ts` | `previousSessionEntry` 在新会话创建时始终保留 |
| `src/auto-reply/reply/abort.ts` | force-stop 集成 `processSupervisor.cancelSession` |
| `src/auto-reply/heartbeat.ts` | heartbeat prompt 补充 "do NOT use the message tool" 指令 |

### 测试文件

| 文件 | 内容 |
|------|------|
| `src/auto-reply/reply/dispatch-from-config.test.ts` | 飞书 mention 去重测试 |
| `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts` | 263+ 行新增，覆盖 CLI 流式回调和 abort 场景 |
| `src/auto-reply/reply/get-reply.reset-hooks-fallback.test.ts` | 自动轮换 reset hooks 测试 |
| `src/auto-reply/reply/reply-utils.test.ts` | silent token 缓冲、split streaming 测试 |
| `src/auto-reply/tokens.test.ts` | `couldBeSilentTokenStart` 全覆盖 |
| `src/auto-reply/status.cli-prompt-load.test.ts` | CLI prompt load 状态渲染测试 |

## 伪代码 (Pseudocode)

### toolCallId 流转路径

```
// 1. CLI stream-json 产生 tool_use 事件
createStreamJsonProcessor 的 onToolUseEvent 回调:
    payload = { name: "Read", toolUseId: "toolu_xxx", input: {...} }

// 2. agent-runner-execution 中的 CLI 流式路径
onToolUseEvent: (payload) =>
    queueStreamingStep(异步 () =>
        await typingSignals.signalToolStart()
        await opts.onToolStart({
            name: payload.name,
            phase: "start",
            toolCallId: payload.toolUseId  // ← 这里传递
        })
    )

// 3. Embedded Pi 路径（非 CLI）同样传递
如果 evt.stream == "tool":
    toolCallId = evt.data.toolUseId
    await opts.onToolStart({ name, phase, toolCallId })

// 4. 飞书等渠道的 onToolStart handler 接收 toolCallId
//    用于更新流式卡片中的 tool call 状态
```

### Dispatch 去重逻辑

```
函数 dispatchReplyFromConfig(params):
    replies = await replyResolver()  // 可能返回数组
    deliveredFinalTexts = Set<string>()

    // 飞书 mention 标签归一化函数
    函数 normalizeMentionsForDedup(text):
        // <at user_id="ou_xxx">Name</at> → <at:ou_xxx>
        // <at id=ou_xxx></at>            → <at:ou_xxx>
        返回 text
            .replace(/<at\s+user_id="([^"]+)">[^<]*<\/at>/g, "<at:$1>")
            .replace(/<at\s+id=([^>]+)><\/at>/g, "<at:$1>")
            .trim()

    对于 replies 中的每个 reply:
        // 跳过 reasoning payloads
        如果 reply.isReasoning:
            继续

        // 去重检查
        如果 reply.text:
            normalizedText = normalizeMentionsForDedup(reply.text)
            如果 deliveredFinalTexts.has(normalizedText):
                继续  // 跳过重复
            deliveredFinalTexts.add(normalizedText)

        // 发送回复
        dispatcher.sendFinalReply(reply)
```

### Message-Received Hooks 管道

```
函数 emitMessageReceivedHooks(ctx: FinalizedMsgContext):
    content = resolveInboundContent(ctx)
    // 优先级: BodyForCommands → RawBody → Body

    channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider).toLowerCase()
    conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From

    // 轨道 1: 插件钩子（fire-and-forget）
    如果 hookRunner.hasHooks("message_received"):
        void hookRunner.runMessageReceived({
            from: ctx.From,
            content,
            timestamp,
            metadata: {
                to, provider, surface, threadId,
                messageId, channelData, senderId,
                senderName, senderUsername, ...
            }
        }, { channelId, accountId, conversationId })

    // 轨道 2: 内部钩子（fire-and-forget）
    如果 sessionKey:
        void triggerInternalHook(
            createInternalHookEvent("message", "received", sessionKey, {
                from, content, timestamp,
                channelId, accountId, conversationId,
                messageId, metadata: { ... }
            })
        )
```

### Silent Token 缓冲机制

```
// tokens.ts
函数 couldBeSilentTokenStart(text, token="NO_REPLY"):
    如果 text 为空: 返回 false
    trimmed = text.trimStart()
    如果 trimmed 包含非 [A-Z_] 字符: 返回 false  // 排除 "No"（小写）
    如果 trimmed.length < token.length 且 token.startsWith(trimmed):
        返回 true  // "NO" 是 "NO_REPLY" 的合法前缀
    返回 false

// streaming-directives.ts
函数 createStreamingDirectiveAccumulator():
    pendingSilent = ""

    函数 consume(raw, options):
        withSilent = pendingSilent + (raw ?? "")
        pendingSilent = ""
        combined = pendingTail + withSilent

        parsed = parseChunk(combined)

        // 缓冲可能是 silent token 前缀的文本
        如果 !options.final 且 !parsed.isSilent 且 parsed.text:
            如果 couldBeSilentTokenStart(parsed.text, silentToken):
                pendingSilent = combined  // 等待下一个 chunk
                返回 null

        // 如果不是前缀，正常返回（包含之前缓冲的文本）
        返回 parsed

// agent-runner-execution.ts
silentPrefixBuf = ""
函数 handlePartialForTyping(payload):
    combinedText = silentPrefixBuf + (payload.text ?? "")
    silentPrefixBuf = ""
    如果 isSilentReplyText(combinedText): 返回 undefined
    如果 isSilentReplyPrefixText(combinedText): 返回 undefined
    如果 couldBeSilentTokenStart(combinedText):
        silentPrefixBuf = combinedText  // 缓冲
        返回 undefined
    返回 normalizeStreamingText({...payload, text: combinedText})
```

### Session Usage 持久化增强

```
函数 applyCliSessionStateToSessionPatch(params, entry, patch):
    nextPatch = { ...patch }

    // 新增: 持久化 prompt load 状态
    如果 params.cliPromptLoad:
        nextPatch.cliPromptLoad = params.cliPromptLoad

    如果 没有 cliProvider:
        返回 nextPatch

    // 新增: 优先使用富绑定
    如果 params.cliSessionBinding?.sessionId:
        setCliSessionBinding(entry, cliProvider, params.cliSessionBinding)
        返回 { ...nextPatch, cliSessionBindings, cliSessionIds, claudeCliSessionId }

    // 回退: 纯 sessionId（向后兼容）
    如果 params.cliSessionId:
        setCliSessionId(entry, cliProvider, params.cliSessionId)
        返回 { ...nextPatch, cliSessionIds, claudeCliSessionId }

    返回 nextPatch
```

## 数据流程图 (Data Flow Diagram)

### toolCallId 端到端数据流

```
Claude CLI 进程 (stream-json NDJSON 输出)
  │
  │  {"type":"assistant","message":{"content":[
  │    {"type":"tool_use","id":"toolu_abc","name":"Read","input":{...}}
  │  ]}}
  │
  ▼
createStreamJsonProcessor (helpers.ts:606)
  │  extractToolUseEvents() → [{name:"Read", toolUseId:"toolu_abc", input:{...}}]
  │  去重: emittedToolUseKeys.has("toolu_abc")? → 首次，通过
  │
  ▼
callbacks.onToolUseEvent (agent-runner-execution.ts)
  │
  ├──► emitAgentEvent({ stream: "tool", data: { phase: "start",
  │                      name: "Read", toolUseId: "toolu_abc" }})
  │
  └──► queueStreamingStep(异步:
         typingSignals.signalToolStart()
         opts.onToolStart({
           name: "Read",
           phase: "start",
           toolCallId: "toolu_abc"
         })
       )
         │
         ▼
    飞书渠道 onToolStart handler
         │
         ▼
    更新流式卡片: "🔧 正在执行 Read..."
    (使用 toolCallId 关联状态更新)
```

### Dispatch 去重流程

```
模型返回多个 content blocks
  │
  ▼
replyResolver() 返回:
  [
    { text: '<at user_id="ou_lukin">Lukin</at> 确认' },  // 格式 A
    { text: '<at id=ou_lukin></at> 确认' },               // 格式 B（语义相同）
  ]
  │
  ▼
dispatchReplyFromConfig (dispatch-from-config.ts)
  │
  │  deliveredFinalTexts = Set()
  │
  │  reply[0]: text = '<at user_id="ou_lukin">Lukin</at> 确认'
  │    normalizeMentionsForDedup() → '<at:ou_lukin> 确认'
  │    deliveredFinalTexts.has('<at:ou_lukin> 确认')? → 否
  │    deliveredFinalTexts.add('<at:ou_lukin> 确认')
  │    ──► dispatcher.sendFinalReply(reply[0])  ✓ 发送
  │
  │  reply[1]: text = '<at id=ou_lukin></at> 确认'
  │    normalizeMentionsForDedup() → '<at:ou_lukin> 确认'
  │    deliveredFinalTexts.has('<at:ou_lukin> 确认')? → 是
  │    ──► 跳过（去重）  ✗ 不发送
  │
  ▼
用户只收到一条消息
```

### Message-Received Hooks 管道

```
入站消息到达
     │
     ▼
dispatchReplyFromConfig()
     │
     ├──► emitMessageReceivedHooks(ctx)  // fire-and-forget
     │         │
     │         ├──► [插件轨道] hookRunner.runMessageReceived({
     │         │      from, content, timestamp,
     │         │      metadata: { to, provider, surface,
     │         │                  threadId, messageId,
     │         │                  channelData, senderId, ... }
     │         │    }, { channelId, accountId, conversationId })
     │         │         │
     │         │         ▼
     │         │    已注册的插件 message_received handler
     │         │
     │         └──► [内部轨道] triggerInternalHook(
     │                createInternalHookEvent(
     │                  "message", "received", sessionKey, {...}
     │                )
     │              )
     │                   │
     │                   ▼
     │              内部钩子订阅者
     │
     └──► 继续正常的 dispatch 流程（路由到模型运行器）
```

### Silent Token 缓冲时序

```
BPE 分词器输出 chunk 序列: ["NO", "_REPLY"]

Chunk 1: "NO"
  │
  ▼
handlePartialForTyping({ text: "NO" })
  │  combinedText = "" + "NO" = "NO"
  │  isSilentReplyText("NO")? → 否
  │  isSilentReplyPrefixText("NO")? → 否（无下划线）
  │  couldBeSilentTokenStart("NO", "NO_REPLY")? → 是（"NO" 是 "NO_REPLY" 的前缀）
  │  silentPrefixBuf = "NO"
  └──► 返回 undefined（不发送给用户）

Chunk 2: "_REPLY"
  │
  ▼
handlePartialForTyping({ text: "_REPLY" })
  │  combinedText = "NO" + "_REPLY" = "NO_REPLY"
  │  isSilentReplyText("NO_REPLY")? → 是
  └──► 返回 undefined（正确吞掉）

===== 对比: 非 silent token 场景 =====

BPE 输出: ["NO", "T really"]

Chunk 1: "NO"
  │  couldBeSilentTokenStart("NO")? → 是
  │  silentPrefixBuf = "NO"
  └──► 返回 undefined（暂缓）

Chunk 2: "T really"
  │  combinedText = "NO" + "T really" = "NOT really"
  │  isSilentReplyText("NOT really")? → 否
  │  couldBeSilentTokenStart("NOT really")? → 否
  └──► 返回 "NOT really"（正确发送）
```

## 参考代码行号 (Reference Line Numbers)

### toolCallId 类型与传递 — `src/auto-reply/types.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `onToolStart` 回调 | 66 | `toolCallId?: string` — 新增参数 |
| `ReplyPayload.toolCallId` | 95 | `toolCallId?: string` — payload 中的 tool call ID |

### CLI 流式集成 — `src/auto-reply/reply/agent-runner-execution.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `couldBeSilentTokenStart` 导入 | 46 | 从 `tokens.ts` 导入（行 51 处 `from "../tokens.js"` 块） |
| silent 缓冲声明 | 603 | `let silentPrefixBuf = ""` |
| silent 缓冲判断 | 613 | `if (couldBeSilentTokenStart(combinedText, SILENT_REPLY_TOKEN))` |
| onToolStart 传递 toolCallId | 929 | `onToolStart({ name, phase, toolCallId })` |
| Embedded tool event 中传递 toolCallId | 1011 | `toolCallId` 赋值 |
| AbortError 静默检测 | 1232 | `err.name === "AbortError"` |
| AbortError 返回 | 1331 | `return { kind: "aborted" }` |

### Dispatch 去重 — `src/auto-reply/reply/dispatch-from-config.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `deliveredFinalTexts` Set | 897 | `const deliveredFinalTexts = new Set<string>()` |
| `normalizeMentionsForDedup` | 898 | 两种飞书 mention 格式统一为 `<at:$1>` |
| 去重判断 | 912 | `if (deliveredFinalTexts.has(normalizedText)) continue` |

### Message-Received Hooks — `src/auto-reply/reply/message-received-hooks.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| 内容解析 | 6 | `resolveInboundContent()` — BodyForCommands → RawBody → Body 优先级 |
| 钩子入口 | 19 | `emitMessageReceivedHooks({ ctx })` |
| 内容提取 | 26 | `resolveInboundContent(ctx)` 调用 |
| 插件 hook 触发 | 33 | `hookRunner.runMessageReceived()` — fire-and-forget |
| 内部 hook 触发 | 68-69 | `triggerInternalHook(createInternalHookEvent("message", "received", ...))` |

### Silent Token 缓冲 — `src/auto-reply/tokens.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `TOKEN_CHARS_ONLY` 正则 | 6 | `/[^A-Z_]/` — 只允许大写字母和下划线 |
| `couldBeSilentTokenStart()` | 97 | 宽松前缀匹配，不要求下划线 |

### Streaming Directives 缓冲 — `src/auto-reply/reply/streaming-directives.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `pendingSilent` 状态 | 80 | `let pendingSilent = ""` |
| 缓冲判断 | 117-122 | `couldBeSilentTokenStart` 检查 + 缓冲到 `pendingSilent` |

### Session Usage 持久化 — `src/auto-reply/reply/session-usage.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `applyCliSessionStateToSessionPatch` | 19 | 替代原 `applyCliSessionIdToSessionPatch` |
| `cliPromptLoad` 写入 | 31-32 | `nextPatch.cliPromptLoad = params.cliPromptLoad` |
| 富绑定写入 | 40 | `setCliSessionBinding(nextEntry, cliProvider, params.cliSessionBinding)` |
| `persistSessionUsageUpdate` | 82 | 含 `cliSessionBinding` 和 `cliPromptLoad` 参数 |

### Status 输出 — `src/auto-reply/status.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `formatCliPromptLoadLine()` | 440 | 渲染 "CLI prompt: file/strict · verified" 等状态行 |
| 集成到输出 | 846 | `const cliPromptLoadLine = formatCliPromptLoadLine(...)` |

### Followup Runner — `src/auto-reply/reply/followup-runner.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| 替换为 `runModelAwareAgent` | 190 | `const result = await runModelAwareAgent({...})` |
| 传递 CLI 绑定 | 302-303 | `cliSessionBinding`, `cliPromptLoad` 传入 usage update |

### Abort 增强 — `src/auto-reply/reply/abort.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `abortSessionExecutions()` | 92 | 同时取消 embedded + CLI supervisor 进程 |
| CLI cancel 调用 | 105 | `getProcessSupervisor().cancelSession(sessionId, "manual-cancel")` |
