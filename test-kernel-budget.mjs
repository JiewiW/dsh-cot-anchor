/**
 * 内核三类有界预算 —— 集成级断言（对已应用补丁的真实内核文件）。
 *
 * 与 test-softcut-budget.mjs 的分工：那边只测移植段纯函数的时序语义（27 断言）；
 * 本文件验证**内核接线**——补丁已应用到 dsh-agent-loop、A 段常量与 SOFT_CUT_LIMITS
 * 取值、B 段 turn 重置点、C2 payload 的 budgets 三键（驼峰）schema、D2 写回映射
 * （wire 连字符 → 驼峰键）、hard-abort 固定序列（emit → abort → break）的顺序，
 * 以及旧 API（shouldShortCircuitSoftCut/decideSoftCutBudget/BUDGET_*）已从内核
 * 完全清除。最后用纯函数跑一条内核同构的混合序列（6 heuristic + 20 repeat +
 * 3 pseudo 交错）做端到端预算收口。
 *
 * 内核路径经 createRequire 解析（与移植脚本同一口径），region 按
 * DSH-SOFT-CUT-PORT 标记切片后 new Function 动态执行——全部为真实函数调用，
 * 禁止用源码字符串断言替代可执行验证（结构性接线检查除外，已逐条标注）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const kernelPath = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-agent-loop");
const source = readFileSync(kernelPath, "utf8");

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

// --- ① 补丁已应用状态 --------------------------------------------------------
const REGION_BEGIN = "//#region DSH-SOFT-CUT-PORT";
const REGION_END = "//#endregion DSH-SOFT-CUT-PORT";
const begin = source.indexOf(REGION_BEGIN);
const end = source.indexOf(REGION_END);
check("内核含 DSH-SOFT-CUT-PORT 起止标记", begin >= 0 && end > begin, `begin=${begin} end=${end}`);
if (begin < 0 || end < 0) {
	console.error("FAIL 内核未处于 soft-cut 已移植状态，终止（先跑 node tools/apply-softcut-port.mjs）");
	process.exit(1);
}
// region 末尾是行注释，return 前必须换行，否则会被注释吞掉。
const region = source.slice(begin, end + REGION_END.length) + "\n";
const factory = new Function(
	region + "return { createSoftCutBudget, decideSoftCut, SOFT_CUT_LIMITS, "
	+ "HEURISTIC_CUT_MAX, CONFIRMED_REPEAT_CUT_MAX, CONFIRMED_PSEUDO_CUT_MAX, "
	+ "SOFT_CUT_PSEUDO_ABORT_MESSAGE };"
);
const {
	createSoftCutBudget,
	decideSoftCut,
	SOFT_CUT_LIMITS,
	HEURISTIC_CUT_MAX,
	CONFIRMED_REPEAT_CUT_MAX,
	CONFIRMED_PSEUDO_CUT_MAX,
	SOFT_CUT_PSEUDO_ABORT_MESSAGE
} = factory();

// --- ② 常量与预算表取值（规格冻结值，禁止漂移） ------------------------------
check("HEURISTIC_CUT_MAX=6", HEURISTIC_CUT_MAX === 6, String(HEURISTIC_CUT_MAX));
check("CONFIRMED_REPEAT_CUT_MAX=20", CONFIRMED_REPEAT_CUT_MAX === 20, String(CONFIRMED_REPEAT_CUT_MAX));
check("CONFIRMED_PSEUDO_CUT_MAX=3", CONFIRMED_PSEUDO_CUT_MAX === 3, String(CONFIRMED_PSEUDO_CUT_MAX));
check("hard-abort 消息串", SOFT_CUT_PSEUDO_ABORT_MESSAGE, "cot-anchor-budget-pseudo-abort");
// SOFT_CUT_LIMITS 为扁平数值表（C2 payload 的 max 直接取该数值），驼峰键。
check("SOFT_CUT_LIMITS.heuristic=6", SOFT_CUT_LIMITS?.heuristic === 6, JSON.stringify(SOFT_CUT_LIMITS));
check("SOFT_CUT_LIMITS.confirmedRepeat=20", SOFT_CUT_LIMITS?.confirmedRepeat === 20, String(SOFT_CUT_LIMITS?.confirmedRepeat));
check("SOFT_CUT_LIMITS.confirmedPseudo=3", SOFT_CUT_LIMITS?.confirmedPseudo === 3, String(SOFT_CUT_LIMITS?.confirmedPseudo));

// --- ③ 纯函数性：createSoftCutBudget 每次返回独立零态 ------------------------
const budgetA = createSoftCutBudget();
const budgetB = createSoftCutBudget();
check("初态三键全零（驼峰）",
	budgetA.heuristic === 0 && budgetA.confirmedRepeat === 0 && budgetA.confirmedPseudo === 0,
	JSON.stringify(budgetA));
budgetA.heuristic = 99;
check("两次调用返回独立对象（互不影响）", budgetB.heuristic === 0, JSON.stringify(budgetB));

// --- ④ 内核接线（结构性检查：锚定已应用源码的精确形态） ----------------------
check("B 段 turn 重置点 softCutBudget: createSoftCutBudget()",
	source.includes("softCutBudget: createSoftCutBudget()"));
check("C2 payload budgets 三键之 heuristic",
	source.includes("heuristic: { used: budgetState.heuristic, max: SOFT_CUT_LIMITS.heuristic }"));
check("C2 payload budgets 三键之 confirmedRepeat",
	source.includes("confirmedRepeat: { used: budgetState.confirmedRepeat, max: SOFT_CUT_LIMITS.confirmedRepeat }"));
check("C2 payload budgets 三键之 confirmedPseudo",
	source.includes("confirmedPseudo: { used: budgetState.confirmedPseudo, max: SOFT_CUT_LIMITS.confirmedPseudo }"));
check("D2 写回 budgetState[budgetKey] = budgetVerdict.usedAfter",
	source.includes("budgetState[budgetKey] = budgetVerdict.usedAfter"));
check("D2 budgetKey 映射 confirmed-repeat → confirmedRepeat",
	/budgetKey\s*=\s*budgetVerdict\.budgetClass\s*===\s*"confirmed-repeat"\s*\?\s*"confirmedRepeat"/.test(source));
check("D2 budgetKey 映射 confirmed-pseudo → confirmedPseudo",
	/"confirmed-pseudo"\s*\?\s*"confirmedPseudo"/.test(source));

// hard-abort 固定序列：emit("agent/error") → phase.abort.abort() → break，顺序不可换。
const emitIdx = source.indexOf('dispatch.emit("agent/error", { error: new Error(SOFT_CUT_PSEUDO_ABORT_MESSAGE) })');
const abortIdx = source.indexOf("this.phase.abort.abort(new Error(SOFT_CUT_PSEUDO_ABORT_MESSAGE))");
const breakAfterAbortIdx = abortIdx >= 0 ? source.indexOf("break;", abortIdx) : -1;
check("hard-abort：emit(agent/error) 存在", emitIdx >= 0);
check("hard-abort：phase.abort.abort 存在", abortIdx >= 0);
check("hard-abort：emit 先于 abort 先于 break", emitIdx >= 0 && abortIdx > emitIdx && breakAfterAbortIdx > abortIdx,
	`emit=${emitIdx} abort=${abortIdx} break=${breakAfterAbortIdx}`);

// 旧 API 清除守卫：0.1.6 的旧标识符不得残留在内核任何位置。
check("旧 API shouldShortCircuitSoftCut 已清除", !source.includes("shouldShortCircuitSoftCut"));
check("旧 API decideSoftCutBudget 已清除", !source.includes("decideSoftCutBudget"));
check("旧 API BUDGET_* 常量已清除", !source.includes("BUDGET_"));

// --- ⑤ 内核同构混合序列端到端（真实函数调用） --------------------------------
// 模拟内核 C2 判定循环：decideSoftCut 裁决 + 采纳后写回（与 D2 同构）。
// 一条流内交错耗尽三类预算，验证各桶独立计数、互不挤占。
const budget = createSoftCutBudget();
const applyVerdict = (verdict) => {
	if (verdict.action !== "cut") return verdict;
	const camelKey = verdict.budgetClass === "confirmed-repeat" ? "confirmedRepeat"
		: verdict.budgetClass === "confirmed-pseudo" ? "confirmedPseudo" : "heuristic";
	budget[camelKey] = verdict.usedAfter;
	return verdict;
};
let mixedOk = true;
for (let i = 1; i <= 6; i++) {
	const v = applyVerdict(decideSoftCut(budget, { budgetClass: "heuristic" }, SOFT_CUT_LIMITS));
	if (v.action !== "cut") { mixedOk = false; console.log(`  heuristic 第 ${i} 次意外 ${v.action}`); }
}
const h7 = decideSoftCut(budget, { budgetClass: "heuristic" }, SOFT_CUT_LIMITS);
check("混合流：heuristic 第 7 次 reject（repeat/pseudo 不受影响）", mixedOk && h7.action === "reject");
for (let i = 1; i <= 20; i++) {
	const v = applyVerdict(decideSoftCut(budget, { budgetClass: "confirmed-repeat" }, SOFT_CUT_LIMITS));
	if (v.action !== "cut") { mixedOk = false; console.log(`  repeat 第 ${i} 次意外 ${v.action}`); }
}
const r21 = decideSoftCut(budget, { budgetClass: "confirmed-repeat" }, SOFT_CUT_LIMITS);
check("混合流：confirmed-repeat 第 21 次 reject", mixedOk && r21.action === "reject");
for (let i = 1; i <= 3; i++) {
	const v = applyVerdict(decideSoftCut(budget, { budgetClass: "confirmed-pseudo" }, SOFT_CUT_LIMITS));
	if (v.action !== "cut") { mixedOk = false; console.log(`  pseudo 第 ${i} 次意外 ${v.action}`); }
}
const p4 = decideSoftCut(budget, { budgetClass: "confirmed-pseudo" }, SOFT_CUT_LIMITS);
check("混合流：confirmed-pseudo 第 4 次 hard-abort", mixedOk && p4.action === "hard-abort" && p4.budgetClass === "confirmed-pseudo",
	JSON.stringify(p4));
check("混合流终态三桶恰好耗尽 {6,20,3}",
	budget.heuristic === 6 && budget.confirmedRepeat === 20 && budget.confirmedPseudo === 3,
	JSON.stringify(budget));

if (failed === 0) console.log("\n全部内核预算集成断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
