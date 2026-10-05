import { readFileSync } from "node:fs";

const source_path = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(source_path, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");

const factory = new Function(`${source}; return { splitSentences, extractConclusions };`);
const { splitSentences, extractConclusions } = factory();

const cases = [
	{
		label: "中文换行编号步骤（用户报告场景）",
		reasoning: "前面有一些铺垫分析，确认了代码链路。\n所以步骤：\n1. 先读取配置文件确认入口参数。\n2. 再执行主程序跑完整个流程。\n3. 最后检查输出目录里的结果。",
		expected_points: 1,
		expected_fragments: ["1. 先读取配置文件", "2. 再执行主程序", "3. 最后检查输出目录"]
	},
	{
		label: "普通句号仍正常切分",
		reasoning: "所以这个方案是可行的。下一步直接开始执行，不用再讨论。",
		expected_points: 1,
		expected_fragments: ["所以这个方案是可行的"]
	},
	{
		label: "英文换行编号步骤",
		reasoning: "after some analysis of the call chain. therefore the plan is:\n1. load the config file and check the entry.\n2. run the main program to completion.\n3. verify the files in the output directory.\nthese steps cover the whole task.",
		expected_points: 1,
		expected_fragments: ["1. load the config", "2. run the main", "3. verify the files"]
	},
	{
		label: "小数点不被当边界",
		reasoning: "所以阈值取 3.14 可以保持结果稳定不变，后续不再调整。",
		expected_points: 1,
		expected_fragments: ["3.14"]
	},
	{
		label: "顿号式编号步骤",
		reasoning: "所以处理顺序是：1、先读配置。2、再跑主程序。3、最后核对输出。全部走完即可。",
		expected_points: 1,
		expected_fragments: ["1、先读配置", "2、再跑主程序", "3、最后核对输出"]
	},
	{
		label: "代码标识符点号不切断（用户报告 card.openCard 场景）",
		reasoning: "前面分析了容器查找逻辑。\n所以修复方案：\n1. 放弃 findDockContainer 的启发式，直接用 card.openCard 挂载。\n2. 在 dock.plugin.js 里改。\n3. 跑一遍 index.test.mjs 验证。",
		expected_points: 1,
		expected_fragments: ["card.openCard", "dock.plugin.js", "index.test.mjs", "1. 放弃", "2. 在", "3. 跑"]
	},
	{
		label: "英文句末点号加空格仍正常切分",
		reasoning: "therefore use card.openCard directly. the next step is to verify it works.",
		expected_points: 1,
		expected_fragments: ["card.openCard directly"]
	}
];

let failed = 0;
for (const test_case of cases) {
	const sentences = splitSentences(test_case.reasoning);
	const points = extractConclusions(test_case.reasoning, 0, 3, 220);
	console.log(`\n=== ${test_case.label} ===`);
	console.log("切分结果:", JSON.stringify(sentences));
	console.log("提取结论:", JSON.stringify(points));

	if (points.length !== test_case.expected_points) {
		console.error(`断言失败: 结论数应为 ${test_case.expected_points}，实际 ${points.length}`);
		failed += 1;
	}
	const combined = points.join("");
	for (const fragment of test_case.expected_fragments ?? []) {
		if (!combined.includes(fragment)) {
			console.error(`断言失败: 结论缺少片段 "${fragment}"`);
			failed += 1;
		}
	}
}

const normal_case_sentences = splitSentences(cases[1].reasoning);
if (normal_case_sentences.length !== 2) {
	console.error(`断言失败: 普通句号切分数量应为 2，实际 ${normal_case_sentences.length}`);
	failed += 1;
}

console.log(failed === 0 ? "\n全部断言通过" : `\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
