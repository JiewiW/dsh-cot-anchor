/**
 * D4/D5/D6 插件侧守卫单元测试。
 *
 *  D4「宁可不切」：超长结论点整条保留（不再硬切片加省略号），并发
 *      cot-anchor/point-truncated 事件（suppressReason/keptWhole/originalChars/
 *      maxPointChars + evidence 四元组）；无 evidence 时只保留不发事件。
 *  D5 长度守恒：checkLengthConservation —— body 首行后的正文必须与
 *      "1. …\n2. …" 重建完全一致；被篡改则 ok:false 并给出 expected/actual。
 *  D6 结构配平：checkStructuralBalance（括号族配平）+ insideUnclosedCodeFence
 *      （代码围栏奇偶，D6 复用）。
 */
import { readFileSync } from "node:fs";

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "").replace(/^export \{[^\n]*$/gm, "");

const factory = new Function(
	`${source}; return { extractConclusions, renderAnchor, checkLengthConservation, checkStructuralBalance, insideUnclosedCodeFence, applyRuntimeSettings };`
);
const { extractConclusions, renderAnchor, checkLengthConservation, checkStructuralBalance, insideUnclosedCodeFence, applyRuntimeSettings } = factory();
applyRuntimeSettings({});

let failed = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

// --- D4：超长点「宁可不切」+ point-truncated 事件 ---------------------------
const events = [];
const emitCtx = { emit(name, payload) { events.push({ name, payload }); } };
const longBase =
	"所以根因是配置中心在灰度分组时对旧版本客户端回退到了缓存的默认模板，" +
	"叠加发布窗口内灰度比例从百分之十被临时调整到百分之五十，" +
	"导致一半新流量读到了尚未完成迁移的旧键位";
const longExtra = "同时灰度元数据没有随配置下发同步更新，监控侧按旧维度聚合掩盖了错误率的抬升，告警规则需要增加键位版本维度避免同类事故再被平均数吞掉";
let longPoint = longBase;
while (longPoint.length < 240) longPoint += longExtra;
longPoint = `${longPoint}。`;
check("D4 前置：长点确超 maxPointChars", longPoint.length > 220, `${longPoint.length} chars`);

{
	events.length = 0;
	const evidence = { ctx: emitCtx, sessionId: "s-d4", turn: 3, step: 1 };
	const points = extractConclusions(`铺垫句子不带任何结论标记，只是交代背景与过程。${longPoint}`, 0, 3, 220, evidence);
	check("D4 超长点整条保留（宁可不切）", points.some((p) => p === longPoint), `kept=${points.some((p) => p === longPoint)}`);
	check("D4 保留点不含省略号截断", !points.some((p) => p.endsWith("…")));
	const evt = events.find((e) => e.name === "cot-anchor/point-truncated");
	check("D4 发出 point-truncated 事件", Boolean(evt), evt ? "" : "missing");
	if (evt) {
		const p = evt.payload;
		check("D4 载荷 suppressReason", p.suppressReason === "over-max-point-chars", p.suppressReason);
		check("D4 载荷 keptWhole:true", p.keptWhole === true);
		check("D4 载荷 originalChars=原文长", p.originalChars === longPoint.length, `${p.originalChars}`);
		check("D4 载荷 maxPointChars=220", p.maxPointChars === 220, `${p.maxPointChars}`);
		check("D4 载荷 evidence 四元组", p.sessionId === "s-d4" && p.turn === 3 && p.step === 1 && typeof p.evidenceSeq === "number");
	}
}
{
	events.length = 0;
	const points = extractConclusions(`铺垫句子不带任何结论标记，只是交代背景与过程。${longPoint}`, 0, 3, 220);
	check("D4 无 evidence 时仍整条保留", points.some((p) => p === longPoint));
	check("D4 无 evidence 时只保留不发事件", events.length === 0, `${events.length} events`);
}

// --- D5：长度守恒 ------------------------------------------------------------
{
	const points = ["根因是缓存没有失效", "改法是给键位加一层去重"];
	const body = renderAnchor(points);
	const ok = checkLengthConservation(body, points);
	check("D5 正常锚点守恒通过", ok.ok === true, JSON.stringify(ok));
	const corrupted = body.replace(points[0], `${points[0]}XYZ`);
	const bad = checkLengthConservation(corrupted, points);
	check("D5 被篡改正文守恒失败", bad.ok === false, JSON.stringify(bad));
	check("D5 失败时给出 expected/actual", typeof bad.expectedChars === "number" && typeof bad.actualChars === "number" && bad.expectedChars !== bad.actualChars);
}

// --- D6：结构配平 ------------------------------------------------------------
{
	check("D6 配平括号族通过", checkStructuralBalance("（中文）【小节】{en} 普通文本 (ok) [fine]").ok === true);
	const unclosed = checkStructuralBalance("一段结论 (缺少闭合");
	check("D6 未闭合括号判失败", unclosed.ok === false, JSON.stringify(unclosed.unbalanced));
	const mismatch = checkStructuralBalance("一段结论 (混用]");
	check("D6 错配括号判失败", mismatch.ok === false, JSON.stringify(mismatch.unbalanced));
	check("D6 代码围栏未闭合判 true", insideUnclosedCodeFence("前面的话 ```js\nconst a = 1;") === true);
	check("D6 代码围栏闭合判 false", insideUnclosedCodeFence("```a```") === false);
}

if (failed === 0) console.log("\n全部 D4/D5/D6 守卫断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
