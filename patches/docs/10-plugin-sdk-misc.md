# Patch 10: Plugin SDK 导出扩展、守卫测试和运行时 Mock

## 为什么要改 (Why)

Patch 09 引入了飞书线程绑定管理器，该管理器依赖多个 core 内部模块（session binding service、diagnostic events、media mime、utility 函数等）。这些模块需要通过 plugin-sdk 的公开 subpath 导出，才能满足插件的导入边界约束。

同时：
1. 守卫测试的快照需要更新以反映新增的导出项
2. 飞书扩展的两个文件 (`quoted-message.ts`, `thread-bindings.manager.ts`) 需要加入导入例外列表
3. 运行时 Mock 缺少 `agents` 和 `hooks` 命名空间的桩，导致依赖这些接口的测试无法运行

## 改了什么 (What Changed)

| 文件 | 变更 |
|------|------|
| `src/plugin-sdk/index.ts` | 新增大量运行时导出和类型导出 |
| `src/plugin-sdk/feishu.ts` | 新增飞书专用导出（hook runner、session、sanitize 等） |
| `src/plugins/contracts/plugin-sdk-index.test.ts` | 更新运行时导出快照 |
| `src/plugin-sdk/channel-import-guardrails.test.ts` | 新增飞书文件到例外列表 |
| `test/helpers/plugins/plugin-runtime-mock.ts` | 新增 `agents` 和 `hooks` Mock |
| `.gitignore` | 新增 `skills/skillstore-plugin-publisher/` |

## 伪代码 (Pseudocode)

### plugin-sdk/index.ts 新增导出

```
// 工具函数（从 utils.ts 导出）
export { clamp, escapeRegExp, normalizeE164, safeParseJson, sleep }
export { stripAnsi }

// Session Binding Service（完整 API）
export {
    getSessionBindingService,
    registerSessionBindingAdapter,
    unregisterSessionBindingAdapter,
    SessionBindingError,
    isSessionBindingError,
}
export type {
    BindingTargetKind, BindingStatus, ConversationRef,
    SessionBindingAdapter, SessionBindingRecord, ...
}

// 日志传输
export { registerLogTransport }

// 诊断事件（从仅导出 onDiagnosticEvent 扩展为完整 API）
export { emitDiagnosticEvent, isDiagnosticsEnabled, onDiagnosticEvent }
export type { DiagnosticEventPayload, DiagnosticHeartbeatEvent, ... 全部14个诊断事件类型 }

// 媒体工具
export { detectMime, extensionForMime, getFileExtension }
export { extractOriginalFilename }

// Skill 命令
export { listSkillCommandsForAgents }

// 错误工具
export { missingTargetError }
```

### plugin-sdk/feishu.ts 新增导出

```
// 以下从 core 导出供飞书插件使用：
export { getGlobalHookRunner }              // 获取全局 hook 运行器
export { getLiveSessionTranscriptEntries }   // 获取实时会话记录
export {
    appendAssistantMessageToSessionTranscript,
    loadSessionStore,
    resolveSessionFilePath,
    resolveSessionFilePathOptions,
}
export type { SessionEntry, SessionTranscriptMessageMeta }
export { stripEnvelopeFromMessage }          // 消息信封剥离
export { resolveUserPath }                   // 用户路径解析
```

### 守卫测试例外更新

```
// channel-import-guardrails.test.ts
LOCAL_EXTENSION_API_BARREL_EXCEPTIONS = [
    "extensions/matrix/src/matrix/accounts.ts",
    // 新增：飞书文件直接导入 SDK barrel
    "extensions/feishu/src/quoted-message.ts",      // +新增
    "extensions/feishu/src/thread-bindings.manager.ts", // +新增
]
```

### 运行时 Mock 扩展

```
// plugin-runtime-mock.ts
createPluginRuntimeMock():
    base = {
        version: "1.0.0-test",

        // +新增 agents 命名空间
        agents: {
            runEmbeddedPiAgent: vi.fn(),
            runModelAwareAgent: vi.fn(),
        },

        // +新增 hooks 命名空间
        hooks: {
            hasMessageSendingHooks: vi.fn(() => false),
            runMessageSending: vi.fn(async () => undefined),
            emitMessageSent: vi.fn(),
        },

        config: { ... },   // 已有
        agent: { ... },     // 已有
        ...
    }
    return mergeDeep(base, overrides)
```

