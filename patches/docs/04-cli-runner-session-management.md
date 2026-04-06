# Patch 04: CLI Runner 三层上下文溢出保护、会话持久化与进程管理

## 为什么要改 (Why)

CLI runner（`claude-cli` 后端）运行时面临几个关键问题：

1. **上下文窗口溢出**：系统提示（system prompt）+ bootstrap 文件 + 用户消息 + 图片的 token 总量可能超过模型上下文窗口限制，导致 CLI 进程直接报错退出。之前没有预防机制，只能在错误发生后被动处理。

2. **会话状态丢失**：Claude CLI 的 session prompt 文件路径、prompt hash、compaction 次数等元数据没有持久化。恢复会话时无法判断 prompt 是否已变更，可能导致 Claude 使用过时的系统提示继续对话。

3. **僵尸进程无法终止**：用户发送 `/stop` 时，只能中止 embedded Pi 运行，无法终止正在运行的 CLI 子进程。CLI 进程会继续消耗资源直到超时。

4. **恢复过期会话失败**：Claude CLI 恢复（resume）一个过期会话时，可能只重放历史帧然后退出，不产生新的 assistant 回复。之前这种情况被当作普通错误处理，没有触发会话重置。

5. **缺少流式输出解析**：CLI 的 `stream-json` 输出模式（NDJSON 格式）没有实时解析能力，无法在 CLI 运行期间向用户推送中间状态（thinking、tool use 等）。

## 改了什么 (What Changed)

### A. CLI Runner 核心（上下文保护、会话、流式处理）

| 文件 | 关键修改 |
|------|---------|
| `src/agents/cli-runner.ts` | 新增三层上下文溢出保护；session prompt 文件写入与 loader prompt 机制；MCP 配置合并；abort signal 集成；stream-json 回调接入（~180 行，薄包装层委托到子模块） |
| `src/agents/cli-runner/execute.ts` | `executeWithOverflowProtection()` — Layer 1 + Layer 2 实现；`CliSessionBindingResult`、`CliPromptLoadResult` 类型（998 行） |
| `src/agents/cli-runner/prepare.ts` | session prompt 文件函数（`resolveClaudeSystemPromptFilePath`、`writeClaudeSystemPromptFile`、`buildClaudeSystemPromptLoaderPrompt`）；`estimatePromptTokens()`、`ESTIMATED_TOKENS_PER_IMAGE`（627 行） |
| `src/agents/cli-runner/helpers.ts` | `createStreamJsonProcessor` 流式 NDJSON 解析器；`summarizeCliFailure` 失败分类函数；`buildSystemPrompt` 支持 `skillsPrompt` 参数（973 行） |
| `src/agents/cli-runner/types.ts` | `RunCliAgentParams` 新增字段（`contextWindowTokens`、`bootstrapProfile` 等）；`PreparedCliRunContext` 新增字段（113 行） |
| `src/agents/cli-runner/bundle-mcp.ts` | MCP 配置合并：读取外部 MCP config、与 bundle MCP 服务合并、写入临时文件并注入 CLI args（130 行） |
| `src/agents/cli-runner/reliability.ts` | watchdog 超时策略：按 fresh/resume 模式选取超时配置，应用比例和上下限约束（88 行） |
| `src/agents/cli-runner/log.ts` | CLI 后端日志通道常量：`cliBackendLog`、`CLI_BACKEND_LOG_OUTPUT_ENV`（5 行） |
| `src/agents/cli-runner.runtime.ts` | 运行时入口重导出：`runCliAgent`、`getCliSessionId`、`setCliSessionId`（2 行） |
| `src/agents/cli-session.ts` | `CliSessionBinding` 富绑定结构替代原有纯 sessionId 存储；`getCliSessionBinding`、`setCliSessionBinding`、`clearCliSession`、`hashCliSessionText`（175 行） |
| `src/agents/claude-cli-runner.ts` | 向后兼容入口点，重导出 `runClaudeCliAgent` / `runCliAgent`（3 行） |

### B. CLI 后端抽象层（多 Provider CLI 支持）

