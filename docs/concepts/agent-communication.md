---
summary: "Lane-based concurrency, bot-to-bot messaging, and group chat response mechanisms"
title: "Agent Communication & Lane Architecture"
read_when:
  - Understanding how messages are queued and processed
  - Implementing bot-to-bot communication
  - Configuring group chat auto-response behavior
---

# Agent Communication & Lane Architecture

This document explains how OpenClaw handles message queuing, concurrency, and inter-agent communication. It covers the lane mechanism, heartbeat behavior, `sessions_send` for bot-to-bot messaging, and group chat auto-response patterns.

## Lane Architecture

OpenClaw uses a **lane-based concurrency system** to manage message processing. Each lane represents an isolated queue with its own concurrency limits.

### Lane Types

| Lane | Purpose | Runtime Default Concurrency |
|------|---------|-----------------------------|
| `Main` | User messages, heartbeat triggers | 4 |
| `Nested` | `sessions_send` (bot-to-bot) messages | 1 |
| `Subagent` | Subagent spawned tasks | 8 |
| `Cron` | Scheduled cron jobs | 1 |

### Code Reference

- Lane definitions: `src/process/lanes.ts`
- Command queue implementation: `src/process/command-queue.ts`
- Lane configuration: `src/gateway/server-lanes.ts`

`Main`, `Subagent`, and `Cron` concurrency are configured by the gateway at startup. `Nested` currently has no config path and keeps the queue default (`1`).

### Queue Processing Logic

```typescript
// From src/process/command-queue.ts
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

**Key behavior**: Each lane runs up to `maxConcurrent` tasks in parallel. New lanes start at `1` and then some lanes are overridden by gateway config.

---

## Heartbeat Behavior with Queue

When you modify the heartbeat interval (e.g., to 1 minute), the behavior depends on whether the Main lane is busy processing a previous message.

### Heartbeat Skip Logic

From `src/infra/heartbeat-runner.ts`:

```typescript
const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
if (queueSize > 0) {
  return { status: "skipped", reason: "requests-in-flight" };
}
```

### What Happens When Heartbeat Fires During Processing

1. **Main lane is busy**: Heartbeat is **skipped** with reason `"requests-in-flight"`
2. **Immediate reschedule**: The heartbeat is immediately rescheduled for the next cycle
3. **Retry on next tick**: The next heartbeat trigger will check the queue again

### Timeline Example

```
T0: User message enters Main lane queue [waiting]
T1: Heartbeat triggers → queueSize > 0 → SKIPPED
T2: Heartbeat immediately rescheduled (advanceAgentSchedule)
T3: User message processing completes
T4: Next heartbeat triggers → queueSize = 0 → executes
```

**Important**: Heartbeat does not wait in the queue. It skips and retries immediately on the next tick. This prevents heartbeat backlog when the agent is busy.

---

## Bot-to-Bot Communication: sessions_send

The `sessions_send` tool allows one agent to send messages to another agent's session. This is the primary mechanism for bot-to-bot communication.

### How sessions_send Works

From `src/agents/tools/sessions-send-tool.ts`:

```typescript
const sendParams = {
  message,
  sessionKey: resolvedKey,
  lane: AGENT_LANE_NESTED,  // Uses Nested lane, not Main
  // ...
};
```

**Key insight**: `sessions_send` uses `Nested` as its global lane (separate from `Main`). At the same time, runs are still serialized per target session by the session lane.

### Timeout Behavior

```typescript
const timeoutSeconds =
  typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
    ? Math.max(0, Math.floor(params.timeoutSeconds))
    : 30;  // Default 30 seconds

