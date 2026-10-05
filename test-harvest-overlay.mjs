import { readFileSync } from "node:fs";

/**
 * 增补层（L3）运行时叠加单元测试（docs/cot-harvest-design.md §5）。
 *
 * 三条必须成立的契约：
 *   ① 未采纳任何模式时，检测器行为与出厂逐字节一致；
 *   ② 采纳字面量后，churn 命中数上升并能触发判定；
 *   ③ 删除叠加后回落，且 `enableLearnedPatterns` 关闭时叠加完全失效。
 *
 * 另验证影子期判据：只有学习层把命中推过阈值时，才算「学习层单独触发」。
 */
const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return {
	effectiveChurnPhrases,
	countChurnHits,
	detectChurn,
	effectiveChurnMinHits,
	learnedThresholdShift,
	isLearnedOnlyChurnTrigger,
	noteChurnShadowHits,
	compileLearnedLiteralPhrase,
	__getChurnPhrases: () => CHURN_PHRASES,
	__setOverlay: (value) => { learnedOverlay = value; },
	__getOverlay: () => learnedOverlay,
	__setSettings: (patch) => { settings = { ...settings, ...patch }; }
};`);
const api = factory();

let failed = 0;
function check(label, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
	if (!condition) failed += 1;
}

/** 出厂配置：无任何学习模式。 */
const EMPTY_OVERLAY = { version: 1, patterns: [], thresholdShifts: [] };

/**
 * 只含学习字面量「再捋一遍」的长文本：出厂 churn 词表一条都不命中。
 * 长度远超 CHURN_MIN_TEXT_CHARS(4000)，尾部窗口内出现约 60 次。
 */
const learnedOnlyText = Array.from({ length: 100 }, (_, i) =>
	`第 ${i} 步：确认模块 ${i} 的依赖关系与配置取值，然后推进到下一项。再捋一遍第 ${i} 项。`
).join("\n");

/**
 * 含 14 次出厂空转词「Let me」的长文本：低于出厂阈值 18，但高于下调 6 后的 12。
 * 前置的填充块必须把总长推过 CHURN_MIN_TEXT_CHARS(4000)，否则 detectChurn 会
 * 因长度门限直接返回 null，测不到阈值这条通路。
 */
const shiftText = "第 N 步：检查模块依赖与配置生效情况，记录实际取值并比对预期结果，确认无异常后继续。\n".repeat(140)
	+ Array.from({ length: 14 }, (_, i) => `Let me check item ${i} once.`).join(" ");

// --- ① 未采纳时与出厂完全一致 --------------------------------------------
api.__setOverlay(EMPTY_OVERLAY);
api.__setSettings({ enableLearnedPatterns: true, learnedMaxShift: 20 });
check("空叠加时 effectiveChurnPhrases 返回出厂数组本体", api.effectiveChurnPhrases() === api.__getChurnPhrases());
check("空叠加时阈值等于出厂值", api.effectiveChurnMinHits() === 18, String(api.effectiveChurnMinHits()));
check("空叠加时阈值偏移为 0", api.learnedThresholdShift("churnMinHits") === 0);
check("空叠加时学习层单独触发为假", api.isLearnedOnlyChurnTrigger(learnedOnlyText) === false);
const baselineHits = api.countChurnHits(learnedOnlyText);
check("出厂配置对「再捋一遍」语料零命中", baselineHits === 0, `hits=${baselineHits}`);
check("出厂配置对该语料不判定空转", api.detectChurn(learnedOnlyText) === null);

// --- ② 采纳字面量后命中数上升并触发 --------------------------------------
api.__setOverlay({
	version: 1,
	patterns: [{
		id: "pat_test01",
		detector: "churn",
		kind: "literal-phrase",
		literal: "再捋一遍",
		regexSource: "再捋一遍",
		source: "learned",
		mode: "shadow",
		shadowHits: 0,
		enabled: true
	}],
	thresholdShifts: []
});
const learnedHits = api.countChurnHits(learnedOnlyText);
check("采纳后命中数上升", learnedHits > baselineHits, `${baselineHits} → ${learnedHits}`);
check("采纳后判定为空转", api.detectChurn(learnedOnlyText) !== null);
check("学习层单独触发为真（出厂配置本不会触发）", api.isLearnedOnlyChurnTrigger(learnedOnlyText) === true);
check("有效词表包含出厂词表 + 学习词表", api.effectiveChurnPhrases().length === api.__getChurnPhrases().length + 1);

// 影子期计数：只记账，不改判定
const shadowBefore = api.__getOverlay().patterns[0].shadowHits;
api.noteChurnShadowHits(learnedOnlyText);
const shadowAfter = api.__getOverlay().patterns[0].shadowHits;
check("影子期计数递增", shadowAfter > shadowBefore, `${shadowBefore} → ${shadowAfter}`);

// --- 停用的学习模式不参与判定 --------------------------------------------
api.__setOverlay({
	version: 1,
	patterns: [{ ...EMPTY_OVERLAY.patterns[0], id: "pat_off", literal: "再捋一遍", detector: "churn", kind: "literal-phrase", enabled: false }],
	thresholdShifts: []
});
check("停用的学习模式不参与判定", api.detectChurn(learnedOnlyText) === null);
check("停用后词表回到出厂本体", api.effectiveChurnPhrases() === api.__getChurnPhrases());

// --- ③ 删除叠加后回落 ----------------------------------------------------
api.__setOverlay(EMPTY_OVERLAY);
check("删除叠加后命中数回落", api.countChurnHits(learnedOnlyText) === baselineHits);
check("删除叠加后不再判定空转", api.detectChurn(learnedOnlyText) === null);

// --- enableLearnedPatterns 关闭时叠加完全失效 ----------------------------
api.__setOverlay({
	version: 1,
	patterns: [{ id: "pat_test02", detector: "churn", kind: "literal-phrase", literal: "再捋一遍", mode: "active", enabled: true }],
	thresholdShifts: [{ key: "churnMinHits", delta: -6, mode: "active", enabled: true }]
});
api.__setSettings({ enableLearnedPatterns: false });
check("总开关关闭时词表回到出厂本体", api.effectiveChurnPhrases() === api.__getChurnPhrases());
check("总开关关闭时阈值偏移为 0", api.learnedThresholdShift("churnMinHits") === 0);
check("总开关关闭时不判定空转", api.detectChurn(learnedOnlyText) === null);
check("总开关关闭时学习层单独触发为假", api.isLearnedOnlyChurnTrigger(learnedOnlyText) === false);

// --- 阈值类增补 -----------------------------------------------------------
api.__setSettings({ enableLearnedPatterns: true, learnedMaxShift: 20 });
api.__setOverlay(EMPTY_OVERLAY);
check("出厂阈值下 14 次命中不触发", api.detectChurn(shiftText) === null, `hits=${api.countChurnHits(shiftText)}`);
api.__setOverlay({ version: 1, patterns: [], thresholdShifts: [{ key: "churnMinHits", delta: -6, mode: "active", enabled: true }] });
check("阈值下调 6 后触发", api.detectChurn(shiftText) !== null);
check("有效阈值变为 12", api.effectiveChurnMinHits() === 12, String(api.effectiveChurnMinHits()));
check("阈值类增补属学习层单独触发", api.isLearnedOnlyChurnTrigger(shiftText) === true);

// 偏移幅度被 learnedMaxShift 夹紧
api.__setSettings({ learnedMaxShift: 3 });
check("偏移幅度被 learnedMaxShift 夹紧", api.learnedThresholdShift("churnMinHits") === -3, String(api.learnedThresholdShift("churnMinHits")));

// --- 编译产物确实是字面量匹配 --------------------------------------------
api.__setOverlay({
	version: 1,
	patterns: [{ id: "pat_meta", detector: "churn", kind: "literal-phrase", literal: "(a+)+", mode: "active", enabled: true }],
	thresholdShifts: []
});
const compiled = api.effectiveChurnPhrases().slice(-1)[0];
check("叠加中的元字符字面量被转义", compiled.source === "\\(a\\+\\)\\+", compiled.source);

// 复原，避免影响后续（本文件为独立进程，仅为可读性）
api.__setOverlay(EMPTY_OVERLAY);
api.__setSettings({ enableLearnedPatterns: true, learnedMaxShift: 20 });

if (failed === 0) console.log("\n全部叠加层断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