| 文件 | 关键修改 |
|------|---------|
| `src/agents/cli-backends.ts` | `CLAUDE_MODEL_ALIASES`、`DEFAULT_CODEX_BACKEND`、`normalizeClaudePermissionArgs()`、多后端配置构建逻辑（315 行） |
| `src/agents/cli-output.ts` | CLI 输出解析器：支持 `stream-json`（NDJSON）和 `json` 两种输出格式；提取 JSON 对象、sessionId、usage 统计；provider-aware 解析逻辑（452 行） |
| `extensions/anthropic/cli-backend.ts` | Anthropic CLI 后端插件：`buildAnthropicCliBackend()` 返回 `CliBackendPlugin`，配置 `claude` 命令参数、stream-json 输出、session 恢复、model alias、watchdog 超时（67 行） |
| `extensions/anthropic/cli-backend-api.ts` | Anthropic CLI 后端公共 API barrel：重导出 `buildAnthropicCliBackend`、`normalizeClaudeBackendConfig`、`isClaudeCliProvider`（6 行） |
| `extensions/anthropic/cli-shared.ts` | Anthropic CLI 共享常量与工具：`CLAUDE_CLI_BACKEND_ID`、`CLAUDE_CLI_MODEL_ALIASES`（30+ alias 映射）、`CLAUDE_CLI_SESSION_ID_FIELDS`、`CLAUDE_CLI_HOST_MANAGED_ENV`、`CLAUDE_CLI_CLEAR_ENV`、`normalizeClaudeBackendConfig()` 配置规范化（150 行） |
| `extensions/anthropic/cli-auth-seam.ts` | Anthropic CLI 认证接缝：`readClaudeCliCredentialsForSetup()`、`readClaudeCliCredentialsForSetupNonInteractive()`、`readClaudeCliCredentialsForRuntime()` — 封装对 `readClaudeCliCredentialsCached` 的不同调用模式（13 行） |
| `extensions/anthropic/cli-migration.ts` | Anthropic → Claude CLI 配置迁移：`migrateToClaudeCli()` 将 `anthropic/claude-*` model ref 重写为 `claude-cli/*`；处理单 model 和 models 数组两种配置形态；认证检测与 interactive/non-interactive 流程分支（138 行） |
| `extensions/anthropic/api.ts` | 新增 `CLAUDE_CLI_BACKEND_ID` 和 `isClaudeCliProvider` 导出（+1 行） |
| `extensions/anthropic/test-api.ts` | 测试用 barrel：重导出 `buildAnthropicCliBackend`、`normalizeClaudeBackendConfig`（3 行） |
| `extensions/google/cli-backend.ts` | Google Gemini CLI 后端插件：`buildGoogleGeminiCliBackend()` 配置 `gemini` 命令、json 输出、model alias（pro/flash/flash-lite）（35 行） |
| `extensions/openai/cli-backend.ts` | OpenAI Codex CLI 后端插件：`buildOpenAICodexCliBackend()` 配置 `codex exec` 命令、json 输出、session resume、`--sandbox workspace-write`（48 行） |

### C. CLI 认证与凭据

| 文件 | 关键修改 |
|------|---------|
| `src/agents/cli-credentials.ts` | 多 CLI 凭据读取器：Claude CLI（文件 + macOS Keychain）、Codex CLI（auth.json）、MiniMax CLI（oauth_creds.json）；带 TTL 缓存和 fingerprint 校验；keychain 读取异常保护（742 行） |
| `src/agents/cli-auth-epoch.ts` | CLI 认证 epoch 计算：`computeCliAuthEpoch()` 从所有已配置的 CLI 凭据和 auth profile store 聚合 SHA-256 摘要，用于检测认证状态变更、触发会话重置（165 行） |
| `src/agents/auth-profiles/external-cli-sync.ts` | 外部 CLI OAuth 凭据同步到 auth profile store：`syncExternalCliCredentials()` 比对 Codex CLI / MiniMax CLI 凭据与 profile store 中已有条目，按需更新/创建 profile（196 行） |
| `src/agents/auth-profiles/constants.ts` | 新增 `MINIMAX_CLI_PROFILE_ID`、`EXTERNAL_CLI_SYNC_TTL_MS`（15 分钟 TTL）（+3 行） |
| `src/agents/auth-profiles/types.ts` | 新增 `ExternalOAuthManager` 类型：`"codex-cli" | "minimax-cli"`（+2 行） |

### D. 进程管理

