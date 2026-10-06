# dsh-cot-anchor 发行说明

## v0.1.5 — 结论抽取过滤空话语句 + 能力边界文档

### 修复（结论抽取质量）

- 结论抽取器此前会把**无事实命题的话语标记句**当成"已确立结论"回灌：模型空转时的 "Actually, wait."、"Hmm."、"其实，等等。" 等纯标记句，以及 "the decisive route: ask the user…" 这类下一步路线宣告，可能出现在注入锚点里，反而强化打转。
- v0.1.5 在结论入池前新增两道过滤，均只作用于**抽取器选句**，不改动、不删除模型的思考文本：
  - **纯话语标记句**：剥掉 Actually / wait / Hmm / hold on / 让我重新 等标记后，剩余字母数字不足 6 个字符的句子不入选；
  - **路线意图宣告句**：`decisive route/move/step`、`route: ask/use/check/…` 等动作宣告不入选。
- 标记词**领起但带事实命题**的句子不受影响（如 "Wait, the kernel never marks in verbose mode." 仍正常入选）——Wait / Actually / Hmm 在推理链中承担结构控制作用，本版本不压制它们本身。
- 无新增设置项；过滤为固定行为，默认开启。

### 文档

- README 新增「能力边界：它治不了什么（含实测反例）」：明确两类机制均为单步边界内机制，不治跨步骤折返跑；附"插件全程在场、软切实际触发 4 次仍未约束住"的实测数据（N=1，含会话日志自复算口径）。
- README「锚点内容」更新为 v0.1.5 的过滤行为说明。
- docs/softcut-kernel-port.md 补「移植后的一次实测确认」：0.2.0 系列已移植内核上软切链路真实工作的取证特征（含按消息 id 去重的计数口径）。
- lib/index.js 头注释澄清："上游已移除 soft-cut"仅适用未打补丁的官方内核，移植后以 probe 结果为准。

### 验证

`node --check lib/index.js` 通过；仓库全部 22 个测试文件通过，其中 test-extract.mjs 新增 5 条用例（纯英文标记句、纯中文标记句、路线意图宣告各 1 条负例，标记词+事实命题、Wait 领起自我修正各 1 条正例）。无设置项、对外接口变化，0.1.0–0.1.4 可直接升级。

### 安装

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-cot-anchor#v0.1.5
# 或
gh release download v0.1.5 --repo JiewiW/dsh-cot-anchor
dsh plugin --profile <你的profile> add ./dsh-cot-anchor-0.1.5.tgz
```

## v0.1.4 — 命令执行纪律注入文案对齐

**更新**（仅注入文本，无设置项、接口或注入时机变化）：
- ②「增长型标量」补第 5 项：已下载量是否增加。
- ③ 僵死终止补充禁令：必须用精确 PID 中断，禁止按命令名通配批量杀，避免误伤并行进程。

**验证**：`node --check lib/index.js` 通过；仓库全部 22 个测试文件通过。0.1.0–0.1.3 可直接升级。

**安装**：

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-cot-anchor#v0.1.4
# 或
gh release download v0.1.4 --repo JiewiW/dsh-cot-anchor
dsh plugin --profile <你的profile> add ./dsh-cot-anchor-0.1.4.tgz
```

## 更正 — v0.1.1「纪律常量前置命中前缀缓存」论断撤回

v0.1.1 声称把纪律常量排到注入数组最前可命中 KV 前缀缓存。经核对宿主注入链路，该论断不成立：插件注入全程以 `surfaceOp: "append"` 在会话日志尾部追加 `user/message`，不改写已有节点；前缀缓存按 token 位置匹配，固定文本出现在新位置时无法复用旧位置的 KV。顺序 `[纪律, 锚点]` 与 `[锚点, 纪律]` 在缓存行为上等价，v0.1.1 的顺序调整不产生缓存收益。

