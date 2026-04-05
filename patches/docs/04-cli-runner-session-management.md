# Patch 04: CLI Runner 三层上下文溢出保护、会话持久化与进程管理

## 为什么要改 (Why)

CLI runner（`claude-cli` 后端）运行时面临几个关键问题：

1. **上下文窗口溢出**：系统提示（system prompt）+ bootstrap 文件 + 用户消息 + 图片的 token 总量可能超过模型上下文窗口限制，导致 CLI 进程直接报错退出。之前没有预防机制，只能在错误发生后被动处理。

2. **会话状态丢失**：Claude CLI 的 session prompt 文件路径、prompt hash、compaction 次数等元数据没有持久化。恢复会话时无法判断 prompt 是否已变更，可能导致 Claude 使用过时的系统提示继续对话。

3. **僵尸进程无法终止**：用户发送 `/stop` 时，只能中止 embedded Pi 运行，无法终止正在运行的 CLI 子进程。CLI 进程会继续消耗资源直到超时。

4. **恢复过期会话失败**：Claude CLI 恢复（resume）一个过期会话时，可能只重放历史帧然后退出，不产生新的 assistant 回复。之前这种情况被当作普通错误处理，没有触发会话重置。

5. **缺少流式输出解析**：CLI 的 `stream-json` 输出模式（NDJSON 格式）没有实时解析能力，无法在 CLI 运行期间向用户推送中间状态（thinking、tool use 等）。

## 改了什么 (What Changed)

### 核心文件

| 文件 | 关键修改 |
|------|---------|
| `src/agents/cli-runner.ts` | 新增三层上下文溢出保护；session prompt 文件写入与 loader prompt 机制；MCP 配置合并；abort signal 集成；stream-json 回调接入 |
| `src/agents/cli-runner/helpers.ts` | 新增 `createStreamJsonProcessor` 流式 NDJSON 解析器；新增 `summarizeCliFailure` 失败分类函数；`buildSystemPrompt` 支持 `skillsPrompt` 参数 |
| `src/agents/cli-session.ts` | `CliSessionBinding` 富绑定结构替代原有纯 sessionId 存储；新增 `getCliSessionBinding`、`setCliSessionBinding`、`clearCliSession`、`hashCliSessionText` |
| `src/process/supervisor/supervisor.ts` | 新增 `cancelSession(sessionId, reason)` 按会话 ID 批量取消活跃进程 |
| `src/auto-reply/reply/abort.ts` | 新增 `abortSessionExecutions` 统一中止函数，同时取消 embedded Pi 和 CLI supervisor 进程 |
| `src/config/sessions/disk-budget.ts` | 磁盘预算管理识别并清理 `.claude-system-prompt.txt` 文件 |
| `src/config/sessions/artifacts.ts` | 新增 `isPrimarySessionPromptFileName`、`resolveSessionPromptFileNameFromTranscriptFileName` |
| `src/agents/command/session-store.ts` | 持久化 `cliSessionBinding` 和 `cliPromptLoad` 到 session store |

### 测试文件

| 文件 | 内容 |
|------|------|
| `src/agents/cli-runner.helpers.stream-json.test.ts` | 534 行新增，覆盖 stream-json 解析器的全部场景 |
| `src/agents/cli-runner.test.ts` | 1430+ 行新增，覆盖三层保护、prompt loader、会话恢复等 |
| `src/agents/cli-session.test.ts` | 51 行新增，覆盖富绑定存取和 legacy 兼容 |
| `src/process/supervisor/supervisor.test.ts` | 新增 `cancelSession` 测试 |

## 伪代码 (Pseudocode)

### 三层上下文溢出保护

