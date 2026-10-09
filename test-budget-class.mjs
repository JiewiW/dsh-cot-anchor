/**
 * budgetClass 契约 + churn 升级序列/turn 归零 + ToolArgsError 续步兜底 —— 插件侧测试。
 *
 * 挂载方式：readFileSync lib/index.js → 剥 import/export → new Function 取 apply，
 * 用最小 mock ctx（ctx.on 捕获全部监听器，按事件名取 handler）真实挂载。
 * 断言组：
 *  ① budgetClass：pseudoTool→confirmed-pseudo；repeat/numberRunaway→confirmed-repeat；
 *     churn/transition→heuristic（wire 枚举与内核 decideSoftCut 归一化口径一致）；
 *  ② churn 文案序列：第 1 次无升级；第 2 次起追加"本 turn 第 N 次空转…"；达 6 次
 *     追加插件侧预算说明（注明内核可能因预算拒绝）；session/event 的
 *     assistant/message(data.turn) 推进 turn 边界后计数归零；同 turn 软切结算消息
 *     不误归零（决策时就地推进 lastTurn）；
 *  ③ ToolArgsError：规格形态顶层 error{name,code} + content 文本抽参；工具名入锚；
 *     抽不到参数名降级通用句式；正常结果不触发；enableToolInject=false 不抑制
 *     该分支（错误分支位于总开关之前）；旧内核 error.info 形态兼容。
 *
 * 注意：settings 是模块级变量，同一进程内第二次 apply 会覆盖全部 handler 可见的
 * settings——因此总开关关闭的对照组（tempHome2）必须在全部默认配置断言之后挂载。
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

function mount(home, persistedOverrides) {
	if (persistedOverrides) {
		fs.mkdirSync(path.join(home, ".dsh", "storages"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".dsh", "storages", "cot-anchor.json"),
			JSON.stringify(persistedOverrides),
			"utf8"
		);
	}
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
	return {
		ctx,
		listeners,
		handlerOf(event) { return listeners.find((item) => item.event === event)?.handler; }
	};
}

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

const main = mount(tempHome);
const softCutHandler = main.handlerOf("agent/soft-cut");
const postExecuteHandler = main.handlerOf("tools/post-execute");
const sessionEventHandler = main.handlerOf("session/event");
check("挂载到 agent/soft-cut", typeof softCutHandler === "function");
check("挂载到 tools/post-execute", typeof postExecuteHandler === "function");
check("挂载到 session/event", typeof sessionEventHandler === "function");

const nullNext = async () => null;
async function cutOf(fullVisibleText, turn = 1, sessionId = "sess-budget") {
	return softCutHandler({ sessionId, turn, step: 0, fullVisibleText }, nullNext);
}
const bodyOf = (decision) => decision?.contexts?.[0]?.content?.[0]?.text ?? "";

// --- ① budgetClass 五个 cut 返回点 ------------------------------------------
const pseudoDecision = await cutOf(PSEUDO_TOOL_CALL_UNIT);
check("pseudoTool → kind=cut", pseudoDecision?.kind === "cut", JSON.stringify(pseudoDecision?.kind));
check("pseudoTool → budgetClass=confirmed-pseudo", pseudoDecision?.budgetClass === "confirmed-pseudo", pseudoDecision?.budgetClass);

const repeatText = SHORT_CYCLE_UNIT.repeat(60);
const repeatDecision = await cutOf(repeatText);
check("repeat → kind=cut", repeatDecision?.kind === "cut", JSON.stringify(repeatDecision?.kind));
check("repeat → budgetClass=confirmed-repeat", repeatDecision?.budgetClass === "confirmed-repeat", repeatDecision?.budgetClass);

// numberRunaway：递增裸数字流（数字随序号变化，非字节周期，故不落在 repeat）。
function buildNumberRun(from = 639, count = 500) {
	let out = "";
	for (let i = 0; i < count; i++) out += `${from + i}) ${from + i + 1}.`;
	return out;
}
const numberDecision = await cutOf(buildNumberRun());
check("numberRunaway → kind=cut", numberDecision?.kind === "cut", JSON.stringify(numberDecision?.kind));
check("numberRunaway → budgetClass=confirmed-repeat", numberDecision?.budgetClass === "confirmed-repeat", numberDecision?.budgetClass);

// churn：每句带索引、措辞不同（无字节周期）的高密度重启词。
const churnText = Array.from({ length: 200 }, (_, i) =>
	`Let me reconsider hypothesis ${i}: actually the ${i}th reading is probably wrong, let me re-read part ${i} and think again. Hmm.`
).join(" ");
const churnDecision = await cutOf(churnText);
check("churn → kind=cut", churnDecision?.kind === "cut", JSON.stringify(churnDecision?.kind));
check("churn → budgetClass=heuristic", churnDecision?.budgetClass === "heuristic", churnDecision?.budgetClass);

// transition：多个互不相同的显式结论句 + 尾部阶段宣布（避开 repeat 的短周期阈值）。
const transitionText = Array.from({ length: 12 }, (_, i) =>
	`因此第 ${i} 项排查的根因是模块 ${i} 的配置缺失，修复方式是补齐第 ${i} 项声明。`
).join("") + "\n接下来我先修复挂载行，再重启验证。";
const transitionDecision = await cutOf(transitionText);
check("transition → kind=cut", transitionDecision?.kind === "cut", JSON.stringify(transitionDecision?.kind));
check("transition → budgetClass=heuristic", transitionDecision?.budgetClass === "heuristic", transitionDecision?.budgetClass);

// --- ② ToolArgsError（规格形态，默认配置下） ---------------------------------
const execPwsh = { name: "pwsh" };
const acceptNext = async () => ({ kind: "accept" });

const resultSpec = {
	isError: true,
	error: { name: "ToolArgsError", code: "INVALID_ARGS" },
	content: [{ type: "text", text: 'Error: invalid arguments: missing required property "description"' }]
};
const specOut = await postExecuteHandler(execPwsh, resultSpec, acceptNext);
const specBody = specOut?.additionalContexts?.find((c) => c?.source?.summary === "cot-anchor: tool-args-error")?.content?.[0]?.text ?? "";
check("规格形态 → 注入 tool-args-error 锚点", specBody.length > 0);
check("锚点含工具名 pwsh", specBody.includes("pwsh"));
check("锚点含抽取到的参数名 description", specBody.includes("description"));
check("四要素①未被执行", specBody.includes("未被执行"));
check("四要素③只重发一次", specBody.includes("只重发一次"));
check("四要素④禁止文本标签", specBody.includes("禁止把工具调用写成") && specBody.includes("文本标签"));

// 抽不到参数名 → 通用句式降级，锚点不允许整条缺失。
const resultNoFields = {
	isError: true,
	error: { name: "ToolArgsError", code: "INVALID_ARGS" },
	content: [{ type: "text", text: "Error: invalid arguments: x" }]
};
const noFieldsOut = await postExecuteHandler(execPwsh, resultNoFields, acceptNext);
const noFieldsBody = noFieldsOut?.additionalContexts?.find((c) => c?.source?.summary === "cot-anchor: tool-args-error")?.content?.[0]?.text ?? "";
check("无字段 → 仍注入锚点（不允许整条缺失）", noFieldsBody.length > 0);
check("无字段 → 通用句式（参数非法 + 按工具完整参数要求重发一次）",
	noFieldsBody.includes("上一次工具调用参数非法") && noFieldsBody.includes("按工具完整参数要求重发一次"));
check("无字段 → 不编造参数名", !noFieldsBody.includes("description"));

// 旧内核形态兼容：error.info.name/code（顶层 name/code 缺失时）。
const resultLegacyInfo = {
	isError: true,
	error: { info: { name: "ToolArgsError", code: "INVALID_ARGS" } },
	content: [{ type: "text", text: 'Error: invalid arguments: missing required property "description"' }]
};
const legacyOut = await postExecuteHandler(execPwsh, resultLegacyInfo, acceptNext);
const legacyBody = legacyOut?.additionalContexts?.find((c) => c?.source?.summary === "cot-anchor: tool-args-error")?.content?.[0]?.text ?? "";
check("旧形态 error.info → 同样触发", legacyBody.includes("pwsh") && legacyBody.includes("description"));

// 对照：正常结果（isError 非 true）不触发错误分支。
const normalOut = await postExecuteHandler(
	execPwsh,
	{ isError: false, content: [{ type: "text", text: "ok" }] },
	acceptNext
);
const normalHasErrorAnchor = normalOut?.additionalContexts?.some((c) => c?.source?.summary === "cot-anchor: tool-args-error") ?? false;
check("正常结果不注入 tool-args-error 锚点", normalHasErrorAnchor === false);

// --- ③ churn 升级序列：第 1 次 / 第 2 次 / 第 6 次 ----------------------------
const esc1 = await cutOf(churnText, 7, "sess-churn-a");
check("churn 第 1 次不含升级指令", !bodyOf(esc1).includes("本 turn 第"));
const esc2 = await cutOf(churnText, 7, "sess-churn-a");
check("churn 第 2 次含升级指令", bodyOf(esc2).includes("本 turn 第 2 次空转")
	&& bodyOf(esc2).includes("下一步必须是一次真实工具调用或最终结论"));
for (let i = 3; i <= 5; i++) await cutOf(churnText, 7, "sess-churn-a");
const esc6 = await cutOf(churnText, 7, "sess-churn-a");
check("churn 第 6 次含插件侧预算说明", bodyOf(esc6).includes("插件侧已发起 6 次空转打断")
	&& bodyOf(esc6).includes("内核可能因预算拒绝后续打断"));
check("第 6 次仍说明字节级重复检测可用", bodyOf(esc6).includes("字节级重复检测仍可能拦截"));

// --- ③b turn 归零：session/event 观察者 + 同 turn 结算不误归零 ----------------
// 路径 ①：观察者识别 assistant/message(data.turn) 推进边界后，新 turn 计数归零。
const turn1Hit = await cutOf(churnText, 10, "sess-churn-b");
check("sess-b turn10 首次命中（第 1 次，无升级）", !bodyOf(turn1Hit).includes("本 turn 第"));
sessionEventHandler({ id: "sess-churn-b" }, { type: "assistant/message", data: { turn: 10, step: 0 } });
const turn1Hit2 = await cutOf(churnText, 10, "sess-churn-b");
check("同 turn 结算消息（turn 不增）不归零：第 2 次仍升级", bodyOf(turn1Hit2).includes("本 turn 第 2 次空转"));
sessionEventHandler({ id: "sess-churn-b" }, { type: "assistant/message", data: { turn: 11, step: 0 } });
const turn2First = await cutOf(churnText, 11, "sess-churn-b");
check("观察者推进 turn 11 后计数归零：新 turn 第 1 次无升级", !bodyOf(turn2First).includes("本 turn 第"));

// 路径 ②：无观察者事件时，churn 决策自身携带 turn 就地归零（消除首中偏移）。
const soloNewTurn = await cutOf(churnText, 20, "sess-churn-c");
check("换 turn 后首个 churn 决策就地归零：无升级", !bodyOf(soloNewTurn).includes("本 turn 第"));
const soloNewTurn2 = await cutOf(churnText, 20, "sess-churn-c");
check("同 turn 第二次仍升级（就地归零未误伤计数）", bodyOf(soloNewTurn2).includes("本 turn 第 2 次空转"));

// --- ④ enableToolInject=false 不抑制错误分支（对照组，必须最后挂载） ---------
const tempHome2 = path.join(os.tmpdir(), "cot-budget-class-off-" + randomUUID().slice(0, 8));
fs.mkdirSync(tempHome2, { recursive: true });
const suppressed = mount(tempHome2, { enableToolInject: false });
const postExecuteOff = suppressed.handlerOf("tools/post-execute");
const offErrorOut = await postExecuteOff(execPwsh, resultSpec, acceptNext);
const offErrorBody = offErrorOut?.additionalContexts?.find((c) => c?.source?.summary === "cot-anchor: tool-args-error")?.content?.[0]?.text ?? "";
check("总开关关闭 → 错误分支仍注入（不受抑制）", offErrorBody.includes("pwsh") && offErrorBody.includes("description"));
const offNormalOut = await postExecuteOff(
	execPwsh,
	{ isError: false, content: [{ type: "text", text: "ok" }] },
	acceptNext
);
check("总开关关闭 → 正常结果不注入（对照）",
	!(offNormalOut?.additionalContexts?.some((c) => String(c?.source?.summary ?? "").startsWith("cot-anchor:")) ?? false));

for (const home of [tempHome, tempHome2]) {
	try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
}

if (failed === 0) console.log("\n全部 budgetClass / churn 序列 / ToolArgsError 断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
