# dsh-cot-anchor

DeepSeek Harness（DSH）插件。识别生成过程中的空转信号——原地重复、伪工具调用、无意义数字流、过长思维链；命中即切断当前生成，把已写出的部分作为正常消息落盘，让回合从断点续跑。判定全部基于本地可机械计算的字符串信号，不调用模型，也不改写会话已有内容。外部插件可请求软切。

## 边界

仅限单流内的思考链冗余与结论反复重新发现。跨步骤的折返跑（同一结论在十几步里重推）不在覆盖范围，由姊妹插件 [dsh-step-governor](https://github.com/JiewiW/dsh-step-governor) 负责。软切不减少回合步数；长任务成本控制请使用 step-governor。

实测中，模型可能自述察觉空转（如「I'm burning turns, let me stop」）却继续生成下一条路线。自知不构成刹车，软切的前提是能机械识别出打转。每回合软切次数设内核侧预算上限，打满后启发式判定不再触发，高置信重复仍照常拦截，避免误判反复掐断正常生成；预算事件可在会话日志中观测。

## 快速开始

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-cot-anchor#v0.4.6
```

重启实例后，设置页出现「COT 锚点」标签即生效。软切依赖内核支持，见[兼容性](#兼容性)。

## 兼容性

0.1.5-rc.3 起内核移除了软切所需的 `agent/soft-cut` 钩子，该能力会静默失效。插件在启动日志和设置页顶部提示当前内核是否支持；以设置页显示为准，开关处于开启状态不代表能力在生效。

新版内核可用随包工具把软切机构移植回去，带版本与哈希自检，幂等、可回滚，不符自动还原：

```sh
node node_modules/dsh-cot-anchor/tools/apply-softcut-port.mjs --check   # 查看状态
node node_modules/dsh-cot-anchor/tools/apply-softcut-port.mjs           # 应用
```

移植后重启实例。完整步骤与风险见 [docs/softcut-kernel-port.md](docs/softcut-kernel-port.md)。

## 设置

设置页「COT 锚点」按用途分组。常调项为软切判定的开关与阈值：伪工具调用、原地重复、反复重新分析、转折句、数字流，以及各自的匹配次数与滑窗长度。每项在页面内有内联说明；键名、默认值和分组以设置页与源码为准。

打断过于频繁时，先关闭转折句判定，其次调高重复判定阈值。

## 成本

判定为本地字符串计算，不额外调用模型。少数需要写回上下文的消息采用尾部追加，不改写已有内容，不打穿前缀缓存。

早期版本曾在一轮约 924 万 token 的真实长会话上复算注入占比，那是旧机制下的历史数据，字符换算 token 使用启发式估算而非 tokenizer 实测。口径、修正与限定见 [docs/cot-anchor-prefix-cache-claim-correction.md](docs/cot-anchor-prefix-cache-claim-correction.md) 与 [RELEASE-NOTES.md](RELEASE-NOTES.md)，不代表当前版本的开销。

判定阈值经反复调整：早期词典过宽会误截断正常思考，后经收紧词典、滑窗长度与匹配次数缓解。代码由 AI 协作完成，装机实测逐版进行。

## 隐私

- 软切与相关判定均在本地完成，不向外部服务发送数据。
- 开启 CoT 采集或自动归纳后，思考文本留在本地；自动归纳还会把样本发往指定 provider（留空则跟随当前会话）。启用前需评估隐私影响。

## 开发

仓库根目录所有 `test-*.mjs` 均为独立可执行脚本，无测试框架、无 `npm test`。逐个运行 `node test-*.mjs`，退出码 0 即通过。

## 许可

MIT
