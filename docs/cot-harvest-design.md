# COT 静默采集与经验增补 — 设计方案

> 状态：设计待评审（未实现）
> 目标插件：`dsh-cot-anchor`
> 默认开关：**关闭**。关闭时零采集、零额外调用、零磁盘写入。

---

## 1. 目标与边界

### 1.1 要解决的问题

插件当前的识别模式全部是 `lib/index.js` 里的硬编码常量：

| 常量 | 作用 | 形态 |
|---|---|---|
| `CONCLUSION_OPENERS` | 结论句开头标记 | 正则数组 |
| `CORRECTION_PATTERNS` | 修正/推翻旧假设 | 正则数组 |
| `CHURN_PHRASES` | 空转重启用语 | 正则数组 |
| `PSEUDO_STRONG_PATTERNS` / `PSEUDO_WEAK_PATTERNS` | 无效工具调用 | 正则数组 |
| `TRANSITION_PATTERNS` | 转折句 | 正则数组 |
| `repeatMinCount` / `churnMinHits` 等 | 各检测器阈值 | 数字 |

这些常量来自**已发生的真实事故**（403 次重复的伪工具调用、6.1 万字的 `Let me` 空转）。它们的问题是：**只覆盖已经踩过的坑**。模型换一种措辞打转、换一种标签拼工具调用、换一种句式下结论，现有模式一律看不见。

### 1.2 本方案要做的

让插件自己从**真实使用场景**里长出识别模式：

```
静默采集 CoT 样本 → LLM 语义归纳异常形态 → 生成候选模式 → 用户审核采纳 → 进入运行时识别模式
```

三个环节分别解决：**看得见**（采集）、**看得懂**（语义归纳）、**管得住**（人工审核 + 可回滚）。

### 1.3 明确不做

- **不做**自动生效。LLM 产出的任何东西都必须经过用户显式采纳才可能影响打断行为。
- **不做** LLM 直写正则。见 §5.2。
- **不做**联网上传。样本与报告只落本机磁盘。
- **不改变**现有检测器的默认行为。学习到的模式是**叠加层**，未采纳时行为与今天逐字节一致。

---

## 2. 总体架构

三层，单向流动，每层都可独立开关与独立失败：

```
┌─────────────────────────────────────────────────────────────┐
│ L1 采集层  Harvest                                          │
│   挂点：ctx.on("session/event")  ← 提交后 fire-and-forget    │
│   产出：~/.dsh/storages/cot-anchor/samples.jsonl            │
│   成本：每步 O(1) 切片 + 去抖落盘；关闭时首行 return         │
└───────────────────────────┬─────────────────────────────────┘
                            │ 未分析的样本
┌───────────────────────────▼─────────────────────────────────┐
│ L2 分析层  Analyze                                          │
│   触发：用户点按钮 / 累计 N 条自动（可选）                    │
│   手段：ctx.get("llm").stream(...) 批量归纳                  │
│   产出：~/.dsh/storages/cot-anchor/proposals.json（待审区）  │
└───────────────────────────┬─────────────────────────────────┘
                            │ 用户逐条采纳
┌───────────────────────────▼─────────────────────────────────┐
│ L3 增补层  Apply                                            │
│   产出：~/.dsh/storages/cot-anchor/patterns.json（生效叠加）  │
│   生效：运行时合并进检测器；删除文件即回滚到出厂行为          │
│   旁路：导出「增补请求包」→ 用户交给编码 Agent 固化进源码      │
└─────────────────────────────────────────────────────────────┘
```

**关键设计取舍：为什么用 `session/event` 而不是复用 `tools/post-execute`？**

| 维度 | `tools/post-execute`（现有） | `session/event`（本方案） |
|---|---|---|
| 触发时机 | 仅工具调用后 | 每个会话事件后（含纯思考步） |
| 语义 | waterfall，可修改下游 | **emit，提交后 fire-and-forget** |
| 失败影响 | 抛错会影响工具结果 | **监听器抛错被宿主捕获记录，不影响已提交的追加** |
| 覆盖 | 漏掉不调工具的思考步 | `assistant/message` 全覆盖 |

采集器是**旁观者**，绝不允许影响被观察的会话。`session/event` 的「观察者失败被包含、不让已提交的 append 失败」语义正好匹配。文档出处：`kb/site/reference/subsystems/session.md:1140`。

---

## 3. L1 采集层

### 3.1 挂点与事件消费

