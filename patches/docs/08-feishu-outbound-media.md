# Patch 08: 飞书出站消息 Hooks、媒体发送与 Channel 集成

## 为什么要改 (Why)

1. **出站消息缺少 Hook 事件**：飞书 channel plugin 的 `handleAction`（工具调用发送）和 outbound adapter 发送消息后没有发射 `message_sent` hook。下游消费者（如 bot-company journal 插件）无法记录出站消息的元数据（消息 ID、chat ID、内容类型等）。

2. **媒体/图片发送没有集成到 channel action**：`send` action 只支持 `text` 和 `card` 参数，不支持 `media`/`image`/`filePath` 参数。Agent 通过工具调用发送图片时需要走不同的路径。

3. **`message_sending` hook 管线缺失**：发送前的内容改写（如追加 mention、审核过滤）在 channel action 路径中没有实现，只在回复分发器中生效。

4. **媒体消息缺少内容类型元数据**：`sendMediaFeishu()` 返回的结果没有包含原始内容 JSON（如 `{"image_key":"..."}` 或 `{"file_key":"..."}`），导致下游无法知道发送了什么类型的媒体。

5. **reply-dispatcher 创建函数没有通过 plugin runtime 暴露**：外部插件（如 bot-company）需要创建流式卡片回复分发器，但只能 fallback 到通用的 route-reply 路径，无法使用飞书原生的流式卡片能力。

6. **media reply 路由逻辑错误**：当 `replyToMessageId` 存在但 `replyInThread` 为 false 时，`sendImageFeishu` 和 `sendFileFeishu` 错误地使用 `message.reply` API，导致消息被强制放入话题线程。

---

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `extensions/feishu/src/channel.ts` | `send` action 支持 `media`/`image`/`filePath` 参数；新增 `emitFeishuActionMessageSent()` 和 `applyFeishuActionMessageSending()`；text/card/media 三路分发均发射 hook |
| `extensions/feishu/src/outbound.ts` | `sendText` 返回值增加 `meta.contentType`/`meta.finalContent`；`sendMedia` 返回值增加 `meta.contentType`/`meta.rawContent`；import 改用 `shouldUseFeishuMarkdownCard` |
| `extensions/feishu/src/media.ts` | `sendImageFeishu`/`sendFileFeishu` 修复 reply 路由条件（`replyToMessageId && replyInThread`）；返回值增加 `rawContent` 字段 |
| `extensions/feishu/src/media-types.ts` | **新文件**：`resolveMediaContentType()` — 根据扩展名解析媒体类型 |
| `extensions/feishu/index.ts` | 导出 `createFeishuReplyDispatcher` 和 `getBotOpenId`；`registerFull()` 将 dispatcher 注册到 `runtime.channel.reply` |
| `extensions/feishu/src/exports.test.ts` | **新文件**：验证导出和 runtime 注册 |

---

## 伪代码 (Pseudocode)

### 1. Channel Action 发送流程（含 Hook）

```
async handleAction("send", params):
    to = params.to
    text = readFirstString(params, ["text", "message"])
    card = params.card
    mediaUrl = readFirstString(params, ["media", "filePath", "media_url", "image"])

    if not card and not text and not mediaUrl:
        throw Error("requires text/message, card, or media")

    # --- message_sending hook ---
    lifecycleResult = await applyFeishuActionMessageSending({
        to, content: text ?? "", accountId, mediaUrls: [mediaUrl]
    })
    if lifecycleResult.cancelled:
        return { ok: true, cancelled: true }

    # --- 三路分发 ---
    if card:
        result = await sendCardFeishu(cfg, to, card, ...)
        emitFeishuActionMessageSent({
            to, content: "", result,
            metadata: { contentType: "interactive" }
        })

    elif mediaUrl:
        # 先发文本（如果有）
        if lifecycleResult.content.trim():
            textResult = await feishuOutbound.sendText(lifecycleResult.content)
            emitFeishuActionMessageSent({
                to, content: lifecycleResult.content, result: textResult
            })

        # 再发媒体
        mediaResult = await feishuOutbound.sendMedia(mediaUrl)
        emitFeishuActionMessageSent({ to, content: "", result: mediaResult })
        return mediaResult

    else:
        textResult = await feishuOutbound.sendText(lifecycleResult.content)
        emitFeishuActionMessageSent({ to, content: lifecycleResult.content, result: textResult })
        return textResult
```

### 2. message_sending Hook 管线

```
async function applyFeishuActionMessageSending(params):
    hookResult = await runtime.hooks.runMessageSending(
        {
            to: params.to,
            content: params.content,
            metadata: {
                channel: "feishu",
                accountId,
                mediaUrls: params.mediaUrls,
                replyToId: params.replyToId,
                threadId: params.threadId,
            }
        },
        { channelId: "feishu", accountId, conversationId: params.to }
    )

    if hookResult?.cancel:
        return { cancelled: true, content: params.content }

    return {
        cancelled: false,
        content: hookResult?.content ?? params.content,
        metadata: hookResult?.metadata
    }
```