| 文件 | 关键修改 |
|------|---------|
| `src/process/supervisor/supervisor.ts` | 新增 `cancelSession(sessionId, reason)` 按会话 ID 批量取消活跃进程（+22 行） |
| `src/process/supervisor/types.ts` | `ProcessSupervisor` 接口新增 `cancelSession` 方法（+1 行） |

### E. Plugin SDK 入口与注册

| 文件 | 关键修改 |
|------|---------|
| `src/plugin-sdk/cli-backend.ts` | 新增 Plugin SDK 公共子路径 `openclaw/plugin-sdk/cli-backend`：导出 `CliBackendConfig`、`CliBackendPlugin` 类型和 watchdog 默认值常量（6 行） |
| `src/plugin-sdk/anthropic-cli.ts` | Plugin SDK facade：通过 `loadBundledPluginPublicSurfaceModuleSync` 惰性加载 Anthropic 扩展的 `CLAUDE_CLI_BACKEND_ID` 和 `isClaudeCliProvider`（14 行） |
| `src/plugin-sdk/provider-auth.ts` | 新增 `readClaudeCliCredentialsCached` 导出，供扩展通过 SDK 读取 Claude CLI 凭据（+1 行） |
| `src/plugin-sdk/zai.ts` | 内部 Z.AI config 接缝：重导出 `applyZaiConfig`、`applyZaiProviderConfig` 及 Z.AI 常量，保持加载路径轻量（14 行） |
| `src/plugins/cli-backends.runtime.ts` | CLI 后端运行时解析：`resolveRuntimeCliBackends()` 从活跃插件注册表提取所有已注册的 `CliBackendPlugin`（13 行） |
| `src/plugins/registry.ts` | 注册表新增 `PluginCliBackendRegistration` 类型和 `cliBackends` 字段（+10 行） |
| `src/plugins/types.ts` | 新增 `CliBackendPlugin` 类型定义：`id`、`config`（`CliBackendConfig`）、`bundleMcp` 标志（+66 行） |
| `src/plugins/loader.ts` | 插件加载器：支持 embedded plugins（`__OPENCLAW_EMBEDDED_PLUGINS__`）；重构 module loading 路径以同时处理 filesystem 和 embedded 来源（+102/-39 行） |
| `src/plugins/runtime/index.ts` | 插件运行时扩展：新增 `createRuntimeAgents()`（`runEmbeddedPiAgent`、`runModelAwareAgent`）；新增 `hooks` 表面（`hasMessageSendingHooks`、`runMessageSending`、`emitMessageSent` + 内部 hook 触发）（+69 行） |
| `src/plugins/runtime/runtime-model-aware.runtime.ts` | model-aware agent 运行时惰性入口：重导出 `runModelAwareAgent`（1 行） |
| `src/plugins/runtime/types-core.ts` | 插件运行时类型扩展：新增 `agents`（`runEmbeddedPiAgent`、`runModelAwareAgent`）字段定义（+55 行） |

### F. 包基础设施

| 文件 | 关键修改 |
|------|---------|
| `package.json` | 新增 `exports` 条目 `./plugin-sdk/cli-backend`（types + default）（+4 行） |
| `scripts/lib/plugin-sdk-entrypoints.json` | 新增 `"cli-backend"` 入口点（+1 行） |

### G. 外部依赖/消费方（本 patch 未修改）

| 文件 | 说明 |
|------|------|
| `src/auto-reply/reply/abort.ts` | `abortSessionExecutions` 统一中止函数，同时取消 embedded Pi 和 CLI supervisor 进程 |
| `src/config/sessions/disk-budget.ts` | 磁盘预算管理识别并清理 `.claude-system-prompt.txt` 文件 |
| `src/config/sessions/artifacts.ts` | `isPrimarySessionPromptFileName`、`resolveSessionPromptFileNameFromTranscriptFileName` |
| `src/agents/command/session-store.ts` | 持久化 `cliSessionBinding` 和 `cliPromptLoad` 到 session store |

### 测试文件

