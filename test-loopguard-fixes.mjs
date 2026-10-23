/**
 * loopguard 三项修复单元测试（node:test）。
 *
 * 覆盖：
 *   ① CHURN_ACTION_PHRASES / detectActionChurn —— 行动提议型空转
 *   ② normalizeForNGram / computeNGramFingerprint / detectNGramLoop —— 数字归一 + n-gram 语义指纹
 *   ④ countInvestigativePrefixes / countActionVsExecVerbs / shouldTightenInvestigativePrefix —— 调查前缀分组复核
 *
 * 全是纯文本输入 + 正则/计数，运行时零 LLM，与现有 detector 并行不破坏原逻辑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── 模块加载：与包根 test-*.mjs 同法 ──
let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return {
	CHURN_ACTION_PHRASES, CHURN_ACTION_MIN_HITS,
	detectChurn, detectActionChurn, countChurnHits, renderActionChurnAnchor,
	normalizeForNGram, computeNGramFingerprint, detectNGramLoop, renderNGramLoopAnchor,
	countInvestigativePrefixes, countActionVsExecVerbs, shouldTightenInvestigativePrefix,
	INVESTIGATIVE_PREFIX_REPEAT_MAX, INVESTIGATIVE_PREFIX_WINDOW_CHARS,
	NGram_PHRASE_MIN, NGram_MIN_COUNT, NGram_COVERAGE_RATIO
};`);
const api = factory();

// ── 样本与夹具 ──

/** 真实泄漏样本（3512 字，CHURN_WINDOW_CHARS=3000 内 tail ） */
const leakSample = readFileSync("D:\\dsh\\logs\\leak-message-fe11f93f.txt", "utf8");

/**
 * 正常中文技术长文：每段句式各异（200 段，用 5 种不同结构轮换）
 * 行动动词稀疏（每 11 段 1 次让我看看 / 每 17 段 1 次我先查一下，远低于阈值）
 * 数字归一后也不会产生高频 n-gram（每段后半句结构不同）
 */
const sentenceVariants = [
	(i) => `第 ${i} 步：检查模块 ${i} 的初始化顺序与依赖关系，确认第 ${i} 项配置在当前环境下生效，并记录其实际取值。`,
	(i) => `然后我们看一下第 ${i} 项参数传递，它在调用链中的位置是 ${i}，需要验证是否存在竞态条件。`,
	(i) => `关于第 ${i} 个异常处理分支，日志里的错误码 ${i} 表明问题出在数据库连接层，而不是业务逻辑。`,
	(i) => `最后补充一下第 ${i} 次重构后的影响面，相关测试用例新增了 ${i} 条覆盖边界场景，回归全部通过。`,
	(i) => `现在验证第 ${i} 个接口的 HTTP 状态码和响应体结构，确保字段命名和文档一致、没有拼写错误。`
];
const normalChinese = Array.from({ length: 200 }, (_, i) => {
	const variant = sentenceVariants[i % sentenceVariants.length];
	const base = variant(i);
	const addenda = [];
	if (i % 11 === 0) addenda.push(" 让我再确认一次第 " + i + " 项的边界条件。");
	if (i % 17 === 0) addenda.push(" 我先看一下输出目录里有没有残留文件。");
	if (i % 23 === 0) addenda.push(" 执行工具调用：npm test module-" + i + " 来验证修复。");
	return base + addenda.join("");
}).join("\n");

/** 反向夹具：1-3 次合法 "让我 curl 一下"（不达到阈值） */
const normalSingleProposal = Array.from({ length: 60 }, (_, i) =>
	`Step ${i}: the pipeline runs module ${i} and validates output ${i}. The ${i}th check verifies error handling.`
).join("\n") + "\n\n让我 curl 一下 http://localhost:3099/health";

// ═══════════════════════════════════════════════════════════
// 修复① 正向：detectActionChurn 在泄漏样本上命中
// ═══════════════════════════════════════════════════════════

