import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { splitSentences, extractConclusions };`);
const { splitSentences, extractConclusions } = factory();

/** 用户报告的精确输入：省略号枚举序列必须整段保留，不得在 "..." 处截断。 */
const userInput = "所以顺序是：(j1,k1),(j2,k1),...,(jL,k1),(j1,k2),...";

const cases = [
	{
		label: "用户输入：无空格省略号枚举，整段不切",
		text: userInput,
		expectedCount: 1,
		expectedContains: userInput
	},
	{
		label: "省略号后跟空格再接内容：不得在省略号处切开",
		text: "所以顺序是：(j1,k1),(j2,k1),... (jL,k1),(j1,k2),...",
		expectedCount: 1,
		expectedContains: "(jL,k1),(j1,k2),..."
	},
	{
		label: "省略号后直接接内容：不得切开",
		text: "所以顺序是：(j1,k1),(j2,k1),...(jL,k1),(j1,k2),...",
		expectedCount: 1,
		expectedContains: "(jL,k1),(j1,k2),..."
	},
	{
		label: "省略号后接中文句号：中文句号仍是边界",
		text: "所以顺序是：(j1,k1),(j2,k1),...,(jL,k1)。接下来开始执行。",
		expectedCount: 2,
		expectedContains: "所以顺序是：(j1,k1),(j2,k1),...,(jL,k1)。"
	},
	{
		label: "中文省略号 U+2026：整段不切",
		text: "所以顺序是：(j1,k1),(j2,k1),…,(jL,k1),(j1,k2),…",
		expectedCount: 1,
		expectedContains: "…"
	},
	{
		label: "真正的英文句末点号仍切分",
		text: "therefore use card.openCard directly. the next step is to verify it works.",
		expectedCount: 2,
		expectedContains: "therefore use card.openCard directly."
	},
	{
		label: "单点结尾无空格：整段不切",
		text: "所以先取第一个元素.",
		expectedCount: 1,
		expectedContains: "所以先取第一个元素."
	}
];

let failed = 0;
for (const testCase of cases) {
	const sentences = splitSentences(testCase.text);
	const countOk = sentences.length === testCase.expectedCount;
	const contentOk = sentences.some((s) => s.includes(testCase.expectedContains));
	const ok = countOk && contentOk;
	console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label}`);
	console.log(`     切分 ${sentences.length} 段（期望 ${testCase.expectedCount}）: ${JSON.stringify(sentences)}`);
	if (!ok) failed += 1;
}

// 结论提取层：用户报告的场景必须产出包含完整枚举序列的结论
const points = extractConclusions(userInput, 1, 3, 220);
const pointOk = points.length === 1 && points[0].includes("(jL,k1),(j1,k2),...");
console.log(`${pointOk ? "PASS" : "FAIL"} 结论提取保留完整枚举序列`);
console.log(`     结论: ${JSON.stringify(points)}`);
if (!pointOk) failed += 1;

if (failed === 0) console.log("\n全部省略号断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);