| 文件 | 内容 |
|------|------|
| `src/agents/cli-runner.test.ts` | 1749 行，覆盖三层保护、prompt loader、会话恢复、overflow recovery |
| `src/agents/cli-runner.test-support.ts` | 266 行，测试基础设施：mock 工厂、supervisor spawn mock、bootstrap context mock、通用 fixture |
| `src/agents/cli-runner.helpers.stream-json.test.ts` | 534 行，覆盖 stream-json 解析器的全部场景（NDJSON 分块、去重、事件回调） |
| `src/agents/cli-runner.helpers.test.ts` | 230 行，覆盖 `summarizeCliFailure`、`buildSystemPrompt` 等 helper 函数 |
| `src/agents/cli-runner.spawn.test.ts` | 708 行，覆盖 CLI 进程 spawn、watchdog 超时、abort signal、env 注入 |
| `src/agents/cli-runner.session.test.ts` | 49 行，覆盖 session binding 存取和 legacy 兼容 |
| `src/agents/cli-runner.reliability.test.ts` | 177 行，覆盖 watchdog 超时策略选取、比例约束、上下限 |
| `src/agents/cli-runner.bundle-mcp.e2e.test.ts` | 91 行，MCP 配置合并 e2e 测试 |
| `src/agents/cli-runner/bundle-mcp.test.ts` | 179 行，MCP 配置合并单元测试 |
| `src/agents/cli-session.test.ts` | 213 行，覆盖富绑定存取、hash 计算、legacy 兼容 |
| `src/agents/cli-backends.test.ts` | 669 行，model alias 解析、permission 规范化、多后端配置构建 |
| `src/agents/cli-output.test.ts` | 212 行，覆盖 JSON/stream-json 输出解析、sessionId 提取、usage 统计 |
| `src/agents/cli-credentials.test.ts` | 473 行，覆盖多 CLI 凭据读取、缓存 TTL、keychain 异常、fingerprint 校验 |
| `src/agents/cli-auth-epoch.test.ts` | 144 行，覆盖 epoch 计算、凭据变更检测 |
| `src/agents/auth-profiles.external-cli-sync.test.ts` | 257 行，覆盖外部 CLI 凭据同步、等价比对、profile 创建/更新 |
| `src/agents/claude-cli-runner.test.ts` | 241 行，覆盖向后兼容入口点的行为 |
| `extensions/anthropic/cli-migration.test.ts` | 260 行，覆盖 model ref 重写、models 数组迁移、认证检测 |
| `extensions/anthropic/cli-shared.test.ts` | 153 行，覆盖 model alias 映射、config 规范化、env 清理列表 |
| `src/process/supervisor/supervisor.test.ts` | 新增 `cancelSession` 测试（+38 行） |

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

## CLI 后端抽象层 (CLI Backend Abstraction)

### 设计概览

CLI runner 通过 `CliBackendPlugin` 接口支持多个 CLI 后端（Claude CLI、Codex CLI、Gemini CLI）。每个后端由对应的 provider 扩展注册，运行时通过插件注册表统一解析。

```
┌──────────────────────────────────────────────┐
│  extensions/anthropic/cli-backend.ts         │
│  extensions/google/cli-backend.ts            │
│  extensions/openai/cli-backend.ts            │
│                                              │
│  各自实现 buildXxxCliBackend():              │
│  → CliBackendPlugin { id, config, bundleMcp }│
└──────────────┬───────────────────────────────┘
               │ 插件加载时注册
               ▼
┌──────────────────────────────────────────────┐
│  src/plugins/registry.ts                     │
│  PluginRegistry.cliBackends[]                │
└──────────────┬───────────────────────────────┘
               │ 运行时查询
               ▼
┌──────────────────────────────────────────────┐
│  src/plugins/cli-backends.runtime.ts         │
│  resolveRuntimeCliBackends()                 │
│  → PluginCliBackendEntry[]                   │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│  src/agents/cli-backends.ts                  │
│  多后端配置构建、model alias 解析、          │
│  permission 规范化                           │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│  src/agents/cli-runner/execute.ts            │
│  executeWithOverflowProtection()             │
│  使用解析后的 CliBackendConfig 执行 CLI      │
└──────────────────────────────────────────────┘
```

### CliBackendPlugin 接口