```js
ctx.on("session/event", (session, event) => {
  if (!settings.enableHarvest) return;      // 关闭时唯一开销
  try {
    harvestOnEvent(session, event);
  } catch (error) {
    console.warn(`[cot-anchor] 采集失败（已忽略）：${error?.message ?? error}`);
  }
});
```

只消费两类事件，其余直接丢弃：

| 事件 | 用途 |
|---|---|
| `assistant/message` | 取 `data.message.content` 中的 `reasoning` 块全文；取 `usage`、`interrupted`、`turn`/`step` |
| `tool/call` / `tool/result` | 取该步的工具名与 `isError`，用于「无效工具调用」「反复重试同一工具」两类分析 |

**必须跳过插件自己注入的消息**：`data.message.source?.plugin === "dsh-cot-anchor"` 一律丢弃。否则锚点文本会被当作模型的思考重新采集，形成自我放大。这与现有 `renderPseudoToolAnchor` 刻意不复述触发标签是同一类防护。

### 3.2 采样策略：广度 + 深度

只采「本地检测器命中」的样本会导致**永远发现不了漏检**——而漏检正是本功能存在的理由。所以分两档：

- **广度档（每个 `assistant/message` 都记）**：只存元数据 + 头尾切片 + 本地信号 + 标签候选。
- **深度档（满足条件才存全文）**：`reasoningChars >= harvestMinTextChars`，或本地检测器命中，或本步无工具调用但文本含尖括号标签候选。全文截断到 `harvestMaxTextChars`。

两档都是**定长有界**的，长会话不会无限增长。

### 3.3 样本记录模型

```jsonc
{
  "id": "smp_7f3a...",
  "ts": 1759298400000,
  "sessionId": "00223d5e-...",
  "workspace": "--D-dsh--",
  "turn": 12,
  "step": 3,
  "provider": "deepseek",
  "model": "deepseek-v4.1-flash",

  "reasoningChars": 18422,
  "textChars": 2130,
  "reasoningHead": "前 400 字…",
  "reasoningTail": "后 1200 字…",
  "reasoningFull": "……（仅深度档，截断到 harvestMaxTextChars）",

  "localSignals": {
    "detectorHits": {
      "repeat": null,
      "churn": { "hits": 31 },
      "pseudoTool": false,
      "transition": true
    },
    "softCutFired": true,
    "anchorPoints": 2,
    "anchorText": "1. ……（截断 400 字）",
    "tagCandidates": ["<seed:tool_call>", "<parameter>"],
    "toolCalls": [{ "name": "read", "isError": false }]
  },

  "outcome": "completed",
  "analyzedAt": null
}
```

字段说明：

- `tagCandidates`：从文本中正则扫出的 `<标识符...>` 形状片段（≤12 个，每个 ≤48 字）。**这是发现新伪工具调用拼法的唯一入口**——已知模式匹配不到的新标签，会原样出现在这里。
- `localSignals` 复用现有检测器函数，不新写判定逻辑。它的作用是给 LLM 提供「本地判了什么」，从而能对比出「本地漏了什么」。
- `analyzedAt` 为 `null` 表示尚未进入分析批次。

### 3.4 存储

```
~/.dsh/storages/cot-anchor/
  samples.jsonl      追加写；定长环形，超出 harvestMaxRecords 或 harvestRetentionDays 时重写压缩
  proposals.json     待审候选（单一 JSON）
  patterns.json      已采纳的生效叠加（单一 JSON）
  reports/           导出的增补请求包（markdown，只增不改）
```

写入策略：**去抖**。事件回调只更新内存环形缓冲，`harvestFlushDebounceMs`（默认 5000ms）内的多次事件合并成一次追加写。避免每个 token 步都落盘。

压缩时机：启动时 + 每次 flush 时检查条数与天数，超出即重写文件（保留尾部 N 条）。压缩本身在 `try/catch` 内，失败不影响采集。

### 3.5 性能与隐私

| 风险 | 处置 |
|---|---|
| 热路径开销 | 关闭时首行 return；开启时每步只做切片与少量 `String.match`，无全文扫描 |
| 磁盘膨胀 | 条数 + 天数双上限；单条字符上限 |
| 隐私 | 思考文本可能含文件内容、路径、凭据片段。数据只落本机；**只有用户主动点分析时才会把样本送进 LLM**；导出报告前在 UI 明示包含哪些样本 |
| 子代理会话 | 子代理的 `assistant/message` 同样会被采集（同一宿主事件总线）。第一版不做区分，`workspace`/`sessionId` 字段已足够回溯 |

---