```
函数 runCliAgent(params):
    // 解析上下文窗口大小
    contextWindowTokens = resolveContextWindowInfo(provider, model)
    hardLimitTokens = contextWindowTokens * 0.7  // 预留 30% 给输出

    // ═══ Layer 1: 预检护栏（Pre-flight Guard）═══
    estimatedTokens = estimatePromptTokens(systemPrompt)
                    + estimatePromptTokens(userPrompt)
                    + imageTokenEstimate

    如果 estimatedTokens > hardLimitTokens:
        // 按顺序尝试降级 profile
        对于 profile 属于 ["reduced", "minimal"]:

            // ── 压缩步骤（在 reduced 和 minimal 之间执行一次）──
            如果 profile == "minimal" 且尚未压缩:
                尝试:
                    compactedFiles = compactBootstrapFiles(contextFiles, llmFn)
                    如果 压缩后 estimatedTokens <= hardLimitTokens:
                        采用压缩后的 prompt
                        跳出循环
                捕获异常:
                    记录警告，继续降级到 minimal

            // 构建该 profile 的 system prompt
            profileContextFiles = buildBootstrapContextFiles(profile配置)
            profileSystemPrompt = buildSystemPrompt(profileContextFiles)
            estimatedTokens = 重新估算

            如果 estimatedTokens <= hardLimitTokens:
                跳出循环

    // ═══ Layer 2: 运行时溢出恢复（Context Overflow Recovery）═══
    尝试:
        output = executeCliWithSession(cliSessionId)
    捕获 FailoverError(reason="context_overflow"):
        // Step 2a: 发送 /compact 指令压缩会话历史
        如果 有现有会话 且 是 claude-cli:
            executeCliWithSession(sessionId, "/compact", isSystemCall=true)

        // Step 2b: 降级到 minimal profile
        如果 activeProfile != "minimal":
            重建 minimal system prompt

        // Step 2c: 用压缩后的会话 + minimal profile 重试
        output = executeCliWithSession(compactedSession 或 新会话)

    // ═══ Layer 3: 上下文窗口感知的动态预算 ═══
    // （在 resolveBootstrapTotalMaxChars 中实现）
    // bootstrapTotalMaxChars 根据 contextWindowTokens 动态调整
    // 确保 bootstrap 文件总量不超过上下文窗口的合理比例
```

### Session Prompt 文件持久化与验证

```
函数 executeCliWithSession(cliSessionId, promptOverride, isSystemCall):
    如果 是 claude-cli 且 非系统调用:
        // 写入 prompt 文件
        promptFile = writeClaudeSystemPromptFile(sessionFile, systemPrompt)
        // promptFile = {filePath: "xxx.claude-system-prompt.txt", hash: "sha256..."}

        // 判断是否需要让 Claude 重新读取 prompt 文件
        reloadReason = 判断:
            - 新会话 → "new-session"
            - prompt hash 变化 → "prompt-changed"
            - compaction 次数增加 → "compaction"
            - 绑定中的文件路径/hash 匹配 → 无需重载

        如果 需要重载:
            systemPromptToSend = buildClaudeSystemPromptLoaderPrompt(filePath, reason)
            // 生成指令："MANDATORY FIRST STEP: use the Read tool to read..."

    // 启动 CLI 进程
    managedRun = supervisor.spawn({...})

    // 如果是 stream-json 模式，创建流式处理器
    streamProcessor = createStreamJsonProcessor(backend, callbacks)
    // callbacks 中拦截 onToolUseEvent 和 onToolResult
    // 验证 Claude 是否真的读取了 prompt 文件

    result = managedRun.wait()

    如果 mustVerifyPromptFileRead 且 未验证:
        抛出 PromptFileReadRequiredError
        // 上层会用 "strict" 模式重试
```

### Stream-JSON 处理器

```
函数 createStreamJsonProcessor(backend, callbacks):
    buffer = ""
    lastAssistantText = ""
    lastThinkingText = ""
    emittedToolUseKeys = Set()  // 去重
    emittedToolResultKeys = Set()

    函数 processLine(line):
        parsed = JSON.parse(line)

        匹配 parsed.type:
            "system" → callbacks.onSystemInit(subtype, sessionId)
            "result" → 提取最终文本和 usage
            "assistant" → 提取 text/thinking/tool_use 内容块
                         → 去重后触发对应回调
            "user" → 提取 tool_result 内容块
                    → 去重后触发 onToolResult

    返回 {
        feed(chunk): 按换行符分割，逐行 processLine
        finish(): 处理剩余 buffer，返回 {text, sessionId, usage}
    }
```

### Force Stop 机制

```
函数 abortSessionExecutions(sessionId):
    // 1. 中止 embedded Pi 运行
    embeddedAborted = abortEmbeddedPiRun(sessionId)

    // 2. 取消 CLI supervisor 中该 session 的所有进程
    cliCancelled = processSupervisor.cancelSession(sessionId, "manual-cancel")

    返回 { embeddedAborted, cliCancelled }

// ProcessSupervisor.cancelSession 实现
函数 cancelSession(sessionId, reason):
    cancelled = 0
    对于 active 中的每个 (runId, run):
        如果 run.sessionId == sessionId:
            cancel(runId, reason)  // 发送 SIGKILL
            cancelled += 1
    返回 cancelled
```

## 数据流程图 (Data Flow Diagram)

### 三层上下文溢出保护流程