test("① detectActionChurn — 泄漏样本 tail3000 命中超阈值", () => {
	const result = api.detectActionChurn(leakSample);
	assert.ok(result !== null, `应命中，但返回 null`);
	console.log(`     行动正则命中 ${result.hits} 次（阈值=${api.CHURN_ACTION_MIN_HITS}）`);
});

test("① CHURN_ACTION_PHRASES 在泄漏样本 tail3000 各条正则统计", () => {
	const tail = leakSample.slice(-3000);
	const perPattern = [];
	for (const re of api.CHURN_ACTION_PHRASES) {
		re.lastIndex = 0;
		const m = tail.match(re);
		const n = m ? m.length : 0;
		perPattern.push({ re: re.source.slice(0, 32), n });
	}
	console.log("     " + perPattern.map((p) => `${p.n}×[${p.re}]`).join(" + "));
	const sum = perPattern.reduce((s, p) => s + p.n, 0);
	assert.ok(sum >= api.CHURN_ACTION_MIN_HITS, `合计 ${sum} < 阈值 ${api.CHURN_ACTION_MIN_HITS}`);
});

test("① renderActionChurnAnchor 包含行动提议语境", () => {
	const anchor = api.renderActionChurnAnchor({ hits: 30 });
	assert.ok(anchor.includes("行动提议"), "应包含行动提议语境");
	assert.ok(anchor.includes("curl"), "应提到 curl");
});

// ═══════════════════════════════════════════════════════════
// 修复① 反向：普通技术文本零误报
// ═══════════════════════════════════════════════════════════

test("① 反向 — 正常中文技术长文不触发 detectActionChurn", () => {
	const result = api.detectActionChurn(normalChinese);
	assert.equal(result, null, `普通技术文本不应命中，但命中 ${result?.hits ?? 0}`);
	const tail = normalChinese.slice(-3000);
	const hits = api.countChurnHits(normalChinese, api.CHURN_ACTION_PHRASES);
	console.log(`     行动正则在普通文本 tail3000 命中 ${hits} 次（阈值=${api.CHURN_ACTION_MIN_HITS}）`);
});

test("① 反向 — 单次行动提议不触发（构造夹具 1-3 次让我 curl）", () => {
	const result = api.detectActionChurn(normalSingleProposal);
	assert.equal(result, null, `1-3 次行动提议不应命中，但命中 ${result?.hits ?? 0}`);
});

test("① 反向 — detectChurn 原逻辑仍正常工作（基线未破坏）", () => {
	const original = Array.from({ length: 600 }, (_, i) =>
		`Let me reconsider hypothesis ${i}: actually the ${i}th reading is probably wrong, let me re-read part ${i} and think again. Hmm.`
	).join(" ");
	const hit = api.detectChurn(original);
	assert.ok(hit !== null, "思维重启型 churn 应仍命中");
});

// ═══════════════════════════════════════════════════════════
// 修复② 正向：n-gram 指纹在"连续反复句式"上命中
// 泄漏样本的循环被 DIGIT 归一 + LISTENING 标签打散，n-gram 捕不到——
// 但修复①(75 hits)和修复④(triggered)已接管；这里换一个 n-gram 的真实猎物：
// 连续反复中文短语（"我再重新梳理一下结论...我再重新梳理一下结论..."）
// ═══════════════════════════════════════════════════════════

/** 真实语义漂移样本：连续反复同一思维句式，findRepeatingTail 捕不到（尾段每次在扩展） */
const ngramLoopFixture = Array.from({ length: 300 }, (_, i) =>
	`我再重新梳理一下结论，让我再重新思考一次第 ${i} 项为什么不成立，我再重新过一遍证据链看看有没有遗漏。`
).join("");

test("② normalizeForNGram — 数字归一 + 小写 + 去标点", () => {
	const norm = api.normalizeForNGram("好，3099 LISTENING=True PID=31760, let me curl 一下！");
	assert.ok(!/31760|3099/.test(norm), "数字应归一为 DIGIT");
	assert.ok(norm.includes("DIGIT"), "归一符 DIGIT 应出现");
});

