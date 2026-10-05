import { readFileSync } from "node:fs";
import { PSEUDO_TOOL_CALL_UNIT } from "./test-fixtures.mjs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { findRepeatingTail, renderRepeatAnchor };`);
const { findRepeatingTail, renderRepeatAnchor } = factory();

/** 真实事故里的重复单元（内联夹具，不再依赖可能被移走的外部日志）。 */
const realUnit = PSEUDO_TOOL_CALL_UNIT;
console.log(`真实重复单元长度: ${realUnit.length} 字符\n`);

/** 正常长文本：每段都不同（含递增编号），不构成周期文本。 */
const normalText = Array.from({ length: 220 }, (_, i) =>
	`第 ${i} 步：处理模块 ${i} 的初始化与校验，确认第 ${i} 项配置在当前环境下生效，并记录第 ${i} 项的实际取值。`
).join("\n");

const cases = [
	{
		label: "真实事故形态：587 字块重复 50 次 → 应命中",
		text: (realUnit + "\n").repeat(50),
		expectHit: true,
		expectCountAtLeast: 40
	},
	{
		label: "真实事故形态：重复 403 次（原始规模）→ 应命中",
		text: (realUnit + "\n").repeat(403),
		expectHit: true,
		expectCountAtLeast: 64
	},
	{
		label: "长块重复 2 次 → 命中（长周期阈值已下调为 2）",
		text: normalText + "\n" + (realUnit + "\n").repeat(2),
		expectHit: true
	},
	{
		label: "长块只出现 1 次 → 不命中",
		text: normalText + "\n" + realUnit + "\n",
		expectHit: false
	},
	{
		label: "正常长文本（无重复块）→ 不命中",
		text: normalText,
		expectHit: false
	},
	{
		label: "长块重复 3 次（已过 2 次阈值）→ 命中",
		text: (realUnit + "\n").repeat(3).slice(0, 3000),
		expectHit: true
	}
];

let failed = 0;
for (const testCase of cases) {
	const result = findRepeatingTail(testCase.text);
	const hit = result !== null;
	const ok = hit === testCase.expectHit && (!testCase.expectCountAtLeast || result.count >= testCase.expectCountAtLeast);
	console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label}`);
	if (result) {
		console.log(`     period=${result.period} count=${result.count} trimTo=${result.trimTo} / 全长=${testCase.text.length}`);
	} else {
		console.log("     未命中");
	}
	if (!ok) failed += 1;
}

// trimTo 必须落在"重复序列只保留一份"的位置
const loopText = (realUnit + "\n").repeat(50);
const loop = findRepeatingTail(loopText);
if (loop) {
	const kept = loopText.slice(0, loop.trimTo);
	const keptUnits = Math.round(kept.length / (realUnit.length + 1));
	const trimOk = keptUnits === 1;
	console.log(`${trimOk ? "PASS" : "FAIL"} trimTo 只保留一份重复内容（保留 ${keptUnits} 份）`);
	if (!trimOk) failed += 1;

	const anchorText = renderRepeatAnchor(loop);
	const anchorOk = anchorText.includes("停止重复") && anchorText.includes("Stop repeating");
	console.log(`${anchorOk ? "PASS" : "FAIL"} 重复锚点文案包含停止指令`);
	if (!anchorOk) failed += 1;
} else {
	console.log("FAIL 未能构造循环用于 trimTo 检查");
	failed += 1;
}

if (failed === 0) console.log("\n全部重复检测断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);