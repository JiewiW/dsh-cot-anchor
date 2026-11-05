/**
 * 超长 CoT 阈值语义回归（2026-11-05）。
 *
 * 缺陷 1：内核 merged 模式（未传 streams.reasoningLength）时，判定处对
 * overLongCoTThreshold 隐式乘 2 —— 用户设 8000，实际要 16000 字符才软切，
 * 设置值被静默改写。修复后设置值就是唯一生效阈值，两种计数口径一致。
 * 缺陷 2：提醒文案是商量式建议且每次逐字相同，模型写一句「我应该立即行动」
 * 后继续分析，可连续 5 次触发。修复后文案硬化并随本 turn 命中次数升级。
 *
 * 覆盖：
 *  ① merged 口径：7999 不切 / 8000 即切（旧行为此处不切，须到 16000）；
 *     锚点与决策标签显示 8000，且无 x2 残留；
 *  ② separate 口径：streams.reasoningLength 7999 不切 / 8000 即切；
 *  ③ 自定义阈值 12000 同样原样生效，证明不是把 8000 写死；
 *  ④ 文案硬化与 per-turn 升级：禁承诺式表态、二选一、逐次加码、
 *     决策标签带次数、换 turn 与 session/event 观察者归零。
 *
 * 挂载方式沿用包根 test-*.mjs：读 lib/index.js 源码、剥 import/export 后
 * 用 new Function 还原模块作用域，真实 apply(ctx) 挂载 agent/soft-cut。
 * 其余检测器全部关闭，确保断言只落在 over-long-cot 分支上。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "").replace(/^export \{[^\n]*$/gm, "");

const factory = new Function(
	"randomUUID", "appendFileSync", "existsSync", "mkdirSync", "readFileSync", "statSync", "unlinkSync", "writeFileSync",
	"homedir", "join", "createRequire", "BlockAssembler", "createUserMessage",
	`${source}; return { apply, applyRuntimeSettings, DEFAULT_SETTINGS };`
);

const BlockAssembler = function () { this.parts = []; };
BlockAssembler.prototype.add = function () { return this; };

const overrides = {
	enableSoftCut: true,
	enableOverLongCoT: true,
	overLongCoTThreshold: 8000,
	enablePseudoTool: false,
	enableRepeat: false,
	enableChurn: false,
	enableTransition: false,
	enableNumberRunaway: false,
	enableExternalSoftCut: false,
	enableToolInject: false,
	enableHarvest: false,
	enableAutoAnalyze: false
};

const tempHome = path.join(os.tmpdir(), "cot-overlong-" + randomUUID().slice(0, 8));
fs.mkdirSync(path.join(tempHome, ".dsh", "storages"), { recursive: true });
fs.writeFileSync(
	path.join(tempHome, ".dsh", "storages", "cot-anchor.json"),
	JSON.stringify(overrides),
	"utf8"
);

const api = factory(
	randomUUID, fs.appendFileSync, fs.existsSync, fs.mkdirSync, fs.readFileSync, fs.statSync, fs.unlinkSync, fs.writeFileSync,
	() => tempHome, path.join, createRequire, BlockAssembler, (text) => ({ role: "user", content: text })
);

const listeners = [];
const webServer = { register() { return () => {}; } };
const ctx = {
	webServer,
	on(event, handler) { listeners.push({ event, handler }); return () => {}; },
	emit() {},
	effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
	inject(services, callback) {
		if (services.includes("systemPrompt")) {
			callback({ effect() { return () => {}; }, systemPrompt: { context() { return () => {}; } } });
		}
		return () => {};
	},
	get(key) { return key === "webServer" ? webServer : undefined; },
	provide() {},
	logger: { info() {}, warn() {}, error() {} }
};
api.apply(ctx);
const softCutHandler = listeners.find((item) => item.event === "agent/soft-cut")?.handler;

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

async function cutOf(payload, { sessionId = "sess-overlong", turn = 1 } = {}) {
	return softCutHandler({ sessionId, turn, step: 0, ...payload }, async () => null);
}
const anchorOf = (decision) => decision?.contexts?.[0]?.content?.[0]?.text ?? "";
const summaryOf = (decision) => decision?.contexts?.[0]?.source?.summary ?? "";
const textOf = (length) => "x".repeat(length);

check("挂载到 agent/soft-cut", typeof softCutHandler === "function");
check("默认阈值 8000", api.DEFAULT_SETTINGS.overLongCoTThreshold === 8000, api.DEFAULT_SETTINGS.overLongCoTThreshold);
check("持久化设置发布为 8000", api.applyRuntimeSettings(overrides).overLongCoTThreshold === 8000);

// --- ① merged 口径（内核默认，无 streams） -----------------------------------
const below = await cutOf({ fullVisibleText: textOf(7999) });
check("merged 7999 字符不切", below === null);

const atThreshold = await cutOf({ fullVisibleText: textOf(8000) });
check("merged 8000 字符即切（旧行为要 16000）", atThreshold?.kind === "cut", JSON.stringify(atThreshold?.kind));
check("merged 锚点显示阈值 8000", anchorOf(atThreshold).includes("阈值 8000"), anchorOf(atThreshold).split("\n")[0]);
check("merged 锚点不含 16000", !anchorOf(atThreshold).includes("16000"));
check("merged 决策标签标注估算口径", summaryOf(atThreshold).includes("[merged estimate]"), summaryOf(atThreshold));
check("merged 决策标签无 x2 残留", !summaryOf(atThreshold).includes("x2"));
check("merged 决策标签分母为 8000", summaryOf(atThreshold).includes("8000/8000"), summaryOf(atThreshold));

// --- ② separate 口径（内核传 streams.reasoningLength） ----------------------
const separateBelow = await cutOf({ fullVisibleText: textOf(16), streams: { mode: "separateThreshold", reasoningLength: 7999 } });
check("separate reasoningLength 7999 不切", separateBelow === null);

const separateAtThreshold = await cutOf({ fullVisibleText: textOf(16), streams: { mode: "separateThreshold", reasoningLength: 8000 } });
check("separate reasoningLength 8000 即切", separateAtThreshold?.kind === "cut", JSON.stringify(separateAtThreshold?.kind));
check("separate 锚点显示阈值 8000（纯思考口径）",
	anchorOf(separateAtThreshold).includes("阈值 8000") && anchorOf(separateAtThreshold).includes("本次思考已达约 8000 字"),
	anchorOf(separateAtThreshold).split("\n")[0]);
check("separate 决策标签分母为 8000", summaryOf(separateAtThreshold).includes("8000/8000"), summaryOf(separateAtThreshold));

// --- ③ 自定义阈值原样生效 ----------------------------------------------------
const custom = api.applyRuntimeSettings({ ...overrides, overLongCoTThreshold: 12000 });
check("自定义阈值发布为 12000", custom.overLongCoTThreshold === 12000, custom.overLongCoTThreshold);
check("自定义阈值下 merged 8000 不切", (await cutOf({ fullVisibleText: textOf(8000) })) === null);
const customAtThreshold = await cutOf({ fullVisibleText: textOf(12000) });
check("自定义阈值下 merged 12000 即切", customAtThreshold?.kind === "cut");
check("自定义阈值锚点显示 12000", anchorOf(customAtThreshold).includes("阈值 12000"), anchorOf(customAtThreshold).split("\n")[0]);

// --- ④ 文案硬化 + per-turn 升级（hy4 连续触发回归） --------------------------
api.applyRuntimeSettings(overrides);
const anchorSession = "sess-overlong-anchor";
const cut8000 = (turn, sessionId = anchorSession) =>
	cutOf({ fullVisibleText: textOf(8000) }, { sessionId, turn });

const a1 = anchorOf(await cut8000(3));
check("首次文案去掉商量式措辞", !a1.includes("如有阶段性结论") && !a1.includes("应该落实"));
check("首次文案禁止承诺式表态", a1.includes("我应该立即行动") && a1.includes("表态不等于执行"));
check("首次文案规定二选一", a1.includes("一次真实工具调用") && a1.includes("最终答案") && a1.includes("二选一"));
check("英文段同步硬化", a1.includes("Your next message MUST be"));

const a2 = anchorOf(await cut8000(3));
check("第 2 次文案与首次不同（不可复读同一句）", a2 !== a1);
check("第 2 次点明次数与未执行", a2.includes("第 2 次") && a2.includes("上一次提醒之后你没有执行"));

for (let i = 3; i <= 4; i++) await cut8000(3);
const a5 = anchorOf(await cut8000(3));
check("第 5 次含硬约束与预算边界", a5.includes("第 5 次") && a5.includes("硬约束") && a5.includes("这一次必须收尾"));
check("决策标签带命中次数", summaryOf(await cut8000(3)).includes("x6"));
check("换 turn 后升级序列归零", !anchorOf(await cut8000(4)).includes("本 turn 第"));

const obsSession = "sess-overlong-observer";
const sessionEventHandler = listeners.find((item) => item.event === "session/event")?.handler;
check("挂载到 session/event", typeof sessionEventHandler === "function");
await cut8000(8, obsSession);
sessionEventHandler({ id: obsSession }, { type: "assistant/message", data: { turn: 9, step: 0 } });
check("观察者推进 turn 后归零", !anchorOf(await cut8000(9, obsSession)).includes("本 turn 第"));

if (failed === 0) console.log("\n全部超长 CoT 阈值语义 + 文案硬化/升级序列断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
