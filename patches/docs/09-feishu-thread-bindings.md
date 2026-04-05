# Patch 09: 飞书话题线程绑定管理器

## 为什么要改 (Why)

飞书插件需要支持子 agent 会话（subagent/ACP）绑定到群聊话题线程。当 agent 在飞书群聊中启动一个新的子会话时，需要：

1. 在群聊中创建一个话题线程作为该会话的独立通道
2. 将该线程与 agent session 建立双向映射关系
3. 在会话空闲或超龄时自动清理绑定
4. 进程重启后恢复绑定状态（持久化到磁盘）

之前没有这套机制，飞书群聊中的 subagent 会话无法隔离到独立线程，消息会混在主群聊里。

## 改了什么 (What Changed)

| 文件 | 变更 |
|------|------|
| `extensions/feishu/src/thread-bindings.types.ts` | 新增类型定义和常量 |
| `extensions/feishu/src/thread-bindings.state.ts` | 新增持久化状态存储层 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 新增线程绑定管理器及 SDK adapter |
| `extensions/feishu/src/thread-bindings.manager.test.ts` | 管理器单元测试 (399 行) |
| `extensions/feishu/src/thread-bindings.state.test.ts` | 状态层单元测试 (127 行) |

## 架构总览

系统分三层：

```
+-----------------------------------------------------+
|  thread-bindings.manager.ts                          |
|  - 每个 accountId 一个 manager 实例（单例注册表）      |
|  - 绑定/解绑/touch/sweep 逻辑                        |
|  - 注册 SessionBindingAdapter 到 SDK                  |
+-----------------------------------------------------+
          |                          |
          v                          v
+-------------------------+  +------------------------+
| thread-bindings.state.ts|  | thread-bindings.types.ts|
| - 内存双索引 Map        |  | - 类型定义              |
| - 磁盘 JSON 持久化      |  | - 超时常量              |
| - globalThis 单例状态   |  +------------------------+
+-------------------------+
```

## 类型定义 (thread-bindings.types.ts)

核心记录类型 `FeishuThreadBindingRecord`（第 3-16 行）：

```
FeishuThreadBindingRecord {
  accountId   -- 飞书账号 ID
  chatId      -- 群聊 ID (oc_xxx)
  rootId      -- 话题线程锚定消息 ID (om_xxx)
  targetKind  -- "subagent" | "acp"
  targetSessionKey -- agent 会话 key
  agentId     -- agent ID
  label       -- 可选展示标签
  boundBy     -- 绑定操作者/来源
  boundAt     -- 绑定时间戳
  lastActivityAt -- 最后活跃时间戳
  idleTimeoutMs  -- 空闲超时 (可选，覆盖默认值)
  maxAgeMs       -- 最大存活时间 (可选)
}
```

默认常量（第 23-27 行）：

| 常量 | 值 | 用途 |
|------|-----|------|
| `FEISHU_THREAD_BINDINGS_VERSION` | 1 | 持久化格式版本号 |
| `FEISHU_THREAD_BINDINGS_SWEEP_INTERVAL_MS` | 120,000 (2min) | 清扫定时器间隔 |
| `DEFAULT_FEISHU_THREAD_BINDING_IDLE_TIMEOUT_MS` | 86,400,000 (24h) | 默认空闲超时 |
| `DEFAULT_FEISHU_THREAD_BINDING_MAX_AGE_MS` | 0 (禁用) | 默认最大存活时间 |
| `FEISHU_THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS` | 15,000 (15s) | touch 持久化最小间隔 |

## 伪代码 (Pseudocode)

### 创建管理器

```
function createFeishuThreadBindingManager(params):
    从磁盘加载已有绑定 (ensureBindingsLoaded)
    accountId = normalizeAccountId(params.accountId)

    如果该 accountId 已有 manager 实例:
        直接返回已有实例（单例）

    初始化超时参数: idleTimeoutMs, maxAgeMs
    创建 manager 对象（包含 bind/unbind/touch/getByKey 等方法）

    如果 enableSweeper != false:
        启动 setInterval 定时器（每 2 分钟）:
            遍历所有绑定
            检查 idle 超时: lastActivityAt + idleTimeoutMs < now
            检查 max-age 超时: boundAt + maxAgeMs < now
            触发 unbind 并发送告别消息

    注册到全局 MANAGERS_BY_ACCOUNT 单例表
    注册 SessionBindingAdapter 到 plugin-sdk
    返回 manager
```

