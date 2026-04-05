# Patch 03: Agent 模型感知运行器、Bootstrap 压缩、图像预分析与故障转移加固

## 为什么要改 (Why)

### 问题 1: 缺少统一的模型感知运行器

内存刷新（memory flush）和后续追踪（followup）等内部子任务需要在嵌入式 API 和 CLI 后端之间自动路由。当前调用者必须手动判断 `isCliProvider` 并分别调用 `runEmbeddedPiAgent` 或 `runCliAgent`，造成代码重复和流回调映射遗漏。

### 问题 2: Bootstrap 文件占用过多上下文窗口

`MEMORY.md` 和 `memory/YYYY-MM-DD.md` 等记忆文件随使用增长，在小上下文窗口模型（如 50K token）上会占满 bootstrap 预算。缺少压缩机制导致系统提示被截断、工具描述丢失。

### 问题 3: 非视觉模型无法处理图像

当主模型不支持图像（如纯文本模型），用户发送的图片被静默忽略。需要一个预分析管道：用支持视觉的模型分析图像，将文本描述传给主模型。

### 问题 4: 故障转移错误分类不全

- Claude CLI 的 `Context overflow — prompt too large` 格式（em-dash）未被识别
- OpenAI 通用 500 错误 `"You can retry your request"` 未被分类为可重试
- 裸文本 `"Internal server error"` 未触发故障转移
- CLI 流式转录中包含历史 "Context overflow" 文本时被误判为当前溢出

---

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/agents/model-aware-runner.ts` | **新文件 (113行)**：`runModelAwareAgent()` 统一入口，自动路由到嵌入式或 CLI 运行器，映射流回调 |
| `src/agents/bootstrap-compaction.ts` | **新文件 (315行)**：LLM 驱动的 bootstrap 文件压缩，含内容哈希缓存、head/tail 截断、超时控制 |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.ts` | **新文件 (191行)**：图像预分析管道，用 imageModel 分析图像并将文本结果传给主模型 |
| `src/agents/pi-embedded-helpers/errors.ts` | 新增 `looksLikeCliStreamTranscript()` 过滤器；识别 em-dash 格式溢出；`classifyFailoverReason` 新增 `"internal server error"` 匹配 |
| `src/agents/pi-embedded-helpers/failover-matches.ts` | 新增 OpenAI 通用 500 重试模式 `"you can retry your request"` |
| `src/agents/pi-embedded-helpers/bootstrap.ts` | 新增 `BootstrapProfile` 三级配置（normal/reduced/minimal）；`resolveBootstrapBudgetForModel()` 根据上下文窗口动态计算 bootstrap 预算 |
| `src/agents/model-selection.ts` | 新增 `resolveNonCliModelRef()` 将 CLI 提供商映射到真实 API 提供商 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 图像处理逻辑重构为预分析优先路径 + 回退路径 |
| `src/agents/pi-embedded-runner/live-session-registry.ts` | **新文件 (81行)**：活跃会话注册表，允许通过 sessionKey/sessionId 读取运行中会话的条目 |
| `src/agents/bootstrap-files.ts` | `resolveBootstrapContextForRun` 新增 `contextWindowTokens` 参数 |

---

## 伪代码 (Pseudocode)

### 模型感知运行器

```
function runModelAwareAgent(params):
    provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER
    
    // 非 CLI 提供商: 直接走嵌入式路径
    if not isCliProvider(provider, params.config):
        return runEmbeddedPiAgent(params)
    
    // CLI 提供商: 走 CLI runner 路径
    extraSystemPrompt = resolveDecisionLikeSystemPrompt({
        extraSystemPrompt: params.extraSystemPrompt,
        disableTools: params.disableTools    // 追加 "Tools are disabled" 指令
    })
    
    return runCliAgent({
        ...params,
        extraSystemPrompt,
        messageChannel: params.messageChannel ?? params.messageProvider,
        
        // 流回调映射: CLI 事件 -> 统一事件格式
        onAssistantTurn: (text) =>
            params.onPartialReply?.({ text })
            emitAgentEvent("assistant", { text })
        
        onThinkingTurn: (payload) =>
            params.onReasoningStream?.({ text: payload.text })
            emitAgentEvent("thinking", { text, delta? })
        
        onToolUseEvent: (payload) =>
            emitAgentEvent("tool", { phase: "start", name, toolUseId, input })
        
        onToolResult: (payload) =>
            params.onToolResult?.({ text, toolCallId })
            emitAgentEvent("tool", { phase: "result", toolUseId, result })
    })
```