```
用户消息到达
     │
     ▼
┌─────────────────────────────────────┐
│  Layer 3: 动态预算                    │
│  resolveBootstrapTotalMaxChars()     │
│  根据 contextWindowTokens 限制       │
│  bootstrap 文件总量上限              │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  Layer 1: 预检护栏 (Pre-flight)      │
│  estimatePromptTokens() < 70% 窗口   │
│                                      │
│  超限? ──是──► 逐级降级:             │
│       │       1. reduced profile     │
│       │       2. compactBootstrap()  │
│       │       3. minimal profile     │
│       │                              │
│       └──否──► 正常执行              │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  executeCliWithSession()             │
│  ┌──────────────────────────────┐   │
│  │ prompt 文件写入               │   │
│  │ xxx.claude-system-prompt.txt  │   │
│  └──────────┬───────────────────┘   │
│             ▼                        │
│  ┌──────────────────────────────┐   │
│  │ 判断是否需要 loader prompt    │   │
│  │ (hash/path/compaction 比较)   │   │
│  └──────────┬───────────────────┘   │
│             ▼                        │
│  ┌──────────────────────────────┐   │
│  │ supervisor.spawn(CLI进程)     │   │
│  │ + stream-json processor      │   │
│  │ + abort signal 监听          │   │
│  └──────────┬───────────────────┘   │
│             ▼                        │
│  ┌──────────────────────────────┐   │
│  │ 验证 prompt 文件被读取        │   │
│  │ (Read tool call 拦截)         │   │
│  └──────────────────────────────┘   │
└─────────────────┬───────────────────┘
                  │
              成功/失败
                  │
        ┌────────┴────────┐
        │                 │
     成功返回        FailoverError
        │            (context_overflow)
        │                 │
        │                 ▼
        │  ┌─────────────────────────────┐
        │  │  Layer 2: 运行时溢出恢复      │
        │  │                              │
        │  │  Step 2a: /compact 压缩历史   │
        │  │  (发送到现有 claude session)   │
        │  │           │                   │
        │  │           ▼                   │
        │  │  Step 2b: 降级到 minimal      │
        │  │  (重建 system prompt)          │
        │  │           │                   │
        │  │           ▼                   │
        │  │  Step 2c: 重试原始 prompt      │
        │  │  (compacted session 或新会话)  │
        │  └─────────────────────────────┘
        │
        ▼
    返回结果
```

### Session Prompt 状态持久化流程

```
CLI 运行完成
     │
     ▼
┌─────────────────────────────────────┐
│  构建 cliSessionBinding             │
│  {                                   │
│    sessionId: "claude-session-xxx",  │
│    systemPromptFile: "/path/to/...", │
│    systemPromptHash: "sha256...",    │
│    systemPromptCompactionCount: N    │
│  }                                   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  构建 cliPromptLoad                  │
│  {                                   │
│    sessionPromptFile: "/path/...",   │
│    loaderMode: "normal"|"strict",    │
│    verifiedRead: true|false,         │
│    fallbackReason?: "write_failed"   │
│  }                                   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  updateSessionStoreAfterAgentRun()   │
│  → setCliSessionBinding(entry, ...)  │
│  → entry.cliPromptLoad = ...         │
│  → 写入 sessions.json                │
└──────────────┬──────────────────────┘
               │
          下次运行恢复时
               │
               ▼
┌─────────────────────────────────────┐
│  getCliSessionBinding(entry)         │
│  → 读取 binding 中的 hash/file      │
│  → 与当前 prompt 比较               │
│  → 决定是否需要 loader prompt        │
│  → 已验证且未变更 → 无需重载        │
└─────────────────────────────────────┘
```

### Force Stop 流程

```
用户发送 /stop
     │
     ▼
┌─────────────────────────────────────┐
│  abort.ts: runStopCommand()          │
│           │                          │
│           ▼                          │
│  abortSessionExecutions(sessionId)   │
│     ┌─────────┬─────────────┐        │
│     │         │             │        │
│     ▼         ▼             │        │
│  abort     cancelSession    │        │
│  Embedded  (supervisor)     │        │
│  Pi run    ──► 遍历 active   │        │
│            ──► SIGKILL 匹配的进程 │    │
│            ──► 返回取消数量   │        │
└─────────────────────────────────────┘
     │
     ├── ACP 取消和队列清理由 `tryFastAbortFromMessage()` 在外层单独处理
     │
     ▼
CLI 进程收到 SIGKILL
     │
     ▼
managedRun.wait() 返回 reason="manual-cancel"
     │
     ▼
runCliAgent 抛出 AbortError
     │
     ▼
agent-runner-execution 返回 { kind: "aborted" }
（不向用户发送错误消息）
```

## 参考代码行号 (Reference Line Numbers)

### 三层保护 — `src/agents/cli-runner.ts`

