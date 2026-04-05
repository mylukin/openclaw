# Patch 06: 飞书入站消息处理增强

## 为什么要改 (Why)

飞书入站消息处理存在多个痛点：

1. **@提及标签格式不一致**：飞书 API 返回的 `@_user_1` 占位符在多用户场景下存在前缀重叠问题（如 `@_user_1` 和 `@_user_10`），逐个正则替换会导致级联误替换。同时卡片和文本消息使用不同的 at 标签格式（`<at user_id="x">` vs `<at id=x>`），需要双向规范化。

2. **引用消息内容丢失**：用户在 DM 中引用（回复）一条消息时，飞书 API 仅返回占位符而非原文。LLM 无法理解引用的上下文。需要从本地 session transcript、数据库、或飞书 API 逐级回退获取原始内容。

3. **消息撤回事件缺乏处理**：飞书 `im.message.recalled_v1` 事件没有处理器，导致日志中没有撤回追踪。

4. **开放 DM 策略下控制命令被拦截**：当 `dmPolicy=open` 且没有显式 allowlist 时，`/stop` 等控制命令因权限检查不通过而被拒绝，导致用户无法中断正在运行的 agent。

5. **发送者名称查询在无权限时反复失败**：飞书返回 `no user authority`（code 41050）时没有退避机制，每条消息都触发一次失败的 API 调用。

---

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `extensions/feishu/src/mention.ts` | 新增 `normalizeMentionTagsForCard()` 和 `normalizeMentionTagsForText()` 双向转换函数 |
| `extensions/feishu/src/mention.test.ts` | 新增 mention 标签规范化测试 |
| `extensions/feishu/src/bot-content.ts` | 修复 `normalizeMentions()`：按 key 长度降序排序，构建单一联合正则，避免级联替换 |
| `extensions/feishu/src/quoted-message.ts` | **新文件**：引用消息内容解析，支持 live session / 磁盘 session / 数据库 / API 四级回退 |
| `extensions/feishu/src/quoted-message.test.ts` | 新文件：引用消息解析完整测试 |
| `extensions/feishu/src/bot.ts` | DM 引用消息走 `resolveQuotedFeishuMessageContent()` 而非直接调飞书 API；新增 `createDirectReplyMirrorHandler()` 将 bot 回复写入 session transcript；新增 `openDirectCommandsAllowed` 逻辑；新增 `dispatchMode=plugin` 分支 |
| `extensions/feishu/src/bot-sender-name.ts` | 新增 `isNoUserAuthorityError()` 检测和 `senderLookupBackoff` map，对 code 41050 做 10 分钟退避 |
| `extensions/feishu/src/monitor.ts` | 新增 `im.message.recalled_v1` 事件处理器 |
| `extensions/feishu/src/monitor.utils.ts` | **新文件**：`buildRecalledEventSummary()` 从多种事件结构中提取撤回信息 |
| `extensions/feishu/src/config-schema.ts` | 新增 `dispatchMode`（`auto` / `plugin`）、`streamingInThread`、`cardHeader`、`cardNote`、`pluginMode` 配置项 |
| `extensions/feishu/src/typing.ts` | typing reaction 清理增加 `pickTypingReactionIdForCleanup()` fallback 逻辑 |

---

## 伪代码 (Pseudocode)

### 1. Mention 标签规范化（避免级联替换）

```
function normalizeMentions(text, mentions, botStripId):
    # 按 key 长度降序排序，避免 @_user_1 匹配 @_user_10 的前缀
    sorted = sort(mentions, by=key.length, desc)
    mentionMap = {}
    for mention in sorted:
        if mention.id == botStripId:
            replacement = ""  # 剥离 bot 自身的 mention
        else:
            replacement = '<at user_id="' + mention.id + '">' + mention.name + '</at>'
        mentionMap[mention.key] = replacement

    # 构建单一联合正则
    pattern = join(sorted.map(m => escape(m.key)), "|")
    return text.replace(RegExp(pattern, "g"), match => mentionMap[match]).trim()
```

### 2. Mention 格式双向转换