### Bootstrap 压缩算法

```
constants:
    COMPACTION_MAX_INPUT_CHARS = 10_000
    COMPACTION_MAX_FILES = 3
    DEFAULT_COMPACTION_TIMEOUT_MS = 30_000
    MAX_CACHE_ENTRIES = 100

function isCompactableFile(filePath):
    basename = path.basename(filePath)
    if basename == "MEMORY.md": return true
    if /^20\d{2}-\d{2}-\d{2}\.md$/.test(basename):
        return path.basename(path.dirname(filePath)) == "memory"
    return false  // AGENTS.md, SOUL.md, IDENTITY.md, CONSTITUTION.md 等不压缩

function compactBootstrapFile({ content, filePath, llmFn, modelRef, signal }):
    // 1. 截断输入: head 30% + tail 70% (保留文件末尾的最新内容)
    if content.length > 10_000:
        headChars = floor(10_000 * 0.3)  // 3000
        tailChars = 10_000 - headChars   // 7000
        inputContent = content[:headChars]
            + "\n\n[... middle content omitted for compaction ...]\n\n"
            + content[-tailChars:]
    else:
        inputContent = content
    
    // 2. 内容哈希缓存查找 (全文哈希, 含模型和版本)
    hashInput = "v{CACHE_VERSION}:{modelRef}:{content}"
    contentHash = sha256(hashInput)[:16]
    if cache[filePath]?.hash == contentHash:
        return { compacted: cache[filePath].compacted, success: true }
    
    // 3. LLM 调用
    try:
        compacted = await llmFn(inputContent, signal)
        if compacted.length >= content.length:
            return { compacted: content, success: false }  // 压缩无效
        cache[filePath] = { hash: contentHash, compacted }
        return { compacted, success: true }
    catch err:
        return { compacted: content, success: false, fallbackReason: err.message }

function compactBootstrapFiles({ contextFiles, config, llmFn, modelRef }):
    // 选择最大的 3 个可压缩文件
    compactable = contextFiles
        .filter(f => isCompactableFile(f.path))
        .sortByDescending(f => f.content.length)
        .slice(0, 3)
    
    // 总超时 = 单文件超时 * 文件数; 每个文件独立超时
    overallDeadline = AbortSignal.timeout(timeoutMs * compactable.length)
    
    for file in compactable:
        perFileTimeout = AbortSignal.timeout(timeoutMs)
        mergedSignal = AbortSignal.any([overallDeadline, perFileTimeout])
        { compacted, result } = await compactBootstrapFile({ ..., signal: mergedSignal })
    
    // 用压缩结果替换原始内容
    return contextFiles.map(f => compactedMap.has(f.path) ? { ...f, content: compacted } : f)
```

### 图像预分析

```
function shouldUseImagePreAnalysis({ config }):
    // 检查配置中是否定义了 imageModel
    return config?.agents?.defaults?.imageModel != null

function analyzeImagesWithImageModel({ images, config, agentDir, userPrompt }):
    // 逐张分析, 累积结果
    results = []
    for (i, image) in images:
        try:
            result = await runWithImageModelFallback({
                image,
                prompt: buildImageAnalysisPrompt(userPrompt, i),
                config, agentDir
            })
            results.push({ index: i, analysis: result.text, success: true })
        catch:
            results.push({ index: i, success: false })
    
    successfulCount = results.filter(r => r.success).length
    analysisText = formatAnalysisResults(results)
    
    return {
        imageCount: images.length,
        successfulImageCount: successfulCount,
        analysisText,
        provider, model  // 使用的分析模型
    }

// attempt.ts 中的使用:
if imageResult.images.length > 0:
    if shouldUseImagePreAnalysis(config):
        try:
            preAnalysis = await analyzeImagesWithImageModel(images, config, userPrompt)
            if preAnalysis.successfulImageCount > 0:
                promptWithAnalysis = effectivePrompt + preAnalysis.analysisText
                session.prompt(promptWithAnalysis)        // 文本传给主模型
            else if mainModelSupportsImages:
                session.prompt(effectivePrompt, { images })  // 回退: 直接传图
            else:
                session.prompt(effectivePrompt)              // 无图
        catch:
            // 回退: 预分析失败 -> 直接传图 (如果主模型支持)
            if mainModelSupportsImages:
                session.prompt(effectivePrompt, { images })
    else:
        if mainModelSupportsImages:
            session.prompt(effectivePrompt, { images })
        else:
            session.prompt(effectivePrompt)  // 忽略图像
```

