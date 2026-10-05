import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { detectNumberRunaway, renderNumberRunawayAnchor };`);
const { detectNumberRunaway, renderNumberRunawayAnchor } = factory();

let failed = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

// 构造真实正样本形态：递增数字流（640+i）. + 分隔符，够长。
function buildPositiveRun(from = 639, count = 500) {
	let out = "";
	for (let i = 0; i < count; i++) {
		out += `${from + i}) ${from + i + 1}.`;
	}
	return out;
}

// 负样本-正常编号列表：每条带文字，数字被字母隔开不成 run
function buildNormalList() {
	let out = "";
	for (let i = 1; i <= 200; i++) {
		out += `${i}. first item description that has words around the number\n`;
	}
	return "some prose prefix. " + out;
}

// 负样本-短数字串
const shortNum = "639.640 641.642 643.644"; // 仅 ~20 字符

// 负样本-散落数字（长文本里随机数字）
function buildScatteredNumbers() {
	let out = "This is a long technical document discussing the stability margins ";
	for (let i = 0; i < 120; i++) {
		out += `and the value stayed below ${400 + i}. matrix index ${i} yields ${i * 2} dB margin. `;
	}
	return out;
}

// 1. 正样本 → 命中
const pos = detectNumberRunaway(buildPositiveRun());
check("正样本（长递增数字流）：返回非 null", pos !== null);
if (pos) {
	check("正样本 increaseRatio ≥ 0.55", pos.increaseRatio >= 0.55, `actual=${pos.increaseRatio.toFixed(3)}`);
	check("正样本 digitRatio ≥ 0.5", pos.digitRatio >= 0.5, `actual=${pos.digitRatio.toFixed(3)}`);
	check("正样本 chars ≥ 500", pos.chars >= 500, `actual=${pos.chars}`);
	check("正样本 trimTo 为数字起点", Number.isInteger(pos.trimTo) && pos.trimTo >= 0);
	check("正样本锚点非空", renderNumberRunawayAnchor(pos).includes("COT anchor"));
}

// 2. 正常编号列表 → null（中间夹字母不成 run）
const listHit = detectNumberRunaway(buildNormalList());
check("负样本-正常编号列表：返回 null", listHit === null, listHit ? `got chars=${listHit.chars}` : "");

// 3. 短数字串 → null
check("负样本-短数字串：返回 null", detectNumberRunaway(shortNum) === null);

// 4. 散落数字 → null
const scat = detectNumberRunaway(buildScatteredNumbers());
check("负样本-散落数字：返回 null", scat === null, scat ? `got chars=${scat.chars}` : "");

// 5. 空/短输入 → null
check("空文本：返回 null", detectNumberRunaway("") === null);
check("短文本(<800)：返回 null", detectNumberRunaway("639.640 641") === null);
check("非字符串：返回 null", detectNumberRunaway(null) === null);

if (failed === 0) console.log("\n全部 detectNumberRunaway 断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);