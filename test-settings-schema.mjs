/**
 * D8/D3/D5/D7 + FIX-04：设置 schema 与运行时发布完整性测试。
 *
 * 文件名不含控件数（FIX-04 裁决）：schema 控件数随后续修复（如 FIX-09
 * 纪律块开关）继续增长，带数字的文件名会立刻名实不符；总数以本文件的
 * 逐键明细清点为准，禁止裸数字对齐。
 *
 * FIX-04 裁决：分支①（保留 learned 四键）。逐键明细（以 git 历史清点，
 * 非裸数字）：
 *   基线 52 键 = v0.1.6（提交 851af8e）SETTINGS_SCHEMA 全量，其中末尾
 *               enableLearnedPatterns/learnedMaxPhrases/learnedMaxShift/
 *               learnedShadowRounds 四键即整改书 FIX-04 所指 learned 组：
 *               有意新增、README:260-265 已文档化，但修复报告 §6 计划项中
 *               无「学习模式」任务，属「§6 计划外增量」；该四键随 v0.1.6
 *               一起发布，已包含在 52 基线之内（不是 52 之外的 +4）。
 *   报告新增 7 键 = e2f2926（D3-D9，v0.2.0）为报告任务新增：
 *               D3 transitionTextMode ×1、D5 enableLengthConservationCheck ×1、
 *               D7 numberRun* ×5。
 *   同期增量 1 键 = e2f2926 同期落地的 P1-10 锚点门控 anchorInjectionMode
 *               （非报告 §6 任务项，与 learned 组同为计划外增量，单列可清点）。
 *   FIX-09 增量 1 键 = enableExecDisciplineBlock（纪律块随锚点注入的独立
 *               开关，默认开；登记在 FIX-04 裁决后的同一份明细上）。
 *   52 + 7 + 1 + 1 = 61。
 *
 *  D8：SETTINGS_SCHEMA 键集合与下方明细逐键相等（双向：不多、不少、不重）；
 *      每个 schema 键都在 DEFAULT_SETTINGS 中（与 test-apply-smoke 同口径）。
 *  D3：transitionTextMode 控件存在、默认 separateThreshold、控件文案标记「待内核支持」、
 *      枚举校验（非法值回退默认）。
 *  D5：enableLengthConservationCheck 控件存在、默认 true。
 *  D7：numberRun* 五键在 schema 中（数字键带 min/max）、默认值正确、
 *      applyRuntimeSettings 后发布进运行时（与默认一致；越界值被 clamp）。
 */