> **实现偏差**：rebase 后 `cli-runner.ts` 已从 ~1900 行缩减为 ~130 行（薄包装层），
> 核心逻辑拆分到 `src/agents/cli-runner/prepare.ts` 和 `src/agents/cli-runner/execute.ts`。
> 三层上下文溢出保护（Layer 1 预检、Layer 2 运行时恢复、动态预算）、
> `estimatePromptTokens`、`hardLimitTokens`、`profilesToTry`、`compactBootstrapFiles`、
> `isContextOverflowError` 等函数在当前代码中 **不存在**。
> Session prompt 文件管理函数（`resolveClaudeSystemPromptFilePath`、`writeClaudeSystemPromptFile`、
> `buildClaudeSystemPromptLoaderPrompt`、`PromptFileReadRequiredError`、`resolveReadToolFilePath`、
> `promptFileReadVerified`）同样 **不存在**。
> 这些功能可能在 conflict resolution 中被丢弃，**需要确认是否需要恢复**。

_以下为原始行号参考，当前代码中已不适用：_

| 位置 | 原行号 | 说明 | 当前状态 |
|------|--------|------|----------|
| Layer 3 注释 | 605 | `Resolve context window early` | **代码缺失** |
| Layer 1 预检 | 758-770 | `estimatedTokens`/`hardLimitTokens` | **代码缺失** |
| Profile 降级循环 | 785-989 | `profilesToTry` | **代码缺失** |
| Compaction 步骤 | 789-918 | `compactBootstrapFiles` | **代码缺失** |
| Token 估算函数 | 207-218 | `estimatePromptTokens()` | **代码缺失** |
| Layer 2 溢出恢复 | 1770-1900 | `isContextOverflowError` | **代码缺失** |

### Session Prompt 文件 — `src/agents/cli-runner.ts`

> **代码缺失**：以下所有 session prompt 文件管理函数在当前代码中不存在。

| 位置 | 原行号 | 说明 | 当前状态 |
|------|--------|------|----------|
| 路径解析 | 123-129 | `resolveClaudeSystemPromptFilePath()` | **代码缺失** |
| 文件写入 | 131-151 | `writeClaudeSystemPromptFile()` | **代码缺失** |
| Loader prompt 构建 | 153-179 | `buildClaudeSystemPromptLoaderPrompt()` | **代码缺失** |
| 验证错误类 | 181-186 | `PromptFileReadRequiredError` | **代码缺失** |
| Read tool 路径解析 | 188-199 | `resolveReadToolFilePath()` | **代码缺失** |
| Prompt 文件写入调用 | 1160 | `writeClaudeSystemPromptFile(...)` | **代码缺失** |
| 验证读取逻辑 | 1228 | `promptFileReadVerified` | **代码缺失** |
| Tool 拦截验证 | 1370-1413 | stream callback 验证 | **代码缺失** |

### Stream-JSON 处理器 — `src/agents/cli-runner/helpers.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| 失败分类 | 69 | `summarizeCliFailure()` — 区分 stale session / 空输出等 |
| 回调类型定义 | 329 | `StreamJsonCallbacks` — 事件回调 |
| 内容块提取 | 356 | `extractContentBlocks()` |
| Tool use 事件提取 | 405 | `extractToolUseEvents()` |
| Tool result 事件提取 | 427 | `extractToolResultEvents()` |
| Delta 计算 | 451 | `resolveDelta()` — thinking 增量文本 |
| 去重桶管理 | 466 | `addDedupeKey()` — 去重 key 管理 |
| 处理器工厂 | 606 | `createStreamJsonProcessor()` — 完整实现 |

### Session 绑定 — `src/agents/cli-session.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| Hash 函数 | 13 | `hashCliSessionText()` — SHA-256 |
| 获取绑定 | 21 | `getCliSessionBinding()` — 优先 `cliSessionBindings`，回退 legacy |
| 设置绑定 | 72 | `setCliSessionBinding()` — 写入富结构 + 向后兼容 |
| 清除绑定 | 117 | `clearCliSession()` — 清理所有相关字段 |

### Force Stop — `src/process/supervisor/supervisor.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| ActiveRun 类型 | 15 | `sessionId` 字段 |
| cancelSession 实现 | 59 | 遍历 active map，按 sessionId 匹配取消 |
| sessionId 存储 | 273 | `active.set(runId, { run, sessionId: input.sessionId })` |

### Abort 集成 — `src/auto-reply/reply/abort.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| `abortSessionExecutions()` | 92 | 统一中止 embedded + CLI 进程 |
| CLI cancel 调用 | 105 | `cancelSession(normalizedSessionId, "manual-cancel")` |
| 调用点 (fast-abort: 中止 handler) | 223 | `abortSessionExecutions(sessionId)` inside abort handler |
| 调用点 (fast-abort: 消息) | 312 | `abortSessionExecutions(sessionId)` inside `tryFastAbortFromMessage` |

### 磁盘预算 — `src/config/sessions/disk-budget.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| Prompt 文件引用解析 | 136 | `resolveReferencedSessionPromptPaths()` |
| 预算清理集成 | 298-308 | 将 prompt 文件纳入可删除文件队列 |
| 级联删除 | 330 | 删除 transcript 时同步删除对应 prompt 文件 |