## 4. L2 分析层

### 4.1 触发

| 方式 | 条件 |
|---|---|
| 手动 | 设置页「立即分析」按钮（第一版只有这一条） |
| 自动 | `enableAutoAnalyze` 为真且未分析样本数 ≥ `analyzeTriggerSamples`（默认 50）时，在 flush 后异步启动 |

同一时刻只允许一个分析在飞（`analyzeInFlight` 标志），与现有 `refineInFlight` 同构。

### 4.2 LLM 调用契约

复用现有提炼调用的全部形态（`BlockAssembler` + `createUserMessage` + `AbortController` 超时）：

```js
llm.stream({
  provider: settings.analyzeProvider || source?.provider,
  model: settings.analyzeModel || source?.model,
  messages: [createUserMessage({ content: [{ type: "text", text: batchText }], source: PLUGIN_SOURCE })],
  system: HARVEST_ANALYZE_SYSTEM_PROMPT,
  maxTokens: settings.analyzeMaxTokens,
  sessionId: undefined,                 // 刻意不绑会话，避免污染被观察的会话
  purpose: "cot-anchor-harvest-analyze", // 独立 purpose，便于宿主侧识别与限流
  signal: controller.signal
})
```

**刻意不传 `sessionId`**：分析调用本身不应作为事件回流进被观察的会话，否则采集器会采到自己的分析输出。这一条需要实测确认（见 §8 P0 探针）。

输入批次组织：按「异常优先级」排序取前 `analyzeMaxSamples` 条（本地命中 > 长文本无命中 > 普通样本），总字符截断到 `analyzeMaxInputChars`。每条样本带 `id` 前缀，便于 LLM 回引证据。

### 4.3 输出契约（严格 JSON）

LLM 只允许输出结构化发现，不允许输出可执行代码：

```jsonc
{
  "findings": [
    {
      "kind": "new-pattern",
      "detector": "churn",
      "title": "中文短句空转：反复「再捋一遍」但完全不含 let me / 重新分析",
      "observation": "样本 3 条里，模型用「再捋一遍」「往回倒一下」交替重启，本地 churn 命中数为 4，低于阈值 18。",
      "evidence": ["smp_7f3a", "smp_91c2"],
      "featureSpec": {
        "literals": ["再捋一遍", "往回倒一下"],
        "coOccurrence": [],
        "minHitsPer1000Chars": 5,
        "negatives": ["文档里正在讨论这句话本身"]
      },
      "confidence": 0.72,
      "suggestedAction": "add-churn-phrase"
    },
    {
      "kind": "missed-by-detector",
      "detector": "pseudoTool",
      "title": "新伪调用拼法 <ds:invoke name=...>",
      "observation": "3 条样本出现该标签且该步 toolCalls 为空，本地未命中。",
      "evidence": ["smp_2b88"],
      "featureSpec": { "literals": ["<ds:invoke name="], "coOccurrence": [], "negatives": [] },
      "confidence": 0.91,
      "suggestedAction": "add-pseudo-tool-strong"
    },
    {
      "kind": "threshold-too-high",
      "detector": "churn",
      "title": "churnMinHits=18 在中文短句空转下偏高",
      "observation": "……",
      "evidence": ["smp_7f3a", "smp_91c2", "smp_55de"],
      "featureSpec": { "thresholdKey": "churnMinHits", "suggestedValue": 12 },
      "confidence": 0.6,
      "suggestedAction": "tune-threshold"
    }
  ]
}
```

`kind` 枚举：`new-pattern` / `missed-by-detector` / `false-positive` / `threshold-too-high`。
`detector` 枚举：`churn` / `repeat` / `pseudoTool` / `transition` / `conclusion`。

