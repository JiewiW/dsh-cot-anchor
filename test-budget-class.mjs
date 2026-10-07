/**
 * S4.2 分类软切预算 + 缺陷 4 续步兜底 + 缺陷 3 churn 升级 —— 插件侧测试。
 *
 * 挂载方式：readFileSync lib/index.js → 剥 import/export → new Function 取 apply，
 * 用 jest 风格的最小 mock ctx（ctx.on 捕获全部监听器，按事件名取 handler）真实挂载。
 * 三组断言：
 *  ① cutClass：pseudoTool / repeat / numberRunaway → 各自类；churn / transition → heuristic；
 *  ② 缺陷 4：ToolArgsError 短 reasoning（47 字）也强制注入四要素恢复锚点；正常结果不注入；
 *  ③ 缺陷 3：同 session 同 turn 第 2 次 churn 起追加升级指令，换 turn 后重置。
 */
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PSEUDO_TOOL_CALL_UNIT, SHORT_CYCLE_UNIT } from "./test-fixtures.mjs";

const tempHome = path.join(os.tmpdir(), "cot-budget-class-" + randomUUID().slice(0, 8));
fs.mkdirSync(tempHome, { recursive: true });

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "").replace(/^export \{[^\n]*$/gm, "");

const factory = new Function(
	"randomUUID", "appendFileSync", "existsSync", "mkdirSync", "readFileSync", "statSync", "unlinkSync", "writeFileSync",
	"homedir", "join", "createRequire", "BlockAssembler", "createUserMessage",
	`${source}; return { apply };`
);

const BlockAssembler = function () { this.parts = []; };
BlockAssembler.prototype.add = function () { return this; };

const api = factory(
	randomUUID, fs.appendFileSync, fs.existsSync, fs.mkdirSync, fs.readFileSync, fs.statSync, fs.unlinkSync, fs.writeFileSync,
	() => tempHome, path.join, createRequire, BlockAssembler, (text) => ({ role: "user", content: text })
);

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

// --- 最小 mock ctx：捕获全部事件监听器 ------------------------------------
const listeners = [];
const webServer = { register() { return () => {}; } };
const ctx = {
	webServer,
	on(event, handler) { listeners.push({ event, handler }); return () => {}; },
	effect() { return () => {}; },
	get(key) { return key === "webServer" ? webServer : undefined; },
	logger: { info() {}, warn() {}, error() {} }
};
api.apply(ctx);

const softCutHandler = listeners.find((item) => item.event === "agent/soft-cut")?.handler;
const postExecuteHandler = listeners.find((item) => item.event === "tools/post-execute")?.handler;
check("挂载到 agent/soft-cut", typeof softCutHandler === "function");
check("挂载到 tools/post-execute", typeof postExecuteHandler === "function");

const nullNext = async () => null;
async function cutOf(fullVisibleText, turn = 1, sessionId = "sess-budget") {
	return softCutHandler({ sessionId, turn, step: 0, fullVisibleText }, nullNext);
}

// --- ① cutClass 四（五）类典型输入 -----------------------------------------
// pseudoTool：完整闭合的文本化工具调用（既有夹具，587 字）。
const pseudoDecision = await cutOf(PSEUDO_TOOL_CALL_UNIT);
check("pseudoTool → kind=cut", pseudoDecision?.kind === "cut", JSON.stringify(pseudoDecision?.kind));
check("pseudoTool → cutClass=pseudoTool", pseudoDecision?.cutClass === "pseudoTool", pseudoDecision?.cutClass);

// repeat：短周期复读（无任何工具标签），字节级确证。
const repeatText = SHORT_CYCLE_UNIT.repeat(60);
const repeatDecision = await cutOf(repeatText);
check("repeat → kind=cut", repeatDecision?.kind === "cut", JSON.stringify(repeatDecision?.kind));
check("repeat → cutClass=confirmed-repeat", repeatDecision?.cutClass === "confirmed-repeat", repeatDecision?.cutClass);

// numberRunaway：递增裸数字流（数字随序号变化，非字节周期，故不落在 repeat）。
function buildNumberRun(from = 639, count = 500) {
	let out = "";
	for (let i = 0; i < count; i++) out += `${from + i}) ${from + i + 1}.`;
	return out;
}
const numberDecision = await cutOf(buildNumberRun());
check("numberRunaway → kind=cut", numberDecision?.kind === "cut", JSON.stringify(numberDecision?.kind));
check("numberRunaway → cutClass=confirmed-repeat", numberDecision?.cutClass === "confirmed-repeat", numberDecision?.cutClass);

// churn：每句带索引、措辞不同（无字节周期）的高密度重启词。
const churnText = Array.from({ length: 200 }, (_, i) =>
	`Let me reconsider hypothesis ${i}: actually the ${i}th reading is probably wrong, let me re-read part ${i} and think again. Hmm.`
).join(" ");
const churnDecision = await cutOf(churnText);
check("churn → kind=cut", churnDecision?.kind === "cut", JSON.stringify(churnDecision?.kind));
check("churn → cutClass=heuristic", churnDecision?.cutClass === "heuristic", churnDecision?.cutClass);

// transition：多个互不相同的显式结论句 + 尾部阶段宣布（避开 repeat 的短周期阈值）。
const transitionText = Array.from({ length: 12 }, (_, i) =>
	`因此第 ${i} 项排查的根因是模块 ${i} 的配置缺失，修复方式是补齐第 ${i} 项声明。`
).join("") + "\n接下来我先修复挂载行，再重启验证。";
const transitionDecision = await cutOf(transitionText);
check("transition → kind=cut", transitionDecision?.kind === "cut", JSON.stringify(transitionDecision?.kind));
check("transition → cutClass=heuristic", transitionDecision?.cutClass === "heuristic", transitionDecision?.cutClass);

// --- ② 缺陷 4：ToolArgsError 续步兜底 --------------------------------------
const reasoning47 = "甲乙丙丁".repeat(12).slice(0, 47); // 恰好 47 字（< MIN_REASONING_CHARS=250）
check("对照用 reasoning 恰好 47 字", reasoning47.length === 47, String(reasoning47.length));

function sessionWithReasoning(text) {
	return {
		surface: { nodes: ["n1"] },
		eventAt: () => ({ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text }] } } })
	};
}
const exec47 = { agent: { session: sessionWithReasoning(reasoning47) } };
const acceptNext = async () => ({ kind: "accept" });

