# 分支备份说明文档

**备份分支**: `backup/main-2026-02-07`  
**备份时间**: 2026-02-07  
**基于分支**: `main` (origin/main)

---

## 📋 概览

本分支包含了 Feishu（飞书）插件的重大功能增强、Agent 系统优化以及 Telegram 的 bug 修复。所有变更已相对于 upstream/main 领先 21 个提交。

---

## 🚀 主要改进分类

### 1. Feishu (飞书) 插件全面增强

#### 1.1 提及功能 (@Mention) 完整实现

- **@all/@everyone/@所有人 支持**
  - 入站消息检测和解析
  - 出站消息自动转换为飞书提及标签
  - 支持标签模式和可读模式
- **Bot 专属提及识别**
  - 基于 `open_id` 的精确匹配
  - 启动时缓存 bot open_id
  - 支持名称作为 fallback 匹配

#### 1.2 流式卡片 (Streaming Card) 优化

- **节流机制**: 500ms 间隔的节流更新，减少 API 开销
- **文本累积**: 防止最终块覆盖之前的内容
- **可靠性增强**: try/finally 确保流式会话清理
- **消息发送钩子**: 集成 `message_sent` 钩子，支持线程

#### 1.3 命令授权系统

- 集成 allowlist 系统
- 支持 access groups 权限控制
- 命令门控机制实现

#### 1.4 Agent 路由解析

- 引入 `resolveAgentRoute` 进行会话键解析
- 正确映射 account ID
- 添加 `SessionKey` 到上下文

#### 1.5 默认账户配置

- 从配置中解析默认账户，替代硬编码常量
- 新增单元测试覆盖

### 2. Agent 系统增强

#### 2.1 图片预分析模块

- **新模块**: `image-pre-analysis.ts` (191 行)
- **功能**: 使用专门的 imageModel 预先分析图片
- **应用场景**: 让非视觉模型也能理解图片内容
- **集成**: 已集成到嵌入式 attempt runner
- **测试**: 151 行全面测试覆盖各种配置场景

#### 2.2 会话写锁优化

- **孤儿锁回收**: 回收当前进程拥有的孤儿会话写锁
- **改进**: 43 行新增/修改，提高系统稳定性

### 3. 插件钩子系统扩展

#### 3.1 新增钩子类型

- `tool_result_persist`: 用于消息修改
- `message_received`: 飞书消息接收钩子
- 钩子运行器日志改进，包含钩子计数

### 4. Telegram 修复

#### 4.1 视频笔记支持

- 添加 `video_note` 媒体类型识别
- 修复媒体解析时的类型检测

### 5. 未提交的 Stash 内容

#### Stash 0: Feishu Bot 提及检测增强

```
文件: src/feishu/message.ts (+27, -1)
内容: 增强 Bot 提及检测逻辑，支持 open_id 和 name 双重匹配
```

#### Stash 1: A2UI Bundle 更新 + Telegram 修复

```
文件:
- src/canvas-host/a2ui/.bundle.hash (更新)
- src/telegram/bot-message-context.ts (+1)
- src/telegram/bot/delivery.ts (+3, -2)
内容:
- A2UI bundle hash 更新
- Telegram video_note (视频笔记) 支持完善
```

---

## 📊 详细提交列表

| 提交      | 作者 | 说明                                                   |
| --------- | ---- | ------------------------------------------------------ |
| a661960e3 | -    | feishu: 从配置解析默认账户，替代常量                   |
| b3e3ba8d7 | -    | agents: 回收孤儿会话写锁                               |
| a778b6b35 | -    | fix(feishu): 流式卡片可靠关闭和 message_sent 发射      |
| 01a679157 | -    | feat(feishu): 添加 message_received 钩子，改进钩子日志 |
| 495a465bd | -    | fix(feishu): 累积流式文本防止最终块覆盖                |
| 6f1a365ab | -    | feat(feishu): 节流流式更新 (500ms 间隔)                |
| 7a5351c75 | -    | feat(feishu): @all 提及标准化和流式卡片改进            |
| 8ecb5ba6c | -    | feat(plugins): 添加 tool_result_persist 钩子           |
| dfaf8f1a4 | -    | feat(feishu): 出站消息 @all 提及标准化                 |
| 6c2ba0889 | -    | feat(feishu): 入站消息 @all 提及支持                   |
| a6f9dfc36 | -    | feat(feishu): 出站消息 @all 提及标准化 (增强版)        |
| 76ab1bef9 | -    | feat(feishu): 启动时缓存 bot open_id                   |
| e71bd4cab | -    | feat(feishu): @all 提及检测和 bot 专属过滤             |
| 895dabadd | -    | feat(feishu): bot 探测响应添加 open_id                 |
| 1282877a9 | -    | feat(feishu): 添加 agent 路由解析                      |
| 7ab2762d2 | -    | feat(agents): 集成图片预分析到 attempt runner          |
| c32480ff3 | -    | test(agents): 图片预分析模块测试                       |
| ec778a7dc | -    | feat(agents): 添加图片预分析模块                       |
| 9e0303feb | -    | feat(feishu): 添加命令授权支持 (#8631)                 |

---

## 🔧 技术细节

### 关键文件变更统计

```
总计: 21 个提交，影响 20+ 文件

主要变更:
- src/feishu/message.ts        (+302/-134) - 消息处理核心
- src/feishu/streaming-card.ts (+150/-20)  - 流式卡片
- src/feishu/send.ts           (+140/-20)  - 消息发送
- src/agents/pi-embedded-runner/run/  - 图片预分析
  - image-pre-analysis.ts      (+191)
  - image-pre-analysis.test.ts (+151)
  - attempt.ts                 (+61/-2)
- src/plugins/                 - 钩子系统扩展
- src/telegram/                (+4/-2)     - video_note 修复
```

### 新增配置项

```typescript
// Feishu 配置扩展
{
  "feishu": {
    "defaultAccount": "string",  // 默认账户 ID
    "mentions": {
      "normalizeAll": true       // 标准化 @all 提及
    }
  }
}

// Agent 配置扩展
{
  "imageModel": {
    "provider": "string",
    "model": "string"           // 用于图片预分析的模型
  }
}
```

---

## ✅ 测试覆盖

- ✅ Feishu 默认账户解析单元测试
- ✅ 图片预分析模块单元测试 (151 行)
- ✅ 会话写锁单元测试

---

## 📝 待办事项 (来自 Stash)

1. **应用 Stash 0**: Feishu Bot 提及检测最终完善
2. **应用 Stash 1**:
   - A2UI bundle 更新验证
   - Telegram video_note 功能最终测试

---

## 🔗 相关 PR/Issue

- PR #8631: Feishu 命令授权支持
- Co-authored: Sisyphus <clio-agent@sisyphuslabs.ai> (多次协作)

---

## 📌 备份说明

```bash
# 查看本备份分支
git log backup/main-2026-02-07 --oneline -20

# 与 main 对比
git diff main..backup/main-2026-02-07 --stat

# 与 upstream 对比
git diff up/main..backup/main-2026-02-07 --stat

# 查看 stash
git stash list
git stash show -p stash@{0}
git stash show -p stash@{1}
```

---

**备份完成时间**: 2026-02-07  
**备份者**: 开发团队