```
# Text → Card 格式（用于卡片消息发送）
function normalizeMentionTagsForCard(content):
    if "<at" not in content: return content
    return content.replace(/<at user_id="(id)">...</at>/g, "<at id=$1></at>")

# Card → Text 格式（用于普通文本消息）
function normalizeMentionTagsForText(content, displayNameMap):
    if "<at" not in content: return content
    return content.replace(/<at id=(id)><\/at>/g,
        '<at user_id="$1">' + (displayNameMap[$1] ?? ($1 == "all" ? "Everyone" : $1)) + '</at>')
```

### 3. 引用消息内容解析（四级回退）

```
async function resolveQuotedFeishuMessageContent(params):
    if not params.parentId: return {}

    # DM 模式：优先本地数据，避免 API 调用
    if not params.isGroup:
        # 1. 尝试 live session（内存中尚未 flush 的 session）
        content = readQuotedContentFromLiveSession(storePath, sessionKey, parentId)
        if content: return { content, source: "session" }

        # 2. 尝试磁盘上的 session transcript (.jsonl)
        content = readQuotedContentFromSession(storePath, sessionKey, parentId)
        if content: return { content, source: "session" }

        # 3. 尝试 bot-company 数据库
        content = readQuotedContentFromBotCompanyDb(cfg, chatId, parentId)
        if content: return { content, source: "db" }

    # 4. 最后回退到飞书 API
    apiResult = await getMessageFeishu(cfg, parentId, accountId)
    return { content: apiResult?.content, source: "api" }
```

### 4. DM 控制命令放行

```
# 在 handleFeishuMessage 中
openDirectCommandsAllowed =
    isDirect AND dmPolicy == "open" AND commandAllowFrom.length == 0

authorizers = [
    { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
    { configured: openDirectCommandsAllowed, allowed: openDirectCommandsAllowed },
]
commandAuthorized = resolveCommandAuthorizedFromAuthorizers(authorizers)
```

### 5. 发送者名称查询退避

```
function resolveFeishuSenderName(account, senderId):
    lookupKey = account.appId + ":" + senderId
    if senderLookupBackoff[lookupKey] > now:
        return {}  # 退避期内，跳过查询

    try:
        result = client.contact.user.get(senderId)
        if result.name:
            senderLookupBackoff.delete(lookupKey)
            return { name: result.name }
    catch err:
        if isNoUserAuthorityError(err):  # code 41050
            senderLookupBackoff[lookupKey] = now + 10_MINUTES
            return {}
```

---

## 数据流程图 (Data Flow Diagram)

### 引用消息解析流程

```
用户在飞书 DM 中引用回复一条消息
         |
         v
handleFeishuMessage() 检测 ctx.parentId 存在
         |
         v
    +----+---- isGroup? ----+
    |                        |
    v (DM)                   v (Group)
resolveQuotedFeishuMessage   getMessageFeishu()
Content()                    (直接调飞书 API)
    |
    v
+------- 1. Live Session -------+
| getLiveSessionTranscriptEntries() |
| 从内存获取 entries               |
|   找到? --> return "session"  |
+---------- 未找到 -------------+
         |
         v
+------- 2. Disk Session -------+
| readFileSync(session.jsonl)   |
| 逐行 JSON.parse 搜索匹配     |
|   找到? --> return "session"  |
+---------- 未找到 -------------+
         |
         v
+------- 3. Bot-Company DB -----+
| DatabaseSync(dbPath, readOnly)|
| SELECT content FROM           |
| chat_messages WHERE ...       |
|   找到? --> return "db"       |
+---------- 未找到 -------------+
         |
         v
+------- 4. Feishu API ---------+
| getMessageFeishu(cfg, parentId)|
|   return "api" or {}          |
+-------------------------------+
```

### Mention 标签规范化流程

```
飞书事件包含 mentions[] 数组和 text 原文
         |
         v
normalizeMentions(text, mentions, botOpenId)
         |
         v
  按 key 长度降序排序 mentions
  (避免 @_user_1 匹配 @_user_10)
         |
         v
  构建 mentionMap: { "@_user_1" => '<at user_id="ou_1">Name</at>',
                      "@_bot_1" => "" }  # bot mention 被剥离
         |
         v
  构建联合正则: /@_user_10|@_user_1|@_bot_1/g
         |
         v
  单次 replace 完成所有替换
         |
         v
  后续发送时按目标格式转换:
  +--> Card: normalizeMentionTagsForCard()  --> <at id=ou_1></at>
  +--> Text: normalizeMentionTagsForText()  --> <at user_id="ou_1">Name</at>
```

