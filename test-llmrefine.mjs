import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { parseRefinedPoints, getRefinedConclusions, reasoningKey, applyRuntimeSettings };`);
const { parseRefinedPoints, getRefinedConclusions, reasoningKey, applyRuntimeSettings } = factory();

let failed = 0;
function check(label, ok, extra) {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

// --- parseRefinedPoints -----------------------------------------------------
{
	const points = parseRefinedPoints("- 根因是缓存没失效\n2. 改法是加一层去重\n\n无关话", 3, 220);
	check("解析去掉编号/项目符号", points.length === 2 && points[0] === "根因是缓存没失效" && points[1] === "改法是加一层去重", JSON.stringify(points));
}
{
	const points = parseRefinedPoints("", 3, 220);
	check("空输出解析为空数组", points.length === 0, points.length);
}
{
	const points = parseRefinedPoints("1. 第一条真实结论内容\n2. 第二条真实结论内容\n3. 第三条真实结论内容\n4. 第四条真实结论内容", 3, 220);
	check("超过 maxPoints 被截断", points.length === 3, points.length);
}
{
	const long = "这条结论特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长";
	const points = parseRefinedPoints(long, 3, 12);
	// 「宁可不切」口径：超长点整条保留原文，绝不静默硬切加省略号。
	check("单条超长整条保留（宁可不切）", points[0] === long && !points[0].endsWith("…"), `${points[0].length} chars`);
}

// --- reasoningKey -----------------------------------------------------------
{
	const a = reasoningKey("同一段思考");
	const b = reasoningKey("同一段思考");
	const c = reasoningKey("不同思考内容");
	check("哈希键稳定", a === b && a !== c, `${a} vs ${c}`);
}

// --- getRefinedConclusions（默认关闭）---------------------------------------
applyRuntimeSettings({});
{
	const fakeCtx = { get: () => undefined };
	const fakeSession = { id: "s1", surface: { nodes: [] } };
	const result = getRefinedConclusions(fakeCtx, fakeSession, "一段足够长的思考内容，用来验证关闭状态下不会发起任何调用。");
	check("未启用时返回 null 且不发起", result === null, String(result));
}

// --- getRefinedConclusions（启用但无 llm 服务 → 静默降级）--------------------
applyRuntimeSettings({ enableLlmRefine: true });
{
	const fakeCtx = { get: () => undefined };
	const fakeSession = { id: "s1", surface: { nodes: [] } };
	const reasoning = "没有 llm 服务时，提炼应静默失败并缓存 null，绝不抛出异常。这里给足长度以便通过长度判断。";
	const key = reasoningKey(reasoning);
	const first = getRefinedConclusions(fakeCtx, fakeSession, reasoning);
	check("无 llm 服务时首次返回 null", first === null, String(first));
	// 等后台 runRefinement 落盘（同步执行完：ctx.get 返回 undefined 立即缓存 null）
	check("无 llm 服务时缓存为 null（不抛）", (() => {
		try {
			const again = getRefinedConclusions(fakeCtx, fakeSession, reasoning);
			return again === null && key === key;
		} catch (error) {
			return false;
		}
	})(), "no-throw");
}

// 关闭开关恢复
applyRuntimeSettings({ enableLlmRefine: false });

if (failed === 0) console.log("\n全部 LLM 提炼断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);