### 绑定流程 (bind)

```
async function bind(params):
    验证 chatId 和 targetSessionKey 非空

    // 第一步：发送 intro 消息创建线程锚点
    result = await sendMessageFeishu({to: "chat:{chatId}", text: introText})
    rootId = result.messageId

    // 第二步：回复该消息以激活飞书话题线程 UI
    await sendMessageFeishu({
        to: "chat:{chatId}",
        replyToMessageId: rootId,
        replyInThread: true,
        text: "Listening in this thread."
    })

    // 第三步：构造绑定记录并写入状态
    record = { accountId, chatId, rootId, targetKind, targetSessionKey, ... }
    setBindingRecord(record)    // 写入内存双索引
    if persist: saveBindingsToDisk()  // 写入磁盘
    return record
```

### 解绑流程 (unbind)

```
function unbind(chatId, rootId, opts):
    key = toBindingKey(accountId, chatId, rootId)
    removed = removeBindingRecord(key)  // 从内存移除
    if persist: saveBindingsToDisk()
    if sendFarewell:
        sendMessageFeishu({replyToMessageId: rootId, replyInThread: true, text: farewellText})
    return removed
```

### Touch（更新活跃时间）

```
function touch(chatId, rootId, at?):
    key = toBindingKey(accountId, chatId, rootId)
    existing = BINDINGS_BY_KEY.get(key)
    updated = { ...existing, lastActivityAt: max(existing.lastActivityAt, at || now) }
    setBindingRecord(updated)
    if persist:
        saveBindingsToDisk({ minIntervalMs: 15000 })  // 节流写盘
```

### SessionBindingAdapter (SDK 集成)

```
registerSessionBindingAdapter({
    channel: "feishu",
    accountId,
    capabilities: { placements: ["current", "child"] },

    bind(input):
        if placement == "child":
            // 在群聊中创建新话题线程
            chatId = input.conversation.parentConversationId
            return manager.bind({chatId, ...})
        if placement == "current":
            // 绑定到已有线程
            {chatId, rootId} = parseConversationId(conversationId)
            setBindingRecord({chatId, rootId, ...})
            return toSessionBindingRecord(record)

    resolveByConversation(ref):
        {chatId, rootId} = parseConversationId(ref.conversationId)
        return manager.getByKey(chatId, rootId)

    unbind(input):
        if targetSessionKey: manager.unbindBySessionKey(...)
        if bindingId: manager.unbind(...)
})
```

## 数据流程图 (Data Flow Diagram)

### 绑定创建流程

```
调用方 (ACP/Subagent)
    |
    v
SessionBindingAdapter.bind(placement="child")     [manager.ts:405]
    |
    v
manager.bind({chatId, targetSessionKey})           [manager.ts:271]
    |
    +---> sendMessageFeishu(intro)                 [manager.ts:282]
    |         |
    |         v
    |     飞书 API (创建消息，获得 rootId)
    |
    +---> sendMessageFeishu(reply, replyInThread)   [manager.ts:296]
    |         |
    |         v
    |     飞书 API (激活话题线程 UI)
    |
    +---> setBindingRecord(record)                  [state.ts:93]
    |         |
    |         +---> BINDINGS_BY_KEY.set(key, record)
    |         +---> linkSession(sessionKey, key)     --> BINDINGS_BY_SESSION
    |
    +---> saveBindingsToDisk()                      [state.ts:153]
              |
              v
          ~/.openclaw/feishu/thread-bindings.json
```

### 消息路由查询

```
飞书 webhook 收到线程消息 (chatId + rootId)
    |
    v
adapter.resolveByConversation({                    [manager.ts:473]
    conversationId: "oc_chat1:om_root1"
})
    |
    v
parseConversationId("oc_chat1:om_root1")           [state.ts:60]
    --> { chatId: "oc_chat1", rootId: "om_root1" }
    |
    v
manager.getByKey("oc_chat1", "om_root1")           [manager.ts:238]
    |
    v
BINDINGS_BY_KEY.get("acc1:oc_chat1:om_root1")
    |
    v
返回 SessionBindingRecord { targetSessionKey, ... }
    --> 路由到正确的 agent session
```

