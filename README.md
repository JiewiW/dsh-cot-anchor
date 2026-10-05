# dsh-cot-anchor

> 思考锚点（COT Anchor）—— 在模型切换到下一步之前，把它**刚刚已经得出的结论**重新递回上下文，减少重复推导。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。

---

## 它解决什么问题

长任务的 agent 在多轮工具调用里会反复"重新推导同一件事"：读完文件、分析完结构、得出结论，进入下一步后又把同样的分析再做一遍。原因是每一步的工具结果会挤占注意力，而**上一轮自己写下的结论没有被强调过**。

这个插件在每次工具执行后，从最近一段思考里摘出已经成立的结论，压缩成几条短句插回上下文。模型于是不必重新推一遍，直接进入下一步。

它同时看守另一类问题：模型把工具调用写成普通文本、原地重复同一段话、语义空转、或输出无意义的递增数字流——这些都会让一次回合白烧 token 却毫无进展。插件能在生成过程中发现并打断它们。

## 快速开始

```sh
# 安装到你的 profile
dsh plugin --profile <你的profile> add dsh-cot-anchor

# 验证这一层已加载（应能看到 dsh-cot-anchor 层）
dsh --profile <你的profile> --dump-config
```

也可从 GitHub 源码安装：

```sh
dsh plugin --profile <你的profile> add github:<owner>/dsh-cot-anchor
```

安装后重启实例。设置页出现「COT 锚点」标签即已生效。

## 工作方式

```
模型思考  →  工具执行  →  [插件] 摘出结论、插回上下文  →  下一步思考
                              ↑
                        只在工具边界注入
```

注入的消息体积很小（默认最多 3 条、每条不超过 220 字），以 `user` 角色追加在工具结果之后、下一次请求之前。

在设置页开启相应开关后，插件还会在**生成过程中**按间隔询问内核是否需要中断当前生成（"软切断"）：检测到问题就切断当前请求、把已生成部分作为正常消息落盘、插入锚点，然后从断点继续。模型不会因为一次误判而丢失整轮工作。

## 成本

| 场景 | 额外成本 |
| --- | --- |
| 默认（结论注入开启，其余关闭） | 每个工具结果后一条短消息，上界 660 字符（3 条 × 220 字）；无额外模型调用 |
| 开启 LLM 提炼结论 | 每个助手回合**多一次**小模型调用 |
| 开启打转判定 | 纯本地字符串计算，无 token 成本；可能增加少量回合数 |
| 开启 CoT 静默采集 | 每个助手回合留一条本地样本；默认关闭 |

注入消息会随之后续请求的上下文一同发送，因此持续占用少量上下文窗口。按中英混排估算，660 字符约合 200–500 token 量级——相对于一次工具往返的上下文可以忽略，但它在**每一步**都会累积。

## 兼容性

| 能力 | DSH 版本 |
| --- | --- |
| 结论注入、设置页 | 0.1.5 起全部版本 |
| 生成中途打断（软切断） | **仅 0.1.5-rc.1 / 0.1.5-rc.2** |

0.1.5-rc.3 起内核不再提供生成中途打断所需的钩子，该能力会静默失效。插件会在启动日志和设置页顶部明确提示当前内核是否具备该能力——**请以设置页显示为准**，不要凭"开关是开的"就认为功能在生效。

如果你希望在新版上保留这项能力，可用随包附带的工具把软切机构移植回内核：

```sh
node node_modules/dsh-cot-anchor/tools/apply-softcut-port.mjs --check   # 看状态
node node_modules/dsh-cot-anchor/tools/apply-softcut-port.mjs           # 应用（幂等）
```

移植后需重启实例。完整步骤、原理、风险与回滚见 [docs/softcut-kernel-port.md](docs/softcut-kernel-port.md)。

本插件不会中止进行中的回合；它只在模型自己写坏输出时切断**当前这一次生成请求**，随后继续。

## 设置项

设置页「COT 锚点」共 52 项，按用途分组。下列"建议值"是针对多数场景的推荐；不同模型差异较大，可据实调整。

### 总开关

| 键 | 含义 | 建议 |
| --- | --- | --- |
| `enableToolInject` | 工具结果后注入锚点 | **保持开启**，这是本插件的主要价值 |
| `enableSoftCut` | 允许生成中途打断 | 内核不支持时无效；支持的版本建议开启 |

### 打断判定

这五项决定"什么情况算问题"。全部关闭时插件只做结论注入。

| 键 | 含义 | 能力边界 | 建议 |
| --- | --- | --- | --- |
| `enablePseudoTool` | 识别把工具调用写成文本的输出 | 只能识别已知的文本形态，无法穷举 | 开启 |
| `enableRepeat` | 识别同一段内容被反复吐出 | 要求**逐字节相同**；换一种措辞的重复抓不到 | 开启 |
| `enableChurn` | 识别措辞不同但反复"重新分析" | 启发式判定；遇到未闭合的代码块会自动让路 | 开启 |
| `enableTransition` | 识别"接下来我要……"这类转折句 | 转折句不等于打转，正常思考里也会出现 | 见下方说明 |
| `enableNumberRunaway` | 识别无意义的递增数字流 | 要求数字流足够长 | 开启 |

> `enableTransition` 是五项中最容易误判的一项：正常的分阶段思考同样会出现转折句。误判代价较低（只会多一次切断，模型从断点继续），但如果你经常看到它在正常思考中切断，可将其关闭。

### 锚点内容

| 键 | 含义 | 建议 |
| --- | --- | --- |
| `minReasoningChars` | 思考短于此长度不提取结论 | 250 |
| `maxPoints` | 最多保留几条结论 | 3 |
| `maxPointChars` | 单条结论字数上限 | 220 |

### 重复循环参数