test("② detectNGramLoop — 连续反复句式被 n-gram 定位", () => {
	const result = api.detectNGramLoop(ngramLoopFixture);
	assert.ok(result !== null, `应定位到高频短语，但返回 null`);
	console.log(`     最高频短语="${result.maxGram}" 出现 ${result.count} 次，覆盖占比 ${(result.coverage * 100).toFixed(1)}%`);
	assert.ok(result.count >= api.NGram_MIN_COUNT, `count=${result.count} < 阈值=${api.NGram_MIN_COUNT}`);
	assert.ok(result.coverage >= api.NGram_COVERAGE_RATIO, `coverage=${result.coverage} < 阈值=${api.NGram_COVERAGE_RATIO}`);
});

test("② renderNGramLoopAnchor 包含指纹信息", () => {
	const anchor = api.renderNGramLoopAnchor({ maxGram: "让我curl", count: 20, coverage: 0.25 });
	assert.ok(anchor.includes("让我curl"), "应包含高频短语");
});

// ═══════════════════════════════════════════════════════════
// 修复② 反向：正常文本零误报
// ═══════════════════════════════════════════════════════════

test("② 反向 — 正常中文长文无高频 n-gram 命中", () => {
	const result = api.detectNGramLoop(normalChinese);
	assert.equal(result, null, `正常技术长文不应有漂移循环，但返回 ${JSON.stringify(result)}`);
});

// ═══════════════════════════════════════════════════════════
// 修复④ 正向：调查前缀分组复核
// ═══════════════════════════════════════════════════════════

test("④ countInvestigativePrefixes — 泄漏样本 '我先' 重复≥INVESTIGATIVE_PREFIX_REPEAT_MAX", () => {
	const counts = api.countInvestigativePrefixes(leakSample);
	const top = counts[0];
	console.log(`     Top 前缀="${top.prefix}" 命中 ${top.count} 次（阈值=${api.INVESTIGATIVE_PREFIX_REPEAT_MAX}）`);
	assert.ok(top.count >= api.INVESTIGATIVE_PREFIX_REPEAT_MAX, "应达收紧阈值");
});

test("④ countActionVsExecVerbs — 泄漏样本动作动词远多于执行动词", () => {
	const { actionCount, execCount } = api.countActionVsExecVerbs(leakSample);
	console.log(`     action=${actionCount} exec=${execCount} 比值=${execCount > 0 ? (actionCount / execCount).toFixed(1) : 'inf'}`);
	assert.ok(actionCount > 0, "动作动词应 > 0");
	assert.ok(execCount < actionCount * 0.5, "执行动词应远少于动作动词");
});

test("④ shouldTightenInvestigativePrefix — 泄漏样本触发收紧", () => {
	const info = api.shouldTightenInvestigativePrefix(leakSample);
	assert.ok(info.triggered === true, `应触发收紧，但 triggered=${info.triggered} top=${info.topPrefix} repeat=${info.repeatCount} action=${info.actionCount} exec=${info.execCount}`);
	console.log(`     triggered=true top=${info.topPrefix} repeat=${info.repeatCount} action=${info.actionCount} exec=${info.execCount}`);
});

// ═══════════════════════════════════════════════════════════
// 修复④ 反向：正常技术文本不触发收紧
// ═══════════════════════════════════════════════════════════

test("④ 反向 — 正常技术文本调查前缀不重复 ≥MAX + 执行动词活跃 → 不触发收紧", () => {
	const info = api.shouldTightenInvestigativePrefix(normalChinese);
	assert.equal(info.triggered, false, `正常文本不应触发收紧（top=${info.topPrefix} repeat=${info.repeatCount} action=${info.actionCount} exec=${info.execCount}）`);
});

// ── 汇总 ──
const { exitCode } = process;
if (exitCode === 0) console.log("\n✓ 全部 loopguard 修复测试通过");