解析必须容错：模型可能包 ```json 围栏、加前导语，或正文完整但漏吐结尾的闭合定界符（实测：`findings` 数组已闭合、最外层 `}` 缺失，provider 仍报 `stop`）。解析器先剥围栏、按字符串感知方式截取对象、必要时补齐缺失的结尾闭合符，再走同一个严格校验器；补齐只追加定界符，不新增、不改写任何内容。字符串未闭合、缺逗号、闭合符顺序错等真畸形一律判失败，该批次标记 `failed`、样本保持未分析、UI 显示失败原因。**不允许**在解析失败时猜测内容。

### 4.4 候选去重与置信累积

同一个 `featureSpec` 在多轮分析里重复出现时，不新增条目，而是：

```
seenCount += 1
lastSeenAt = now
confidence = min(0.99, confidence + 0.05)
evidence 合并去重（上限 20 条）
```

这让「反复被不同批次独立发现」的模式自然浮到列表顶部。

---

## 5. L3 增补层

### 5.1 两层模式模型

| 层 | 位置 | 内容 | 生效方式 |
|---|---|---|---|
| 出厂层 | `lib/index.js` 常量 | 现有全部模式与阈值 | 代码改动 + 重启 |
| 学习层 | `~/.dsh/storages/cot-anchor/patterns.json` | 用户采纳的增量 | 运行时合并，即时生效，删文件即回滚 |

合并点在检测器读取常量的位置。以 `CHURN_PHRASES` 为例：

```js
function effectiveChurnPhrases() {
  if (!settings.enableLearnedPatterns) return CHURN_PHRASES;
  return CHURN_PHRASES.concat(learnedChurnPhrases());
}
```

**出厂常量一个字节都不改**，现有单元测试（`test-churn.mjs` 等）继续覆盖出厂行为，学习层单独测。

### 5.2 安全编译：LLM 永远不写正则

这是本方案最重要的一条安全约束。

LLM 产出的是 **featureSpec（字面量 + 计数）**，插件用**固定模板**编译成安全正则：

```js
/** 把字面量编译成安全的全局匹配正则：转义全部元字符、限长、无嵌套量词。 */
const LEARNED_LITERAL_MAX_CHARS = 48;
function compileLearnedLiteralPhrase(literal) {
  const cleaned = String(literal ?? "").slice(0, LEARNED_LITERAL_MAX_CHARS);
  if (cleaned.length === 0) return null;
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "g");
}
```

由此得到的性质：

- 编译产物只可能是**字面量匹配**，不含 `+` `*` `{n,}` 等量词 → 结构上不可能灾难性回溯。
- 长度硬上限 48 字符 → 单次匹配代价有界。
- 编译后立即做一次**自检**：对 3 条正常语料跑一遍，命中即拒绝采纳并提示原因。
- 采纳前在 UI 上原样展示编译后的正则，用户看到的就是最终生效的东西。

阈值类增补更安全——只是一个数字，且被 `SETTINGS_SCHEMA` 的 `min`/`max` 夹紧，并且限制相对出厂值的偏移幅度不超过 `learnedMaxShift`。

### 5.3 影子模式（采纳后默认先观察）

被打断是**有破坏性的**（会切断正在进行的生成）。学习来的模式第一次生效时默认进入**影子期**：

- 影子期内，学习模式照常参与判定，但**只记录「若生效会打断」的次数，不真的打断**。
- 设置页显示影子统计：「该模式在影子期本会触发 7 次，误伤你 0 次」→ 用户点「转正式」。
- `learnedShadowRounds`（默认 20 次命中）满后，UI 提示可转正。

这一条把「新模式的误判风险」从「直接打断用户」降到「多一条统计」。

### 5.4 生效叠加文件

```jsonc
{
  "version": 1,
  "patterns": [
    {
      "id": "pat_3c91...",
      "detector": "churn",
      "kind": "literal-phrase",
      "literal": "再捋一遍",
      "regexSource": "再捋一遍",
      "source": "learned",
      "title": "中文短句空转",
      "evidence": ["smp_7f3a", "smp_91c2"],
      "confidence": 0.72,
      "addedAt": 1759298400000,
      "mode": "shadow",
      "shadowHits": 0,
      "enabled": true
    }
  ],
  "thresholdShifts": [
    { "key": "churnMinHits", "delta": -6, "mode": "shadow", "shadowHits": 0 }
  ]
}
```

条数上限 `learnedMaxPhrases`（默认 60）。达到上限时 UI 阻止新增并提示先清理。

### 5.5 旁路：导出增补请求包

运行时叠加解决「当场生效」，但有些模式值得**固化进源码**成为出厂默认。为此提供导出：

- 内容：markdown 报告，含每条候选的 `featureSpec`、证据样本摘要、建议落点常量名、建议 diff 片段。
- 落盘：`~/.dsh/storages/cot-anchor/reports/harvest-request-YYYYMMDD-HHmm.md`。
- 用法：用户把报告贴进一个会话，让编码 Agent 按报告改 `lib/index.js`，走完整校验闭环。

这条路径把「用户发起插件功能增补请求」显式化，且天然保留人工确认。

---

## 6. 设置项与界面

### 6.1 新增设置项（`DEFAULT_SETTINGS` + `SETTINGS_SCHEMA` + `applyRuntimeSettings` 三处同步）

**采集**

| key | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `enableHarvest` | boolean | `false` | — | 总开关，关闭时零开销 |
| `harvestIncludeToolTrace` | boolean | `true` | — | 是否记录工具调用轨迹 |
| `harvestMaxRecords` | number | `200` | 20–2000 | 样本条数上限 |
| `harvestRetentionDays` | number | `14` | 1–90 | 样本保留天数 |
| `harvestMinTextChars` | number | `3000` | 500–50000 | 超过此长度才存全文 |
| `harvestMaxTextChars` | number | `8000` | 500–40000 | 单条全文上限 |
| `harvestFlushDebounceMs` | number | `5000` | 500–60000 | 落盘去抖 |

**分析**

| key | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `enableAutoAnalyze` | boolean | `false` | — | 自动分析 |
| `analyzeTriggerSamples` | number | `50` | 5–500 | 累计多少条未分析样本后触发 |
| `analyzeProvider` | text | `""` | — | 留空跟随会话 |
| `analyzeModel` | text | `""` | — | 留空跟随会话 |
| `analyzeMaxTokens` | number | `1500` | 256–4000 | |
| `analyzeTimeoutMs` | number | `60000` | 5000–180000 | |
| `analyzeMaxInputChars` | number | `40000` | 2000–120000 | |
| `analyzeMaxSamples` | number | `20` | 3–60 | 单批样本数 |

**增补**

| key | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `enableLearnedPatterns` | boolean | `true` | — | 是否加载已采纳模式（空文件时无影响） |
| `learnedMaxPhrases` | number | `60` | 4–200 | 学习模式条数上限 |
| `learnedMaxShift` | number | `20` | 0–50 | 阈值允许的最大偏移幅度 |
| `learnedShadowRounds` | number | `20` | 0–200 | 影子期命中次数，0 = 直接生效 |

### 6.2 界面

现有设置页由 `SETTINGS_SCHEMA` 泛型渲染（boolean/number/text），新增项自动出现，**无需改 client.js 即可获得设置能力**。

但候选列表、采纳按钮、影子统计需要自定义 UI。方案：在泛型表单下方追加一个自定义区块，复用现有 `THEME` 与按钮样式函数：

```
┌ COT 采集与增补 ──────────────────────────────┐
│ 已采集 137 条 · 未分析 22 条 · 最近分析 10-01 15:20 │
│ [立即分析]  [导出增补请求包]  [清空样本]            │
├ 待审候选 (3) ───────────────────────────────┤
│ ● 中文短句空转：反复「再捋一遍」        churn  0.72 │
│   证据 2 条 · 本会触发 7 次                        │
│   [采纳] [忽略] [看证据]                          │
│ ● 新伪调用拼法 <ds:invoke name=...>  pseudoTool 0.91│
│   …                                              │
├ 已生效模式 (1) ─────────────────────────────┤
│ 再捋一遍           影子期 7/20   [转正式] [停用] [删除] │
└──────────────────────────────────────────┘
```

新增 HTTP 路由（与现有 `/plugins/cot-anchor/settings` 并列，不动原路由）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/plugins/cot-anchor/harvest` | 返回状态、待审候选、已生效模式、影子统计 |
| `POST` | `/plugins/cot-anchor/harvest` | `{ action: "analyze" \| "approve" \| "reject" \| "promote" \| "disable" \| "delete" \| "clear" \| "export" }` |