## 数据流程图 (Data Flow Diagram)

### 导入边界体系

```
extensions/feishu/src/*.ts
    |
    |  允许的导入路径:
    |
    +---> "openclaw/plugin-sdk"                    (根导出)
    |         --> src/plugin-sdk/index.ts
    |
    +---> "openclaw/plugin-sdk/feishu"             (飞书专用)
    |         --> src/plugin-sdk/feishu.ts
    |
    +---> "openclaw/plugin-sdk/conversation-runtime" (会话运行时)
    |         --> registerSessionBindingAdapter 等
    |
    +---> "openclaw/plugin-sdk/core"               (核心工具)
    |         --> normalizeAccountId 等
    |
    X     不允许: 直接 import "../../../src/xxx"
    X     不允许: import "openclaw/plugin-sdk/feishu" 从插件自身
```

### SDK 导出依赖链（新增部分）

```
src/plugin-sdk/index.ts (根导出)
    |
    +---> src/utils.ts
    |         clamp, escapeRegExp, normalizeE164, safeParseJson, sleep
    |
    +---> src/terminal/ansi.ts
    |         stripAnsi
    |
    +---> src/infra/outbound/session-binding-service.ts
    |         getSessionBindingService, registerSessionBindingAdapter,
    |         unregisterSessionBindingAdapter, SessionBindingError, ...
    |
    +---> src/infra/outbound/target-errors.ts
    |         missingTargetError
    |
    +---> src/logging/logger.ts
    |         registerLogTransport
    |
    +---> src/infra/diagnostic-events.ts
    |         emitDiagnosticEvent, isDiagnosticsEnabled, onDiagnosticEvent
    |
    +---> src/media/mime.ts
    |         detectMime, extensionForMime, getFileExtension
    |
    +---> src/media/store.ts
    |         extractOriginalFilename
    |
    +---> src/auto-reply/skill-commands.ts
              listSkillCommandsForAgents

src/plugin-sdk/feishu.ts (飞书专用导出)
    |
    +---> src/plugins/hook-runner-global.ts
    |         getGlobalHookRunner
    |
    +---> src/agents/pi-embedded-runner/live-session-registry.ts
    |         getLiveSessionTranscriptEntries
    |
    +---> src/config/sessions.ts
    |         appendAssistantMessageToSessionTranscript,
    |         loadSessionStore, resolveSessionFilePath, ...
    |
    +---> src/gateway/chat-sanitize.ts
    |         stripEnvelopeFromMessage
    |
    +---> src/utils.ts
              resolveUserPath
```

### 守卫测试验证流程

```
channel-import-guardrails.test.ts
    |
    +---> 扫描 extensions/**/src/**/*.ts 源文件
    |
    +---> 对每个扩展的非 api barrel 源文件:
    |         |
    |         v
    |     检查是否 import "openclaw/plugin-sdk/<同名扩展>"
    |         |
    |         v
    |     如果匹配且不在 LOCAL_EXTENSION_API_BARREL_EXCEPTIONS 中:
    |         --> 测试失败
    |
    +---> 对每个 SAME_CHANNEL_SDK_GUARDS 条目:
    |         |
    |         v
    |     读取源文件内容
    |     检查 forbiddenPatterns 是否匹配
    |         --> 匹配则测试失败
    |
    +---> index.test.ts "keeps the root runtime surface intentionally small":
              |
              v
          collectRuntimeExports("src/plugin-sdk/index.ts")
              |
              v
          断言排序后的导出列表 === 快照
              （快照新增了 SessionBindingError, clamp, detectMime,
               emitDiagnosticEvent, escapeRegExp, extensionForMime,
               extractOriginalFilename, getFileExtension,
               getSessionBindingService, isDiagnosticsEnabled,
               isSessionBindingError, listSkillCommandsForAgents,
               missingTargetError, normalizeE164, registerLogTransport,
               registerSessionBindingAdapter, safeParseJson, sleep,
               stripAnsi, unregisterSessionBindingAdapter）
```

### 运行时 Mock 使用流程

