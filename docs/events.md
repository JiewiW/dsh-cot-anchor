# cot-anchor 事件登记

本插件通过 `ctx.emit(eventName, payload)` 向宿主事件总线发出的全部自造事件。事件名一律带 `cot-anchor/` 前缀；载荷统一携带四元组溯源字段 `sessionId` / `turn` / `step` / `evidenceSeq`（上下文不可得时对应字段为 `null`，但字段始终存在）。`evidenceSeq` 由模块级单调递增计数器生成（`lib/index.js` 中 `nextEvidenceSeq()`），同一次提取调用内产生的多个事件共享同一 `evidenceBase`（同一 `evidenceSeq`），便于把「同源多事件」归组。

| 事件名 | 语义 | 发射点 | 门控设置 |
| --- | --- | --- | --- |
| `cot-anchor/point-truncated` | 超长结论点触发「宁可不切」保护：整条保留原文并发事件记录本应截断的事实 | ① `extractConclusions`（启发式提取切片点）② `parseRefinedPoints`（LLM 提炼解析切片点） | 无独立开关；`maxPointChars` 决定阈值 |
| `cot-anchor/reflow-misjudged` | 回流误判：门禁判定有结论可回流，但实际提取为空 / 渲染为空，注入流程放弃 | ① soft-cut transition 分支 ② `agent/pre-step` 分支 ③ tools/post-execute 分支 | 跟随各注入路径开关（`enableSoftCut` / `enableToolInject`） |
| `cot-anchor/length-conservation-failed` | 长度守恒校验失败：回流/注入内容长度不守恒，放弃本次注入 | 同上三条注入路径 | `enableLengthConservationCheck`（默认 true） |
| `cot-anchor/structure-unbalanced` | 括号/代码围栏结构配平校验失败：配平不齐则不注入 | 同上三条注入路径 | 无独立开关（结构安全硬校验） |

## 载荷明细

公共字段（所有事件都带）：

```jsonc
{
  "sessionId": "… | null",
  "turn": 0 | null,
  "step": 0 | null,
  "evidenceSeq": 1   // 单调递增；同一次提取调用的多事件共享同一值
}
```

### cot-anchor/point-truncated

```jsonc
{
  "sessionId": "…", "turn": 0, "step": 0, "evidenceSeq": 1,
  "suppressReason": "over-max-point-chars", // 触发原因（钉死）
  "maxPointChars": 220,                     // 当时的阈值（settings.maxPointChars）
  "originalChars": 351,                     // 原文长度
  "keptWhole": true,                        // 「宁可不切」口径：恒为 true，整条保留
  "preview": "所以根因是…"                  // 原文前 80 字
}
```

无 `evidence` 上下文（如单测直接调提取函数）时不发事件，静默走「宁可不切」路径。

### cot-anchor/reflow-misjudged

```jsonc
{
  "sessionId": "…", "turn": 0, "step": 0, "evidenceSeq": 2,
  "reason": "empty-extraction" // "empty-extraction" 提取为空 | "anchor-render-empty" 渲染为空
}
```

### cot-anchor/length-conservation-failed

```jsonc
{
  "sessionId": "…", "turn": 0, "step": 0, "evidenceSeq": 3,
  "reason": "length-conservation", // 钉死
  "expected": 1024,                // 校验期望值（输入字节数）
  "actual": 983                    // 实际值
}
```

### cot-anchor/structure-unbalanced

```jsonc
{
  "sessionId": "…", "turn": 0, "step": 0, "evidenceSeq": 4,
  "reason": "structure-unbalanced", // 钉死
  "detail": "unbalanced fence / unbalanced bracket" // 围栏奇偶或括号配平失败
}
```

## 语义口径

- **宁可不切**：超长点不静默硬切，整条保留原文并发 `point-truncated` 事件（`keptWhole: true`）。事件是「本应截断但保留」的事实记录，不是截断通知。
- **守卫失败即放弃**：`length-conservation-failed` / `structure-unbalanced` 触发时本次注入直接放弃（不发锚点），保证坏内容不出现在对话流。
- **误判即放弃**：`reflow-misjudged` 表示门禁预测会回流但实际无内容，锚点构建流程终止，不发空锚点。

## 相关设置

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `maxPointChars` | 220 | 单点长度阈值；超过触发 point-truncated 保护 |
| `enableLengthConservationCheck` | true | 长度守恒校验开关 |
| `transitionTextMode` | `"separateThreshold"` | 枚举 `disable \| separateThreshold`；内核 text/reasoning 分流由内核侧（子卡 C）提供，控件标记「待内核支持」，插件侧仅登记不伪造生效 |
