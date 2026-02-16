---
summary: "基于车道的并发控制、机器人间通信和群聊自动回复机制"
title: "Agent 通信与车道架构"
read_when:
  - 理解消息队列和处理机制
  - 实现机器人间通信
  - 配置群聊自动回复行为
---

# Agent 通信与车道架构

本文档介绍 OpenClaw 如何处理消息队列、并发控制以及 Agent 间的通信。涵盖车道机制、heartbeat 行为、`sessions_send` 机器人间通信以及群聊自动回复模式。

## 车道架构

OpenClaw 使用**基于车道的并发系统**来管理消息处理。每个车道代表一个独立的队列，拥有自己的并发限制。

### 车道类型

| 车道 | 用途 | 运行时默认并发数 |
|------|------|------------------|
| `Main` | 用户消息、heartbeat 触发 | 4 |
| `Nested` | `sessions_send`（机器人间）消息 | 1 |
| `Subagent` | 子 Agent 任务 | 8 |
| `Cron` | 定时任务 | 1 |

### 代码参考

- 车道定义：`src/process/lanes.ts`
- 命令队列实现：`src/process/command-queue.ts`
- 车道配置：`src/gateway/server-lanes.ts`

`Main`、`Subagent`、`Cron` 的并发数会在 Gateway 启动时配置。`Nested` 目前没有配置项，保持队列默认值（`1`）。

### 队列处理逻辑

```typescript
// 来自 src/process/command-queue.ts
function drainLane(lane: string) {
  const state = getLaneState(lane);

  const pump = () => {
    while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift();
      const taskId = nextTaskId++;
      state.activeTaskIds.add(taskId);
      void (async () => {
        try {
          await entry.task();
          completeTask(...);
          pump();
        } catch {
          completeTask(...);
          pump();
        }
      })();
    }
  };

  pump();
}
```

**关键行为**：每个车道最多并行执行 `maxConcurrent` 个任务。新建车道默认是 `1`，随后部分车道会被 Gateway 配置覆盖。

---

## Heartbeat 与队列的行为

当你修改 heartbeat 间隔（例如改为 1 分钟）时，具体行为取决于 Main 车道是否正在处理上一条消息。

### Heartbeat 跳过逻辑

来自 `src/infra/heartbeat-runner.ts`：

```typescript
const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
if (queueSize > 0) {
  return { status: "skipped", reason: "requests-in-flight" };
}
```

### 当 Heartbeat 在处理过程中触发时会发生什么

1. **Main 车道忙碌**：Heartbeat 被**跳过**，原因 `"requests-in-flight"`
2. **立即重新调度**：Heartbeat 立即安排下一次执行
3. **下次触发时重试**：下一个 heartbeat 触发时会再次检查队列

### 时间线示例

```
T0: 用户消息进入 Main 车道队列 [等待中]
T1: Heartbeat 触发 → queueSize > 0 → 被跳过
T2: Heartbeat 立即重新调度 (advanceAgentSchedule)
T3: 用户消息处理完成
T4: 下次 Heartbeat 触发 → queueSize = 0 → 执行
```

**重要**：Heartbeat 不会在队列中等待。它会跳过并在下一轮立即重试。这可以防止 Agent 忙碌时 heartbeat 堆积。

---

## 机器人间通信：sessions_send

`sessions_send` 工具允许一个 Agent 向另一个 Agent 的会话发送消息。这是机器人间通信的主要机制。

### sessions_send 工作原理

来自 `src/agents/tools/sessions-send-tool.ts`：

```typescript
const sendParams = {
  message,
  sessionKey: resolvedKey,
  lane: AGENT_LANE_NESTED,  // 使用 Nested 车道，而非 Main
  // ...
};
```

**关键洞察**：`sessions_send` 把 `Nested` 作为全局车道（与 `Main` 分离），但同时仍受目标会话车道约束，所以同一会话内仍然串行。

### 超时行为

```typescript
const timeoutSeconds =
  typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
    ? Math.max(0, Math.floor(params.timeoutSeconds))
    : 30;  // 默认 30 秒

const timeoutMs = timeoutSeconds * 1000;
```

| 超时值 | 行为 |
|--------|------|
| `0` | 发送后不等待 |
| `> 0`（默认 30） | 等待该次运行完成（包含排队时间） |