### 3. message_sent 事件发射

```
function emitFeishuActionMessageSent(params):
    runtime.hooks.emitMessageSent(
        {
            to: params.to,
            content: params.content,
            success: true,
            messageId: params.result.messageId,
            metadata: {
                chatId: params.result.chatId,
                ...params.result.meta,
                ...params.metadata,
            }
        },
        {
            channelId: "feishu",
            accountId: params.accountId,
            conversationId: params.result.chatId ?? params.to,
            sessionKey: params.sessionKey,
            isGroup: params.isGroup,
            groupId: isGroup ? (chatId ?? to) : undefined,
        }
    )
```

### 4. 媒体类型解析

```
function resolveMediaContentType(extOrUrl):
    ext = extOrUrl.startsWith(".") ? extOrUrl : path.extname(extOrUrl).toLowerCase()
    if ext in IMAGE_EXTENSIONS: return "image"   # .jpg .png .gif .webp ...
    if ext in VIDEO_EXTENSIONS: return "video"   # .mp4 .mov .avi
    if ext in AUDIO_EXTENSIONS: return "audio"   # .opus .ogg .mp3 .wav
    return "file"
```

### 5. 媒体元数据附加

```
function attachFeishuMediaMetadata(sent, mediaUrl):
    contentType = resolveMediaContentType(mediaUrl)
    return {
        ...sent,
        meta: {
            ...sent.meta,
            contentType,                                    # "image" | "video" | "audio" | "file"
            rawContent: sent.rawContent ?? "[type: url]",   # 原始飞书消息内容 JSON
        }
    }
```

### 6. Media Reply 路由修复

```
# 修复前（错误）:
if replyToMessageId:
    message.reply(replyToMessageId, ...)  # 总是创建话题回复

# 修复后（正确）:
if replyToMessageId AND replyInThread:
    message.reply(replyToMessageId, ...)  # 仅在 replyInThread=true 时用 reply API
else:
    message.create(receiveId, ...)        # 其他情况用 create API
```

### 7. Reply Dispatcher Runtime 注册

```
# extensions/feishu/index.ts
export default defineChannelPluginEntry({
    registerFull(api):
        replyRuntime = api.runtime.channel.reply
        if replyRuntime and not replyRuntime.createFeishuReplyDispatcher:
            replyRuntime.createFeishuReplyDispatcher = createFeishuReplyDispatcher
})
```

---

## 数据流程图 (Data Flow Diagram)

### 出站消息完整流程（Channel Action）

```
Agent 工具调用:
feishu.send({ to: "chat:oc_group", text: "hello", media: "/tmp/img.png" })
    |
    v
handleAction("send", params)
    |
    v
applyFeishuActionMessageSending()
    |
    +--> runMessageSending hook
    |        |
    |        +--> cancel? --> return { cancelled: true }
    |        +--> rewrite? --> effectiveContent = hookResult.content
    |
    v
isGroupTarget = !/^(user|dm|open_id):/.test(to)
    |
    v
+---- text AND media 都存在 ----+
|                                |
v                                |
feishuOutbound.sendText()        |
    |                            |
    v                            |
emitFeishuActionMessageSent()    |
    |                            |
    v                            v
feishuOutbound.sendMedia()
    |
    v
sendMediaFeishu()
    |
    +-- 图片 --> uploadImageFeishu() --> sendImageFeishu()
    |            返回 { messageId, chatId, rawContent: '{"image_key":"..."}' }
    |
    +-- 视频/文件 --> uploadFileFeishu() --> sendFileFeishu()
                      返回 { messageId, chatId, rawContent: '{"file_key":"..."}' }
    |
    v
attachFeishuMediaMetadata()
    --> { messageId, chatId, meta: { contentType: "image", rawContent: "..." } }
    |
    v
emitFeishuActionMessageSent()
    --> hooks.emitMessageSent({
        to, content: "", success: true,
        messageId, metadata: { chatId, contentType: "image", rawContent: "..." }
    })
```

### Outbound Adapter 文本发送流程

```
feishuOutbound.sendText({ cfg, to, text, accountId })
    |
    v
normalizePossibleLocalImagePath(text)
    |
    +-- 是本地图片路径 --> sendMediaFeishu() --> attachFeishuMediaMetadata()
    |                      return { meta: { contentType: "image", rawContent } }
    |
    +-- 不是本地路径 -->
        |
        v
    resolveFeishuAccount() --> renderMode
        |
        +-- "card" 或 (auto AND 检测到 markdown) -->
        |   sendStructuredCardFeishu()
        |   return { meta: { contentType: "interactive",
        |                     finalContent: normalizeMentionTagsForCard(text) } }
        |
        +-- "raw" 或 (auto AND 普通文本) -->
            sendOutboundText()
            return { meta: { contentType: "post", finalContent: text } }
```