### 故障转移错误分类增强

```
function looksLikeCliStreamTranscript(raw):
    // 检测 CLI 流式转录: 包含 {"type":"system","subtype":"init"} + assistant/user 条目
    if raw.length < 100: return false
    if not contains('"type":"system"') or not contains('"subtype":"init"'): return false
    return contains('"type":"assistant"') or contains('"type":"user"') or ...

function isContextOverflowError(errorMessage):
    // ... 现有检查 ...
    
    // 新增: 排除 CLI 流式转录中的历史溢出文本
    if looksLikeCliStreamTranscript(errorMessage):
        return false
    
    // 新增: 识别 claude-cli em-dash 格式
    if lower.includes("context overflow —") or lower.includes("context overflow --"):
        return true

function classifyFailoverReason(raw):
    // ... 现有分类 ...
    
    // 新增: 裸文本 "internal server error"
    if raw.toLowerCase().includes("internal server error"):
        return "timeout"

// failover-matches.ts ERROR_PATTERNS.server:
    // 新增: OpenAI 通用 500 重试提示
    /you can retry your request/i
```

---

## 数据流程图 (Data Flow Diagram)

### 模型感知运行器路由

```
runModelAwareAgent(params)
     |
     | provider = params.provider
     |
     +-- isCliProvider(provider, config)?
     |       |
     |   No  |  Yes
     |       |
     v       v
+----------------+    +------------------+
| runEmbeddedPi  |    | runCliAgent      |
| Agent(params)  |    | (params +        |
|                |    |  流回调映射)     |
+----------------+    +------------------+
     |                       |
     v                       v
EmbeddedPiRunResult    EmbeddedPiRunResult
                       (统一返回类型)

流回调映射:
  CLI onAssistantTurn -> onPartialReply + onAgentEvent("assistant")
  CLI onThinkingTurn  -> onReasoningStream + onAgentEvent("thinking")
  CLI onToolUseEvent  -> onAgentEvent("tool", phase:"start")
  CLI onToolResult    -> onToolResult + onAgentEvent("tool", phase:"result")
```

### Bootstrap 压缩管道

```
resolveBootstrapContextForRun(params)
     |
     | contextWindowTokens?
     v
resolveBootstrapTotalMaxChars(cfg, contextWindowTokens)
     |
     +-- 有配置值? -> 使用配置值
     |
     +-- 有 contextWindowTokens? -> resolveBootstrapBudgetForModel()
     |       |
     |       | reserve = max(tokens * 0.3, 30K)
     |       | available = tokens - reserve
     |       | totalMaxChars = clamp(available * 4, 20K, 150K)
     |       v
     |   { maxCharsPerFile: 20K, totalMaxChars: 计算值 }
     |
     +-- 都没有? -> DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS (150K)
     |
     v
buildBootstrapContextFiles(files, { maxChars, totalMaxChars })
     |
     v
compactBootstrapFiles({ contextFiles, llmFn, modelRef })
     |
     | 1. 筛选可压缩文件: MEMORY.md, memory/YYYY-MM-DD.md
     | 2. 按大小降序取前 3 个
     | 3. 对每个文件:
     v
+----------------------------------+
| compactBootstrapFile()           |
| - 截断输入 (head 30% + tail 70%)|
| - 哈希缓存查找                  |
| - LLM 调用 (结构化摘要)         |
| - 验证压缩有效性                 |
| - 写入缓存 (LRU, max 100)       |
+----------------------------------+
     |
     v
替换 contextFiles 中的压缩内容
```

### 图像预分析回退策略

```
用户消息含图像
     |
     v
detectAndLoadPromptImages()
     |
     | images.length > 0?
     |
     v
shouldUseImagePreAnalysis(config)?
     |           |
   Yes           No
     |           |
     v           v
+-------------+ mainModelSupportsImages?
| analyzeWith | |         |
| ImageModel  | Yes       No
+-------------+ |         |
     |          v         v
     |   直接传图    忽略图像
     |   给主模型    prompt(text)
     |
     +-- 成功且有分析文本?
     |       |
     |   Yes |  No (全部失败)
     |       |
     v       v
prompt(      mainModelSupportsImages?
 text +      |         |
 analysis)   Yes       No
             |         |
             v         v
          直接传图   prompt(text)
```

