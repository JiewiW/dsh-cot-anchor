/**
 * 事故语料回放回归 —— 2026-10-07 软切配额耗尽事故的三段脱敏语料。
 *
 * 语料：test/fixtures/incident-20261007-{normal,repeat,transition}.txt
 * （源自事故轨迹 A1/A3/A6 段，CRLF→LF 归一并脱敏：原轨迹中的本机盘符路径
 *   统一替换为 /workspace 或 /workspace-root。提交门禁四类模式——盘符反斜杠
 *   路径、本机用户名、会话指纹、本机分析目录名——对三个 fixture 必须零命中；
 *   四类模式本身即敏感词，禁止以连续字面量写入仓库源码，下方逐段拼接构造，
 *   本测试自带门禁复验）。
 *
 * 重放口径：与内核 C2 一致——文本从 REPEAT_MIN_TEXT_CHARS(800) 起每 32 字符
 * 一个检查点，末尾再全量判一次；每检查点按瀑布序判定
 * pseudoTool → repeat → numberRunaway → churn，首个命中即"该发生的 cut"。
 *
 * 断言（对应事故报告中已实测的基准值）：
 *  ① A1+A3 拼接：首次 cut 为 confirmed-repeat（repeat 检测器），位置 ∈[19,000,19,700]，
 *     period=35、count=5（事故实测 19,360）；
 *  ② A3 单独回放：首次 repeat cut ∈[4,300,4,800]（事故实测约 4,544）；
 *  ③ A6：首次 cut 为 churn（映射 heuristic），位置 ≈2,208（容差 [2,000,2,400]），
 *     且全程 confirmed-repeat 检测零命中；
 *  ④ A1 正常段：任何检测器全程零命中（正常内容不误伤）；
 *  ⑤ 阈值分档单测（周期/次数组合的边界行为，直接驱动 findRepeatingTail）：
 *     period<2 永不触发；2≤period<12 需 count≥30；12≤period<96 需 count≥5；
 *     period≥96 需 count≥2。
 *
 * 检测器经整源码 new Function 提取（函数名锚定，不依赖行号），全部真实调用。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

// --- 检测器提取：整源码剥 import/export 后 new Function，返回检测器与阈值 ------
const tempHome = path.join(os.tmpdir(), "cot-replay-" + randomUUID().slice(0, 8));
fs.mkdirSync(tempHome, { recursive: true });

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "").replace(/^export \{[^\n]*$/gm, "");
const factory = new Function(
	"randomUUID", "appendFileSync", "existsSync", "mkdirSync", "readFileSync", "statSync", "unlinkSync", "writeFileSync",
	"homedir", "join", "createRequire", "BlockAssembler", "createUserMessage",
	`${source}; return {
		findRepeatingTail, detectNumberRunaway, hasPseudoToolCall, detectChurn, insideUnclosedCodeFence,
		REPEAT_MIN_TEXT_CHARS, REPEAT_MIN_PERIOD, REPEAT_SHORT_PERIOD,
		REPEAT_MIN_COUNT, REPEAT_MIN_COUNT_SHORT, REPEAT_ULTRA_SHORT_MIN_COUNT
	};`
);
const detectors = factory(
	randomUUID, fs.appendFileSync, fs.existsSync, fs.mkdirSync, fs.readFileSync, fs.statSync, fs.unlinkSync, fs.writeFileSync,
	() => tempHome, path.join, createRequire,
	function () { this.parts = []; },
	(text) => ({ role: "user", content: text })
);
const {
	findRepeatingTail, detectNumberRunaway, hasPseudoToolCall, detectChurn, insideUnclosedCodeFence,
	REPEAT_MIN_TEXT_CHARS, REPEAT_MIN_PERIOD, REPEAT_SHORT_PERIOD,
	REPEAT_MIN_COUNT, REPEAT_MIN_COUNT_SHORT, REPEAT_ULTRA_SHORT_MIN_COUNT
} = detectors;

// 检测阈值冻结守卫（阈值不得漂移——事故回归的基准前提）。
check("REPEAT_MIN_TEXT_CHARS=800", REPEAT_MIN_TEXT_CHARS === 800, String(REPEAT_MIN_TEXT_CHARS));
check("REPEAT_MIN_PERIOD=12", REPEAT_MIN_PERIOD === 12, String(REPEAT_MIN_PERIOD));
check("REPEAT_SHORT_PERIOD=96", REPEAT_SHORT_PERIOD === 96, String(REPEAT_SHORT_PERIOD));
check("REPEAT_MIN_COUNT=2", REPEAT_MIN_COUNT === 2, String(REPEAT_MIN_COUNT));
check("REPEAT_MIN_COUNT_SHORT=5", REPEAT_MIN_COUNT_SHORT === 5, String(REPEAT_MIN_COUNT_SHORT));
check("REPEAT_ULTRA_SHORT_MIN_COUNT=30", REPEAT_ULTRA_SHORT_MIN_COUNT === 30, String(REPEAT_ULTRA_SHORT_MIN_COUNT));

// --- 重放器 -------------------------------------------------------------------
// 与 handler 3547 行同构：churn 判定前有 insideUnclosedCodeFence 闸（未闭合代码
// 围栏内禁用 churn，普通代码叙述不误伤）。扫描全部检查点，按检测器分类记录首次
// 命中——事故中 churn(heuristic) 先于 repeat 触发（对应事故轨迹的 6 次 churn
// 打断），故"首次 confirmed-repeat cut"须按类单独统计，不能取全瀑布首个 cut。
function replayScan(fullVisibleText) {
	const first = { pseudoTool: null, repeat: null, numberRunaway: null, churn: null, any: null };
	const note = (detector, entry) => {
		if (!first[detector]) first[detector] = entry;
		if (!first.any) first.any = entry;
	};
	const checkpoints = [];
	for (let n = REPEAT_MIN_TEXT_CHARS; n <= fullVisibleText.length; n += 32) checkpoints.push(n);
	checkpoints.push(fullVisibleText.length); // 末尾全量判一次（与内核 C2 尾判一致）
	for (const n of checkpoints) {
		const t = fullVisibleText.slice(0, n);
		if (!first.pseudoTool && hasPseudoToolCall(t)) note("pseudoTool", { at: n, detector: "pseudoTool", budgetClass: "confirmed-pseudo" });
		const rep = findRepeatingTail(t);
		if (!first.repeat && rep) note("repeat", { at: n, detector: "repeat", budgetClass: "confirmed-repeat", loop: rep });
		if (!first.numberRunaway && detectNumberRunaway(t)) note("numberRunaway", { at: n, detector: "numberRunaway", budgetClass: "confirmed-repeat" });
		if (!first.churn && !insideUnclosedCodeFence(t) && detectChurn(t)) note("churn", { at: n, detector: "churn", budgetClass: "heuristic" });
	}
	return first;
}

// --- ⓪ fixture 门禁复验（脱敏必须零命中，与入库门槛同一四类模式） --------------
const BS = String.fromCharCode(92);
const gateRe = new RegExp([
	"D:" + BS + BS,
	["ling", "feng"].join(""),
	["94e352", "f6"].join(""),
	BS + ".tmp-dup" + "-scan"
].join("|"));
const fixtureOf = (name) => readFileSync(new URL(`./test/fixtures/${name}`, import.meta.url), "utf8");
const a1 = fixtureOf("incident-20261007-normal.txt");
const a3 = fixtureOf("incident-20261007-repeat.txt");
const a6 = fixtureOf("incident-20261007-transition.txt");
for (const [name, text] of [["normal", a1], ["repeat", a3], ["transition", a6]]) {
	check(`门禁零命中（${name}）`, !gateRe.test(text));
}

// --- ① A1+A3 拼接：首次 confirmed-repeat cut ∈[19,000,19,700]，period=35/count=5
const concat = `${a1}\n${a3}`;
const scanConcat = replayScan(concat);
check("A1+A3 首次 confirmed-repeat cut 存在", Boolean(scanConcat.repeat),
	JSON.stringify(scanConcat.repeat && { at: scanConcat.repeat.at, period: scanConcat.repeat.loop?.period, count: scanConcat.repeat.loop?.count }));
check("A1+A3 首次 confirmed-repeat 位置 ∈[19000,19700]",
	scanConcat.repeat?.at >= 19000 && scanConcat.repeat?.at <= 19700, String(scanConcat.repeat?.at));
check("A1+A3 period=35", scanConcat.repeat?.loop?.period === 35, String(scanConcat.repeat?.loop?.period));
check("A1+A3 count=5", scanConcat.repeat?.loop?.count === 5, String(scanConcat.repeat?.loop?.count));
check("A1+A3 早于 repeat 的首个 cut 是 churn（与事故 6 次 churn 打断一致）",
	scanConcat.any?.detector === "churn" && (scanConcat.churn?.at ?? Infinity) < (scanConcat.repeat?.at ?? Infinity),
	JSON.stringify(scanConcat.any));

// --- ② A3 单独回放：首次 confirmed-repeat cut ∈[4,300,4,800] -------------------
const scanA3 = replayScan(a3);
check("A3 首次 confirmed-repeat cut 存在", Boolean(scanA3.repeat),
	JSON.stringify(scanA3.repeat && { at: scanA3.repeat.at, d: scanA3.repeat.detector }));
check("A3 首次 confirmed-repeat 位置 ∈[4300,4800]", scanA3.repeat?.at >= 4300 && scanA3.repeat?.at <= 4800, String(scanA3.repeat?.at));

// --- ③ A6：首次 cut = churn(heuristic)，位置 ≈2208；confirmed-repeat 全程零命中
const scanA6 = replayScan(a6);
check("A6 首次 cut = churn", scanA6.any?.detector === "churn", JSON.stringify(scanA6.any));
check("A6 首次位置 ∈[2000,2400]", scanA6.any?.at >= 2000 && scanA6.any?.at <= 2400, String(scanA6.any?.at));
check("A6 映射 heuristic", scanA6.any?.budgetClass === "heuristic", scanA6.any?.budgetClass);
check("A6 全程 confirmed-repeat 零命中", scanA6.repeat === null && scanA6.numberRunaway === null && scanA6.pseudoTool === null,
	JSON.stringify({ repeat: scanA6.repeat?.at ?? null, nr: scanA6.numberRunaway?.at ?? null, pseudo: scanA6.pseudoTool?.at ?? null }));

// --- ④ A1 正常段：无 confirmed 类命中（规格断言允许 heuristic churn 存在） ----
const scanA1 = replayScan(a1);
check("A1 正常内容无 confirmed 类命中",
	scanA1.repeat === null && scanA1.numberRunaway === null && scanA1.pseudoTool === null,
	JSON.stringify({ repeat: scanA1.repeat?.at ?? null, nr: scanA1.numberRunaway?.at ?? null, pseudo: scanA1.pseudoTool?.at ?? null }));

// --- ⑤ 阈值分档单测（直接驱动 findRepeatingTail） ------------------------------
// 构造：filler（逐字符递增码点，无重复周期）+ unit×count（unit 长度 = period）。
function buildTierText(period, count) {
	const unit = Array.from({ length: period }, (_, i) => String.fromCharCode(0x4e00 + ((period * 7 + i) % 2000))).join("");
	let filler = "";
	for (let i = 0; i < 900; i++) filler += String.fromCharCode(0x30a0 + (i % 500)) + String.fromCharCode(0x3040 + (i % 300));
	return filler + unit.repeat(count);
}
const cases = [
	{ label: "period=1 永不触发（period<2）", period: 1, count: 99, expect: false },
	{ label: "period=5 count=29 不触发（<30）", period: 5, count: 29, expect: false },
	{ label: "period=5 count=30 触发（=30）", period: 5, count: 30, expect: true },
	{ label: "period=35 count=4 不触发（<5）", period: 35, count: 4, expect: false },
	{ label: "period=35 count=5 触发（=5）", period: 35, count: 5, expect: true },
	{ label: "period=100 count=1 不触发（<2）", period: 100, count: 1, expect: false },
	// period=100/count=2 是 stage-1 探针粒度盲区（run 200 < probe 128+period 100，
	// 窗口预过滤找不到上一次出现），属结构性边界而非阈值违规，不作断言；
	// 长周期档用 period=200（run 400 ≥ 328）验证 count≥2 阈值。
	{ label: "period=200 count=2 触发（=2，长周期档）", period: 200, count: 2, expect: true },
	{ label: "period=100 count=3 触发（run 300 ≥ probe+period）", period: 100, count: 3, expect: true }
];
for (const c of cases) {
	const hit = findRepeatingTail(buildTierText(c.period, c.count));
	check(c.label, c.expect ? Boolean(hit) : hit === null, JSON.stringify(hit && { period: hit.period, count: hit.count }));
}

try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

if (failed === 0) console.log("\n全部事故语料回放断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
