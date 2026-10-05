import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { detectChurn, renderChurnAnchor, countChurnHits, findRepeatingTail };`);
const { detectChurn, renderChurnAnchor, countChurnHits, findRepeatingTail } = factory();

/**
 * 真实事故形态：措辞不同但反复重启分析，实测 "Let me" 出现 638 次 / 6.1 万字符
 * （约每 95 字符一次）。用内联夹具重建该密度，不再依赖可能被移走的外部日志。
 */
const realLog = Array.from({ length: 600 }, (_, i) =>
	`Let me reconsider hypothesis ${i}: actually the ${i}th reading is probably wrong, let me re-read part ${i} and think again. Hmm.`
).join(" ");

/** 正常英文技术长文：偶发 "let me"，密度符合真实写作。 */
const normalEnglish = Array.from({ length: 120 }, (_, i) => {
	const base = `Step ${i}: the loader resolves module ${i} before the scheduler runs, so the ordering guarantee holds for item ${i}. The ${i}th case is covered by the existing regression test.`;
	return i % 9 === 0 ? `${base} Let me note the edge case once.` : base;
}).join("\n");

/**
 * 语义打转：每句措辞都不同（含递增编号，无逐字节周期），但每句都在"让我重新分析"。
 * 这正是周期检测结构上看不见、只能靠空转密度抓住的形态。
 */
const semanticChurn = Array.from({ length: 200 }, (_, i) =>
	`Let me reconsider hypothesis ${i}: actually the ${i}th reading is probably wrong, let me re-read part ${i} and think again. Hmm.`
).join(" ");

/** 正常中文长文。 */
const normalChinese = Array.from({ length: 200 }, (_, i) =>
	`第 ${i} 步：检查模块 ${i} 的初始化顺序与依赖关系，确认第 ${i} 项配置在当前环境下生效，并记录其实际取值。`
).join("\n");

const cases = [
	{
		label: "真实事故全文（Let me 638 次）→ 命中",
		text: realLog,
		expectHit: true
	},
	{
		label: "真实事故前 30000 字（措辞不同的语义打转）→ 命中",
		text: realLog.slice(0, 30000),
		expectHit: true
	},
	{
		label: "构造语义打转（每句不同、无逐字节周期）→ 命中",
		text: semanticChurn,
		expectHit: true
	},
	{
		label: "正常英文技术长文（少量 let me）→ 不命中",
		text: normalEnglish,
		expectHit: false
	},
	{
		label: "正常中文长文 → 不命中",
		text: normalChinese,
		expectHit: false
	},
	{
		label: "文本过短（<6000）→ 不命中",
		text: "Let me think. Let me think. Let me think.",
		expectHit: false
	}
];

let failed = 0;
for (const testCase of cases) {
	const result = detectChurn(testCase.text);
	const hit = result !== null;
	const ok = hit === testCase.expectHit;
	const hits = countChurnHits(testCase.text);
	console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label} → ${hit}（窗口内命中 ${hits} 次）`);
	if (!ok) failed += 1;
}

// 空转锚点必须说清"停止重复分析、只输出新内容"
const anchor = renderChurnAnchor({ hits: 31 });
const anchorOk = anchor.includes("空转") && anchor.includes("停止重新分析") && anchor.includes("尚未说过");
console.log(`${anchorOk ? "PASS" : "FAIL"} 空转锚点包含停止指令`);
if (!anchorOk) failed += 1;

// 互补性：语义打转（措辞不同、无逐字节周期）必须由空转检测兜住
const periodic = findRepeatingTail(semanticChurn);
const churn = detectChurn(semanticChurn);
const complementOk = periodic === null && churn !== null;
console.log(`${complementOk ? "PASS" : "FAIL"} 语义打转：周期检测无命中(${periodic === null}) 而空转检测命中(${churn !== null})`);
if (!complementOk) failed += 1;

if (failed === 0) console.log("\n全部空转检测断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);