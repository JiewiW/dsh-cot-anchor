import { readFileSync } from "node:fs";

const source_path = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(source_path, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");

const factory = new Function(`${source}; return { wantsSoftCut, renderAnchor };`);
const { wantsSoftCut, renderAnchor } = factory();

const A = "前面先彻查了 findDockContainer 的挂载时机和布局约束，确认它拿不到真正的容器引用。" +
	"所以修复方案是放弃 findDockContainer 的启发式，直接用 card 容器来定位，这样最稳。" +
	"另一个结论是 dock 组件需要显式传入容器引用而不能再靠内部猜测。";

const cases = [
	{
		label: "长思考后接「接下来我要」转折 → 应切断",
		text: A + "\n接下来我要修改 dock.plugin.js，把挂载点改成 card，再跑一遍测试验证。",
		expected: true
	},
	{
		label: "长思考后接「下面我将」转折 → 应切断",
		text: A + "\n下面我将重构事件监听，把逻辑拆成独立函数。",
		expected: true
	},
	{
		label: "仅思考无转折 → 不切断",
		text: A + "\n还需要再想想这个方案有没有边界问题。",
		expected: false
	},
	{
		label: "转折出现在结论句中（非句首）→ 不误切",
		text: "所以接下来要处理的就是把挂载点稳住，其余不动。这方案已经足够。" +
			"然后继续分析性能影响，确认没有明显开销问题。",
		expected: false
	},
	{
		label: "文本太短（<min）→ 不切断",
		text: "接下来我要做下一步。",
		expected: false
	},
	{
		label: "英文 now i will 转折 → 应切断",
		text: "after tracing the call chain i concluded findDockContainer is wrong and the card is the right anchor. " +
			"another conclusion is to pass the container explicitly. now i will rewrite dock.plugin.js and re-run the tests.",
		expected: true
	},
	{
		label: "英文结论句含 now 非句首 → 不误切",
		text: "i now conclude that the anchor is broken. the fix is to use card directly. further analysis shows no perf concern.",
		expected: false
	},
	{
		label: "级联连接词 and now i will → 不误切",
		text: "the best fix is card.openCard, and now i will rewrite the plugin accordingly. keeping the rest of the logic intact.",
		expected: false
	},
	{
		label: "级联连接词 so now let's → 不误切",
		text: "so now let's recheck whether the dock still resolves correctly after the change. i will adjust if needed.",
		expected: false
	},
	{
		label: "完整句号后重开 now i will → 应切断",
		text: "the conclusions are solid. now i will move on to rewriting dock.plugin.js and running the tests.",
		expected: true
	},
	{
		label: "「我先」刚出现、句子未写完 → 不切（防句中途切断）",
		text: A + "\n我先",
		expected: false
	},
	{
		label: "「我先」写完完整句 → 应切断",
		text: A + "\n我先看一下配置文件的入口参数，确认没有遗漏。",
		expected: false
	},
	{
		label: "调查预告「我先读…确认字段语义」→ 不误切",
		text: A + "\n下一步我先读 config-loader 消费者的代码，确认它的字段语义与我推断一致。",
		expected: false
	},
	{
		label: "调查预告「接下来我核对基线」→ 不误切",
		text: A + "\n接下来我核对基线 parse-config 的空值分支与默认值处理。",
		expected: false
	},
	{
		label: "调查预告英文「now let's check」→ 不误切",
		text: A + "\nnow let's check whether load-config-file still resolves correctly.",
		expected: false
	},
	{
		label: "执行宣告「接下来我重构」→ 应切断",
		text: A + "\n接下来我重构 dock.plugin.js 的事件监听，把逻辑拆成独立函数。",
		expected: true
	},
	{
		label: "转折后无句号但已展开（follow 足够）→ 切",
		text: A + "\n接下来我要修改 dock.plugin.js 的挂载点实现",
		expected: true
	},
	{
		label: "转折后仅二字（follow 不足）→ 不切",
		text: A + "\n接下来我",
		expected: false
	}
];

let failed = 0;
for (const test_case of cases) {
	const got = wantsSoftCut(test_case.text, 60);
	const ok = got === test_case.expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${test_case.label} → ${got}`);
	if (!ok) failed += 1;
}

if (failed === 0) console.log("\n全部软切断断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);