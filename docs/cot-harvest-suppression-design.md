# COT 误报学习与抑制层 — 补充设计

> 状态：设计待评审（未实现）
> 关系：本文是 [`cot-harvest-design.md`](./cot-harvest-design.md)（下称"原文"）的增补篇，不替代原文。原文管"该打断时没打断"（漏报侧），本文管"不该打断时打断了"（误报侧）。两篇合并实施，本文不单独成立。
> 目标插件：`dsh-cot-anchor`

## TL;DR（最小规则集）

1. 本工程给插件的打断能力增加**对称的减法**：出厂模式逐条发 id，误报可按 id 禁用、按语境豁免、按参数收紧，全部经人工采纳与影子期后才生效。
2. 【禁止】字节级重复循环（repeat 路径）永不抑制；级联排除组与闭合标签组（`system.*`）禁止停用；其他插件已作出的 cut 不抑制。
3. 【必须】每条出厂正则带稳定 id；id 删除即注销、永不复用，全量清单由快照测试锁定。
4. 【必须】所有抑制规则先进影子期（只统计不放过），转正依据设置页三列后验计数由人工决定；后验启发式信号只排序、不定罪，人工标记是唯一确定标签。
5. 【必须】LLM 不写正则；否定字面量复用原文 48 字转义编译，只在命中点 ±窗口 内生效。
6. 【必须】P1b（id 化）最先独立合入，验收为现有全部测试零修改退出码 0 加真实回放 cut 决策零差异。
7. 【暂定】后验信号阈值与影子期轮数为初调值，修订触发条件见 §7.2、§9。
8. 相似度重复检测与 `splitSentences` 截断加固不在本工程内（§13）。

## 目录

1. 背景与目标（为什么需要减法）
2. 总体模型：双向学习
3. 术语、模态词与命名映射
4. 出厂模式身份证（id 化改造）
5. 决策单点重构：`decideCut`
6. L1 扩展：打断记录与后验信号
7. L2 扩展：误报发现
8. L3 扩展：suppressions 模型
9. 抑制影子期
10. 可抑制性矩阵、设置项、路由与界面
11. 测试与阶段验收（客观信号）
12. P0 探针增量
13. 分阶段实施与工作量
14. 风险与对策
15. 明确不覆盖的范围
- 附录 A：症状/报错 → 章节 反向索引
- 附录 B：交付前自查清单

---

## 1. 背景与目标

原文 L3 是单向加法：`patterns`（新增命中词）+ `thresholdShifts`（调计数阈值），合并为 `CHURN_PHRASES.concat(...)`；`featureSpec.negatives` 仅用于采纳前一次性自检；findings 的 `false-positive` 无字段承接。净效应是打断只增不减。

本插件代价最高的事故恰在误报侧，且全部靠"减法"修复：

- 裸 `let me` 在正常英文推理中提前软切断 → 收紧为仅匹配显式阶段宣布（`lib/index.js` 第 428–431 行注释）；
- 转折词刚吐出两个字就切 → 增加 `softCutMinFollowChars` 展开字数门槛（同文件第 441–447 行）；
- 伪调用标签在思考中起草未闭合即误切 → 强/弱路径均要求闭合结构（同文件第 650–656、679–686 行注释）。

目标：把这类"减法修复"从只能改源码，变为可从真实误报中学习、经人工确认后运行时生效，且默认行为与今天逐字节一致（无采纳数据时零变化）。

## 2. 总体模型：双向学习

```
                         L1 采集
        assistant/tool 事件样本（原文 §3）
                 +
        agent/soft-cut 打断记录 + 后验信号（本文 §6）
                              │
                              ▼
                         L2 分析
            漏报发现                      误报发现
       new-pattern /                 kind=false-positive
       missed-by-detector /          suppressionKind 三选一（§7）
       threshold-too-high                  │
                ┌──────────────────────────┴──────────────────────────┐
                ▼                                                     ▼
        patterns（加法，原文 §5）                            suppressions（减法，本文 §8）
        thresholdShifts（计数阈值双向）                      disable-pattern /
                                                             negative-literal /
                                                             param-tighten
```

两侧共用同一套安全机制：LLM 只产结构化特征、不写正则；人工采纳；影子期先行；删文件即回滚。

## 3. 术语、模态词与命名映射

### 3.1 术语表（首次定义，全文统一用字）

| 术语 | 定义 |
|---|---|
| 软切断 / soft-cut / 打断 | 生成中途由 `agent/soft-cut` 事件返回 `{kind:"cut"}`，把当前生成切开并注入锚点。三词同义，行文用"打断"。 |
| 出厂模式 | `lib/index.js` 内硬编码的全部正则常量与阈值 |
| 学习层 | `~/.dsh/storages/cot-anchor/patterns.json` 内用户采纳的数据 |
| 影子期 / shadow | 规则已加载但不改变实际行为，只统计"若生效会怎样" |
| 转正 / active | 规则结束影子期、开始实际改变判定 |
| 后验信号 | 打断之后的后续事件特征（§6.2） |
| 字 / 字符数 | 除显式注明外，一律指 JS `string.length`（UTF-16 code unit），含标点与空白；"去空白归一化"指删除全部空白字符后再计数 |