### 并发：并行还是串行？

`sessions_send` 在 `runEmbeddedPiAgent` 中会经过**两层队列**：

- 会话车道：`session:<sessionKey>`（单会话串行）
- 全局车道：`nested`（所有 `sessions_send` 共享）

因此默认情况下：

- **同一个目标会话内**：串行
- **跨不同目标会话**：也串行（共享全局 `nested` 车道，默认并发 `1`）

```
会话车道 A: [msg1] → [msg2] (串行)
会话车道 B: [msg1] → [msg2] (串行)
全局 nested 车道: [A1] → [B1] → [A2] → [B2]（默认串行）
```

如果通过代码把全局 `nested` 车道并发调高，跨会话才可能并行。

### 这为什么很重要

当机器人 A 向机器人 B 发送消息，而机器人 B 正在处理用户消息时：

1. 机器人 B 的 Main 车道忙碌
2. `sessions_send` 等待最多 `timeoutSeconds`（默认 30 秒）
3. 如果超时，返回错误
4. 如果用户消息完成，`sessions_send` 会被处理

### sessions_send 的会话持久化

`sessions_send` 会通过 `gateway agent` 向目标会话投递任务，并使用 `deliver: false`。

- 目标会话仍会执行一次正常的 agent run，因此用户/助手消息会写入该会话 transcript。
- 工具随后会读取同一目标会话的 `chat.history`，提取最新助手回复。
- 如果目标 run 超时/报错/中断，可能拿不到最终助手消息。

这意味着：`sessions_send` 的回复通常会持久化在目标会话中，但失败 run 下不保证有最终输出。

---

## 群聊自动回复

OpenClaw 支持在群聊中自动回复。Agent 可以直接回复群消息，而无需使用 `message` 工具。

### 两种激活模式

| 模式 | 配置 | 行为 |
|------|------|------|
| **mention** | `requireMention: true` | 仅在 @机器人 时回复；未 @ 的群消息可能仅进入临时历史 |
| **always** | `requireMention: false` | 尝试处理所有到达 Gateway 网关的群聊入站消息 |

### 直接回复如何工作

来自 `src/auto-reply/reply/groups.ts`：

```typescript
lines.push(
  "Your replies are automatically sent to this group chat. " +
  "Do not use the message tool to send to this same group — just reply normally."
);
```

系统提示告诉 Agent：
- **不要**使用 `message` 工具发送到这个群
- **直接正常回复** — 回复会自动发送到群

### 会话上下文存储

当 Agent 回复群消息时，回复会自动存储在会话记录中。

来自 `src/auto-reply/reply/route-reply.ts`：

```typescript
mirror:
  params.mirror !== false && params.sessionKey
    ? {
        sessionKey: params.sessionKey,
        agentId: resolvedAgentId,
        text,
        mediaUrls,
      }
    : undefined,
```

**默认行为**：所有回复都会镜像（存储）到会话记录中。这确保了对话上下文被保留。

### Feishu 限制（bot@bot 重点）

在 Feishu/Lark 中，官方 `im.message.receive_v1` 偏向“用户消息”事件，通常不包含 bot 自己发出的消息。

- 另一个 bot @你，不一定会触发你的入站事件。
- `requireMention: false` 能提升已到达入站消息的覆盖率，但无法补回平台根本没有推送的事件。

因此，`requireMention: false` 很有帮助，但不等于“完整群历史同步”。

### “写入 session” 的准确含义

消息会进入 session transcript 的前提是：它成为了实际 agent run 的输入/输出（或走了镜像写入的出站回复）。

以下情况不保证进入 session transcript：

- 平台未推送到你的事件（例如上游排除 bot 自发消息）
- 被策略/白名单拦截的消息
- 被去重逻辑丢弃的消息
- 在产出最终助手回复前就失败的 run

### 静默回复

使用 `activation: "always"` 时，Agent 可以选择不回复。系统为此提供特殊令牌：

```typescript
`If no response is needed, reply with exactly "${params.silentToken}" ` +
`(and nothing else) so OpenClaw stays silent.`
```

默认的静默令牌是 `SILENT_REPLY_TOKEN`。当 Agent 仅返回此令牌时，不会向群发送任何消息。

