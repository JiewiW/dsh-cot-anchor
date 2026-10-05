import { readFileSync } from "node:fs";
import { SHORT_CYCLE_UNIT, PSEUDO_TOOL_CALL_UNIT } from "./test-fixtures.mjs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { findRepeatingTail };`);
const { findRepeatingTail } = factory();

/** 真实事故形态：短词循环（含空行），周期约 58 字符。 */
const shortCycle = SHORT_CYCLE_UNIT;

/**
 * 非周期的正常长前缀（每段含递增编号）。真实生成里循环之前必有正常内容，
 * 且检测器有最小长度门限，所以用"正常前缀 + 尾部循环"构造才贴近真实触发条件。
 */
const normalPrefix = Array.from({ length: 120 }, (_, i) =>
	`第 ${i} 步：检查模块 ${i} 的状态与依赖关系，确认第 ${i} 项配置生效。`
).join("\n");

/** 真实事故尾部原文的等价物：短词循环的连续副本（内联夹具）。 */
const realLog = shortCycle.repeat(700) + PSEUDO_TOOL_CALL_UNIT.repeat(20);

const cases = [
	{
		label: "真实事故：短词循环重复 500 次 → 应命中",
		text: shortCycle.repeat(500),
		expectHit: true
	},
	{
		label: "真实事故尾部原文（摘取 4 万字符）→ 应命中",
		text: realLog.slice(-40000),
		expectHit: true
	},
	{
		label: "短句只重复 3 次 → 不命中（正常强调）",
		text: normalPrefix + shortCycle.repeat(3),
		expectHit: false
	},
	{
		label: "短句重复 10 次 → 命中（超过短周期阈值 8）",
		text: normalPrefix + shortCycle.repeat(10),
		expectHit: true
	},
	{
		label: "短句重复 4 次 → 不命中（未达短周期阈值 5）",
		text: normalPrefix + shortCycle.repeat(4),
		expectHit: false
	},
	{
		label: "长块（587 字）重复 3 次 → 命中（长周期阈值低）",
		text: normalPrefix + (PSEUDO_TOOL_CALL_UNIT + "\n").repeat(3),
		expectHit: true
	},
	{
		label: "正常长文本（每段不同）→ 不命中",
		text: Array.from({ length: 400 }, (_, i) => `第 ${i} 步：检查模块 ${i} 的初始化状态与依赖关系，确认第 ${i} 项配置生效。`).join("\n"),
		expectHit: false
	}
];

let failed = 0;
for (const testCase of cases) {
	const result = findRepeatingTail(testCase.text);
	const hit = result !== null;
	const ok = hit === testCase.expectHit;
	console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label}`);
	if (result) console.log(`     period=${result.period} count=${result.count} trimTo=${result.trimTo} / 全长=${testCase.text.length}`);
	else console.log("     未命中");
	if (!ok) failed += 1;
}

// 关键：命中短周期循环时，落盘必须裁到只剩一份
const loopText = shortCycle.repeat(500);
const loop = findRepeatingTail(loopText);
if (loop) {
	const trimOk = loop.trimTo <= loop.period * 1.5;
	console.log(`${trimOk ? "PASS" : "FAIL"} 短周期循环 trimTo 只保留一份（trimTo=${loop.trimTo}, period=${loop.period}）`);
	if (!trimOk) failed += 1;
} else {
	console.log("FAIL 未能命中短周期循环");
	failed += 1;
}

if (failed === 0) console.log("\n全部短周期循环断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);