### 3.2 模态词约定（R49）

- 【必须】/【禁止】：硬约束，违反即设计不成立或验收失败。
- 【建议】：可在评审中修改的软建议，不影响闭环成立。
- 【暂定】：初调数值，必须带修订触发条件；触发条件满足前按本值实现。

### 3.3 抑制动作命名（全文唯一一套，R34）

L2 输出、路由 action、L3 落盘三处共用下列三个名字，禁止再起别名：

| 抑制动作（唯一命名） | L2 输出字段取值 | L3 落盘 `kind` | 语义 |
|---|---|---|---|
| `disable-pattern` | `suppressionKind: "disable-pattern"` | `"disable-pattern"` | 按 id 摘掉一条出厂模式 |
| `negative-literal` | `suppressionKind: "negative-literal"` | `"negative-literal"` | 命中点邻近窗口出现豁免字面量则本次不切 |
| `param-tighten` | `suppressionKind: "param-tighten"` | `"param-tighten"` | 结构参数向"更少打断"方向收紧 |

L2 发现统一为 `kind: "false-positive"` + `suppressionKind` 三选一 + `suggestedAction: "add-suppression"`；采纳时按 `suppressionKind` 落盘。解析到其它取值【必须】拒绝整条 finding（不猜测、不降级映射）。

## 4. 出厂模式身份证（id 化改造）

### 4.1 改造形态

所有参与打断判定的出厂常量，由裸正则数组改为 `{ id, pattern }` 对象数组；判定逻辑一字节不变，仅遍历解构出 `id`：

```js
// 改造前
const TRANSITION_PATTERNS = [ /…/, /…/ ];
// 改造后
const TRANSITION_PATTERNS = [
	{ id: "transition.zh-jiexialai", pattern: /(^|[…])\s*接下来(我|我们)?(要|将|准备|先)?/u }
];
```

### 4.2 id 命名规则【必须】

- 形如 `<族>.<语义简写>`，全小写 kebab-case；`<族>` 编码检测器与子组，见 id 即知判定路径。
- id 一经发布永不复用：删除模式时该 id 同步注销；新模式【禁止】复用已注销 id。注销名单由快照测试锁定（§11.1）。
- 全量 id 清单不进本文档，以代码为唯一事实源，快照测试锁定（实现时新增模式必须同步改快照，测试失败即提醒）。

代表性 id（示意，非全量）：

| 常量 | 代表性 id |
|---|---|
| `TRANSITION_PATTERNS` | `transition.zh-jiexialai`、`transition.zh-wo-xian`、`transition.en-let-me-now` |
| `CASCADING_PATTERNS` | `system.cascade-en-and-now` 等 |
| `CHURN_PHRASES` | `churn.en-let-me`、`churn.en-hmm`、`churn.zh-rangwo-xiangxiang` |
| `PSEUDO_STRONG_PATTERNS` | `pseudo.strong.seed-function-closed` 等 |
| `PSEUDO_WEAK_PATTERNS` | `pseudo.weak.seed-opener` 等 |
| `PSEUDO_CLOSER_PATTERNS` | `system.pseudo-closer-*` |
| `CONCLUSION_OPENERS` | `gate.zh-suoYi`、`gate.en-therefore` 等 |

### 4.3 保护组与风险组【必须】

抑制只允许让打断"变少/变晚"。据此：

- 【禁止】停用 `system.cascade-*`（级联连词排除）与 `system.pseudo-closer-*`（闭合结构要求）：它们本身就是防误报规则，停用只会让误报增多。加载含这些 targetId 的抑制规则时【必须】整条拒绝。
- 停用 `gate.*`（结论词闸门）意味着允许"无明确结论也转折切断"，属高风险：UI 【必须】展示警告文案，且该类抑制的影子期轮数加倍（§9）。

### 4.4 行为等价验收【必须】

id 化是纯结构改造，三条同时满足才算完成（客观做法见 §11.2）：

1. 现有全部 `test-*.mjs` 零修改、逐个退出码 0；
2. 新增 id 快照测试退出码 0；
3. 真实会话回放语料的 cut/no-cut 决策逐点比对，差异条数 = 0。

## 5. 决策单点重构：`decideCut`

### 5.1 现状与目标

现 `agent/soft-cut` 处理器（`lib/index.js` 第 1293–1353 行）含四条提前 `return {kind:"cut"}` 路径，归因散落。重构为纯函数判定 + 单点编排：