客户端半边改动只需刷新页面即可生效（宿主半边改动需重启）。

---

## 7. 风险与对策

| # | 风险 | 对策 | 残留 |
|---|---|---|---|
| R1 | 正则灾难性回溯 | LLM 不写正则；只编译字面量；转义 + 48 字限长 + 无嵌套量词 | 无（结构上排除） |
| R2 | 新模式误伤，打断正常思考 | 默认影子期；采纳前用正常语料自检；UI 展示编译后正则 | 低 |
| R3 | 采集器自我放大（采到自己的锚点/分析输出） | 按 `source.plugin` 过滤自身注入；分析调用不绑 `sessionId` | 需 P0 实测确认 |
| R4 | 热路径性能回归 | 关闭时首行 return；开启时每步 O(1)；落盘去抖 | 低 |
| R5 | 磁盘无限增长 | 条数 + 天数双上限；flush 时压缩；报告目录单独可清 | 低 |
| R6 | 隐私泄漏 | 只落本机；只在用户主动分析时才送 LLM；导出前明示样本范围 | 中（用户需知情） |
| R7 | LLM 输出不合 schema | 严格 JSON 解析（仅补缺失的结尾闭合定界符，不猜测内容）+ 失败标记；样本保持未分析可重试 | 低 |
| R8 | 学习模式数量失控导致判定漂移 | 条数上限；阈值偏移上限；影子统计；一键全停 | 低 |
| R9 | 改 client.js 导致设置页崩 | 客户端半边保持 `__ModuleLoader__.load` 壳；改后刷新页面验证 | 低 |

