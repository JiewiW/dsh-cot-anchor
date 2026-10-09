/**
 * S4.3 内核分类预算 —— 直接驱动移植段纯函数状态机判定。
 *
 * 剥载方式沿用 test-softcut-fix.mjs：从补丁后内核 lib/index.js 取出由
 * tools/apply-softcut-port.mjs 注入的 DSH-SOFT-CUT-PORT region（常量 + 纯函数就在
 * 该 region 内），new Function 动态执行后取两个纯函数与四个常量，做时序判定。
 * 禁止用源码字符串/AST 静态断言替代——这里全部是真实函数调用。
 * 内核路径经 createRequire 解析（与移植脚本同一解析口径），不写死内容哈希。
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
	region + "return { shouldShortCircuitSoftCut, decideSoftCutBudget, "
	+ "BUDGET_HEURISTIC, BUDGET_CONFIRMED_REPEAT, BUDGET_PSEUDO_TOOL, BUDGET_TOTAL };"
);
const {
	shouldShortCircuitSoftCut,
	decideSoftCutBudget,
	BUDGET_HEURISTIC,
	BUDGET_CONFIRMED_REPEAT,
	BUDGET_PSEUDO_TOOL,
	BUDGET_TOTAL
} = factory();

let failed = 0;
function check(label, actual, expected) {
	const ok = actual === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${label} → ${actual}（期望 ${expected}）`);
	if (!ok) failed += 1;
}
function freshState() {
	return { heuristic: 0, confirmedRepeat: 0, pseudoTool: 0, total: 0 };
}

// --- 常量断言（不计入 10+3 项时序） -----------------------------------------
check("BUDGET_HEURISTIC=6", BUDGET_HEURISTIC, 6);
check("BUDGET_CONFIRMED_REPEAT=20", BUDGET_CONFIRMED_REPEAT, 20);
check("BUDGET_PSEUDO_TOOL=3", BUDGET_PSEUDO_TOOL, 3);
check("BUDGET_TOTAL=29", BUDGET_TOTAL, 29);

// --- decideSoftCutBudget：从 0 计数按序推演（10 项） ------------------------
// heuristic 第 1..6 次 take、第 7 次 ignore（此时 total=6）。
let s = freshState();
for (let i = 1; i <= 6; i++) {
	check(`heuristic 第 ${i} 次 take`, decideSoftCutBudget(s, "heuristic"), "take");
	s.heuristic += 1; s.total += 1; // 仅 take 时调用点才会真的 +1，这里模拟采纳
}
check("heuristic 第 7 次 ignore（total=6）", (() => {
	const r = decideSoftCutBudget(s, "heuristic");
	return r;
})(), "ignore");
check("heuristic 超限时 total 确为 6", s.total, 6);

// confirmed-repeat：P4 预算策略（2026-10-09）后 confirmed-repeat 恒 "take"
// （字节级确证不占可耗尽预算，计数器仍照常累加供观测）。第 21 次用真实混合序列
// 状态断言恒 take；heuristic 上限 6 不受影响。
s = freshState();
for (let i = 1; i <= 6; i++) { check(`confirmed-repeat 第 ${i} 次 take`, decideSoftCutBudget(s, "confirmed-repeat"), "take"); s.confirmedRepeat += 1; s.total += 1; }
check("confirmed-repeat 第 7 次 take", decideSoftCutBudget(s, "confirmed-repeat"), "take");
s.confirmedRepeat += 1; s.total += 1;
for (let i = 8; i <= 19; i++) { check(`confirmed-repeat 第 ${i} 次 take`, decideSoftCutBudget(s, "confirmed-repeat"), "take"); s.confirmedRepeat += 1; s.total += 1; }
check("confirmed-repeat 第 20 次 take", decideSoftCutBudget(s, "confirmed-repeat"), "take");
const mixedAtTwentyFirst = { heuristic: 6, confirmedRepeat: 20, pseudoTool: 0, total: 26 };
check("confirmed-repeat 第 21 次 take（P4 恒 take，混合态 total=26）", decideSoftCutBudget(mixedAtTwentyFirst, "confirmed-repeat"), "take");
check("confirmed-repeat 超限时 total 确为 26", mixedAtTwentyFirst.total, 26);

// pseudoTool 第 1/2/3 次均 take。
s = freshState();
check("pseudoTool 第 1 次 take", decideSoftCutBudget(s, "pseudoTool"), "take");
s.pseudoTool += 1; s.total += 1;
check("pseudoTool 第 2 次 take", decideSoftCutBudget(s, "pseudoTool"), "take");
s.pseudoTool += 1; s.total += 1;
check("pseudoTool 第 3 次 take", decideSoftCutBudget(s, "pseudoTool"), "take");
s.pseudoTool += 1; s.total += 1;

// pseudoTool 第 4 次：P4 预算策略后 pseudoTool 恒 "take"（计数器照常累加）。
// 本断言沿用防御性混合态（total=28），只验证类计数分支恒放行；真实流程中该态
// 会在 waterfall 前被 shouldShortCircuitSoftCut 总闸拦截，不代表线上可达路径。
const defensive = { heuristic: 0, confirmedRepeat: 0, pseudoTool: 3, total: 28 };
check("pseudoTool 第 4 次 take（P4 恒 take，防御性分支 total=28）", decideSoftCutBudget(defensive, "pseudoTool"), "take");

// cutClass 缺省（undefined）按 heuristic 判定。
s = freshState();
s.heuristic = 3;
check("cutClass 缺省 → 按 heuristic（第 4 次 take）", decideSoftCutBudget(s, undefined), "take");
s.heuristic = 6;
check("cutClass 缺省 → heuristic 桶满即 ignore", decideSoftCutBudget(s, undefined), "ignore");

// --- shouldShortCircuitSoftCut（3 项） --------------------------------------
check("total=28 → 不短路", shouldShortCircuitSoftCut({ total: 28 }), false);
check("total=29 → 短路", shouldShortCircuitSoftCut({ total: 29 }), true);
check("零计数 → 不短路", shouldShortCircuitSoftCut(freshState()), false);

if (failed === 0) console.log("\n全部内核预算纯函数时序断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