```js
/**
 * 出厂+学习加法模式下的完整判定，不含任何抑制。
 * @returns {{trigger:"pseudoTool"|"repeat"|"churn"|"transition",
 *            patternIds:string[], cut:object}} 命中时
 *          或 {{trigger:null}} 不命中时
 */
function decideCut(fullVisibleText) { /* 四条路径，每条返回命中 id 列表 */ }

/** 抑制编排：放行或压制一个判定；影子规则只记录不压制（§8.4、§9）。 */
function applySuppressions(decision, fullText, settings) { /* §8 */ }
```

### 5.2 路径与归因规则【必须】

| 触发路径 | patternIds 来源 | 可否抑制 |
|---|---|---|
| `pseudoTool` | `hasPseudoToolCall` 改返回 `{hit, ids}`，给出命中的 strong/weak id | 见 §10.1 矩阵 |
| `repeat` | 固定占位 `["structural.repeat-bytecycle"]`，仅供记录 | 【禁止】抑制 |
| `churn` | 命中的 churn 模式 id | 见矩阵 |
| `transition` | 尾部最后命中的转折模式 id | 见矩阵 |

处理器编排顺序【必须】严格为：

1. `const upstream = await next();` 若 `upstream?.kind === "cut"` 直接返回——其他插件的 cut 本插件【禁止】抑制或改写；
2. `enableSoftCut === false` 或文本非字符串 → 返回 null；
3. `decideCut` 得 `trigger:null` → 返回 null（此情况不产生打断记录）；
4. `applySuppressions` 压制 → 返回 null 并记录；放行 → 返回 decision.cut 并记录。

## 6. L1 扩展：打断记录与后验信号

### 6.1 打断记录文件

在 `decideCut`/`applySuppressions` 同一处理器内直接记录（无需新挂点）。文件：`~/.dsh/storages/cot-anchor/cut-records.jsonl`，与原文 `samples.jsonl` 同构：追加写、5000ms 去抖、条数与天数双上限环形压缩，压缩失败不影响会话。

记录四态，穷尽无遗漏（R27）：

| 出厂判定 | 抑制状态 | decision 字段 | 是否真打断 |
|---|---|---|---|
| 不 cut | — | 不产生记录 | — |
| cut | 无规则命中 | `"cut"` | 是 |
| cut | 仅影子规则命中 | `"shadow-suppressed"` | 是 |
| cut | 有启用规则压制 | `"suppressed"` | 否 |

记录样例（完整键名，R40）：

```jsonc
{
  "id": "cut_81bc2f0a",            // 必填，cut_ + 8 位随机十六进制
  "ts": 1759298400000,             // 必填，毫秒时间戳
  "sessionId": "00223d5e-...",     // 必填，取自会话；探针 4 确认取不到时填 "unknown"
  "turn": 12,                      // 可选，探针 4 确认；取不到填 null
  "step": 3,                       // 可选，同上
  "provider": "deepseek",          // 必填，取不到填 "unknown"
  "model": "deepseek-v4.1-flash",  // 必填，取不到填 "unknown"
  "visibleChars": 18422,           // 必填，打断时 fullVisibleText.length
  "trigger": "transition",         // 必填，四路径之一
  "patternIds": ["transition.zh-wo-xian"], // 必填，非空（repeat 为占位 id）
  "decision": "cut",               // 必填，三态之一
  "suppressedBy": [],              // 必填，命中的 sup_ id 列表；无则空数组
  "tailAroundCut": "…",            // 可选，打断时文本尾部 400 字（打断发生在中途，不存在"切点后"文本；续写文本在 postCut 回填时另取），仅深度档存
  "sampleRef": "smp_7f3a9e21",     // 可选，同时刻样本 id；无则 null
  "postCut": null                  // 可选，后验信号对象（§6.2）；未回填为 null
}
```

隐私：记录开关 `enableCutRecords` 仅在原文 `enableHarvest=true` 时生效；`harvestIncludeToolTrace=false` 时不含工具轨迹；切片受原文深度档字符上限约束。

### 6.2 后验信号（回填 postCut）

打断之后首个助手回合落盘时回填最近一条未闭合记录；超过 `postCutCloseRounds`（默认 2 个回合，定义点 §10.2）未闭合【必须】冻结为 `"unknown"`，不做猜测。