const timeoutMs = timeoutSeconds * 1000;
```

| Timeout Value | Behavior |
|---------------|----------|
| `0` | Fire-and-forget, no waiting |
| `> 0` (default: 30) | Waits for that run to finish (including queue time) |

### Concurrency: Parallel or Serial?

`sessions_send` runs through **two queues** in `runEmbeddedPiAgent`:

- Session lane: `session:<sessionKey>` (serial per session)
- Global lane: `nested` (shared across all `sessions_send` runs)

So by default:

- **Within a single target session**: serial
- **Across different target sessions**: also serial (shared global `nested` lane has concurrency `1`)

```
Session lane A: [msg1] → [msg2] (serial)
Session lane B: [msg1] → [msg2] (serial)
Global nested lane: [A1] → [B1] → [A2] → [B2] (serial by default)
```

If global `nested` lane concurrency is increased programmatically, cross-session parallelism becomes possible.

### Why This Matters

When bot A sends to bot B while bot B is processing a user message:

1. Bot B's Main lane is busy
2. `sessions_send` waits up to `timeoutSeconds` (default 30s)
3. If timeout expires, returns error
4. If user message completes, `sessions_send` is processed

### Transcript Persistence for sessions_send

`sessions_send` sends work to the target session via `gateway agent` with `deliver: false`.

- The target session still runs a normal agent turn, so user/assistant messages are written to that session transcript.
- The tool then reads `chat.history` from the same target session to extract the latest assistant reply.
- If the target run ends with timeout/error/abort, you may not get a final assistant message.

This means `sessions_send` replies are usually persisted in the target session, but final output is not guaranteed on failed runs.

---

## Group Chat Auto-Response

OpenClaw supports automatic agent responses in group chats. The agent can directly reply to group messages without using the `message` tool.

### Two Activation Modes

| Mode | Config | Behavior |
|------|--------|----------|
| **mention** | `requireMention: true` | Responds only when @mentioned; non-mention group messages may stay in temporary history |
| **always** | `requireMention: false` | Tries to process every inbound group message that reaches the gateway |

### How Direct Reply Works

From `src/auto-reply/reply/groups.ts`:

```typescript
lines.push(
  "Your replies are automatically sent to this group chat. " +
  "Do not use the message tool to send to this same group — just reply normally."
);
```

The system prompt tells the agent:
- **Do not** use the `message` tool for the same group
- **Just reply normally** — the reply is automatically sent to the group

### Session Context Storage

When the agent replies to a group message, the response is automatically stored in the session transcript.

From `src/auto-reply/reply/route-reply.ts`:

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

**Default behavior**: All replies are mirrored (stored) in the session transcript. This ensures conversation context is preserved.

### Feishu Caveat (Important for bot@bot)

For Feishu/Lark, official `im.message.receive_v1` behavior is user-message oriented and typically excludes bot-originated messages.

- Another bot @mentioning your bot may not trigger an inbound event.
- `requireMention: false` improves coverage for inbound group messages, but it still cannot capture events that the platform never pushes.

So `requireMention: false` is helpful, but it is not equivalent to a full group-history sync.

### What "Stored in Session" Really Means

Messages are in session transcript when they become actual agent-run inputs/outputs (or mirrored outbound replies).

Not guaranteed to be in session transcript:

- Platform events that never arrive (for example, bot-originated events excluded upstream)
- Messages blocked by policy/allowlist checks
- Messages dropped by dedupe logic
- Runs that fail before a final assistant reply is produced

### Silent Responses

When using `activation: "always"`, the agent can choose not to respond. The system provides a special token for this:

```typescript
`If no response is needed, reply with exactly "${params.silentToken}" ` +
`(and nothing else) so OpenClaw stays silent.`
```

The default silent token is `SILENT_REPLY_TOKEN`. When the agent returns only this token, no message is sent to the group.

---

## Design Recommendations

### For Bot-to-Bot Communication

**Option A: sessions_send (LLM-driven)**

- Agent explicitly calls `sessions_send` tool
- More flexible, allows custom logic
- Requires LLM to call the tool correctly
- Timeout handling needed

**Option B: Group message monitoring (via HEARTBEAT.md)**

- Agent monitors group messages via heartbeat
- Directly responds without tool calls
- More reliable than tool-calling for many cases (no tool invocation needed)
- Configure `requireMention: false` for always-on mode
- Still depends on provider event delivery behavior (for example, Feishu bot-originated event exclusions)

### HEARTBEAT.md Example for Group Monitoring

```markdown
# Heartbeat checklist

- Check group chats for messages that need your attention
- If addressed directly or mentioned, respond directly in the group
- If no response needed, reply with SILENT_REPLY_TOKEN
- Your responses are automatically sent to the group and saved to session context
```

### Recommended Config: Feishu Multi-Bot + sessions_send + Heartbeat

Use this pattern when each agent maps to a separate Feishu bot account, and you want:

- bot@bot coordination through `sessions_send`
- `requireMention: false` to improve group context capture
- heartbeat turns to decide whether to proactively join relevant discussions

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

Notes:

- Heartbeat decides only from context already in session/transcript. It does not poll Feishu history by itself.
- `requireMention: false` helps capture inbound group messages that reach the gateway; it is not a full sync guarantee.
- `sessions_send` remains the reliable control plane for explicit bot@bot coordination.
- If your Feishu app scopes/filtering exclude bot-originated events, heartbeat cannot see those missing events.

### Lane Configuration

To change concurrency limits:

```json5
{
  cron: {
    maxConcurrentRuns: 1, // default
  },
  agents: {
    defaults: {
      maxConcurrent: 4, // default for Main lane
      subagents: {
        maxConcurrent: 8, // default for Subagent lane
      },
    },
  },
}
```

There is currently no config key for `Nested` lane concurrency.

---

## Summary

| Topic | Key Takeaway |
|-------|--------------|
| **Lanes** | Isolated queues with configurable concurrency |
| **Heartbeat** | Skips when Main lane busy; retries immediately on next tick |
| **sessions_send** | Uses session lane + shared Nested lane; serial by default; replies usually persist in target session |
| **Group reply** | Agent replies directly and is mirrored, but only for messages that actually arrive and pass checks |
| **Mirror** | All replies mirrored to transcript by default |

Understanding these mechanisms helps you design reliable multi-agent systems and configure appropriate response behaviors for group chats.