### DM 控制命令授权流程

```
用户在 open DM 中发送 /stop
         |
         v
dmPolicy == "open" AND allowFrom == []
         |
         v
openDirectCommandsAllowed = true
         |
         v
authorizers = [
  { configured: false, allowed: false },   # allowFrom 空
  { configured: true, allowed: true },     # open DM 放行
]
         |
         v
resolveCommandAuthorizedFromAuthorizers()
         |
         v
CommandAuthorized = true --> /stop 命令被执行
```

---

## 参考代码行号 (Reference Line Numbers)

> 基于当前源码文件（非 patch 行号）。

### `extensions/feishu/src/mention.ts`

| 行号 | 内容 |
|------|------|
| 19 | `AT_USER_ID_TAG_RE` 正则定义 |
| 21 | `AT_ID_TAG_RE` 正则定义 |
| 32 | `normalizeMentionTagsForCard()` — text 格式转 card 格式 |
| 45 | `normalizeMentionTagsForText()` — card 格式转 text 格式 |
| 65 | `extractMentionTargets()` — 从事件中提取非 bot mention 列表 |

### `extensions/feishu/src/quoted-message.ts`

| 行号 | 内容 |
|------|------|
| 76 | `extractConversationInfo()` — 从 transcript 条目中提取 message_id 的 JSON 块 |
| 136 | `matchesMirroredAssistantMessage()` — 匹配 assistant 消息的 providerMessageId |
| 157 | `findQuotedContentInEntries()` — 反向遍历 session entries 查找引用内容 |
| 215 | `readQuotedContentFromLiveSession()` — 从 live session 内存读取 |
| 240 | `readQuotedContentFromSession()` — 从磁盘 .jsonl 文件读取 |
| 303 | `readQuotedContentFromBotCompanyDb()` — 从 SQLite 数据库读取 |
| 338 | `resolveQuotedFeishuMessageContent()` — 四级回退主函数 |

### `extensions/feishu/src/bot.ts`

| 行号 | 内容 |
|------|------|
| 302 | `collectProviderMessageIds()` — 合并 messageId/messageIds 去重 |
| 320 | `createDirectReplyMirrorHandler()` — 将 bot 回复写入 session transcript |
| 491 | `dispatchMode = feishuCfg?.dispatchMode ?? "auto"` |
| 528-601 | requireMention / bound thread session 检测 |
| 606 | `dispatchMode !== "plugin" && requireMention && !ctx.mentionedBot` 门控 |
| 693-706 | `openDirectCommandsAllowed` 逻辑和双 authorizer 数组 |
| 900 | DM 引用消息走 `resolveQuotedFeishuMessageContent()` |

### `extensions/feishu/src/bot-content.ts`

| 行号 | 内容 |
|------|------|
| 248 | `normalizeMentions()` — 排序、构建联合正则、单次替换 |

### `extensions/feishu/src/bot-sender-name.ts`

| 行号 | 内容 |
|------|------|
| 30 | `senderLookupBackoff` Map 定义 |
| 79 | `buildSenderLookupKey()` |
| 83 | `isNoUserAuthorityError()` |
| 123-147 | 退避检查（124-125）和退避设置逻辑（146-147） |

### `extensions/feishu/src/monitor.ts`

| 行号 | 内容 |
|------|------|
| 306-315 | `im.message.recalled_v1` 事件处理器 |

### `extensions/feishu/src/monitor.utils.ts`

| 行号 | 内容 |
|------|------|
| 51 | `buildRecalledEventSummary()` — 从多种飞书事件结构中提取撤回详情 |

### `extensions/feishu/src/config-schema.ts`

| 行号 | 内容 |
|------|------|
| 23 | `DispatchModeSchema = z.enum(["auto", "plugin"])` |
| 73 | `PluginModeConfigSchema` — pluginMode.forwardControlCommands |
| 148 | `StreamingInThreadSchema` |
| 197 | `cardHeader` 配置项 |
| 198 | `cardNote` 配置项 |

### `extensions/feishu/src/typing.ts`

| 行号 | 内容 |
|------|------|
| 69 | `pickTypingReactionIdForCleanup()` — typing reaction 清理 fallback（调用点 226） |