| 键 | 可观测判别条件（满足记 true，否则 false） | 含义 |
|---|---|---|
| `resumedChars` | 取数值：打断后首个 assistant/message 的 reasoning+text 字符数 | 中性度量，不定罪 |
| `restatedCutContent` | 打断后续写前 400 字与切点前 400 字，各自去空白归一化后，最长公共子串长度 ÷ 较短文本长度 **≥ 0.6【暂定】** | 模型在重说被切内容 → 疑似误伤线索 |
| `interruptedAfterCut` | 回合关闭时消息 `interrupted === true` **且**本回合无成功工具调用，两个条件同时满足 | 被立刻终止 → 疑似误伤线索 |
| `toolCallAfterCut` | 打断后 1 个回合内出现成功的 tool/call + tool/result 配对 | 模型接受提醒并行动 → 疑似正确线索 |
| `userFeedback` | 仅取人工标记值 `"false-cut"` / `"correct-cut"`；未标记为 `null` | **唯一确定标签** |

【暂定】修订触发：`restatedCutContent` 的 0.6 阈值在首批 50 条已人工标记记录上回算，若与人工标签一致率低于 0.7 则调整，调整值写入本节并保留旧值说明。

【必须】上述启发式信号只用于 L2 批次排序和 UI 展示，【禁止】作为自动抑制、自动转正或自动判罚的依据；prompt 中必须向 LLM 声明其为线索而非结论。

## 7. L2 扩展：误报发现

### 7.1 输入批次

在原文"异常优先级"排序前插入最高优先级一类：带后验信号的打断记录。入排规则（穷尽）：`userFeedback="false-cut"` 的记录最优先；其次两个启发式嫌疑同时成立；再次单个成立；最后无信号记录。`userFeedback="correct-cut"` 的记录【必须】排除出误报分析批次（确定不是误报）；`userFeedback=null` 不阻塞入排。每条附 `patternIds`、`tailAroundCut`（切点前文本）、打断后续写前 400 字（postCut 回填来源）、关联样本的 localSignals；总字符仍受原文 `analyzeMaxInputChars` 截断。

### 7.2 输出契约

在原文 findings 数组中新增如下形态（命名遵循 §3.3，其它 kind 仍按原文）：

```jsonc
{
  "kind": "false-positive",
  "suppressionKind": "disable-pattern",   // 三选一，见 §3.3
  "detector": "transition",
  "targetId": "transition.zh-xianzai",    // 仅 disable-pattern 必填，须为现存出厂 id
  "title": "「现在我们开始」在正常分节叙述中被误切",
  "observation": "cut_81bc、cut_77a0 打断后均在 300 字内重述切点前内容且无工具调用。",
  "evidence": ["cut_81bc", "cut_77a0"],
  "featureSpec": null,                     // disable-pattern 时为 null
  "confidence": 0.68,
  "suggestedAction": "add-suppression"
}
```

三种 `suppressionKind` 的必填字段【必须】按模板齐全，缺字段整条拒绝：

| suppressionKind | 必填字段 | 禁止字段 |
|---|---|---|
| `disable-pattern` | `targetId`（现存、非保护组、矩阵允许） | `featureSpec` |
| `negative-literal` | `featureSpec.literals`（非空字符串数组，单条 ≤48 字）、`featureSpec.negatives`（数组，可为空） | `targetId` |
| `param-tighten` | `featureSpec.key`（§8.3 白名单内）、`featureSpec.suggestedValue`（数字） | `targetId` |

去重沿用原文 §4.4 规则；去重键：disable 用 `targetId`，negative 用归一化后的字面量，param 用 `key`（同 key 只保留更收紧的一条候选）。解析容错沿用原文：剥围栏、`JSON.parse` 失败则整批标记 failed、样本保持未分析。

## 8. L3 扩展：suppressions 模型

### 8.1 文件与版本口径

`patterns.json` 直接交付 `version: 2`（原文尚未实现，不存在 v1 数据，无需迁移；合并实施时原文 §5.4 的 version 1 样例以本文 version 2 为准——R21 单点口径）。在原文两键外新增 `suppressions` 数组：

```jsonc
{
  "version": 2,
  "patterns": [],          // 原文：加法
  "thresholdShifts": [],   // 原文：计数阈值，双向
  "suppressions": []       // 本文：减法，元素 schema 见 §8.2
}
```

### 8.2 三种元素的字段模板（R48，同 kind 字段集合一致）

**disable-pattern**

```jsonc
{ "id": "sup_3c91a1", "kind": "disable-pattern", "targetId": "transition.zh-xianzai",
  "title": "正常分节叙述误切", "evidence": ["cut_81bc"], "confidence": 0.68,
  "addedAt": 1759298400000, "mode": "shadow", "shadowHits": 0, "enabled": true }
```

**negative-literal**

```jsonc
{ "id": "sup_9d22b7", "kind": "negative-literal", "detector": "churn",
  "literal": "let me now apply this to", "regexSource": "let me now apply this to",
  "scopeChars": 240,
  "evidence": ["cut_55de"], "confidence": 0.61,
  "addedAt": 1759298400000, "mode": "shadow", "shadowHits": 0, "enabled": true }
```

**param-tighten**