```typescript
type CliBackendPlugin = {
  id: string;                    // 后端标识符，如 "claude-cli"、"codex-cli"
  config: CliBackendConfig;      // 命令、参数、输出格式、session 模式等
  bundleMcp?: boolean;           // 是否合并 MCP 配置到 CLI 参数
};

type CliBackendConfig = {
  command: string;               // CLI 命令名
  args: string[];                // 默认参数
  resumeArgs?: string[];         // 恢复会话时的参数（含 {sessionId} 占位符）
  output: "stream-json" | "json"; // 输出解析模式
  input: "stdin" | "arg";        // prompt 传递方式
  modelArg?: string;             // model 参数名，如 "--model"
  modelAliases?: Record<string, string>; // 模型别名映射
  sessionMode?: "existing";      // 会话恢复模式
  sessionIdFields?: string[];    // 输出中 sessionId 字段名
  reliability?: { watchdog: {...} }; // 超时配置
};
```

### Anthropic CLI 共享基础设施

`extensions/anthropic/cli-shared.ts` 提供 Anthropic 专有的常量和工具：

- **`CLAUDE_CLI_MODEL_ALIASES`**：30+ 个模型别名映射（如 `"sonnet-4.6"` → `"sonnet"`）
- **`CLAUDE_CLI_SESSION_ID_FIELDS`**：`["session_id", "sessionId", "conversation_id"]`
- **`CLAUDE_CLI_HOST_MANAGED_ENV`**：由宿主管理的环境变量列表（不透传给 CLI 子进程）
- **`CLAUDE_CLI_CLEAR_ENV`**：需要清除的环境变量列表（避免干扰 CLI 子进程行为）
- **`normalizeClaudeBackendConfig()`**：配置规范化函数

### Anthropic → Claude CLI 配置迁移

`extensions/anthropic/cli-migration.ts` 的 `migrateToClaudeCli()` 处理从 Anthropic API 到 Claude CLI 后端的配置迁移：

1. 将 `anthropic/claude-*` model ref 重写为 `claude-cli/*` 格式
2. 处理单 model（`agents.defaults.model`）和 models 数组两种配置形态
3. 通过 `cli-auth-seam.ts` 检测 Claude CLI 认证状态（interactive / non-interactive 两种模式）

## CLI 认证与凭据 (CLI Auth & Credentials)

### 多 CLI 凭据读取

`src/agents/cli-credentials.ts`（742 行）统一管理三种 CLI 的凭据读取：

| CLI | 凭据路径 | 读取方式 |
|-----|---------|---------|
| Claude CLI | `~/.claude/.credentials.json` + macOS Keychain | 文件读取 + `security find-generic-password` |
| Codex CLI | `~/.codex/auth.json` | 文件读取 |
| MiniMax CLI | `~/.minimax/oauth_creds.json` | 文件读取 |

每种凭据读取器具有：
- **TTL 缓存**：`CachedValue<T>` 结构，带 `readAt` 时间戳和 `sourceFingerprint`
- **Fingerprint 校验**：文件 mtime 变化时刷新缓存
- **Keychain 异常保护**：Claude CLI 的 keychain 读取失败不阻塞流程

### 认证 Epoch

`src/agents/cli-auth-epoch.ts` 的 `computeCliAuthEpoch()` 聚合所有已配置 CLI 凭据和 auth profile store 的状态，生成 SHA-256 摘要。用途：

- 检测认证状态变更（凭据更新、profile 切换）
- 触发会话重置（epoch 变化时重新建立 CLI session）

### 外部 CLI 凭据同步

`src/agents/auth-profiles/external-cli-sync.ts` 的 `syncExternalCliCredentials()` 将外部 CLI 的 OAuth 凭据同步到 auth profile store：

```
Codex CLI auth.json ──┐
                      ├──► areOAuthCredentialsEquivalent() 比对
MiniMax CLI creds  ───┘    ├── 等价 → 跳过
                           ├── 不等价 → 更新 profile
                           └── 不存在 → 创建 profile
```

同步间隔由 `EXTERNAL_CLI_SYNC_TTL_MS`（15 分钟）控制。

## CLI 输出解析 (CLI Output Parsing)

`src/agents/cli-output.ts`（452 行）是 CLI 后端输出的统一解析层，支持两种输出格式：

### JSON 模式

从 CLI stdout 提取 JSON 对象候选（处理前后缀噪声），解析 `text`、`sessionId`、`usage` 字段。

### Stream-JSON 模式（NDJSON）

由 `src/agents/cli-runner/helpers.ts` 的 `createStreamJsonProcessor()` 处理，详见上方伪代码。

两种模式均为 provider-aware：通过 `isClaudeCliProvider()` 判断是否应用 Anthropic 特有的解析逻辑。