保留该顺序仅为注入内容排列的一致性，与成本无关。真正控制成本的是纪律块与锚点共用的推理指纹去重闸门：注入频率等于指纹变化频率，两者 1:1 成对出现。v0.1.1 表格中的体积占比数据不受影响，但其中「具备缓存命中条件」的结论作废；README 成本表的未命中占比口径已更正为约 5.6%（21,436 / 379,969，每个注入块在其首现请求上未命中一次）。

## v0.1.3 — 更正缓存论断与成本口径

**文档更正**：
- README 成本章节撤回"常量前置命中前缀缓存"的因果表述，改为说明尾部追加注入不打穿前缀缓存、每个注入块首现未命中一次的真实机制；纪律与锚点的顺序仅为排列一致性。
- 成本表未命中占比口径更正：注入块首现带来的未命中输入为全部注入量 21,436 token，占会话未命中输入约 5.6%（原 1.12% 只计了动态锚点，口径错误）；删除低估的"占缓存读取 0.20%"行。
- 代码注释同步更正，不再声称顺序影响缓存。

**验证**：`node --check lib/index.js` 通过；仓库全部 22 个测试文件通过。无设置项、对外接口与注入行为变化，0.1.0–0.1.2 可直接升级。

**安装**：

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-cot-anchor#v0.1.3
# 或
gh release download v0.1.3 --repo JiewiW/dsh-cot-anchor
dsh plugin --profile <你的profile> add ./dsh-cot-anchor-0.1.3.tgz
```

## v0.1.2 — 成本实测补充与注入文本优化

**更新**：
- 命令执行纪律的注入文本改为通用行为表述（长任务按固定短间隔轮询等待），不再引用特定脚本路径。
- README「成本」章节新增「实测成本占比」小节——95 次助手请求、约 924 万 token 的真实长会话上，注入新增估算 21,436 token（占全会话约 0.23%），其中固定纪律文本 80.2%、动态锚点 19.8%；附基于会话日志 `source.summary` 与 `usage` 字段的自复算口径。
- 测试样例文本与代码注释做了通用化整理，测试句式与断言语义不变。

**验证**：`node --check lib/index.js` 通过；仓库全部 22 个测试文件通过。无设置项、对外接口变化，0.1.0/0.1.1 可直接升级。

**安装**：

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-cot-anchor#v0.1.2
# 或
gh release download v0.1.2 --repo JiewiW/dsh-cot-anchor
dsh plugin --profile <你的profile> add ./dsh-cot-anchor-0.1.2.tgz
```

## v0.1.1 — 纪律常量前置，命中 KV 前缀缓存

**变化**：工具结果后的注入顺序由 `[锚点, 纪律]` 调整为 `[纪律, 锚点]`（`tools/post-execute` 的两条返回路径同步修改，插件其余注入点均为单上下文，不涉及顺序）。无设置项、对外接口与默认行为变化，0.1.0 可直接升级。

**原因**：纪律文本与推理锚点共用同一推理指纹去重闸门，两者恒为 1:1 成对注入；顺序调整仅为排列一致性，不改变缓存行为（该论断已于后续版本更正，见上方「更正」小节）。

**实测佐证**（字符估算口径，非 tokenizer 实测；任何人可在自己的 DSH 会话日志上按同口径复算：逐条统计 `user/message` 中 `source.summary` 为 `cot-anchor: exec-discipline`（常量）与其他 `cot-anchor:*`（变量）的注入文本，并对照各次助手请求 `usage` 中的 `inputTokens` / `cacheReadTokens`）：

| 观测项 | 数值 |
| --- | --- |
| 样本规模 | 95 次助手请求、累计约 924 万 token 的单个长会话 |
| 常量纪律注入 / 变量锚点注入 | 45 条 / 51 条 |
| 单条纪律文本 | 全文固定，523 码点，约 380 token |
| 全部注入新增估算 | 约 2.14 万 token，占全会话总 token 约 0.23% |
| 其中常量纪律占注入估算比 | 约 80.2%（仅表示体积占比，不表示缓存命中；缓存论断已撤回） |
| 会话缓存读取占输入比 | 95% 以上 |

