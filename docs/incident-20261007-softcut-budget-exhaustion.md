# 事故复盘：软切配额耗尽导致 78,586 字符复读无拦截（2026-10-07）

> 证据来源：一次真实会话明文日志（2026-10-07）、dsh-cot-anchor@0.1.5 源码、内核 `@deepseek-ai/dsh-agent-loop` 的 soft-cut 移植段。分析期使用的本地脚本（软切统计、反事实回放等）不随仓库发布。

## 结论（直接根因）

**该 turn 在复读开始前已恰好耗尽内核的每 turn 6 次软切硬配额；复读发生时内核每 32 字符的累积检查仍在执行，但在调用插件钩子（waterfall）之前就被配额判断短路，字节级复读检测器根本没有被询问的机会。**

内核 `@deepseek-ai/dsh-agent-loop/lib/index.js`（soft-cut 移植段，行号为 0.2.0-rc.2 移植版本参考）：

```js
if ((this.phase.softCuts ?? 0) >= MAX_SOFT_CUTS_PER_TURN) continue;  // 上限 = 6（第23行）
```

日志实测：复读步（step 22）之前，soft-cut 触发 **正好 6 次，全部是 churn（空转）警告**（分别中止 step10/11/13/14/17/20 的独立流，日志行 1728/1734/1748/1754/1773/1795，计数 18→18→20→19→18→18）。step 22 流中内核仍每 32 字符累积一次检查（1100–1104 行照常执行），但 `softCuts=6 ≥ 6` 在 1105 行永久 continue，1108 行的 `waterfall("agent/soft-cut")` 一次都不再发出。复读于是无拦截持续 334 秒、78,586 字符（同一句字符串出现 1,653 次；复读检测器口径 count=1,619，差额 34 为退化稳定前的非周期出现），直到用户手动 abort。

## 完整故障链

1. **任务模糊性空转**（step9–20）：模型对一个宽泛的"整理目录"任务反复重新分析，每个无工具步产出 1,800–3,200 字犹豫 reasoning。churn 检测器（尾部 3000 字内 ≥18 个重启词）在 step10/11/13/14/17/20 共 6 个 step 触发软切。
2. **churn 锚点只能临时打断、不能打破循环**：6 次软切的直接后继步为 step11/12/14/15/18/21，其中 4 次（后继 step12/15/18/21）下一步立即发出工具调用，另 2 次（后继 step11/14）继续纯 reasoning 空转并再次触发 churn。即使被临时驱动去行动，模型行动后又回到空转——anchor 是无状态文字劝告，不消除根因（模型不知道目录内容、任务目标宽泛）。6 次命中计数（18/18/20/19/18）始终不降。
3. **配额耗尽**：第 6 次 churn 软切（行1795，中止 step20）把 `phase.softCuts` 推到 6。
4. **关键行动失败且无兜底**：step21 模型被 anchor 驱动调用 shell 工具列目录，但漏填必填的 `description` 参数，工具层直接返回 `ToolArgsError: INVALID_ARGS`，命令未执行。`tools/post-execute` 钩子在参数校验失败时**确认会触发**（本 turn step12/18/19 三次 INVALID_ARGS 后均有 "cot-anchor: N points" 注入为证）；step21 独无注入的唯一原因是该步 reasoning 仅 47 字，extractConclusions 提取为空，插件在 `if (!body) return downstream` 处静默跳过。行1803→1804 之间无**插入型** spliced（行1797 有一条 removedCount:1/inserted:[] 的消费移除事件，是第 6 次 churn anchor 被 step21 正常出队，非新注入）。
5. **恶性复读裸奔**：step22 模型面对工具错误再次陷入思考并坍缩为纯复读。本应必中的 `findRepeatingTail` 挂在 soft-cut 钩子上，而钩子已因配额耗尽不再被调用。反事实验证（抽取插件真实检测器代码、对真实 reasoning 按 32 字符节奏回放）：复读周期 **35 字符**（phrase 字面 33 字符 + `\n\n` 分隔），落短周期档（12–95，阈值 5 次）；首次命中在累计 19,360 字符处（count=5，复读始于 14,791 字符），全量 {period:35, count:1619, trimTo:21956}。即钩子若在，复读在退化约 4,600 字符处即被截停，可减少约 75.3% 的裸奔输出（(78,586−19,360)/78,586），而非实际的约 64k 字符纯复读。
6. 用户 abort 收场（turn/end reason=aborted/user，块尾切断在半句 `OK, I`）。

## 设计层面的四个缺陷

### 缺陷 1（主因）：软切配额不区分触发类型与严重度