---

## 8. 验证方案

### 8.1 P0 探针（实现前的硬门槛）

先不写正式代码，用一个临时探针确认三件事，任何一条不成立都要改设计：

1. **`session/event` 能拿到 reasoning 全文**：挂监听打印 `event.type`、`data.message.content` 各块的 `type` 与 `length`。
2. **不声明 inject 也能收到事件**：确认 `ctx.on("session/event", ...)` 在 `inject: ["webServer"]` 不变的前提下能触发。
3. **分析调用不回流**：跑一次带 `purpose: "cot-anchor-harvest-analyze"`、不带 `sessionId` 的 `llm.stream`，确认会话里没有多出 `assistant/message`。

### 8.2 单元测试（沿用现有 `test-*.mjs` 风格）

`test-*.mjs` 的既有约定：读 `lib/index.js` 源码，剥掉 `^import` / `^export` 行，用 `new Function` 取内部函数。新增测试沿用同一形态：

- `test-harvest-sample.mjs`：给定构造事件，断言样本记录字段与截断上限。
- `test-harvest-compile.mjs`：断言字面量编译结果、元字符被转义、超长被截断、危险输入（`(a+)+`）编译后不含量词。
- `test-harvest-parse.mjs`：断言带围栏/带前导语的 LLM 输出能被解析；坏 JSON 被标记失败而非猜测。
- `test-harvest-overlay.mjs`：断言未采纳时检测器行为与出厂完全一致；采纳后 churn 命中数上升；删除叠加后回落。

### 8.3 插件校验闭环（按 hotrules §6，不得跳过）

1. 模块格式预检：`lib/client.js` 仍被 `window.__ModuleLoader__.load(` 包裹，无顶层 `return`。
2. 先解决 profile 依赖阴影问题，再用空闲端口起独立实例 `dsh web --no-open --port <调试端口>`（不要占用正在运行的实例端口）。
3. 抓 combo → `node --check` 退出码 0、体积 ≥14MB。
4. 打开页面：无 `Failed to load plugins` / `module is not defined` / `Illegal return statement`；设置页实际渲染新区块。

### 8.4 端到端验收

用一个真实会话跑出一次「模型打转」，确认：样本落盘 → 点分析 → 出现候选 → 采纳 → 影子统计计数 → 转正式后真实打断。**界面验证一律用真实打开页面观察，不做模拟点击**。

---

## 9. 分阶段实施

| 阶段 | 内容 | 产出 | 前置 |
|---|---|---|---|
| P0 | 探针验证 §8.1 三条 | 结论记录 | 无 |
| P1 | 采集层：设置项 + 环形缓冲 + JSONL + 状态路由 | 能落盘、能看条数 | P0 通过 |
| P2 | 分析层：手动触发 + LLM 批次 + proposals.json | 能出候选 | P1 |
| P3 | 增补层：候选 UI + 采纳 + patterns.json + 运行时叠加（先只做 churn 字面量） | 闭环打通 | P2 |
| P4 | 影子模式 + 自动分析 + 导出请求包 + 其余检测器扩展 | 完整功能 | P3 |

每阶段结束都跑 §8.3 闭环。P1–P3 是核心，P4 可延后。

**预估改动量**：`lib/index.js` +约 450 行；`lib/client.js` +约 180 行；新增 4 个测试文件。

---

## 10. 待确认问题

1. **采集范围**：是否只采主会话，还是连子代理会话一起采？（当前设计：一起采）
2. **默认值**：`enableHarvest` 默认关闭已定；但 `enableLearnedPatterns` 默认开（空文件时无影响）是否接受？
3. **影子期**：默认 20 次命中才允许转正，是否过长/过短？
4. **阈值类增补**：是否允许学习层改阈值，还是第一版只允许加字面量模式？（当前设计：允许，但有偏移上限）
5. **导出路径**：报告写进 `~/.dsh/storages/cot-anchor/reports/` 还是直接写进插件仓库 `docs/`？
6. **样本清理**：是否需要「只保留异常样本」的省空间模式？
