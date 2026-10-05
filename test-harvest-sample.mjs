import { readFileSync } from "node:fs";

/**
 * 采集层（L1）单元测试：断言样本记录模型与截断上限。
 *
 * 沿用既有 test-*.mjs 约定：读 lib/index.js 源码、剥掉 import/export 行、
 * 用 new Function 取出内部函数。采集层不碰文件系统，因此可以直接调用。
 */
const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return {
	buildHarvestSample,
	collectTagCandidates,
	collectHarvestLocalSignals,
	parseHarvestFindings,
	mergeHarvestProposal,
	harvestProposalKey,
	harvestSamplePriority,
	renderAnalyzeBatch,
	compileLearnedLiteralPhrase,
	selfCheckLearnedLiteral,
	normalizeHarvestFeatureSpec
};`);
const api = factory();

let failed = 0;
/** 断言并打印一行结果。 */
function check(label, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
	if (!condition) failed += 1;
}

// --- 样本记录模型 ---------------------------------------------------------
const shortText = "正常思考：读文件、确认接口、准备改代码。";
const shortSample = api.buildHarvestSample({
	id: "smp_test0001",
	ts: 1759298400000,
	sessionId: "sess-1",
	reasoningChars: shortText.length,
	fullVisibleText: shortText,
	toolCalls: [{ name: "read", isError: false }],
	outcome: "completed"
});

check("短文本样本不存全文", shortSample.reasoningFull === undefined);
check("样本带 id/ts/outcome", shortSample.id === "smp_test0001" && shortSample.ts === 1759298400000 && shortSample.outcome === "completed");
check("样本 analyzedAt 初始为 null", shortSample.analyzedAt === null);
check("短文本头部切片等于原文", shortSample.reasoningHead === shortText);
check("尾部切片不超过上限", shortSample.reasoningTail.length <= 1200);
check("localSignals 复用检测器字段齐全",
	typeof shortSample.localSignals.detectorHits.repeat === "object" || shortSample.localSignals.detectorHits.repeat === null);
check("localSignals 含工具轨迹", Array.isArray(shortSample.localSignals.toolCalls) && shortSample.localSignals.toolCalls.length === 1);

// --- 深度档：长文本触发全文存储并截断 -------------------------------------
const longText = "第 N 步：检查模块依赖与配置生效情况，记录实际取值并比对预期。\n".repeat(400);
const longSample = api.buildHarvestSample({
	id: "smp_test0002",
	ts: Date.now(),
	sessionId: "sess-1",
	reasoningChars: longText.length,
	fullVisibleText: longText,
	toolCalls: [],
	outcome: "completed"
});
check("长文本（>3000 字）存全文", typeof longSample.reasoningFull === "string" && longSample.reasoningFull.length > 0);
check("全文被截断到 harvestMaxTextChars=8000", longSample.reasoningFull.length === 8000, `len=${longSample.reasoningFull.length}`);
check("全文保留的是尾部", longText.endsWith(longSample.reasoningFull));

// --- 深度档：短文本但带标签候选也算异常 -----------------------------------
const tagText = "我准备调用工具 <ds:invoke name=\"read\"> 读取配置。";
const tagSample = api.buildHarvestSample({
	id: "smp_test0003",
	ts: Date.now(),
	sessionId: "sess-2",
	reasoningChars: tagText.length,
	fullVisibleText: tagText,
	toolCalls: [],
	outcome: "completed"
});
check("无工具调用但含标签候选 → 存全文", typeof tagSample.reasoningFull === "string");
check("标签候选被扫出且保留属性", tagSample.localSignals.tagCandidates.includes('<ds:invoke name="read">'),
	JSON.stringify(tagSample.localSignals.tagCandidates));

// --- 标签候选的边界 -------------------------------------------------------
const tags = api.collectTagCandidates("<a> <b> <a> <c> <d>");
check("标签候选去重且保序", tags.join(",") === "<a>,<b>,<c>,<d>", tags.join(","));
const manyTags = api.collectTagCandidates(Array.from({ length: 40 }, (_, i) => `<tag${i}>`).join(" "));
check("标签候选数量上限 12", manyTags.length === 12, `len=${manyTags.length}`);
check("普通文本无标签候选", api.collectTagCandidates("没有任何尖括号的普通句子。").length === 0);

// --- 软切断与锚点信号被记录 ----------------------------------------------
const signalSample = api.buildHarvestSample({
	id: "smp_test0004",
	ts: Date.now(),
	sessionId: "sess-3",
	reasoningChars: 10,
	fullVisibleText: "短文本。",
	toolCalls: [],
	softCutFired: true,
	anchorPoints: 2,
	anchorText: "1. 结论一"
});
check("softCutFired 被写入信号", signalSample.localSignals.softCutFired === true);
check("anchorPoints/anchorText 被写入信号",
	signalSample.localSignals.anchorPoints === 2 && signalSample.localSignals.anchorText === "1. 结论一");

// --- 批次优先级：异常样本排前 --------------------------------------------
check("伪调用样本优先级最高", api.harvestSamplePriority({ localSignals: { detectorHits: { pseudoTool: true } } }) === 0);
check("空转样本次之", api.harvestSamplePriority({ localSignals: { detectorHits: { churn: { hits: 20 } } } }) === 1);
check("普通样本优先级最低", api.harvestSamplePriority({ localSignals: { detectorHits: {} } }) === 3);

// --- 批次渲染受字符预算约束 ----------------------------------------------
const rendered = api.renderAnalyzeBatch([
	{ id: "smp_a", reasoningChars: 10, reasoningFull: "AAA", localSignals: { detectorHits: {}, tagCandidates: [], toolCalls: [] } },
	{ id: "smp_b", reasoningChars: 10, reasoningFull: "BBB", localSignals: { detectorHits: {}, tagCandidates: [], toolCalls: [] } }
], 100000);
check("批次渲染包含样本 id", rendered.includes("### smp_a") && rendered.includes("### smp_b"));
const tight = api.renderAnalyzeBatch([
	{ id: "smp_a", reasoningChars: 10, reasoningFull: "A".repeat(5000), localSignals: { detectorHits: {}, tagCandidates: [], toolCalls: [] } },
	{ id: "smp_b", reasoningChars: 10, reasoningFull: "B".repeat(5000), localSignals: { detectorHits: {}, tagCandidates: [], toolCalls: [] } }
], 6000);
check("超出预算时至少保留一条且不超限", tight.includes("### smp_a") && !tight.includes("### smp_b"));

if (failed === 0) console.log("\n全部采集层断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