```jsonc
{ "id": "sup_55de03", "kind": "param-tighten", "key": "softCutMinFollowChars",
  "value": 12, "evidence": ["cut_11aa"], "confidence": 0.74,
  "addedAt": 1759298400000, "mode": "active", "shadowHits": 0, "enabled": true }
```

公共字段：`id`（sup_+6 位随机十六进制）、`kind`、`evidence`、`confidence`、`addedAt`、`mode`（`"shadow"`/`"active"`）、`shadowHits`、`enabled`。加载校验失败的元素【必须】整条跳过并在状态接口标注原因，不得部分生效。

### 8.3 三种减法的语义

**(a) disable-pattern**

检测器读取常量统一走 effective 访问器，active 规则按 id 过滤，出厂常量本身不改：

```js
function effectivePatterns(factoryArr) {
	return factoryArr.filter(({ id }) => !disabledPatternIds.has(id));
}
```

同一次判定由多个 id 共同触发时（如 pseudo 弱路径多标签命中），【必须】全部命中 id 均被禁用才压制；只要还有一条生效即照常打断（保守原则）。

**(b) negative-literal**

复用原文 §5.2 的安全编译（转义全部元字符、48 字限长、无嵌套量词）。作用域：以触发命中位置为中点，向前 `scopeChars` 字、向后 `scopeChars` 字的窗口内（默认 240，总跨度约 480 字，定义点 §10.2）出现该字面量时，压制对应检测器**本次**判定；窗口外出现不影响任何判定。仅 `churn`、`transition` 开放（矩阵见 §10.1）。条数受 `learnedNegativeLiteralsMax` 限制；采纳前【必须】对内置正常语料库自检并展示命中频次。

**(c) param-tighten 与 thresholdShifts 的分工（R30 选择判据）**

| 机制 | 作用对象 | 允许方向 | 例 |
|---|---|---|---|
| `thresholdShifts`（原文） | 计数型阈值 | 双向（正偏移少切、负偏移多切），幅度受 `learnedMaxShift` 夹紧 | `churnMinHits` |
| `param-tighten`（本文） | 结构型参数 | 仅"更少/更晚打断"单向 | 见下表 |

param-tighten 白名单（只含下列键；键不在表内的候选加载时拒绝）：

| key | 允许方向 | 收紧语义 |
|---|---|---|
| `softCutMinFollowChars` | 只增 | 转折词后要求更多展开字数 |
| `softCutTransitionWindow` | 只减 | 转折词必须更贴近句末 |
| `softCutScanTail` | 只减 | 缩小尾部扫描窗口 |
| `churnMinTextChars` | 只增 | 提高 churn 启用文本门槛 |
| `repeatMinTextChars` | 只增 | 提高 repeat 启用文本门槛 |
| `pseudoToolScanTail` | 只减 | 缩小伪调用扫描窗口 |

取值同时受 `SETTINGS_SCHEMA` 的 min/max 夹紧；同键多条 active 规则取最收紧值。

### 8.4 执行顺序与总开关

`applySuppressions` 内【必须】严格按序：

1. param-tighten 已作为运行时参数进入 `decideCut`（更严参数下可能直接不 cut，此情况无 suppressedBy 归因）；
2. disable-pattern：按 §8.3(a) 保守原则判断；
3. negative-literal：窗口内命中任一启用字面量即压制；
4. 命中影子规则：照常返回 cut，记 `"shadow-suppressed"`、shadowHits +1；命中启用规则：返回 null，记 `"suppressed"`。

总开关 `enableSuppressions`（默认 true，空文件零影响）关闭时，decision 原样通过，行为与今天逐字节一致；删除 `patterns.json` 同样完全回滚。

## 9. 抑制影子期

抑制的风险方向与新增模式相反但同样真实（错误抑制会放行真打转），故对称设影子期，且【必须】默认先影子：

- 影子期内真打断照常发生，只记录"本会被放过"及该次完整后验信号；
- 转正门槛：`shadowHits ≥ learnedSuppressionShadowRounds`（默认 10，唯一定义点 §10.2）；`gate.*` 类抑制门槛加倍为 20；0 表示采纳即生效，【建议】不要设为 0；
- 设置页对每条影子规则展示三列计数："本会放过 N 次：疑似误伤 a、疑似正确 b、未知 c"，三列分列，启发式信号不得合并成单一结论；
- 转正【必须】人工点击，系统不自动转正；
- param-tighten 为例外：纯数字单向收紧，允许采纳即 active，但受影响的前 N 次 cut（N 取 `learnedSuppressionShadowRounds`）仍在记录中标注，供回看；
- active 抑制若事后出现被其压制且 `userFeedback="correct-cut"` 的记录，UI 【必须】提示"建议停用该抑制"，不自动停用。