```
测试文件 (e.g. thread-bindings.manager.test.ts)
    |
    v
import { createPluginRuntimeMock }
    from "test/helpers/plugins/plugin-runtime-mock.ts"
    |
    v
const runtime = createPluginRuntimeMock({
    // 可选覆盖
    hooks: { hasMessageSendingHooks: vi.fn(() => true) }
})
    |
    v
mergeDeep(base, overrides)               [plugin-runtime-mock.ts:23-36]
    |
    +---> base.agents.runEmbeddedPiAgent   [行 76-79]  <-- 新增
    +---> base.agents.runModelAwareAgent   [行 76-79]  <-- 新增
    +---> base.hooks.hasMessageSendingHooks [行 81-83] <-- 新增
    +---> base.hooks.runMessageSending     [行 84-86]  <-- 新增
    +---> base.hooks.emitMessageSent       [行 87]     <-- 新增
    +---> ... 已有的 config, agent, system 等
    |
    v
返回完整的 PluginRuntime mock 对象
```

## 参考代码行号 (Reference Line Numbers)

### `src/plugin-sdk/index.ts`

| 行号 | 内容 |
|------|------|
| 89 | `export { clamp, escapeRegExp, normalizeE164, safeParseJson, sleep }` (新增) |
| 90 | `export { stripAnsi }` (新增) |
| 91 | `export { missingTargetError }` (新增) |
| 92-98 | Session Binding Service 运行时导出 (新增) |
| 99-112 | Session Binding Service 类型导出 (新增) |
| 113 | `export { registerLogTransport }` (新增) |
| 114 | LogTransport 类型导出 (新增) |
| 115-119 | 诊断事件运行时导出 (改为 3 个函数，原来只有 `onDiagnosticEvent`) |
| 120-135 | 诊断事件全部类型导出 (新增 14 个类型) |
| 136 | `export { detectMime, extensionForMime, getFileExtension }` (新增) |
| 137 | `export { extractOriginalFilename }` (新增) |
| 138 | `export { listSkillCommandsForAgents }` (新增) |
| 139 | `export type { SkillCommandSpec }` (新增) |
| 157 | `export { emptyPluginConfigSchema }` (保留，位置后移) |
| 158 | `export { registerContextEngine }` (保留) |
| 159 | `export { delegateCompactionToRuntime }` (保留) |

### `src/plugin-sdk/feishu.ts`

| 行号 | 内容 |
|------|------|
| 71 | `export { getGlobalHookRunner }` (新增) |
| 72 | `export { getLiveSessionTranscriptEntries }` (新增) |
| 73-78 | session 存储相关导出 (新增 4 个函数) |
| 79 | `SessionEntry`, `SessionTranscriptMessageMeta` 类型导出 (新增) |
| 80 | `export { stripEnvelopeFromMessage }` (新增) |
| 81 | `export { resolveUserPath }` (新增) |

### `src/plugin-sdk/channel-import-guardrails.test.ts`

| 行号 | 内容 |
|------|------|
| 167-174 | `LOCAL_EXTENSION_API_BARREL_EXCEPTIONS` 数组 |
| 172 | `"extensions/feishu/src/quoted-message.ts"` (新增例外) |
| 173 | `"extensions/feishu/src/thread-bindings.manager.ts"` (新增例外) |

### `src/plugins/contracts/plugin-sdk-index.test.ts`

| 行号 | 内容 |
|------|------|
| 96-127 | 运行时导出快照断言 (原来约 8 项，现在约 25 项) |

### `test/helpers/plugins/plugin-runtime-mock.ts`

| 行号 | 内容 |
|------|------|
| 76-79 | `agents` 命名空间 Mock (新增) |
| 77 | `runEmbeddedPiAgent: vi.fn()` |
| 78 | `runModelAwareAgent: vi.fn()` |
| 80-88 | `hooks` 命名空间 Mock (新增) |
| 81-83 | `hasMessageSendingHooks: vi.fn(() => false)` |
| 84-86 | `runMessageSending: vi.fn(async () => undefined)` |
| 87 | `emitMessageSent: vi.fn()` |

### `.gitignore`

| 行号 | 内容 |
|------|------|
| 27 | 新增 `skills/skillstore-plugin-publisher/` 到忽略列表 |