---

## 设计建议

### 机器人间通信方案

**方案 A：sessions_send（LLM 驱动）**

- Agent 显式调用 `sessions_send` 工具
- 更灵活，允许自定义逻辑
- 需要 LLM 正确调用工具
- 需要处理超时

**方案 B：群消息监控（通过 HEARTBEAT.md）**

- Agent 通过 heartbeat 监控群消息
- 无需工具调用直接回复
- 在很多场景下比工具调用更可靠（无需工具调用）
- 配置 `requireMention: false` 实现始终开启模式
- 仍受渠道事件投递机制影响（例如 Feishu 对 bot 自发消息事件的排除）

### HEARTBEAT.md 群监控示例

```markdown
# Heartbeat 检查清单

- 检查群聊中需要你关注的消息
- 如果被直接@或提及，直接在群里回复
- 如果不需要回复，返回 SILENT_REPLY_TOKEN
- 你的回复会自动发送到群并保存到会话上下文
```

### 推荐配置：Feishu 多 Bot + sessions_send + Heartbeat

当你把每个 Agent 绑定到一个独立 Feishu 机器人账号，并且希望实现以下目标时，可使用这个模式：

- 通过 `sessions_send` 实现 bot@bot 协作
- 用 `requireMention: false` 提升群聊上下文覆盖
- 通过 heartbeat 回合判断是否要主动参与相关讨论

```json5
{
  agents: {
    list: [
      {
        id: "bot-a",
        default: true,
        heartbeat: {
          every: "1m",
          target: "none",
        },
        tools: {
          allow: ["sessions_send", "sessions_list", "sessions_history", "session_status"],
        },
      },
      {
        id: "bot-b",
        heartbeat: {
          every: "1m",
          target: "none",
        },
        tools: {
          allow: ["sessions_send", "sessions_list", "sessions_history", "session_status"],
        },
      },
    ],
  },

  bindings: [
    { agentId: "bot-a", match: { channel: "feishu", accountId: "account-a" } },
    { agentId: "bot-b", match: { channel: "feishu", accountId: "account-b" } },
  ],

  tools: {
    agentToAgent: {
      enabled: true,
      allow: ["bot-a", "bot-b"],
    },
  },

  session: {
    agentToAgent: {
      maxPingPongTurns: 2,
    },
  },

  channels: {
    feishu: {
      groupPolicy: "open",
      accounts: {
        "account-a": {
          appId: "cli_xxx_a",
          appSecret: "xxx",
          groups: {
            "oc_group_id": { requireMention: false },
          },
          historyLimit: 50,
        },
        "account-b": {
          appId: "cli_xxx_b",
          appSecret: "xxx",
          groups: {
            "oc_group_id": { requireMention: false },
          },
          historyLimit: 50,
        },
      },
    },
  },
}
```

说明：

- Heartbeat 只能基于已写入 session/transcript 的上下文决策，不会自行拉取 Feishu 历史。
- `requireMention: false` 只能提升“已到达 Gateway 网关”的入站群消息覆盖，不等于全量同步。
- 显式 bot@bot 协作仍应以 `sessions_send` 作为可靠主链路。
- 如果 Feishu 应用权限/过滤规则排除了 bot 源事件，heartbeat 无法看到这些缺失事件。

### 车道配置

修改并发限制：

```json5
{
  cron: {
    maxConcurrentRuns: 1, // 默认
  },
  agents: {
    defaults: {
      maxConcurrent: 4, // Main 车道默认
      subagents: {
        maxConcurrent: 8, // Subagent 车道默认
      },
    },
  },
}
```

目前没有用于配置 `Nested` 车道并发的配置键。

---

## 总结

| 主题 | 关键要点 |
|------|----------|
| **车道** | 独立队列，可配置并发数 |
| **Heartbeat** | Main 车道忙碌时跳过；下一轮立即重试 |
| **sessions_send** | 使用会话车道 + 共享 Nested 车道；默认串行；回复通常会持久化到目标会话 |
| **群回复** | Agent 可直接回复并镜像入 session，但前提是消息先到达且通过校验 |
| **镜像** | 所有回复默认镜像到记录中 |

理解这些机制有助于设计可靠的多 Agent 系统，并正确配置群聊回复行为。