## 10. 可抑制性矩阵、设置项、路由与界面

### 10.1 可抑制性矩阵（R25：四条触发路径穷尽，无其它路径）

| 触发路径 | disable-pattern | negative-literal | param-tighten | 备注 |
|---|---|---|---|---|
| `pseudoTool` | 允许（strong/weak 逐条） | 【禁止】 | `pseudoToolScanTail` 只减 | `system.pseudo-closer-*` 禁停用；需人工证据 |
| `repeat` | 【禁止】（结构判定，无字面 id） | 【禁止】 | `repeatMinTextChars` 只增 | 字节级循环无论出现位置都是垃圾（现源码 828–829 行定论） |
| `churn` | 允许 | 允许 | `churnMinTextChars` 只增 | minHits 走 thresholdShifts |
| `transition` | 允许 | 允许 | followChars 只增 / window 只减 / scanTail 只减 | `system.cascade-*` 禁停用；`gate.*` 影子期加倍 |

加载任何与本表冲突的抑制规则（含 targetId 不存在、属保护组、列中标【禁止】的组合）时【必须】整条拒绝并在 UI 标红原因。

### 10.2 新增设置项（唯一定义点；原文三处同步规则不变）

| key | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `enableCutRecords` | boolean | `true` | — | 打断记录开关，仅 `enableHarvest=true` 时生效 |
| `enableSuppressions` | boolean | `true` | — | 抑制层总开关，空文件零影响 |
| `cutRecordMaxRecords` | number | `200` | 20–1000 | cut-records 环形条数上限 |
| `learnedSuppressionMaxItems` | number | `40` | 4–100 | suppressions 条数上限（三 kind 合计） |
| `learnedNegativeLiteralsMax` | number | `30` | 4–100 | negative-literal 条数上限 |
| `learnedSuppressionShadowRounds` | number | `10` | 0–100 | 影子期转正门槛；`gate.*` 加倍 = 2×此值；0=采纳即生效（不建议） |
| `negativeLiteralScopeChars` | number | `240` | 80–800 | 豁免字面量作用窗口：命中点前、后各此数字符 |
| `postCutCloseRounds` | number | `2` | 1–5 | 后验信号回填回合窗口，超期冻结 unknown |

### 10.3 路由与界面

不新增路由面，在原文 `/plugins/cot-anchor/harvest` 上扩展。POST action 全量枚举如下（原文 8 个 + 本文 3 个）；未列出的 action 【必须】返回 HTTP 400 与 `{ok:false, error:"unknown action"}`，不得静默忽略：

- 原文：`analyze` / `approve` / `reject` / `promote` / `disable` / `delete` / `clear` / `export`
- 本文：`promote-suppression`（影子抑制转正）/ `disable-suppression`（停用单条抑制）/ `mark-cut`（body 必须含 `cutId` 与 `label:"false-cut"|"correct-cut"`，其余取值 400）

GET 返回体在原文基础上增加三个键：`cutRecords`（分页，含后验信号）、`suppressions`（含 mode 与三列影子计数）、`suppressionRejections`（加载被拒规则及原因）。

界面在原文自定义区块"已生效模式"下方追加两个子区：

1. **打断记录**：每条显示触发路径、pattern id、decision、后验三态，提供 [误判]/[正确] 两个按钮（对应 `mark-cut`）；
2. **抑制规则**：显示 kind、作用对象、影子三列计数，提供 [转正式]/[停用]/[删除]。

## 11. 测试与阶段验收（客观信号）

运行方式（R52）：仓库 `package.json` 无 test 脚本，测试文件均为自执行断言脚本，用 `node <文件名>` 直接运行；通过信号为进程退出码 0 且末行打印"全部…断言通过"（`test-softcut.mjs` 已实测：退出码 0、末行"全部软切断断言通过"，2026-10-01）。

### 11.1 新增四个测试文件

| 文件 | 断言内容 |
|---|---|
| `test-pattern-ids.mjs` | 每个出厂数组元素均为 `{id,pattern}` 且 id 全局唯一；id 全量清单与内联快照一致；保护组 id 带 `system.` 前缀；注销名单内 id 不出现在现存清单 |
| `test-suppression-runtime.mjs` | disable 按 id 生效；多 id 共触发需全失效才压制；negative-literal 窗口内压制、窗口外不压制；param 越界/非白名单键被拒；repeat 与保护组抑制被拒；无 suppressions 时回放 cut 结果与出厂逐点一致 |
| `test-cut-record.mjs` | 四路径 patternIds 归因正确；四态记录（无记录/cut/shadow-suppressed/suppressed）与 §6.1 表一致；upstream cut 不产生本插件记录 |
| `test-suppression-shadow.mjs` | 影子计数与门槛拦截；gate.* 门槛加倍；param 采纳即 active 但留标注；correct-cut 回看提示触发 |

