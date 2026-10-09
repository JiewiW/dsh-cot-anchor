import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { detectNumberRunaway, renderNumberRunawayAnchor, applyRuntimeSettings, DEFAULT_SETTINGS };`);
const { detectNumberRunaway, renderNumberRunawayAnchor, applyRuntimeSettings, DEFAULT_SETTINGS } = factory();
// D7：阈值改走运行时设置，测试前先发布默认值。
applyRuntimeSettings({});

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

// 6. D7：numberRun 五键运行时生效（修复前读 const 绑定，改设置无效）。
// 注意 clampNumber 对 ratio 类键做 Math.round（半值上取整），ratio 实际只能取 0/1——
// 这里用 1 证明键被运行时读取（默认阈值下命中的样本在阈值为 1 时必须落空）。
const MIXED_RUN = (() => {
	let out = "", v = 639;
	for (let i = 0; i < 90; i++) { out += `${v}) ${v + 1}.`; v += i % 5 === 4 ? -5 : 1; }
	return out;
})();
check("D7-混合递增样本默认阈值命中（increaseRatio≈0.8）", detectNumberRunaway(MIXED_RUN) !== null,
	detectNumberRunaway(MIXED_RUN) ? `ratio=${detectNumberRunaway(MIXED_RUN).increaseRatio.toFixed(2)}` : "null");
applyRuntimeSettings({ numberRunMinTextChars: 50000 });
check("D7-numberRunMinTextChars 运行时调大：落空", detectNumberRunaway(buildPositiveRun()) === null);
applyRuntimeSettings({ numberRunMinChars: 20000 });
check("D7-numberRunMinChars 运行时调大：落空", detectNumberRunaway(buildPositiveRun()) === null);
applyRuntimeSettings({ numberRunMinDigitRatio: 1 });
check("D7-numberRunMinDigitRatio 运行时=1：落空", detectNumberRunaway(buildPositiveRun()) === null);
// 专用样本：所有相邻 gap=2（"639)  640..640)  641.."），默认 MAX_GAP=8 连成 run，
// MAX_GAP 压到 1 时每对都断开 → 全部单 token run，span<500 → 落空。
const buildGappedRun = (count = 80) => {
	let out = "", v = 639;
	for (let i = 0; i < count; i++) { out += `${v})  ${v + 1}..`; v += 1; }
	return out;
};
applyRuntimeSettings({});
check("D7-gap2 样本默认 MAX_GAP=8：命中", detectNumberRunaway(buildGappedRun()) !== null);
applyRuntimeSettings({ numberRunMaxGap: 1 });
check("D7-numberRunMaxGap 运行时=1：全断开落空", detectNumberRunaway(buildGappedRun()) === null);
applyRuntimeSettings({ numberRunMinIncreaseRatio: 1 });
check("D7-numberRunMinIncreaseRatio 运行时=1：混合样本落空", detectNumberRunaway(MIXED_RUN) === null);
applyRuntimeSettings({ numberRunMinTextChars: 100, numberRunMinChars: 50 });
const shortHit = detectNumberRunaway(buildPositiveRun(639, 12));
check("D7-numberRunMinChars 运行时调低到 50：短样本命中", shortHit !== null, shortHit ? `chars=${shortHit.chars}` : "");
applyRuntimeSettings({});
check("D7-恢复默认：正样本重新命中", detectNumberRunaway(buildPositiveRun()) !== null);

if (failed === 0) console.log("\n全部 detectNumberRunaway 断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);