churn 是**启发式**检测（换词重分析，有误报余量、注释自述"only heuristic trigger"），repeat / numberRunaway 是字节级确证（近乎零误报，注释原话 "garbage regardless"），pseudoTool 介于两者之间（合法文本中的工具格式示例存在误报面）。四类触发共享同一个 6 次配额。结果：6 次轻度 churn 把额度全部用完，最该死的字节级复读发生时熔断已归零。
**修复方向**：分类独立预算——heuristic（churn/transition）维持 6 次；confirmed-repeat（repeat/numberRunaway）给独立高额度（20 次/turn）；pseudoTool 误报可形成"cut→新 step→再误报"的自我 DoS（turn 永不可完成），给独立低额度（3 次/turn），超限不再软切而升级为硬 abort 并向用户告警。所有配额必须有界，禁止无限额。

### 缺陷 2：配额按 turn 计数，与 step 粒度失配

一个 turn 可有几十个 step（本 turn ≥22 步）。6 次/turn 在长 turn 中等于前几个 step 之后全程不设防；而长 turn 恰恰是模型最容易退化的场景。
**修复方向**：对字节级复读改用按累计可见字符数的硬上限（与 step 数量无关，口径单一）。若采用"连续 N 个 step"滑动窗口，必须写明两点语义：①soft-cut 本身新开 step，退化时 step 数快速增长，窗口按 step 计数会持续刷新额度——必须规定滑出窗口的 cut 才恢复额度，且窗口长度按时间或字符数而非 step 数；②误报情形下窗口刷新导致的可观测后果（turn 被反复软切、用户可见大量 anchor）须有告警。本次修复以分类独立预算（缺陷 1）为主，滑动窗口列为后续评估项。

### 缺陷 3：churn 重复触发无升级机制

同一 turn 内 churn 命中 6 次、计数不下降，系统每次只重复同一段文字劝告，没有升级动作（如：强制下一步必须是工具调用、注入"上次工具调用失败原因+正确参数格式"、或直接向用户告警）。第 6 次与第 1 次的处置完全相同，额度却被耗尽。
**修复方向**：第 2 次 churn 起升级为结构化干预；工具 INVALID_ARGS 后的续步注入参数纠错锚点。

### 缺陷 4：工具失败续步是注入盲区

`tools/post-execute` 是工具执行后的注入点；日志证实该钩子在 ToolArgsError 时**确认触发**（本 turn step12/18/19 三次错误后均有 "cot-anchor: N points" 注入为证），但短 reasoning（step21 仅 47 字）提取 body 为空时在 `if (!body) return downstream` 静默跳过。模型恰恰是在"工具失败 + 无指引"的下一步（step22）坍缩的。
**修复方向**：在 post-execute 最前面增加错误分支：ToolArgsError 时强制注入"上一次调用失败：缺 X 参数，按此格式重发"的恢复锚点，该分支位于 body 空判断之前、不依赖 reasoning 长度。

## 检测器本身的次要盲区（非本次主因）

即便配额未耗尽，纯复读句 `OK, I think I'm ready to proceed.` 不含 churn 词典中的任何词（let me / hmm / reconsider / I need to / 让我…），churn 检测在纯复读阶段命中 0；能抓住它的只有 repeat 检测器。这印证了缺陷 1 的后果被进一步放大——唯一能识别纯复读的检测器与失效的钩子绑定在同一条配额链路上。

## 关键证据索引

| 证据 | 位置 |
| --- | --- |
| 6 次软切恰好耗尽配额（中止 step10/11/13/14/17/20） | 会话日志行1728/1734/1748/1754/1773/1795 |
| 内核配额定义与跳过逻辑（softCuts 仅 878/1105/1123 三处读写） | dsh-agent-loop/lib/index.js 第23、878、1105、1123行 |
| 软切检查间隔 32 字符（text/reasoning-delta 均计入） | 同文件第19、1100行 |
| 复读步无插入型 spliced、334.345 秒（行1797 为消费移除事件） | 会话日志行1797、1803–1806 时间戳 |
| 工具失败真因（缺 description） | 会话日志行1801/1802 ToolArgsError INVALID_ARGS |
| post-execute 在 INVALID_ARGS 时确认触发（step12/18/19 三次反证） | 会话日志行1741/1742、1780/1781、1788/1789 |
| churn 词典不含复读句 | dsh-cot-anchor/lib/index.js 第1126–1134行 |
| repeat 阈值与反事实回放（周期 35=phrase33+\n\n；首次命中 19,360 字 count=5；全量 count=1619 trimTo=21956） | dsh-cot-anchor/lib/index.js 第780–887行 |
| post-execute 短文本 body 空静默跳过 | dsh-cot-anchor/lib/index.js 第3394–3396行 |