### 11.2 阶段验收命令【必须】

P1b 验收（在插件根目录下执行）：

```powershell
# 1) 现有测试零修改、全部通过：逐个退出码 0
Get-ChildItem test-*.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "FAIL: $($_.Name)" } }
# 2) id 快照测试
node test-pattern-ids.mjs   # 期望：退出码 0
# 3) 真实回放零差异（回放脚本为 P1b 交付物，见 §13）
node scripts/replay-cuts.mjs   # 期望：末行打印 "cut 决策差异条数：0"，退出码 0
```

负结果留痕：若探针未通过导致某项当阶段无法执行，阶段记录中写固定标签「未做动态验证：<原因>」，禁止以"已检查"笼统表述（R31）。

界面验收沿用原文 §8.3 插件校验闭环（独立调试实例、combo 体积 ≥14MB、`node --check` 退出码 0、真实打开页面无 `Failed to load plugins`），不做模拟点击。

## 12. P0 探针增量

并入原文 §8.1，编号承接（原文已有 1–3 条）：

4. 【待实测，未证实不得作实现前提】打印 `agent/soft-cut` 的 payload 全量键，确认 `turn`/`step`/`sessionId` 是否可得，决定 §6.1 可选字段取值；
5. 【待实测】查明打断后用户重新生成/删除/手动中断分别产生的事件，确认 `assistant/message` 的 `interrupted` 标记覆盖哪些场景，决定 `interruptedAfterCut` 最终条件；
6. 【待实测】确认四条路径返回具体命中 id 不需要改匹配算法本身（pseudo 返回下标、transition 记录最后命中 id）。

任一条结论与设计假设冲突时，按受影响章节回改设计后再进入对应阶段。

## 13. 分阶段实施与工作量

顺序语义：【必须严格按序】，P1b 必须最先且独立合入；颠倒 P1b 与后续阶段会导致抑制规则没有合法作用对象。

| 阶段 | 内容 | 产出 | 前置 |
|---|---|---|---|
| P0 | 原文三探针 + 本文探针 4–6 | 探针结论记录 | 无 |
| **P1b** | id 化改造 + `test-pattern-ids.mjs` + `scripts/replay-cuts.mjs`（内置真实回放语料，逐点比对 cut 决策） | 零行为变化合入 | P0 第 6 条 |
| 原文 P1–P2 | 采集层、手动分析 | 样本落盘、能出候选 | P0 |
| **P3b** | `decideCut` 重构 + cut-records 落盘 + suppressions 运行时（**仅 shadow 模式**，规则先手工录入）+ 打断记录列表与 [误判]/[正确] 按钮 | 不依赖 L2 的人工闭环 | P1b、原文 P1 |
| **P4b** | L2 三类误报发现（§7）+ 候选审核 UI + 采纳/转正流程 | 双向学习完整闭环 | P3b、原文 P2 |

P3b 完成即有最小人工闭环：列表点[误判] → 按 patternId 生成 disable-pattern 规则进影子期 → 看三列计数 → 人工转正。

工作量预估：`lib/index.js` +约 350–450 行（id 化约 80、cutRecord 约 120、抑制运行时约 150）；`lib/client.js` +约 150 行；新增 4 个测试文件加 1 个回放脚本。加上原文后单文件增量约 800–900 行，【建议】P3b 前评估把学习层拆为独立模块文件，避免与检测器代码交织。

## 14. 风险与对策

| # | 风险 | 对策（可观测） | 残留 |
|---|---|---|---|
| R10 | id 化触碰全部检测器引入行为漂移 | P1b 独立合入；验收三命令（§11.2）全过，差异条数客观为 0 | 低 |
| R11 | 错误抑制放行真打转 | repeat 永不抑制（矩阵硬禁）；默认影子期；转正人工看三列计数；`enableSuppressions` 一键全停 | 低 |
| R12 | negative-literal 过宽成全局豁免 | ±窗口作用域 + 48 字限长 + 条数上限 + 采纳前语料自检（展示频次） | 低 |
| R13 | 启发式后验信号误判被当成定论 | 信号只排序不判罚；仅人工标记入确定列；转正无自动化；阈值【暂定】带修订触发（§6.2） | 中 |
| R14 | 抑制波及其他插件的 cut | upstream cut 第 1 步原样返回；`test-cut-record.mjs` 锁定无本插件记录 | 无 |
| R15 | id 复用语义错位 | 注销名单入快照测试；复用已注销 id 时测试失败 | 无 |
| R16 | 探针假设不成立（turn/step、interrupted 不可得） | 字段降级为 null/"unknown"（§6.1 已给默认值）；探针 5 不通过则 `interruptedAfterCut` 整键取消而非猜测 | 低 |

## 15. 明确不覆盖的范围

