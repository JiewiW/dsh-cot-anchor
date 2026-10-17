/**
 * cot-anchor 外部软切服务单测 + 跨插件集成测试（node:test）。
 *
 * 加载方式沿用包根既有 test-*.mjs 惯例：读 lib/index.js 源码、剥掉
 * import/export 行后用 new Function 工厂还原模块作用域。与包根脚本不同的
 * 是工厂 return 额外暴露 requestExternalSoftCut / consumeExternalSoftCut /
 * externalSoftCutPending / applyRuntimeSettings——它们是模块级声明，在同一
 * 作用域可见，不改变生产代码即可直接断言。
 *
 * 覆盖：
 *  一、requestExternalSoftCut 受理门：
 *    1 非法 sessionId → invalid-session-id；
 *    2 能力门（内核 absent）→ soft-cut-capability-absent；
 *    3 设置门（默认关）→ disabled；
 *    4 开启后受理 + pending 挂起 + 覆盖式写入；
 *    5 anchorText：有文本时 = 前缀 + 尾部 2000 字符截取；无文本时 = 固定兜底锚点；
 *    6 reason/evidenceSeq/turn/step 归一化（非数字/非字符串回落 null）；
 *    7 ttlMs 自定义与缺省 30000。
 *  二、consumeExternalSoftCut 消费语义：
 *    8 一次性消费（第二次返回 null）；
 *    9 TTL 过期作废（注入时钟，禁真实 sleep）；
 *   10 无记录返回 null。
 *  三、钩子现场（agent/soft-cut）：
 *   11 挂起请求优先于内部检测：内部 enableSoftCut 关闭 + 五类检测器全关，仍因外部请求切断；
 *   12 返回 cut + budgetClass=heuristic + 无 trimTo + contexts 锚点为 external-request；
 *   13 发射 cot-anchor/softcut-taken（cutClass=external, reason, evidenceSeq）；
 *   14 无挂起请求时内部全关 → 返回 null（不切断）。
 *  四、服务注册与设置：
 *   15 apply 注册 ctx.provide("cotAnchor")，requestSoftCut 经服务受理；
 *   16 DEFAULT_SETTINGS.enableExternalSoftCut=false 且 schema 控件存在。
 *  五、跨插件集成（watcher stall-2 → cot-anchor）：
 *   17 用真实 apply 产出的 cotAnchor 服务驱动 createStallController：
 *      stall-2 → requestSoftCut 挂起 → agent/soft-cut 钩子消费 → cut 决策闭环。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── 模块加载：剥 import/export 后以工厂还原（与包根 test-apply-smoke.mjs 同法） ──
let source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");

const factory = new Function(
	"randomUUID", "appendFileSync", "existsSync", "mkdirSync", "readFileSync", "statSync", "unlinkSync", "writeFileSync",
	"homedir", "join", "BlockAssembler", "createUserMessage",
	`${source}; return { apply, name, inject, DEFAULT_SETTINGS, SETTINGS_SCHEMA, applyRuntimeSettings,`
	+ ` requestExternalSoftCut, consumeExternalSoftCut, externalSoftCutPending };`
);

const BlockAssembler = function () { this.parts = []; };
BlockAssembler.prototype.add = function () { return this; };

/** 构造一份隔离的模块实例（临时 HOME，不碰真实 ~/.dsh/storages）。 */
function loadApi() {
	const tempHome = path.join(os.tmpdir(), "cot-anchor-ext-" + randomUUID().slice(0, 8));
	fs.mkdirSync(tempHome, { recursive: true });
	const api = factory(
		randomUUID, fs.appendFileSync, fs.existsSync, fs.mkdirSync, fs.readFileSync, fs.statSync, fs.unlinkSync, fs.writeFileSync,
		() => tempHome, path.join, BlockAssembler, (text) => ({ role: "user", content: text })
	);
	return { api, tempHome };
}