### 过期清扫流程

```
setInterval (每 120 秒)                             [manager.ts:369]
    |
    v
遍历 manager.listBindings()                        [manager.ts:251]
    |
    +---> 对每个 binding:
    |         |
    |         v
    |     检查 idle: lastActivityAt + idleTimeoutMs < now?  [manager.ts:375]
    |     检查 max-age: boundAt + maxAgeMs < now?           [manager.ts:376]
    |         |
    |         v (如果过期)
    |     manager.unbind(chatId, rootId, {                  [manager.ts:386]
    |         reason: "idle-expired",
    |         sendFarewell: true
    |     })
    |         |
    |         +---> removeBindingRecord(key)                [state.ts:103]
    |         +---> sendFarewellInThread(record, text)      [manager.ts:224]
    |         +---> saveBindingsToDisk()                    [state.ts:153]
```

### 状态持久化

```
saveBindingsToDisk()                                [state.ts:153]
    |
    v
检查节流: now - lastPersistedAtMs < minIntervalMs?
    |
    v (通过)
遍历 BINDINGS_BY_KEY --> 序列化为 JSON
    |
    v
写入临时文件: {path}.tmp.{pid}                      [state.ts:175-176]
    |
    v
原子重命名: rename(tmpPath, filePath)               [state.ts:177]
    --> ~/.openclaw/feishu/thread-bindings.json

ensureBindingsLoaded()                              [state.ts:181]
    |
    v
读取 thread-bindings.json                           [state.ts:190]
    |
    v
校验 version 字段                                   [state.ts:195]
    |
    v
遍历 bindings --> setBindingRecord() 恢复内存索引    [state.ts:201-204]
```

## 内存状态结构

```
globalThis.__openclawFeishuThreadBindingsState:
    bindingsByKey:    Map<string, FeishuThreadBindingRecord>
                      key = "accountId:chatId:rootId"
    bindingsBySession: Map<string, Set<string>>
                      key = targetSessionKey, value = Set<bindingKey>
    persistByAccountId: Map<string, boolean>
    loadedBindings:    boolean
    lastPersistedAtMs: number

globalThis.__openclawFeishuThreadBindingManagers:
    Map<string, FeishuThreadBindingManager>
    key = accountId (规范化后)
```

两层 globalThis 单例设计是为了确保 ESM 和 jiti 加载器路径共享同一份状态。

## 参考代码行号 (Reference Line Numbers)

### `extensions/feishu/src/thread-bindings.types.ts`

| 行号 | 内容 |
|------|------|
| 1 | `FeishuThreadBindingTargetKind` 类型定义 |
| 3-16 | `FeishuThreadBindingRecord` 完整字段 |
| 18-20 | `PersistedFeishuThreadBindingsPayload` 持久化载荷类型 |
| 23 | `FEISHU_THREAD_BINDINGS_VERSION = 1` |
| 24 | `FEISHU_THREAD_BINDINGS_SWEEP_INTERVAL_MS = 120_000` |
| 25 | `DEFAULT_FEISHU_THREAD_BINDING_IDLE_TIMEOUT_MS = 24h` |
| 26 | `DEFAULT_FEISHU_THREAD_BINDING_MAX_AGE_MS = 0` |
| 27 | `FEISHU_THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS = 15_000` |

### `extensions/feishu/src/thread-bindings.state.ts`