以下两项【不随本工程实施】，需另立专题，混入会扩大 P1b 风险面或偏离打断主题：

1. 相似度重复检测：字节级周期检测对"每次微调几个字再重复"的已知盲区，属 repeat 检测器内部算法替换；
2. `splitSentences` 锚点文本截断加固：编号点、代码标识符点、省略号三类切句事故（2026-09-30 三次修复）属结论提取器缺陷，正确解法是切句器加固加回归用例，与模式学习无关。

---

## 附录 A：症状/报错 → 章节 反向索引

| 症状或报错串 | 去哪里 |
|---|---|
| 抑制规则加载后不生效 | §8.4 执行顺序；查 mode 是否仍为 shadow（§9） |
| 状态接口出现 suppressionRejections / 规则被标红 | §10.1 矩阵冲突或保护组（§4.3）；targetId 不存在/非白名单键（§7.2、§8.3） |
| `{ok:false, error:"unknown action"}` | §10.3 action 全量枚举 |
| mark-cut 返回 400 | §10.3，body 缺 cutId 或 label 非两个合法值 |
| 打断记录 turn/step 为 null、sessionId 为 "unknown" | §6.1 与探针 4（§12），字段降级而非故障 |
| postCut 一直为 null 或显示 unknown | §6.2，超过 `postCutCloseRounds` 冻结 |
| gate 类抑制影子期显示 20 次门槛 | §9 与 §10.2（加倍 = 2×learnedSuppressionShadowRounds） |
| 回放出现 cut 决策差异 | §4.4 P1b 未达标，差异必须为 0 才能合入 |
| L2 返回的候选整条消失 | §3.3/§7.2，suppressionKind 非法或必填字段缺失，拒绝不猜测 |
| 关闭功能后仍担心行为变化 | §8.4，`enableSuppressions=false` 或删除 patterns.json 即完全回滚 |

## 附录 B：交付前自查清单

实施方完成各阶段后逐条作答（是/否/不适用）；任一"否"按锚点章节修正后再交付。

- [ ] B1. 每条出厂正则是否都为 `{id,pattern}`，id 全局唯一且符合 `<族>.<语义>` 命名？〔§4.1、§4.2〕
- [ ] B2. 已删除模式的 id 是否进入注销名单，且无新模式复用？〔§4.2〕
- [ ] B3. 是否不存在任何以 `system.cascade-*`、`system.pseudo-closer-*` 为目标的抑制？〔§4.3〕
- [ ] B4. upstream 的 cut 是否原样返回、无本插件抑制与记录？〔§5.2〕
- [ ] B5. repeat 路径是否无任何抑制入口（占位 id 仅用于记录）？〔§5.2、§10.1〕
- [ ] B6. cut 记录四态（无记录/cut/shadow-suppressed/suppressed）是否与代码行为一致，必填键无缺失？〔§6.1〕
- [ ] B7. 后验回填是否在超回合窗口时冻结 unknown，且启发式信号未参与任何自动判罚？〔§6.2〕
- [ ] B8. L2 的 false-positive 是否只使用三个合法 suppressionKind，且非法值整条拒绝？〔§3.3、§7.2〕
- [ ] B9. 否定字面量是否经 48 字安全编译、只在 ±scopeChars 窗口生效、仅 churn/transition 可用？〔§8.3、§10.1〕
- [ ] B10. param-tighten 是否只接受白名单键且只允许收紧方向，取值受 schema min/max 夹紧？〔§8.3〕
- [ ] B11. 多 id 共同触发是否在全部被禁用时才压制？〔§8.3〕
- [ ] B12. 影子规则是否只计数不改变打断，转正是否只能人工触发，gate.* 门槛是否加倍？〔§9〕
- [ ] B13. 矩阵中标【禁止】的组合与非白名单 action/键是否全部硬拒绝并有可观测报错？〔§10.1、§10.3〕
- [ ] B14. 新增设置项是否在 DEFAULT_SETTINGS、SETTINGS_SCHEMA、applyRuntimeSettings 三处同步，默认值与 §10.2 一致？〔§10.2〕
- [ ] B15. P1b 三条验收命令是否全部退出码 0、回放差异条数为 0，且现有测试零修改？〔§11.2、§4.4〕
- [ ] B16. 未执行的验证是否用「未做动态验证：<原因>」固定标签留痕？〔§11.2〕
- [ ] B17. 探针 4–6 未证实的字段/事件是否未被当作实现前提，降级路径是否已落实？〔§12、§14 R16〕
- [ ] B18. 界面验证是否走真实打开页面（无模拟点击），combo 与独立实例闭环通过？〔§11.2〕
- [ ] B19. 兜底核对：逐条比对本文所有【必须】/【禁止】条款，任一条未被 B1–B18 覆盖即补查。〔全文〕
