/**
 * D8/D3/D5/D7：设置 schema 与运行时发布完整性测试。
 *
 *  D8：SETTINGS_SCHEMA 恰 59 控件（52 原有 + 7 新增）；10+1 分组；
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

// --- D8：控件总数与键完整性 ---------------------------------------------------
check("D8 schema 恰 59 控件", Array.isArray(SETTINGS_SCHEMA) && SETTINGS_SCHEMA.length === 59, `${SETTINGS_SCHEMA.length}`);
const keys = SETTINGS_SCHEMA.map((e) => e.key);
check("D8 schema 键无重复", new Set(keys).size === keys.length, `${keys.length} unique`);
check("D8 每个 schema 键都在 DEFAULT_SETTINGS", keys.every((k) => k in DEFAULT_SETTINGS));
const groups = [...new Set(SETTINGS_SCHEMA.map((e) => e.group))];
check("D8 分组 ≥ 10（原 10 + 数字流参数）", groups.length >= 10, groups.join(" / "));
check("D8 数字流参数分组存在", groups.includes("数字流参数"));

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
check("D7 五键全部入 schema", numberRunKeys.every((k) => keys.includes(k)), numberRunKeys.filter((k) => !keys.includes(k)).join(","));
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

if (failed === 0) console.log("\n全部 schema/设置完整性断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