---

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/agents/model-aware-runner.ts` | 3 | 导入 `isCliProvider` |
| `src/agents/model-aware-runner.ts` | 8-19 | `resolveDecisionLikeSystemPrompt()` - disableTools 指令追加 |
| `src/agents/model-aware-runner.ts` | 31-37 | 路由决策: `isCliProvider` 检查 -> 嵌入式或 CLI |
| `src/agents/model-aware-runner.ts` | 45-112 | CLI 路径: `runCliAgent` 调用 + 流回调映射 |
| `src/agents/bootstrap-compaction.ts` | 9-10 | 常量: `COMPACTION_MAX_INPUT_CHARS=10K`, `COMPACTION_MAX_FILES=3` |
| `src/agents/bootstrap-compaction.ts` | 14-35 | `COMPACTION_SYSTEM_PROMPT` 结构化摘要模板 |
| `src/agents/bootstrap-compaction.ts` | 79-93 | 内容哈希缓存实现 (LRU, max 100) |
| `src/agents/bootstrap-compaction.ts` | 100 | `getContentHash()` - SHA256 前 16 字符 |
| `src/agents/bootstrap-compaction.ts` | 110 | `resolveCompactionConfig()` - 从 `cfg.agents.defaults.compaction` 读取 |
| `src/agents/bootstrap-compaction.ts` | 126 | `isCompactableFile()` - MEMORY.md + memory/YYYY-MM-DD.md |
| `src/agents/bootstrap-compaction.ts` | 153-241 | `compactBootstrapFile()` - 截断、缓存、LLM 调用、有效性验证 |
| `src/agents/bootstrap-compaction.ts` | 169-175 | head 30% + tail 70% 截断逻辑 |
| `src/agents/bootstrap-compaction.ts` | 249-315 | `compactBootstrapFiles()` - 编排: 选择、超时、替换 |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.ts` | 31 | `shouldUseImagePreAnalysis()` - 检查 imageModel 配置 |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.ts` | 44-191 | `analyzeImagesWithImageModel()` - 逐张分析 + 文本格式化 |
| `src/agents/pi-embedded-runner/run/image-pre-analysis.ts` | 99 | 调用 `runWithImageModelFallback()` |
| `src/agents/pi-embedded-helpers/errors.ts` | 218-230 | `looksLikeCliStreamTranscript()` - CLI 流式转录检测 |
| `src/agents/pi-embedded-helpers/errors.ts` | 252 | `isContextOverflowError` 排除 CLI 转录 |
| `src/agents/pi-embedded-helpers/errors.ts` | 274-275 | 新增 em-dash `"context overflow —"` 和 `"context overflow --"` 模式 |
| `src/agents/pi-embedded-helpers/errors.ts` | 322 | `isLikelyContextOverflowError` 排除 CLI 转录 |
| `src/agents/pi-embedded-helpers/errors.ts` | 1167 | `classifyFailoverReason` 的 `"internal server error"` 匹配 (在 `TRANSIENT_API_ERROR_RE` 正则中) |
| `src/agents/pi-embedded-helpers/failover-matches.ts` | 112-113 | 新增 OpenAI `"you can retry your request"` 模式 |
| `src/agents/pi-embedded-helpers/bootstrap.ts` | 107-118 | `resolveBootstrapTotalMaxChars` 新增 `contextWindowTokens` 参数 |
| `src/agents/pi-embedded-helpers/bootstrap.ts` | 124-142 | `BootstrapProfile` 类型 + `getBootstrapProfileConfig()` |
| `src/agents/pi-embedded-helpers/bootstrap.ts` | 131-137 | `BOOTSTRAP_PROFILE_CONFIGS`: normal(20K/150K), reduced(10K/50K), minimal(5K/20K) |
| `src/agents/pi-embedded-helpers/bootstrap.ts` | 149-162 | `resolveBootstrapBudgetForModel()` - 动态预算: reserve=max(30%,30K), chars=clamp(avail*4, 20K, 150K) |
| `src/agents/model-selection.ts` | 439 | `resolveNonCliModelRef()` - CLI 到 API 提供商映射 |
| `src/agents/pi-embedded-runner/live-session-registry.ts` | 1-81 | 活跃会话注册表: 按 sessionKey/sessionId 注册/读取/注销 |