### Reply Dispatcher Runtime 注册流程

```
飞书插件加载
    |
    v
defineChannelPluginEntry.registerFull(api)
    |
    v
api.runtime.channel.reply.createFeishuReplyDispatcher
    = createFeishuReplyDispatcher
    |
    v
外部插件（如 bot-company）可以调用:
    |
    v
const { dispatcher, replyOptions } =
    runtime.channel.reply.createFeishuReplyDispatcher({
        cfg, agentId, chatId, ...
    })
    |
    v
获得完整的流式卡片能力（思考面板 + 工具追踪 + 去重）
而非 fallback 到通用的 route-reply 路径
```

### Media Reply 路由修复

```
修复前:
sendImageFeishu(replyToMessageId="om_123", replyInThread=false)
    |
    v
if replyToMessageId:  # true, 但不应该进入 reply
    message.reply(om_123, content, reply_in_thread=undefined)
    --> 消息被放入话题线程（非预期行为）

修复后:
sendImageFeishu(replyToMessageId="om_123", replyInThread=false)
    |
    v
if replyToMessageId AND replyInThread:  # false, 走 create 路径
    (跳过)
message.create(receive_id, content)
    --> 消息正常发送到聊天（预期行为）
```

---

## 参考代码行号 (Reference Line Numbers)

> 基于当前源码文件。

### `extensions/feishu/src/channel.ts`

| 行号 | 内容 |
|------|------|
| 443-475 | `emitFeishuActionMessageSent()` — 发射 message_sent hook 事件 |
| 477-514 | `applyFeishuActionMessageSending()` — 运行 message_sending hook 管线 |
| 751-757 | `send` action 参数解析新增 `media`/`filePath`/`media_url`/`image` |
| 766-767 | 错误信息更新为 `requires text/message, card, or media` |
| 771-790 | `applyFeishuActionMessageSending()` 调用和取消检查 |
| 800-829 | media 路径：发媒体并发射 hook |
| 830-855 | 纯文本路径：通过 `feishuOutbound.sendText()` 发送并发射 hook |
| 856-869 | card 路径发射 `message_sent` hook（contentType: "interactive"） |

### `extensions/feishu/src/outbound.ts`

| 行号 | 内容 |
|------|------|
| 8 | `import { resolveMediaContentType } from "./media-types.js"` |
| 10 | `import { normalizeMentionTagsForCard } from "./mention.js"` |
| 17 | `import { shouldUseFeishuMarkdownCard } from "./send.js"` |
| 114 | `shouldUseFeishuMarkdownCard(text)` 替换原来的内联 `shouldUseCard()` |
| 121-133 | `attachFeishuMediaMetadata()` — 附加媒体元数据 |
| 157-167 | 本地图片自动转发：附加 media 元数据 |
| 186-187 | card 模式检测使用 `shouldUseFeishuMarkdownCard()` |
| 197-213 | card 发送后附加 `meta.contentType="interactive"` 和 `meta.finalContent` |
| 215-229 | 文本发送后附加 `meta.contentType="post"` 和 `meta.finalContent` |
| 268-276 | media 发送后通过 `attachFeishuMediaMetadata()` 附加元数据 |

### `extensions/feishu/src/media.ts`

| 行号 | 内容 |
|------|------|
| 311-316 | `SendMediaResult` 类型新增 `rawContent` 字段 |
| 423 | `if (replyToMessageId && replyInThread)` — 修复 reply 路由条件（sendImageFeishu） |
| 433 | 返回值增加 `rawContent: content` |
| 445 | create 路径返回值增加 `rawContent: content` |
| 470 | `if (replyToMessageId && replyInThread)` — 修复 reply 路由条件（sendFileFeishu） |
| 480 | 返回值增加 `rawContent: content` |
| 492 | create 路径返回值增加 `rawContent: content` |

### `extensions/feishu/src/media-types.ts`

| 行号 | 内容 |
|------|------|
| 3-14 | `IMAGE_EXTENSIONS`、`VIDEO_EXTENSIONS`、`AUDIO_EXTENSIONS` 常量集 |
| 21-27 | `resolveMediaContentType()` — 扩展名到 "image"/"video"/"audio"/"file" 映射 |

### `extensions/feishu/index.ts`

| 行号 | 内容 |
|------|------|
| 8 | `import { createFeishuReplyDispatcher }` |
| 15-16 | `export { getBotOpenId }` 和 `export { createFeishuReplyDispatcher }` |
| 80-88 | `registerFull()` 中将 `createFeishuReplyDispatcher` 注册到 runtime |