/** mock ctx：收集 provide 的服务、事件监听与 emit。 */
function mockCtx(collector) {
	const webServer = { register(route) { collector.routes.push(route); return () => {}; } };
	return {
		webServer,
		on(event, handler) { collector.listeners.push({ event, handler }); return () => {}; },
		emit(eventName, payload) { collector.emitted.push({ eventName, payload }); },
		effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
		inject(services, callback) {
			if (services.includes("systemPrompt")) {
				callback({
					effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
					systemPrompt: { context() { return () => {}; } }
				});
			}
			return () => {};
		},
		get(key) { return key === "webServer" ? webServer : undefined; },
		provide(name, service) { collector.services[name] = service; },
		logger: { info() {}, warn() {}, error() {} }
	};
}

const collect = () => ({ routes: [], listeners: [], emitted: [], services: {} });

// ═══ 一、受理门 ═══════════════════════════════════════════════════════════

test("1：sessionId 非空字符串校验 → invalid-session-id", () => {
	const { api, tempHome } = loadApi();
	for (const bad of [undefined, null, "", 42, {}]) {
		const r = api.requestExternalSoftCut({ sessionId: bad });
		assert.deepEqual(r, { accepted: false, reason: "invalid-session-id" }, JSON.stringify(bad));
	}
	assert.equal(api.externalSoftCutPending.size, 0, "拒绝时不入表");
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("2：内核 soft-cut 能力 absent → soft-cut-capability-absent", () => {
	// 本机内核可能已移植 soft-cut（present）也可能缺失（absent）。两种现场各自断言：
	// absent 时能力门必须拒绝；present/unknown 时该项不适用，直接验证不受能力门阻断。
	const { api, tempHome } = loadApi();
	// apply 第二参数 options 即设置覆盖入口（apply 会用默认值归一 settings，
	// 先调 applyRuntimeSettings 会被覆盖，故统一走 apply options）
	api.apply(mockCtx(collect()), { enableExternalSoftCut: true });
	// apply 回填 kernelSoftCutProbe；此处无法直接读该 let，改经外部请求的结果反推：
	// 若内核 absent，受理必被能力门拒绝；否则受理成功。
	const r = api.requestExternalSoftCut({ sessionId: "s-cap" });
	if (r.accepted === false) {
		assert.equal(r.reason, "soft-cut-capability-absent",
			"内核缺失 soft-cut 钩子时唯一合法拒绝原因就是能力门，不得是 disabled");
	} else {
		assert.equal(r.accepted, true);
		assert.equal(r.delivery, "pending-next-soft-cut");
	}
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("3：默认关闭 → disabled（首发保守）", () => {
	const { api, tempHome } = loadApi();
	assert.equal(api.DEFAULT_SETTINGS.enableExternalSoftCut, false);
	const r = api.requestExternalSoftCut({ sessionId: "s-off" });
	assert.deepEqual(r, { accepted: false, reason: "disabled" });
	assert.equal(api.externalSoftCutPending.size, 0);
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("4：开启后受理 + 挂起 + 同 sessionId 覆盖旧请求", () => {
	const { api, tempHome } = loadApi();
	api.applyRuntimeSettings({ enableExternalSoftCut: true });
	const first = api.requestExternalSoftCut({ sessionId: "s-1", fullVisibleText: "第一次请求的文本" });
	assert.equal(first.accepted, true);
	assert.equal(first.delivery, "pending-next-soft-cut");
	assert.equal(first.ttlMs, 30000, "缺省 ttl = 30 秒");
	assert.equal(typeof first.requestedAt, "number");
	assert.equal(api.externalSoftCutPending.size, 1);
	assert.ok(api.externalSoftCutPending.get("s-1").anchorText.includes("第一次请求的文本"));

	// 覆盖：同 sessionId 新请求替换旧请求，不叠加
	const second = api.requestExternalSoftCut({ sessionId: "s-1", fullVisibleText: "第二次请求的文本", ttlMs: 1234 });
	assert.equal(second.ttlMs, 1234);
	assert.equal(api.externalSoftCutPending.size, 1, "同 sessionId 覆盖而非新增");
	assert.ok(api.externalSoftCutPending.get("s-1").anchorText.includes("第二次请求的文本"));
	assert.equal(api.externalSoftCutPending.get("s-1").ttlMs, 1234);
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("5：anchorText 生成——有文本取尾部 2000 字符 + 固定引导语；无文本用兜底锚点", () => {
	const { api, tempHome } = loadApi();
	api.applyRuntimeSettings({ enableExternalSoftCut: true });
	// 有文本：引导语 + 尾部 2000 字符
	const longText = "甲".repeat(2500) + "尾部标记XYZ";
	api.requestExternalSoftCut({ sessionId: "s-anchor", fullVisibleText: longText });
	const anchored = api.externalSoftCutPending.get("s-anchor").anchorText;
	assert.ok(anchored.startsWith("外部停滞检测请求在此软切：停止当前重复路径，基于以下最近可见文本重新组织下一步："),
		"固定中文引导语");
	assert.ok(anchored.endsWith("尾部标记XYZ"), "按字符截取尾部");
	assert.equal(anchored.length - "外部停滞检测请求在此软切：停止当前重复路径，基于以下最近可见文本重新组织下一步：\n\n".length,
		2000, "正文不超过 2000 字符");
	// 无文本：固定兜底锚点，不捏造任务事实
	api.requestExternalSoftCut({ sessionId: "s-anchor", fullVisibleText: "   " });
	const fallback = api.externalSoftCutPending.get("s-anchor").anchorText;
	assert.equal(fallback, "检测到语义停滞的外部软切请求，要求立即停止当前重复论述，用新的一步推进任务。");
	api.requestExternalSoftCut({ sessionId: "s-anchor" });
	assert.equal(api.externalSoftCutPending.get("s-anchor").anchorText,
		"检测到语义停滞的外部软切请求，要求立即停止当前重复论述，用新的一步推进任务。",
		"字段缺失时同样兜底");
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("6：reason/evidenceSeq/turn/step 归一化（非数字/非字符串回落 null）", () => {
	const { api, tempHome } = loadApi();
	api.applyRuntimeSettings({ enableExternalSoftCut: true });
	api.requestExternalSoftCut({
		sessionId: "s-norm", reason: "semantic-stall-2", evidenceSeq: 7, turn: 3, step: 9
	});
	const good = api.externalSoftCutPending.get("s-norm");
	assert.equal(good.reason, "semantic-stall-2");
	assert.equal(good.evidenceSeq, 7);
	assert.equal(good.turn, 3);
	assert.equal(good.step, 9);
	api.requestExternalSoftCut({
		sessionId: "s-norm", reason: "", evidenceSeq: "x", turn: null, step: {}
	});
	const bad = api.externalSoftCutPending.get("s-norm");
	assert.equal(bad.reason, null, "空 reason 归一为 null");
	assert.equal(bad.evidenceSeq, null, "非数字 evidenceSeq 归一为 null");
	assert.equal(bad.turn, null);
	assert.equal(bad.step, null);
	fs.rmSync(tempHome, { recursive: true, force: true });
});

// ═══ 二、消费语义 ═════════════════════════════════════════════════════════

test("7：consume 一次性——命中后删除，第二次返回 null", () => {
	const { api, tempHome } = loadApi();
	api.applyRuntimeSettings({ enableExternalSoftCut: true });
	api.requestExternalSoftCut({ sessionId: "s-consume", fullVisibleText: "待消费文本" });
	const first = api.consumeExternalSoftCut("s-consume");
	assert.ok(first && first.anchorText.includes("待消费文本"));
	assert.equal(api.externalSoftCutPending.size, 0, "消费即删除");
	assert.equal(api.consumeExternalSoftCut("s-consume"), null, "一次性，不重复切断");
	assert.equal(api.consumeExternalSoftCut("never-requested"), null, "无记录返回 null");
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("8：TTL 过期作废（注入时钟，禁真实 sleep）", () => {
	const { api, tempHome } = loadApi();
	api.applyRuntimeSettings({ enableExternalSoftCut: true });
	const requestedAt = api.requestExternalSoftCut({ sessionId: "s-ttl" }).requestedAt;
	// 30 秒整点：未超（判定为 > ttlMs 才过期）
	assert.ok(api.consumeExternalSoftCut("s-ttl", requestedAt + 30000), "恰好 30 秒仍有效");
	// 重新挂起后超过 1ms：过期
	api.requestExternalSoftCut({ sessionId: "s-ttl" });
	assert.equal(api.consumeExternalSoftCut("s-ttl", requestedAt + 30001), null, "超过 TTL 作废");
	assert.equal(api.externalSoftCutPending.size, 0, "过期记录被清理");
	// 自定义 ttl：1234ms
	api.requestExternalSoftCut({ sessionId: "s-ttl2", ttlMs: 1234 });
	assert.ok(api.consumeExternalSoftCut("s-ttl2", Date.now() + 1000));
	api.requestExternalSoftCut({ sessionId: "s-ttl2", ttlMs: 1234 });
	assert.equal(api.consumeExternalSoftCut("s-ttl2", Date.now() + 2000), null, "自定义 ttl 生效");
	fs.rmSync(tempHome, { recursive: true, force: true });
});

// ═══ 三、钩子现场 ═════════════════════════════════════════════════════════

test("9：内部检测全关 + 挂起外部请求 → 仍切断（显式外部干预独立于 enableSoftCut）", async () => {
	const { api, tempHome } = loadApi();
	// 内部开关与五类检测器全部关闭，仅开外部软切
	const internalOff = {
		enableSoftCut: false,
		enablePseudoTool: false, enableRepeat: false, enableChurn: false,
		enableTransition: false, enableNumberRunaway: false,
		enableExternalSoftCut: true
	};
	const collector = collect();
	api.apply(mockCtx(collector), internalOff);
	const softCut = collector.listeners.find((item) => item.event === "agent/soft-cut");
	if (!softCut) {
		// 本机内核缺失 agent/soft-cut 钩子（能力 absent）：apply 不注册回调。
		// 该场景无法在本机复现钩子现场，跳过并明示，不用假通过糊弄。
		test.skip("本机内核无 agent/soft-cut 钩子（probeKernelHook=absent），钩子级断言不适用");
		fs.rmSync(tempHome, { recursive: true, force: true });
		return;
	}
	const r = api.requestExternalSoftCut({
		sessionId: "s-hook", reason: "semantic-stall-2", evidenceSeq: 5, fullVisibleText: "外部停滞文本"
	});
	assert.equal(r.accepted, true);
	const nextNull = async () => null;
	const result = await softCut.handler(
		{ sessionId: "s-hook", turn: 2, step: 7, fullVisibleText: "内部检测视角的现场文本" },
		nextNull
	);
	assert.ok(result && result.kind === "cut", "外部请求必须在内部全关时仍切断");
	assert.equal(result.budgetClass, "heuristic", "外部请求固定启发式桶，禁 confirmed-pseudo");
	assert.equal(result.trimTo, undefined, "不带 trimTo：外部不掌握现场全文");
	assert.equal(result.contexts.length, 1);
	assert.equal(result.contexts[0].source.summary, "cot-anchor: external-request (semantic-stall-2)");
	assert.ok(result.contexts[0].content[0].text.includes("外部停滞检测请求在此软切"));
	assert.ok(result.contexts[0].content[0].text.includes("外部停滞文本"));
	// 事件：cutClass=external + reason + evidenceSeq 随 payload 头
	const ev = collector.emitted.find((item) => item.eventName === "cot-anchor/softcut-taken");
	assert.ok(ev, "发射 softcut-taken");
	assert.equal(ev.payload.cutClass, "external");
	assert.equal(ev.payload.reason, "semantic-stall-2");
	assert.equal(ev.payload.evidenceSeq, 5);
	assert.equal(ev.payload.sessionId, "s-hook");
	// 一次性：钩子再次被调用（无新挂起）不再切断
	const again = await softCut.handler({ sessionId: "s-hook" }, nextNull);
	assert.equal(again, null, "消费一次性，内部全关时不再切");
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("10：无挂起请求 + 内部全关 → 返回 null（不误切）", async () => {
	const { api, tempHome } = loadApi();
	const internalOff = {
		enableSoftCut: false,
		enablePseudoTool: false, enableRepeat: false, enableChurn: false,
		enableTransition: false, enableNumberRunaway: false,
		enableExternalSoftCut: true
	};
	const collector = collect();
	api.apply(mockCtx(collector), internalOff);
	const softCut = collector.listeners.find((item) => item.event === "agent/soft-cut");
	if (!softCut) {
		test.skip("本机内核无 agent/soft-cut 钩子，钩子级断言不适用");
		fs.rmSync(tempHome, { recursive: true, force: true });
		return;
	}
	const nextNull = async () => null;
	const result = await softCut.handler({ sessionId: "s-empty", fullVisibleText: "正常文本" }, nextNull);
	assert.equal(result, null);
	assert.equal(collector.emitted.length, 0, "未切断不发射事件");
	fs.rmSync(tempHome, { recursive: true, force: true });
});

// ═══ 四、服务注册与设置 ═══════════════════════════════════════════════════

test("11：apply 注册 ctx.provide(\"cotAnchor\")，经服务入口受理", () => {
	const { api, tempHome } = loadApi();
	const collector = collect();
	api.apply(mockCtx(collector), { enableExternalSoftCut: true });
	const service = collector.services.cotAnchor;
	assert.ok(service && typeof service.requestSoftCut === "function", "provide 的服务形态");
	const r = service.requestSoftCut({ sessionId: "s-service", fullVisibleText: "经服务受理" });
	assert.equal(r.accepted, true);
	assert.equal(r.delivery, "pending-next-soft-cut");
	assert.ok(api.externalSoftCutPending.get("s-service").anchorText.includes("经服务受理"));
	// 无效入参经服务原样返回拒绝形状
	assert.deepEqual(service.requestSoftCut({}), { accepted: false, reason: "invalid-session-id" });
	fs.rmSync(tempHome, { recursive: true, force: true });
});

test("12：DEFAULT_SETTINGS 与 SETTINGS_SCHEMA 成对且默认 false", () => {
	const { api, tempHome } = loadApi();
	assert.equal(api.DEFAULT_SETTINGS.enableExternalSoftCut, false);
	const entry = api.SETTINGS_SCHEMA.find((item) => item.key === "enableExternalSoftCut");
	assert.ok(entry, "schema 控件存在");
	assert.equal(entry.type, "boolean");
	assert.equal(entry.label, "允许外部插件请求软切");
	assert.equal(entry.group, "总开关");
	assert.ok(entry.hint.includes("dsh-derive-watcher"), "hint 说明供 watcher 停滞干预调用");
	assert.equal(api.applyRuntimeSettings({}).enableExternalSoftCut, false, "运行时默认值发布");
	fs.rmSync(tempHome, { recursive: true, force: true });
});

// ═══ 五、跨插件集成 ═══════════════════════════════════════════════════════

test("13：跨插件集成——watcher stall-2 请求 → cot-anchor 挂起 → 钩子现场消费出 cut 决策", async () => {
	const { api, tempHome } = loadApi();
	const collector = collect();
	// cot-anchor 侧：开启外部软切后 apply，拿到真实 ctx.provide 服务
	api.apply(mockCtx(collector), { enableExternalSoftCut: true });
	const anchorService = collector.services.cotAnchor;
	assert.ok(anchorService && typeof anchorService.requestSoftCut === "function");
	const softCut = collector.listeners.find((item) => item.event === "agent/soft-cut");

	// watcher 侧：真实 createStallController，getCotAnchor 指向上面这份真实服务
	const { createStallController } = await import("../../dsh-derive-watcher/lib/stall.js");
	const { EVT } = await import("../../dsh-derive-watcher/lib/events.js");
	const { DEFAULT_SETTINGS } = await import("../../dsh-derive-watcher/lib/settings.js");
	const events = [];
	const logs = [];
	const controller = createStallController({
		emit: (n, p) => events.push({ n, p }),
		log: (line) => logs.push(line),
		getSettings: () => ({ ...DEFAULT_SETTINGS, enableStall2SoftCut: true }),
		getL2: null,
		getCotAnchor: () => anchorService
	});
	const semDup = (step) => ({
		id: `j_${String(step).padStart(4, "0")}`, turn: 1, step,
		novelty: "duplicate", semantic_duplicate: true, duplicate_of: "j_0001",
		summary: "第 " + step + " 条重复结论：反复重读同一文件"
	});
	// 6 条语义重复触发 stall-2
	controller.onEntries("s-it", [semDup(1), semDup(2), semDup(3)]);
	const r = controller.onEntries("s-it", [semDup(4), semDup(5), semDup(6)]);
	assert.equal(r.level, 2);
	for (let i = 0; i < 8; i++) await new Promise((res) => setImmediate(res));

	// 断言链一：watcher 侧受理
	assert.ok(logs.some((line) => line.includes("[dsh-derive-watcher] L2 soft-cut requested")
		&& line.includes("delivery=pending-next-soft-cut")), "L2 soft-cut requested 日志");
	const iv = events.filter((e) => e.n === EVT.INTERVENTION);
	assert.equal(iv.length, 1);
	assert.equal(iv[0].p.action, "soft-cut-request");
	assert.equal(iv[0].p.accepted, true);
	assert.equal(iv[0].p.code, "semantic-stall-2");
	assert.equal(iv[0].p.delivery, "pending-next-soft-cut");

	// 断言链二：cot-anchor 侧已挂起（键为同一 sessionId）
	const pending = api.externalSoftCutPending.get("s-it");
	assert.ok(pending, "watcher 的请求已挂起进 cot-anchor 挂起表");
	assert.equal(pending.reason, "semantic-stall-2");
	assert.equal(pending.evidenceSeq, 2);
	assert.ok(pending.anchorText.includes("第 6 条重复结论"), "fullVisibleText 来自 entry.summary");

	// 断言链三：钩子现场消费 → cut 决策（本机内核提供钩子时才可验）
	if (!softCut) {
		// 内核缺钩子时至少证明「挂起表 + 服务受理」两环真实闭环；
		// 钩子消费环节由第 9 项测试在具备钩子的内核上覆盖。
		assert.equal(pending.anchorText.includes("外部停滞检测请求在此软切"), true);
		fs.rmSync(tempHome, { recursive: true, force: true });
		return;
	}
	const nextNull = async () => null;
	const cut = await softCut.handler(
		{ sessionId: "s-it", turn: 1, step: 6, fullVisibleText: "模型当次生成的现场全文（内部检测视角）" },
		nextNull
	);
	assert.ok(cut && cut.kind === "cut", "钩子现场消费挂起请求并返回 cut");
	assert.equal(cut.budgetClass, "heuristic");
	assert.equal(cut.contexts[0].source.summary, "cot-anchor: external-request (semantic-stall-2)");
	const ev = collector.emitted.find((item) => item.eventName === "cot-anchor/softcut-taken");
	assert.ok(ev && ev.payload.cutClass === "external" && ev.payload.reason === "semantic-stall-2");
	assert.equal(api.externalSoftCutPending.size, 0, "消费后挂起表清空");
	fs.rmSync(tempHome, { recursive: true, force: true });
});
