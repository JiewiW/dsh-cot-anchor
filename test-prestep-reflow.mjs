/**
 * D9：agent/pre-step 结论回流端到端测试。
 *
 * 无工具调用的 turn 也能获得结论回流：pre-step handler 在每个 step 前触发，
 * await next() 后把锚点上下文追加到 decision.messages 尾部。断言：
 *  ① 注册到 agent/pre-step；
 *  ② 正常 enter decision → messages 追加锚点（role=user、含 COT anchor 正文、summary 带 (pre-step)）；
 *  ③ 同 session 同一推理快照第二次不重复注入（与 post-execute 共用去重空间）；
 *  ④ reject decision 原样返回（短路，绝不污染拒绝）；
 *  ⑤ signal.aborted 原样返回；
 *  ⑥ 提取为空 → 发 cot-anchor/reflow-misjudged（reason=empty-extraction）且不注入。
 */
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const tempHome = path.join(os.tmpdir(), "cot-prestep-" + randomUUID().slice(0, 8));
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
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

// --- mock ctx：捕获监听器 + 事件 ---------------------------------------------
const listeners = [];
const events = [];
const webServer = { register() { return () => {}; } };
const ctx = {
	webServer,
	on(event, handler) { listeners.push({ event, handler }); return () => {}; },
	effect() { return () => {}; },
	get(key) { return key === "webServer" ? webServer : undefined; },
	emit(name, payload) { events.push({ name, payload }); },
	logger: { info() {}, warn() {}, error() {} }
};
api.apply(ctx);

const preStepHandler = listeners.find((item) => item.event === "agent/pre-step")?.handler;
check("D9 注册到 agent/pre-step", typeof preStepHandler === "function");

// --- session 夹具：surface.nodes（旧→新）+ eventAt ---------------------------
function makeSession(contentBlocks) {
	const nodes = contentBlocks.map((_, i) => `node-${i}`);
	const byId = new Map(contentBlocks.map((blocks, i) => [`node-${i}`, { type: "assistant/message", data: { message: { content: blocks } } }]));
	return { id: "sess-prestep", surface: { nodes }, eventAt(id) { return byId.get(id); } };
}

// ≥250 字符、含 3 条显式结论句（所以… 均带内容信号），filler 只交代背景。
const c1 = "所以根因是灰度分组对旧版本客户端回退到了缓存的默认模板，键位读到了旧值。";
const c2 = "所以修复方向是灰度期间冻结比例，并在读取侧补齐回读校验。";
const c3 = "所以回归验证必须覆盖双版本客户端的键位兼容场景。";
const fillerBase = "先交代一下背景，刚才把两边的日志并排看完，时间线已经对齐了，中间那段波动的来源也定位到了。接下来把每一步的先后顺序再顺一遍，确认没有遗漏的分支，也确认回滚脚本在两个环境里都演练过一遍。";
const fillerExtra = "观察窗口的指标基线没有漂移，采集到的样本量足够支撑结论";
let filler = fillerBase;
while (`${filler}${c1}${c2}${c3}`.length < 260) filler += fillerExtra;
const reasoningText = `${filler}${c1}${c2}${c3}`;
check("夹具前置：reasoning ≥ 250 字符", reasoningText.length >= 250, `${reasoningText.length}`);

const enterDecision = { kind: "enter", messages: [{ role: "user", content: "继续" }] };
const nullNext = async () => enterDecision;

// ① 正常回流
{
	const session = makeSession([[{ type: "reasoning", text: reasoningText }]]);
	const out = await preStepHandler({ agent: { session }, turn: 5, step: 0, signal: { aborted: false } }, nullNext);
	check("D9 enter decision 返回 enter", out?.kind === "enter", out?.kind);
	check("D9 messages 追加 1 条锚点", Array.isArray(out?.messages) && out.messages.length === 2, `len=${out?.messages?.length}`);
	const anchor = out?.messages?.[1];
	check("D9 锚点 role=user", anchor?.role === "user");
	check("D9 锚点正文含 COT anchor", anchor?.content?.[0]?.text?.includes("COT anchor") === true);
	check("D9 锚点正文含结论句", anchor?.content?.[0]?.text?.includes("灰度期间冻结比例") === true);
	check("D9 summary 标记 (pre-step)", anchor?.source?.summary?.includes("(pre-step)") === true, anchor?.source?.summary);
}

// ② 同一推理快照去重（与 post-execute 共用键空间）
{
	const session = makeSession([[{ type: "reasoning", text: reasoningText }]]);
	const out = await preStepHandler({ agent: { session }, turn: 5, step: 1, signal: { aborted: false } }, nullNext);
	check("D9 第二次同指纹不重复注入", Array.isArray(out?.messages) && out.messages.length === 1, `len=${out?.messages?.length}`);
}

// ③ reject decision 短路
{
	const session = makeSession([[{ type: "reasoning", text: reasoningText }]]);
	const reject = { kind: "reject", messages: [] };
	const out = await preStepHandler({ agent: { session }, turn: 6, step: 0, signal: { aborted: false } }, async () => reject);
	check("D9 reject 原样返回", out === reject);
}

// ④ signal.aborted 短路
{
	const session = makeSession([[{ type: "reasoning", text: reasoningText }]]);
	const out = await preStepHandler({ agent: { session }, turn: 7, step: 0, signal: { aborted: true } }, nullNext);
	check("D9 aborted 返回原 decision", out === enterDecision || out?.kind === "enter", JSON.stringify(out?.kind));
}

// ⑤ 提取为空 → reflow-misjudged 事件，不注入
{
	events.length = 0;
	const emptyReasoning = "好的。行。嗯。我再想想。先这样。等等。".repeat(8);
	const session = makeSession([[{ type: "reasoning", text: emptyReasoning }]]);
	const out = await preStepHandler({ agent: { session }, turn: 8, step: 0, signal: { aborted: false } }, nullNext);
	check("D9 空提取不注入", Array.isArray(out?.messages) && out.messages.length === 1, `len=${out?.messages?.length}`);
	const evt = events.find((e) => e.name === "cot-anchor/reflow-misjudged");
	check("D9 空提取发 reflow-misjudged", Boolean(evt), evt ? "" : "missing");
	if (evt) {
		const p = evt.payload;
		check("D9 misjudged reason=empty-extraction", p.reason === "empty-extraction", p.reason);
		check("D9 misjudged evidence 四元组", p.sessionId === "sess-prestep" && p.turn === 8 && p.step === 0 && typeof p.evidenceSeq === "number");
	}
}

// ⑥ 无 session 的 payload 原样返回（内核兼容）
{
	const out = await preStepHandler({ turn: 9, step: 0, signal: { aborted: false } }, nullNext);
	check("D9 无 session 原样返回", out === enterDecision);
}

try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

if (failed === 0) console.log("\n全部 pre-step 回流断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