判定"同一段内容被反复吐出"的阈值。调低更激进，调高更保守。

| 键 | 含义 | 建议 |
| --- | --- | --- |
| `repeatMinCount` | 长块重复几次判定打转 | 2 |
| `repeatMinCountShort` | 短周期需重复几次 | 5 |
| `repeatUltraShortMinCount` | 极小循环（如 `er4er4…`）需重复几次 | 30 |
| `repeatMinPeriod` | 周期下限（字） | 12 |
| `repeatShortPeriod` | 长块与短块的分界（字） | 96 |
| `repeatMaxPeriod` | 超过此周期不再视为循环 | 8000 |
| `repeatWindowChars` | 只在文本尾部这段长度内做预筛 | 16000 |
| `repeatProbeChars` | 周期探针长度 | 128 |
| `repeatMinTextChars` | 文本短于此长度不判定 | 800 |

### 语义空转参数

| 键 | 含义 | 建议 |
| --- | --- | --- |
| `churnMinHits` | 窗口内"让我想想/重新分析"类用语命中几次即判定 | 18 |
| `churnWindowChars` | 空转统计窗口 | 3000 |
| `churnMinTextChars` | 文本短于此长度不判定 | 800 |

### 转折句参数

| 键 | 含义 | 建议 |
| --- | --- | --- |
| `softCutScanTail` | 转折句扫描窗口 | 160 |
| `softCutTransitionWindow` | 转折词距句末的最大距离 | 48 |
| `softCutMinFollowChars` | 转折词后至少展开多少字才允许切断 | 6 |
| `pseudoToolScanTail` | 伪调用扫描窗口 | 4000 |

> `softCutMinFollowChars` 是防误切的关键：它保证不会在句子刚开头就切断、截出半句结论。调低会明显增加误切。

### LLM 提炼

用一次小模型调用把整段思考压成摘要式结论，通常比摘句更准。**默认关闭**。

| 键 | 含义 | 建议 |
| --- | --- | --- |
| `enableLlmRefine` | 启用 LLM 提炼 | 按需 |
| `llmRefineProvider` | 提炼用 provider | 留空则跟随会话 |
| `llmRefineModel` | 提炼用 model | 留空则跟随会话 |
| `llmRefineMaxTokens` | 提炼输出上限 | 256 |
| `llmRefineTimeoutMs` | 提炼超时（毫秒） | 20000 |
| `llmRefineMaxInputChars` | 提炼输入截断字数 | 12000 |

### CoT 采集 / CoT 分析 / CoT 增补

这三组用于归纳"现有检测器看不见的打转形态"。**默认全部关闭**；开启会在本地留存你的思考文本，请自行评估隐私影响。

| 键 | 含义 | 建议 |
| --- | --- | --- |
| `enableHarvest` | 启用静默采集 | 关闭；开启前先读隐私说明 |
| `harvestIncludeToolTrace` | 记录工具调用轨迹 | 跟随 `enableHarvest` |
| `harvestMaxRecords` | 样本条数上限 | 200 |
| `harvestRetentionDays` | 样本保留天数 | 14 |
| `harvestMinTextChars` | 存全文的最小思考字数 | 3000 |
| `harvestMaxTextChars` | 单条全文上限 | 8000 |
| `harvestFlushDebounceMs` | 落盘去抖（毫秒） | 5000 |
| `enableAutoAnalyze` | 达到阈值自动分析 | 关闭 |
| `analyzeTriggerSamples` | 自动分析触发条数 | 50 |
| `analyzeProvider` / `analyzeModel` | 分析用模型 | 留空则跟随样本 |
| `analyzeMaxTokens` | 分析输出上限 | 4000 |
| `analyzeTimeoutMs` | 分析超时（毫秒） | 180000 |
| `analyzeMaxInputChars` | 分析输入截断字数 | 8000 |
| `analyzeMaxSamples` | 单批样本数 | 3 |
| `analyzeRunBudgetMs` | 单次分析总时长上限（毫秒） | 300000 |
| `enableLearnedPatterns` | 加载已采纳的学习模式 | 保持默认 |
| `learnedMaxPhrases` | 学习模式条数上限 | 60 |
| `learnedMaxShift` | 学习层对出厂阈值的最大调整幅度 | 20 |
| `learnedShadowRounds` | 影子期命中次数（0=直接生效） | 20 |

> `learnedShadowRounds` 默认为 20，含义是学习出的模式不会立刻生效，需累计命中 20 次才转正——这是防止一次误学就永久改变判定。如果你希望它立即生效，可设为 0；这会提高误判风险。

## 隐私

- 结论注入与打转判定**全部在本地完成**，不发送任何数据到外部服务。
- LLM 提炼开启时，会把当前思考文本发给你指定的 provider（留空则发给你正在用的模型对应的服务）。
- CoT 采集开启时，会在本地留存思考文本与工具调用轨迹。

## 常见问题

**设置页显示"当前内核没有掐断能力"**
该版本的 DSH 内核不提供生成中途打断所需的钩子。结论注入不受影响。若需要该能力，可停留在 0.1.5-rc.1 / rc.2。

**模型好像没被提醒到**
确认 `enableToolInject` 已开启，且思考长度超过 `minReasoningChars`。思考过短时本来就不会提取结论。

**打断太频繁**
优先关闭 `enableTransition`；其次调高各判定阈值。`enableChurn` 是启发式判定，最容易偏激进。

## 开发

```sh
node test-repeat.mjs          # 重复循环检测
node test-number-runaway.mjs  # 数字流退化检测
node test-softcut.mjs         # 软切判定
```

测试以 `lib/index.js` 为源，剥离 import/export 后用 `new Function` 求值被测函数，因此新增测试无需改动模块结构。

## 许可

MIT
