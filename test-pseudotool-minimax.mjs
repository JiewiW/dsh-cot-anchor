/**
 * S4.6 缺陷 5：MiniMax 家族裸 invoke 伪工具方言识别回归。
 *
 * 真实夹具 PSEUDO_MINIMAX_PSEUDO_UNIT（410 字节、15 个噪声单元，含 block3 替换性
 * 损伤）见 test-fixtures.mjs 顶部注释。本文件锁定修复方案（乙 + 多块支路）的边界：
 *  - 真实夹具（原始 / 剥噪）都命中，且 32 字符节奏首次命中点精确为 160 / 96；
 *  - 无包裹双块合成 → 命中（支路二）；无包裹单块 → 有意漏判；
 *  - 6 个误报对照全部不命中（含 60 字无包裹教程式完整示例——否决候选甲的实证）；
 *  - 锚点文本不自激；既有 test-pseudotool.mjs 由全量回归另行保证零回归。
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PSEUDO_MINIMAX_PSEUDO_UNIT } from "./test-fixtures.mjs";

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { hasPseudoToolCall, renderPseudoToolAnchor };`);
const { hasPseudoToolCall, renderPseudoToolAnchor } = factory();

let failed = 0;
function check(label, actual, expected) {
	const ok = actual === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${label} → ${actual}（期望 ${expected}）`);
	if (!ok) failed += 1;
}

// --- 夹具固化指标（字节级，防误改/误"修整齐"） ------------------------------
const unit = PSEUDO_MINIMAX_PSEUDO_UNIT;
check("夹具 byteLength=410", Buffer.byteLength(unit), 410);
check("夹具噪声单元 15 个（通用噪声正则）", (unit.match(/\]?<\]\w+\[\]?>?\[?/g) || []).length, 15);
check("夹具 sha256 固定", createHash("sha256").update(unit).digest("hex"),
	"2f4ecb50a753f13a76f5c47836b064d393585a2374d807bdecc6d86d50dd1ee4");
check("block3 替换性损伤原样保留（=\" 被吞）", unit.includes('<invoke name]<]minimax[>[skill">'), true);

// 沿 32 字符检查节奏求首次命中前缀长度（内核检查间隔口径）。
function gridFirstHit(text) {
	for (let n = 32; n <= text.length; n += 32) {
		if (hasPseudoToolCall(text.slice(0, n))) return n;
	}
	return -1;
}

// --- 真实夹具：原始 / 剥噪 --------------------------------------------------
check("原始夹具整体命中（支路一）", hasPseudoToolCall(unit), true);
check("原始夹具 32 节奏首次命中点精确为 160", gridFirstHit(unit), 160);
check("首次命中点实现余量 ≤192", gridFirstHit(unit) <= 192 ? 160 : -1, 160);

const stripped = unit.split("]<]minimax[>[").join("");
check("剥噪后长度为 215", stripped.length, 215);
check("剥噪版整体命中（靠 block1/2）", hasPseudoToolCall(stripped), true);
check("剥噪版 32 节奏首次命中点为 96", gridFirstHit(stripped), 96);

// --- 无包裹合成：双块命中 / 单块有意漏判 ------------------------------------
// 用字符码拼标签，避免在本文件正文里平铺触发串（也避免软切自激）。
const LT = String.fromCharCode(60), GT = String.fromCharCode(62);
function bareBlock(n) {
	return `${LT}invoke name="skill${n}"${GT}${LT}name${GT}s${n}${LT}/name${GT}${LT}/invoke${GT}`;
}
check("无包裹双块合成 → 命中（支路二）", hasPseudoToolCall(bareBlock(1) + bareBlock(2)), true);
check("无包裹单块合成 → 不命中（与教程客观同形，有意漏判）", hasPseudoToolCall(bareBlock(1)), false);

// --- 6 个误报对照（全部不命中） ---------------------------------------------
const falsePositives = [
	["散文讨论该方言（无闭合）",
		"prose discussing a bare invoke opener with a name attribute, but no closing tag anywhere in this sentence"],
	["仅开标签起草（无闭）",
		"next step: " + LT + 'invoke name="skill"' + GT],
	["无 name 属性的普通 XML invoke 标签对",
		LT + "invoke" + GT + "run the task now" + LT + "/invoke" + GT],
	["60 字无包裹教程式完整示例（否决候选甲的实证）",
		LT + 'invoke name="skill"' + GT + "load the polling skill and follow it" + LT + "/invoke" + GT],
	["教程单块带一个 parameter（不引入 parameter 共现）",
		LT + 'invoke name="skill"' + GT + LT + 'parameter name="x"' + GT + "1" + LT + "/parameter" + GT + LT + "/invoke" + GT],
	["插件自身锚点文本（防自激振荡）",
		renderPseudoToolAnchor(false, null)]
];
for (const [label, text] of falsePositives) {
	check(`误报对照不命中：${label}（${text.length} 字）`, hasPseudoToolCall(text), false);
}

if (failed === 0) console.log("\n全部 MiniMax 裸 invoke 方言断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
