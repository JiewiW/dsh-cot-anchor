import { readFileSync } from "node:fs";
import { ER4_RUN_UNIT, ER4_CYCLE } from "./test-fixtures.mjs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { findRepeatingTail };`);
const { findRepeatingTail } = factory();

/** 真实事故尾部原文的等价物：一次性前缀 + 大量 3 字周期 token 卡死。 */
function makeEr4Run(cycles) {
	return ER4_RUN_UNIT + ER4_CYCLE.repeat(cycles);
}

/** 正常长前缀，把待测循环推到尾部并越过长度门限（与其它 repeat 测试同套路）。 */
const normalPrefix = Array.from({ length: 120 }, (_, i) =>
	`第 ${i} 步：检查模块 ${i} 的状态与依赖关系，确认第 ${i} 项配置生效。`
).join("\n");

const cases = [
	{
		label: "真实事故：er4 token 卡死，周期3 重复 400 次（约1200字）→ 应命中",
		text: makeEr4Run(400),
		expectHit: true
	},
	{
		label: "er4 周期3 重复 200 次，但前面垫正常前缀 → 应命中（周期很长已越过800字）",
		text: normalPrefix + "\n" + makeEr4Run(200),
		expectHit: true
	},
	{
		label: "er4 周期3 只重复 10 次 → 不命中（未达超短周期阈值 30，正常强调/抖动）",
		text: normalPrefix + "\n" + ER4_RUN_UNIT + ER4_CYCLE.repeat(10),
		expectHit: false
	},
	{
		label: "周期1 分隔线（======）重复 100 次 → 不命中（单字符周期被排除）",
		text: normalPrefix + "\n" + "=".repeat(300),
		expectHit: false
	},
	{
		label: "周期2 普通抖动（哈哈）只重复 6 次 → 不命中",
		text: normalPrefix + "\n" + "哈哈".repeat(6),
		expectHit: false
	},
	{
		label: "正常长文本（每段不同）→ 不命中",
		text: Array.from({ length: 400 }, (_, i) => `第 ${i} 步：处理模块 ${i} 的初始化与校验，确认第 ${i} 项配置生效。`).join("\n"),
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

// 关键：命中超短周期循环时，落盘必须裁到只剩一份（前缀 + 一个周期）
const loopText = makeEr4Run(400);
const loop = findRepeatingTail(loopText);
if (loop) {
	const trimOk = loop.trimTo <= loop.period + ER4_RUN_UNIT.length;
	console.log(`${trimOk ? "PASS" : "FAIL"} 超短周期循环 trimTo 只保留一份（trimTo=${loop.trimTo}, period=${loop.period}）`);
	if (!trimOk) failed += 1;
} else {
	console.log("FAIL 未能命中超短周期循环");
	failed += 1;
}

if (failed === 0) console.log("\n全部超短周期循环断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);