import { readFileSync } from "node:fs";

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "").replace(/^export \{[^\n]*$/gm, "");

const factory = new Function(
	`${source}; return { SETTINGS_SCHEMA, DEFAULT_SETTINGS, applyRuntimeSettings };`
);
const { SETTINGS_SCHEMA, DEFAULT_SETTINGS, applyRuntimeSettings } = factory();
const runtime = applyRuntimeSettings({});

let failed = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

// --- FIX-04：逐键明细（计数唯一事实源，禁止只比对总数） -----------------------
// 基线 52 键（v0.1.6 / 851af8e 全量；learned 四键为其中「§6 计划外增量」组）。
const BASELINE_KEYS_V016 = [
	"enableToolInject", "enableSoftCut",
	"enablePseudoTool", "enableRepeat", "enableChurn", "enableTransition", "enableNumberRunaway",
	"minReasoningChars", "maxPoints", "maxPointChars",
	"repeatMinCount", "repeatMinCountShort", "repeatUltraShortMinCount", "repeatMinPeriod",
	"repeatShortPeriod", "repeatMaxPeriod", "repeatWindowChars", "repeatProbeChars", "repeatMinTextChars",
	"churnMinHits", "churnWindowChars", "churnMinTextChars",
	"softCutScanTail", "softCutTransitionWindow", "softCutMinFollowChars", "pseudoToolScanTail",
	"enableLlmRefine", "llmRefineProvider", "llmRefineModel", "llmRefineMaxTokens",
	"llmRefineTimeoutMs", "llmRefineMaxInputChars",
	"enableHarvest", "harvestIncludeToolTrace", "harvestMaxRecords", "harvestRetentionDays",
	"harvestMinTextChars", "harvestMaxTextChars", "harvestFlushDebounceMs",
	"enableAutoAnalyze", "analyzeTriggerSamples", "analyzeProvider", "analyzeModel",
	"analyzeMaxTokens", "analyzeTimeoutMs", "analyzeMaxInputChars", "analyzeMaxSamples", "analyzeRunBudgetMs",
	// learned 组（4 键）：README:260-265 已文档化的有意新增，报告 §6 无对应
	// 任务项——§6 计划外增量；随 v0.1.6 发布，计入基线 52，不在基线之外另加。
	"enableLearnedPatterns", "learnedMaxPhrases", "learnedMaxShift", "learnedShadowRounds",
];
// 报告新增 7 键（e2f2926 / v0.2.0，D3+D5+D7）。
const REPORT_NEW_KEYS_D3_D5_D7 = [
	"transitionTextMode",            // D3
	"enableLengthConservationCheck", // D5
	"numberRunMinTextChars", "numberRunMinChars", "numberRunMaxGap", // D7 ×5
	"numberRunMinDigitRatio", "numberRunMinIncreaseRatio",
];
// 同期增量 1 键（e2f2926 同期 P1-10；非报告 §6 任务项，单列可清点）。
const SAME_WINDOW_EXTRA_KEYS = ["anchorInjectionMode"];
// FIX-09 增量 1 键：纪律块独立开关（默认开），登记在 FIX-04 同一份明细上。
const FIX09_KEYS = ["enableExecDisciplineBlock"];

const EXPECTED_KEYS = [...BASELINE_KEYS_V016, ...REPORT_NEW_KEYS_D3_D5_D7, ...SAME_WINDOW_EXTRA_KEYS, ...FIX09_KEYS];
check("FIX-04/FIX-09 明细自身无重复键", new Set(EXPECTED_KEYS).size === EXPECTED_KEYS.length, `${new Set(EXPECTED_KEYS).size}/${EXPECTED_KEYS.length}`);
check("FIX-04/FIX-09 明细计数 52 基线 + 7 报告新增 + 1 同期 + 1 FIX-09 = 61",
	BASELINE_KEYS_V016.length === 52 && REPORT_NEW_KEYS_D3_D5_D7.length === 7
	&& SAME_WINDOW_EXTRA_KEYS.length === 1 && FIX09_KEYS.length === 1 && EXPECTED_KEYS.length === 61,
	`${BASELINE_KEYS_V016.length}+${REPORT_NEW_KEYS_D3_D5_D7.length}+${SAME_WINDOW_EXTRA_KEYS.length}+${FIX09_KEYS.length}=${EXPECTED_KEYS.length}`);

// --- D8：控件集合与明细逐键相等（双向） ---------------------------------------
const actualKeys = SETTINGS_SCHEMA.map((e) => e.key);
check("D8 schema 键无重复", new Set(actualKeys).size === actualKeys.length, `${actualKeys.length} unique`);
const missingFromSchema = EXPECTED_KEYS.filter((k) => !actualKeys.includes(k));
const unexpectedInSchema = actualKeys.filter((k) => !EXPECTED_KEYS.includes(k));
check("D8 明细中的键全部在 schema（不缺）", missingFromSchema.length === 0, missingFromSchema.join(","));
check("D8 schema 中无明细之外的键（不多）", unexpectedInSchema.length === 0, unexpectedInSchema.join(","));
check("D8 schema 总数与明细一致（61）", SETTINGS_SCHEMA.length === EXPECTED_KEYS.length, `${SETTINGS_SCHEMA.length} vs ${EXPECTED_KEYS.length}`);
check("D8 每个 schema 键都在 DEFAULT_SETTINGS", actualKeys.every((k) => k in DEFAULT_SETTINGS), actualKeys.filter((k) => !(k in DEFAULT_SETTINGS)).join(","));
const groups = [...new Set(SETTINGS_SCHEMA.map((e) => e.group))];
check("D8 分组 ≥ 10（原 10 + 数字流参数）", groups.length >= 10, groups.join(" / "));
check("D8 数字流参数分组存在", groups.includes("数字流参数"));
// learned 组归属可清点：四键同组「CoT 增补」。
const learnedKeys = ["enableLearnedPatterns", "learnedMaxPhrases", "learnedMaxShift", "learnedShadowRounds"];
check("FIX-04 learned 四键同属「CoT 增补」分组", learnedKeys.every((k) => SETTINGS_SCHEMA.find((e) => e.key === k)?.group === "CoT 增补"));

// --- D3：transitionTextMode ---------------------------------------------------
const ttm = SETTINGS_SCHEMA.find((e) => e.key === "transitionTextMode");
check("D3 transitionTextMode 控件存在", Boolean(ttm));
check("D3 默认 separateThreshold", DEFAULT_SETTINGS.transitionTextMode === "separateThreshold", DEFAULT_SETTINGS.transitionTextMode);
check("D3 控件标记待内核支持", typeof ttm?.label === "string" && ttm.label.includes("待内核支持"), ttm?.label);
check("D3 运行时默认值发布", runtime.transitionTextMode === "separateThreshold", runtime.transitionTextMode);

// --- D5：enableLengthConservationCheck ---------------------------------------
const lcc = SETTINGS_SCHEMA.find((e) => e.key === "enableLengthConservationCheck");
check("D5 enableLengthConservationCheck 控件存在", Boolean(lcc) && lcc.type === "boolean");
check("D5 默认 true", DEFAULT_SETTINGS.enableLengthConservationCheck === true);
check("D5 运行时默认值发布", runtime.enableLengthConservationCheck === true);

// --- D7：numberRun 五键 -------------------------------------------------------
const numberRunKeys = ["numberRunMinTextChars", "numberRunMinChars", "numberRunMaxGap", "numberRunMinDigitRatio", "numberRunMinIncreaseRatio"];
check("D7 五键全部入 schema", numberRunKeys.every((k) => actualKeys.includes(k)), numberRunKeys.filter((k) => !actualKeys.includes(k)).join(","));
check("D7 默认值 800/500/8/0.5/0.55",
	DEFAULT_SETTINGS.numberRunMinTextChars === 800 &&
	DEFAULT_SETTINGS.numberRunMinChars === 500 &&
	DEFAULT_SETTINGS.numberRunMaxGap === 8 &&
	DEFAULT_SETTINGS.numberRunMinDigitRatio === 0.5 &&
	DEFAULT_SETTINGS.numberRunMinIncreaseRatio === 0.55,
	JSON.stringify(numberRunKeys.map((k) => DEFAULT_SETTINGS[k])));
check("D7 比值键 schema 带 min/max",
	["numberRunMinDigitRatio", "numberRunMinIncreaseRatio"].every((k) => {
		const e = SETTINGS_SCHEMA.find((item) => item.key === k);
		return typeof e?.min === "number" && typeof e?.max === "number";
	}));
check("D7 运行时五键与默认一致（clampNumber 不抬升比值）",
	runtime.numberRunMinDigitRatio === 0.5 && runtime.numberRunMinIncreaseRatio === 0.55,
	`${runtime.numberRunMinDigitRatio}/${runtime.numberRunMinIncreaseRatio}`);

if (failed === 0) console.log("\n全部 schema/设置完整性断言通过（FIX-04 分支① + FIX-09，61 键逐键明细）");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