| 行号 | 内容 |
|------|------|
| 15-21 | `FeishuThreadBindingsGlobalState` 全局状态类型 |
| 23 | `STATE_KEY` globalThis 键名 |
| 35-41 | `resolveGlobalState()` 单例初始化 |
| 45-46 | 导出 `BINDINGS_BY_KEY` / `BINDINGS_BY_SESSION` |
| 52-54 | `toBindingKey()` 构造 "accountId:chatId:rootId" |
| 56-58 | `toConversationId()` 构造 "chatId:rootId" |
| 60-66 | `parseConversationId()` 解析复合 ID |
| 72-78 | `linkSession()` 维护 session -> bindingKey 反向索引 |
| 80-87 | `unlinkSession()` 清理反向索引 |
| 93-101 | `setBindingRecord()` 写入记录并维护双索引 |
| 103-109 | `removeBindingRecord()` 删除记录并清理索引 |
| 111-119 | `resolveBindingKeysForSession()` 按 session 查找绑定 |
| 125-132 | `resolveStateDirFromEnv()` 路径解析（支持测试/生产环境） |
| 134-136 | `resolveThreadBindingsPath()` -> `~/.openclaw/feishu/thread-bindings.json` |
| 142-144 | `shouldDefaultPersist()` 非测试环境默认持久化 |
| 153-179 | `saveBindingsToDisk()` 原子写入（先 tmp 再 rename） |
| 157-164 | 写盘节流逻辑（minIntervalMs 检查） |
| 181-206 | `ensureBindingsLoaded()` 启动时从磁盘恢复 |
| 208-210 | `setPersistEnabled()` 按 account 控制持久化开关 |
| 212-218 | `resetForTests()` 测试清理 |

### `extensions/feishu/src/thread-bindings.manager.ts`

| 行号 | 内容 |
|------|------|
| 36-40 | `resolveAgentIdFromSessionKey()` 从 session key 提取 agentId |
| 42-48 | `normalizeTargetKind()` 推断 subagent/acp 类型 |
| 58-63 | `normalizeDurationMs()` 安全的时长转换 |
| 73-80 | `resolveInactivityExpiresAt()` 计算 idle 过期时间 |
| 82-89 | `resolveMaxAgeExpiresAt()` 计算 max-age 过期时间 |
| 91-99 | `resolveEffectiveExpiresAt()` 取两个过期时间的较早者 |
| 101-128 | `toSessionBindingRecord()` 内部记录 -> SDK 标准记录转换 |
| 130-138 | `parseBindingIdParts()` 从 bindingId 反解 chatId/rootId |
| 145-157 | 全局 manager 注册表（globalThis 单例） |
| 163-180 | `FeishuThreadBindingManager` 类型定义（公开 API） |
| 182-190 | `FeishuBindParams` 绑定参数类型 |
| 192-199 | `CreateManagerParams` 工厂参数类型 |
| 201-203 | `createFeishuThreadBindingManager()` 工厂函数入口 |
| 204 | `ensureBindingsLoaded()` 确保磁盘状态已加载 |
| 206-208 | 单例检查：同 accountId 直接返回已有 manager |
| 214-219 | 初始化超时默认值 |
| 224-233 | `sendFarewellInThread()` 告别消息辅助函数（fire-and-forget） |
| 238-242 | `getByKey()` 按 chatId+rootId 查找 |
| 244-249 | `listBySessionKey()` 按 session key 列出所有绑定 |
| 251 | `listBindings()` 列出当前 account 的所有绑定 |
| 253-269 | `touch()` 更新活跃时间 + 节流持久化 |
| 271-327 | `bind()` 完整绑定流程（发消息 -> 创建记录 -> 持久化） |
| 329-339 | `unbind()` 解绑 + 告别消息 + 持久化 |
| 341-354 | `unbindBySessionKey()` 批量解绑 |
| 356-365 | `stop()` 停止 sweeper + 注销 adapter + 从注册表移除 |
| 368-395 | sweeper 定时器逻辑（idle/max-age 双检查） |
| 397 | 注册到 `MANAGERS_BY_ACCOUNT` |
| 400-502 | `registerSessionBindingAdapter()` SDK adapter 完整实现 |
| 403 | adapter capabilities: `["current", "child"]` |
| 405-443 | adapter `bind()`: child 创建新线程 / current 绑定已有线程 |
| 470-471 | adapter `listBySession()` |
| 473-479 | adapter `resolveByConversation()` 消息路由查询 |
| 481-485 | adapter `touch()` |
| 487-501 | adapter `unbind()` |
| 507-512 | `resetManagersForTests()` 测试清理 |