// 任务给定形态：message 无引号字段 → 走"必填参数不合法"兜底。
const resultArgsError = {
	isError: true,
	content: [{ type: "text", text: "Error: invalid arguments: x" }],
	error: { message: "invalid arguments: x", info: { name: "ToolArgsError", code: "INVALID_ARGS" } }
};
const recoveryOut = await postExecuteHandler(exec47, resultArgsError, acceptNext);
const recoveryCtx = recoveryOut?.additionalContexts?.find((c) => c?.source?.summary === "cot-anchor: tool-args-error");
check("ToolArgsError → 注入 additionalContexts", Array.isArray(recoveryOut?.additionalContexts) && recoveryOut.additionalContexts.length >= 1);
check("恢复锚点 label=cot-anchor: tool-args-error", Boolean(recoveryCtx), recoveryCtx?.source?.summary);
const recoveryBody = recoveryCtx?.content?.[0]?.text ?? "";
check("四要素①未被执行", recoveryBody.includes("未被执行"));
check("四要素②参数名兜底文案", recoveryBody.includes("必填参数不合法"));
check("四要素③按 schema 重发且只一次", recoveryBody.includes("参数 schema") && recoveryBody.includes("只重发一次"));
check("四要素④禁止文本标签", recoveryBody.includes("禁止把工具调用写成") && recoveryBody.includes("文本标签"));

// 引号内实际字段：从 violations/message 取出真实参数名（description），不编造。
const resultQuoted = {
	isError: true,
	content: [{ type: "text", text: 'Error: invalid arguments: missing required property "description"' }],
	error: {
		message: 'invalid arguments: missing required property "description"',
		info: { name: "ToolArgsError", code: "INVALID_ARGS", violations: ['missing required property "description"'] }
	}
};
const quotedOut = await postExecuteHandler(exec47, resultQuoted, acceptNext);
const quotedBody = quotedOut?.additionalContexts?.find((c) => c?.source?.summary === "cot-anchor: tool-args-error")?.content?.[0]?.text ?? "";
check("引号字段提取到实际参数名 description", quotedBody.includes("description"), quotedBody.slice(0, 60));
check("提取实际字段时不出现兜底文案", !quotedBody.includes("必填参数不合法"));

// 对照：同样 47 字 reasoning，但结果正常（isError 非 true）→ 不注入错误锚点。
const normalOut = await postExecuteHandler(
	exec47,
	{ isError: false, content: [{ type: "text", text: "ok" }] },
	acceptNext
);
const normalHasErrorAnchor = normalOut?.additionalContexts?.some((c) => c?.source?.summary === "cot-anchor: tool-args-error") ?? false;
check("正常结果不注入 tool-args-error 锚点", normalHasErrorAnchor === false);

// --- ③ 缺陷 3：churn 二次升级，turn 切换重置 --------------------------------
const c1 = await softCutHandler({ sessionId: "sess-churn", turn: 7, step: 0, fullVisibleText: churnText }, nullNext);
const c2 = await softCutHandler({ sessionId: "sess-churn", turn: 7, step: 1, fullVisibleText: churnText }, nullNext);
const c3NextTurn = await softCutHandler({ sessionId: "sess-churn", turn: 8, step: 0, fullVisibleText: churnText }, nullNext);
const bodyOf = (decision) => decision?.contexts?.[0]?.content?.[0]?.text ?? "";
check("churn 第 1 次不含升级指令", !bodyOf(c1).includes("升级指令"));
check("churn 第 2 次含升级指令", bodyOf(c2).includes("升级指令") && bodyOf(c2).includes("必须且只能是一次合法工具调用"));
check("换 turn 后第 1 次再次不含升级指令", !bodyOf(c3NextTurn).includes("升级指令"));

try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

if (failed === 0) console.log("\n全部预算分类 / 续步兜底 / churn 升级断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
