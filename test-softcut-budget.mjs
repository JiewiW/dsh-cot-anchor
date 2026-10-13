/**
 * 三类有界软切预算状态机 —— 直接驱动内核移植段纯函数（步骤 1.3b）。
 *
 * 手法与既有内核测试一致：readFileSync 读取**已应用补丁**的内核
 * @deepseek-ai/dsh-agent-loop/lib/index.js，按 DSH-SOFT-CUT-PORT region 标记切片，
 * new Function 执行后取出 createSoftCutBudget / decideSoftCut 与三个上限常量，
 * 全部断言基于真实函数调用——禁止另写一份平行实现。
 * 内核路径经 createRequire 解析（与移植脚本同一解析口径），不写死内容哈希。
 *
 * 断言清单：
 *  ① decision 缺 budgetClass → 计入 heuristic，第 7 次返回 reject；
 *  ② confirmed-repeat：前 20 次 cut，第 21 次 reject；
 *  ③ confirmed-pseudo：前 3 次 cut，第 4 次返回 hard-abort；
 *  ④ 纯函数性：不修改传入 budget 对象本身（写回是调用点职责）、不修改
 *     decision 入参、重复调用结果确定（无隐藏状态）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const kernelPath = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-agent-loop");
const source = readFileSync(kernelPath, "utf8");

const REGION_BEGIN = "//#region DSH-SOFT-CUT-PORT";
const REGION_END = "//#endregion DSH-SOFT-CUT-PORT";
const begin = source.indexOf(REGION_BEGIN);
const end = source.indexOf(REGION_END);
if (begin < 0 || end < 0) {
	console.error("FAIL 内核未处于 soft-cut 已移植状态（找不到 DSH-SOFT-CUT-PORT region）");
	process.exit(1);
}
// region 末尾是行注释，return 前必须换行，否则会被注释吞掉。
const region = source.slice(begin, end + REGION_END.length) + "\n";
const factory = new Function(
	region + "return { createSoftCutBudget, decideSoftCut, "
	+ "HEURISTIC_CUT_MAX, CONFIRMED_REPEAT_CUT_MAX, CONFIRMED_PSEUDO_CUT_MAX };"
);
const {
	createSoftCutBudget,
	decideSoftCut,
	HEURISTIC_CUT_MAX,
	CONFIRMED_REPEAT_CUT_MAX,
	CONFIRMED_PSEUDO_CUT_MAX
} = factory();

const LIMITS = {
	heuristic: HEURISTIC_CUT_MAX,
	confirmedRepeat: CONFIRMED_REPEAT_CUT_MAX,
	confirmedPseudo: CONFIRMED_PSEUDO_CUT_MAX
};

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

// --- 常量与工厂 --------------------------------------------------------------
check("HEURISTIC_CUT_MAX=6", HEURISTIC_CUT_MAX, 6);
check("CONFIRMED_REPEAT_CUT_MAX=20", CONFIRMED_REPEAT_CUT_MAX, 20);
check("CONFIRMED_PSEUDO_CUT_MAX=3", CONFIRMED_PSEUDO_CUT_MAX, 3);
const freshBudget = createSoftCutBudget();
check("createSoftCutBudget 三键归零",
	freshBudget.heuristic === 0 && freshBudget.confirmedRepeat === 0 && freshBudget.confirmedPseudo === 0,
	JSON.stringify(freshBudget));
check("createSoftCutBudget 每次返回新对象", createSoftCutBudget() !== createSoftCutBudget());

// --- ① decision 缺 budgetClass → heuristic 桶，第 7 次 reject ----------------
{
	const budget = createSoftCutBudget();
	let allCut = true;
	for (let i = 1; i <= 6; i++) {
		const verdict = decideSoftCut(budget, {}, LIMITS);
		if (verdict.action !== "cut" || verdict.budgetClass !== "heuristic" || verdict.usedAfter !== i) {
			allCut = false;
			check(`缺 budgetClass 第 ${i} 次 cut/heuristic/usedAfter=${i}`, false, JSON.stringify(verdict));
			break;
		}
		budget.heuristic = verdict.usedAfter; // 调用点写回（与内核 C2 一致）
	}
	check("缺 budgetClass 前 6 次 cut 且计入 heuristic", allCut);
	check("heuristic 计数确为 6", budget.heuristic, 6);
	const seventh = decideSoftCut(budget, {}, LIMITS);
	check("缺 budgetClass 第 7 次 action=reject", seventh.action === "reject", seventh.action);
	check("第 7 次 budgetClass=heuristic", seventh.budgetClass === "heuristic", seventh.budgetClass);
	check("第 7 次 usedAfter 不增（=6）", seventh.usedAfter, 6);
	// decision 为 null/undefined 同样按缺失处理。
	check("decision=undefined 视同 heuristic",
		decideSoftCut(createSoftCutBudget(), undefined, LIMITS).budgetClass === "heuristic");
	// 未知取值按缺失处理 → heuristic。
	check("budgetClass 未知取值归一化为 heuristic",
		decideSoftCut(createSoftCutBudget(), { budgetClass: "weird-class" }, LIMITS).budgetClass === "heuristic");
}

// --- ② confirmed-repeat：前 20 次 cut，第 21 次 reject -----------------------
{
	const budget = createSoftCutBudget();
	let allCut = true;
	for (let i = 1; i <= 20; i++) {
		const verdict = decideSoftCut(budget, { budgetClass: "confirmed-repeat" }, LIMITS);
		if (verdict.action !== "cut" || verdict.budgetClass !== "confirmed-repeat" || verdict.usedAfter !== i) {
			allCut = false;
			check(`confirmed-repeat 第 ${i} 次 cut/usedAfter=${i}`, false, JSON.stringify(verdict));
			break;
		}
		budget.confirmedRepeat = verdict.usedAfter;
	}
	check("confirmed-repeat 前 20 次 cut", allCut);
	check("confirmedRepeat 计数确为 20", budget.confirmedRepeat, 20);
	const twentyFirst = decideSoftCut(budget, { budgetClass: "confirmed-repeat" }, LIMITS);
	check("confirmed-repeat 第 21 次 action=reject", twentyFirst.action === "reject", twentyFirst.action);
	check("第 21 次 budgetClass=confirmed-repeat", twentyFirst.budgetClass === "confirmed-repeat", twentyFirst.budgetClass);
	check("第 21 次 usedAfter 不增（=20）", twentyFirst.usedAfter, 20);
}

// --- ③ confirmed-pseudo：前 3 次 cut，第 4 次 hard-abort ---------------------
{
	const budget = createSoftCutBudget();
	let allCut = true;
	for (let i = 1; i <= 3; i++) {
		const verdict = decideSoftCut(budget, { budgetClass: "confirmed-pseudo" }, LIMITS);
		if (verdict.action !== "cut" || verdict.budgetClass !== "confirmed-pseudo" || verdict.usedAfter !== i) {
			allCut = false;
			check(`confirmed-pseudo 第 ${i} 次 cut/usedAfter=${i}`, false, JSON.stringify(verdict));
			break;
		}
		budget.confirmedPseudo = verdict.usedAfter;
	}
	check("confirmed-pseudo 前 3 次 cut", allCut);
	check("confirmedPseudo 计数确为 3", budget.confirmedPseudo, 3);
	const fourth = decideSoftCut(budget, { budgetClass: "confirmed-pseudo" }, LIMITS);
	check("confirmed-pseudo 第 4 次 action=hard-abort", fourth.action === "hard-abort", fourth.action);
	check("第 4 次 budgetClass=confirmed-pseudo", fourth.budgetClass === "confirmed-pseudo", fourth.budgetClass);
	check("hard-abort 不携带 usedAfter", fourth.usedAfter === undefined);
	// hard-abort 不依赖传入的 budget 形态（已达上限即触发）。
	const directFull = { heuristic: 9, confirmedRepeat: 9, confirmedPseudo: 3 };
	check("confirmedPseudo=3 直接判定 hard-abort",
		decideSoftCut(directFull, { budgetClass: "confirmed-pseudo" }, LIMITS).action === "hard-abort");
}

// --- ④ 纯函数性 ---------------------------------------------------------------
{
	const budget = createSoftCutBudget();
	const budgetSnapshot = JSON.stringify(budget);
	const decision = { budgetClass: "confirmed-repeat" };
	const decisionSnapshot = JSON.stringify(decision);
	decideSoftCut(budget, decision, LIMITS);
	decideSoftCut(budget, decision, LIMITS);
	check("decideSoftCut 不写回 budget（写回是调用点职责）", JSON.stringify(budget) === budgetSnapshot,
		JSON.stringify(budget));
	check("decideSoftCut 不修改 decision 入参", JSON.stringify(decision) === decisionSnapshot);
	// 同一无状态入参重复调用结果确定 → 无隐藏外部状态。
	const first = decideSoftCut(createSoftCutBudget(), { budgetClass: "heuristic" }, LIMITS);
	const second = decideSoftCut(createSoftCutBudget(), { budgetClass: "heuristic" }, LIMITS);
	check("重复调用结果确定（无隐藏状态）", JSON.stringify(first) === JSON.stringify(second));
	// limits 缺键防御：按 NaN 比较自然落入 cut 之外分支前需不抛错。
	let noThrow = true;
	try { decideSoftCut(createSoftCutBudget(), {}, {}); } catch { noThrow = false; }
	check("limits 缺键不抛错", noThrow);
}

if (failed === 0) console.log("\n全部三类预算状态机断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