**同步补文档**：命令执行纪律提醒自 v0.1.0 起已在包内（随推理锚点同车注入、沿用同一指纹去重节奏，不单独排队、不无限堆叠），但 v0.1.0 的 README 成本章节漏写，v0.1.1 已补齐。

**安装**：

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-cot-anchor#v0.1.1
# 或
gh release download v0.1.1 --repo JiewiW/dsh-cot-anchor
dsh plugin --profile <你的profile> add ./dsh-cot-anchor-0.1.1.tgz
```

## v0.1.0 — 思考锚点首版

**面向问题**：DeepSeek-V4-Flash 等思考链极度冗余的模型，在长任务里反复"重新推导同一件事"。

## 真实数据刻画的症状

来自一次对 DeepSeek-V4-Flash 的会话日志分析：

| 指标 | 数字 | 含义 |
| --- | --- | --- |
| 思考 : 文本输出 | **14 : 1 ~ 24 : 1** | 模型每写一个字给用户，就要消耗 14~24 个字的"思考" |
| 单条带 reasoning 的消息平均宣告"接下来要做 X" | **1.6 ~ 3.6 次** | 但兑现率显著偏低 |
| reasoning 块平均长度 | ~7,000 字 | 极度啰嗦 |
| "宣布决定性证据齐全" | 几乎每轮思考一次 | 然后接着说"接下来要验证 XXX" |

## 用户能在聊天窗口直接看到的失控形态

- **原地重复**：同一段话说几遍，措辞微调但推进为零
- **伪工具调用**：把工具调用写成普通文本（如 `<seed:tool_call>...</seed:tool_call>`）塞进正文
- **递增数字流**：思考里突然输出无意义的递增数字（`639.640) 640.641)…`）
- **自吹决定性证据**：每思考一次就来一次"决定性证据齐全"，然后紧接"接下来要验证 XXX"
- **结论被重新发现**：上一轮写明白的事，下一轮又被当作新信息重新推导

## 本插件做什么

1. **结论回流**：每次工具结果后，从最新一段思考里抽取已成立的结论（最多 3 条、每条 ≤ 220 字），作为用户消息插回上下文。下一步思考起手就能看到这些结论，不必再推一遍。
2. **失控形态打断**：在生成过程中按 32 字符一次的频率检查，一旦发现上述任何一种失控形态，立即切断当前请求、把已生成部分作为正常消息落盘、把锚点排进下一步、让回合续跑。模型不会因为一次误判丢失整轮工作。

## 安装

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-cot-anchor#v0.1.0
```

或下载 tarball：

```sh
gh release download v0.1.0 --repo JiewiW/dsh-cot-anchor
dsh plugin --profile <你的profile> add ./dsh-cot-anchor-0.1.0.tgz
```

## 文档

- `README.md` — 完整说明，52 个设置项逐项解释（含功能、能力边界、成本、建议值）
- `docs/softcut-kernel-port.md` — 在 0.1.5-rc.3+ 内核上恢复生成中途软切的移植工具与指南
- `docs/DISTRIBUTION.md` — 分发方式
- `tools/apply-softcut-port.mjs` — 可分发版内核移植脚本
- `tools/trace-softcut.mjs` — 从会话日志取证软切是否真的发生

## 兼容性

| 能力 | DSH 版本 |
| --- | --- |
| 结论注入、设置页 | 0.1.5 起全部版本 |
| 生成中途打断（软切断） | **仅 0.1.5-rc.1 / 0.1.5-rc.2** |

0.1.5-rc.3 起内核不再提供生成中途打断所需的 `agent/soft-cut` 钩子。结论注入在所有版本都可用。是否启用了软切断，以设置页顶部的能力提示条为准。

## 许可

MIT