## Bundle MCP 配置合并 (Bundle MCP)

`src/agents/cli-runner/bundle-mcp.ts`（130 行）处理 MCP 服务器配置的合并注入：

1. 查找 CLI 参数中已有的 `--mcp-config` 路径
2. 读取外部 MCP 配置（如有）
3. 加载已启用的 bundle MCP 服务
4. 合并两组配置到临时文件
5. 将临时文件路径注入 CLI 参数
6. 返回清理函数（删除临时文件）

仅在后端声明 `bundleMcp: true` 时激活（目前仅 Anthropic CLI 后端启用）。

## CLI Runner 可靠性 (Reliability)

`src/agents/cli-runner/reliability.ts`（88 行）实现 watchdog 超时策略：

- **Fresh 模式**：新会话使用更宽松的超时（CLI 启动需要更多时间）
- **Resume 模式**：恢复会话使用较短的超时
- 超时值 = `noOutputTimeoutRatio * totalTimeoutMs`，受 `minMs` / `maxMs` 约束
- 各后端通过 `CliBackendConfig.reliability.watchdog` 覆盖默认值

## Plugin SDK 与注册 (Plugin SDK & Registry)

### 新增 SDK 子路径

`openclaw/plugin-sdk/cli-backend` 是新增的公共 SDK 入口：

```typescript
// src/plugin-sdk/cli-backend.ts
export type { CliBackendConfig } from "../config/types.js";
export type { CliBackendPlugin } from "../plugins/types.js";
export { CLI_FRESH_WATCHDOG_DEFAULTS, CLI_RESUME_WATCHDOG_DEFAULTS } from "...";
```

扩展通过此路径获取类型和默认值来构建自己的 CLI 后端。

### 注册表扩展

`src/plugins/registry.ts` 新增 `PluginCliBackendRegistration` 和 `cliBackends` 字段。`src/plugins/types.ts` 新增 `CliBackendPlugin` 类型（66 行）。

### 插件加载器改进

`src/plugins/loader.ts` 的主要变更：

- **Embedded plugins 支持**：通过 `globalThis.__OPENCLAW_EMBEDDED_PLUGINS__` 注入的插件（Bun 二进制打包场景），加载器自动生成 discovery candidates
- **Module loading 重构**：统一 filesystem 和 embedded 两种来源的模块加载路径

### 运行时扩展

`src/plugins/runtime/index.ts` 新增：

- **`createRuntimeAgents()`**：惰性加载 `runEmbeddedPiAgent` 和 `runModelAwareAgent`
- **`hooks` 表面**：`hasMessageSendingHooks()`、`runMessageSending()`、`emitMessageSent()` — 将消息发送事件桥接到内部 hook 系统

## 参考代码行号 (Reference Line Numbers)

### 实现位置 — 三层保护与 Session Prompt 文件

rebase 后 `cli-runner.ts` 已缩减为薄包装层（~130 行），核心逻辑拆分到以下文件：

| 文件 | 实现内容 |
|------|----------|
| `src/agents/cli-runner/execute.ts` | `executeWithOverflowProtection()` — Layer 1 预检护栏 + Layer 2 运行时溢出恢复；`CliSessionBindingResult`、`CliPromptLoadResult` 类型定义 |
| `src/agents/cli-runner/prepare.ts` | session prompt 文件管理函数（`resolveClaudeSystemPromptFilePath`、`writeClaudeSystemPromptFile`、`buildClaudeSystemPromptLoaderPrompt`）；`estimatePromptTokens()`、`ESTIMATED_TOKENS_PER_IMAGE` 常量；`PromptFileReadRequiredError`、`resolveReadToolFilePath`、`promptFileReadVerified` |
| `src/agents/cli-runner/types.ts` | `RunCliAgentParams` 新增字段（`contextWindowTokens`、`bootstrapProfile` 等）；`PreparedCliRunContext` 新增字段 |
| `src/agents/cli-runner.ts` | 薄包装层，委托到 `execute.ts` 和 `prepare.ts` |

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

### CLI 后端抽象 — Provider CLI Backends

| 文件 | 关键实现 |
|------|---------|
| `extensions/anthropic/cli-backend.ts:14` | `buildAnthropicCliBackend()` — command: `claude`, output: `stream-json`, bundleMcp: true |
| `extensions/anthropic/cli-shared.ts:5` | `CLAUDE_CLI_MODEL_ALIASES` — 30+ alias 映射 |
| `extensions/anthropic/cli-shared.ts:61` | `normalizeClaudeBackendConfig()` — 配置规范化 |
| `extensions/anthropic/cli-auth-seam.ts:3` | `readClaudeCliCredentialsForSetup()` — 认证接缝 |
| `extensions/anthropic/cli-migration.ts:47` | `migrateToClaudeCli()` — model ref 重写 + 认证检测 |
| `extensions/google/cli-backend.ts:13` | `buildGoogleGeminiCliBackend()` — command: `gemini`, output: `json` |
| `extensions/openai/cli-backend.ts:7` | `buildOpenAICodexCliBackend()` — command: `codex exec`, output: `json` |

### CLI 认证与凭据

| 文件 | 关键实现 |
|------|---------|
| `src/agents/cli-credentials.ts:30` | `readClaudeCliCredentialsCached()` — 文件 + Keychain 读取，TTL 缓存 |
| `src/agents/cli-credentials.ts:200` | `readCodexCliCredentialsCached()` — auth.json 读取 |
| `src/agents/cli-credentials.ts:350` | `readMiniMaxCliCredentialsCached()` — oauth_creds.json 读取 |
| `src/agents/cli-auth-epoch.ts:50` | `computeCliAuthEpoch()` — SHA-256 聚合摘要 |
| `src/agents/auth-profiles/external-cli-sync.ts:40` | `syncExternalCliCredentials()` — 外部 CLI 凭据同步 |
| `src/agents/auth-profiles/external-cli-sync.ts:23` | `areOAuthCredentialsEquivalent()` — 凭据等价比较 |

### CLI 输出解析 — `src/agents/cli-output.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| JSON 对象提取 | 26 | `extractJsonObjectCandidates()` — 从 stdout 提取 JSON 候选 |
| 输出解析入口 | ~100 | `parseCliOutput()` — provider-aware 解析 |
| 流式增量解析 | ~200 | `parseCliStreamingDelta()` — 流式增量输出解析 |

### Bundle MCP — `src/agents/cli-runner/bundle-mcp.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| MCP config 路径查找 | 31 | `findMcpConfigPath()` — 从 CLI args 提取 --mcp-config |
| 外部 config 读取 | 20 | `readExternalMcpConfig()` — 读取已有 MCP 配置 |
| 合并与写入 | ~60 | `prepareBundleMcpConfig()` — 合并 + 写入临时文件 |

### Reliability — `src/agents/cli-runner/reliability.ts`

| 位置 | 行号 | 说明 |
|------|------|------|
| Watchdog profile 选取 | 9 | `pickWatchdogProfile()` — fresh/resume 模式选取 |
| 超时计算 | ~50 | ratio + min/max 约束逻辑 |

### Plugin SDK 与注册

| 文件 | 关键实现 |
|------|---------|
| `src/plugin-sdk/cli-backend.ts:1` | `CliBackendConfig`、`CliBackendPlugin` 类型导出 |
| `src/plugin-sdk/anthropic-cli.ts:6` | `loadFacadeModule()` — 惰性 facade 加载 |
| `src/plugin-sdk/provider-auth.ts` | 新增 `readClaudeCliCredentialsCached` 导出 |
| `src/plugins/registry.ts:141` | `PluginCliBackendRegistration` 类型 + `cliBackends` 字段 |
| `src/plugins/cli-backends.runtime.ts:8` | `resolveRuntimeCliBackends()` — 运行时后端解析 |
| `src/plugins/loader.ts:1127` | embedded plugins discovery candidates 注入 |
| `src/plugins/runtime/index.ts:96` | `createRuntimeAgents()` — 惰性 agent 运行时 |
| `src/plugins/runtime/index.ts:238` | `hooks` 表面 — message sending/sent 桥接 |

### Abort 集成 — `src/auto-reply/reply/abort.ts`（外部依赖/消费方，本 patch 未修改）

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

---

## Commit 12 修复说明

- `src/agents/cli-runner/execute.ts`：`promptFileReadVerified` 现在通过 `onToolUse` 回调在 JSONL 流式解析器中正确接线，确保 prompt 文件读取验证在 stream-json 模式下生效
