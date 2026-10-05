import { readFileSync } from "node:fs";

/**
 * 采集面板的可执行校验：在 mock 的 __ModuleLoader__ / React / fetch 下真实渲染
 * 「COT 锚点」设置页组件，并驱动到「采集状态已加载」的那一帧。
 *
 * 为什么要做到这一步：test-client.mjs 只渲染了外层组件，而 CotHarvestPanel 是以
 * React 元素形式挂在树里的（惰性求值），它的函数体根本没被执行过。面板里的
 * fetch 地址、字段名、动作名一旦写错，只有真正执行才能发现——而这正是
 * 「打开页面才发现崩」的典型盲区。
 */

let loaded = null;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded = definition;
		}
	}
};

// ---------------------------------------------------------------------------
// 极简 hook 运行时：够用即可，只为让组件走完「首帧 → 副作用 → 重渲染」这条链
// ---------------------------------------------------------------------------
function createHookRuntime() {
	const states = [];
	const effectSlots = [];
	let cursor = 0;
	let pending = [];
	let dirty = false;

	return {
		beginRender() {
			cursor = 0;
			pending = [];
		},
		useState(initial) {
			const index = cursor++;
			if (states[index] === undefined) {
				states[index] = typeof initial === "function" ? initial() : initial;
			}
			const setter = (value) => {
				const next = typeof value === "function" ? value(states[index]) : value;
				if (next !== states[index]) {
					states[index] = next;
					dirty = true;
				}
			};
			return [states[index], setter];
		},
		useEffect(fn, deps) {
			const index = cursor++;
			const slot = effectSlots[index];
			const changed = !slot
				|| deps === undefined
				|| !slot.deps
				|| deps.length !== slot.deps.length
				|| deps.some((dep, i) => dep !== slot.deps[i]);
			if (changed) {
				effectSlots[index] = { deps, run: fn, cleanup: slot && slot.cleanup };
				pending.push(index);
			}
		},
		flushEffects() {
			const list = pending;
			pending = [];
			for (const index of list) {
				const slot = effectSlots[index];
				if (!slot) continue;
				if (typeof slot.cleanup === "function") slot.cleanup();
				const returned = slot.run();
				slot.cleanup = typeof returned === "function" ? returned : undefined;
			}
		},
		get dirty() { return dirty; },
		clearDirty() { dirty = false; }
	};
}

/** 反复渲染直到状态稳定（最多 maxPasses 轮），每轮都让 promise 落地。 */
async function settle(component, runtime, maxPasses = 8) {
	let tree = null;
	for (let pass = 0; pass < maxPasses; pass++) {
		runtime.beginRender();
		tree = component();
		runtime.flushEffects();
		// 两轮微任务 + 一个宏任务，足够 fetch 链（.then().then()）落地
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (!runtime.dirty) return tree;
		runtime.clearDirty();
	}
	return tree;
}

/** 深度遍历元素树，收集全部字符串子节点。 */
function collectText(node, out = []) {
	if (node === null || node === undefined || typeof node === "boolean") return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const item of node) collectText(item, out);
		return out;
	}
	if (typeof node === "object") {
		if (Array.isArray(node.children)) {
			for (const child of node.children) collectText(child, out);
		}
		if (node.props && typeof node.props === "object") {
			for (const value of Object.values(node.props)) {
				if (typeof value === "string") out.push(value);
			}
		}
	}
	return out;
}

/** 找出树里所有「函数组件」子元素（用于定位 CotHarvestPanel）。 */
function collectFunctionElements(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) collectFunctionElements(item, out);
		return out;
	}
	if (typeof node.type === "function") out.push(node);
	if (Array.isArray(node.children)) {
		for (const child of node.children) collectFunctionElements(child, out);
	}
	return out;
}

/** 收集全部按钮元素。 */
function collectButtons(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) collectButtons(item, out);
		return out;
	}
	if (node.type === "button") out.push(node);
	if (Array.isArray(node.children)) {
		for (const child of node.children) collectButtons(child, out);
	}
	return out;
}

// ---------------------------------------------------------------------------
// fetch 替身：按 URL 与动作返回固定载荷，并记录每一次调用
// ---------------------------------------------------------------------------
const fetchCalls = [];
const SETTINGS_PAYLOAD = {
	ok: true,
	schema: [{ key: "enableHarvest", label: "启用 CoT 静默采集", type: "boolean", group: "CoT 采集" }],
	settings: { enableHarvest: true },
	defaults: { enableHarvest: false }
};
const HARVEST_PAYLOAD = {
	ok: true,
	enabled: true,
	samples: 42,
	pending: 7,
	analyzing: false,
	shadowRounds: 20,
	proposals: [{
		id: "prp_abc123",
		kind: "new-pattern",
		detector: "churn",
		title: "中文短句空转",
		observation: "反复「再捋一遍」但本地 churn 命中低于阈值。",
		evidence: ["smp_1", "smp_2"],
		featureSpec: { literals: ["再捋一遍"] },
		confidence: 0.72,
		seenCount: 3
	}],
	patterns: [{
		id: "pat_xyz789",
		detector: "churn",
		kind: "literal-phrase",
		literal: "往回倒一下",
		mode: "shadow",
		shadowHits: 4,
		enabled: true
	}],
	thresholdShifts: [],
	paths: {
		samples: "C:\\Users\\u\\.dsh\\storages\\cot-anchor\\samples.jsonl",
		proposals: "C:\\Users\\u\\.dsh\\storages\\cot-anchor\\proposals.json",
		patterns: "C:\\Users\\u\\.dsh\\storages\\cot-anchor\\patterns.json"
	}
};

globalThis.fetch = function (url, options) {
	const method = (options && options.method) || "GET";
	fetchCalls.push({ url, method, body: options && options.body ? JSON.parse(options.body) : null });
	if (method === "POST") {
		const body = JSON.parse(options.body);
		if (body.action === "analyze") return Promise.resolve({ json: () => Promise.resolve({ ...HARVEST_PAYLOAD, ok: true, findings: 2 }) });
		return Promise.resolve({ json: () => Promise.resolve({ ...HARVEST_PAYLOAD, ok: true }) });
	}
	if (url === "/plugins/cot-anchor/settings") return Promise.resolve({ json: () => Promise.resolve(SETTINGS_PAYLOAD) });
	return Promise.resolve({ json: () => Promise.resolve(HARVEST_PAYLOAD) });
};

const code = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function(code)();

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

const runtime = createHookRuntime();
const ReactStub = {
	createElement(type, props, ...children) {
		return { type, props: props || {}, children };
	},
	useState: runtime.useState,
	useEffect: runtime.useEffect
};

const exportsObject = loaded.factory(function (name) {
	if (name === "react") return ReactStub;
	throw new Error("unexpected require: " + name);
});

const registrations = [];
const ctx = {
	slots: {
		inject(key, callback) { callback(); },
		register(options, component) { registrations.push({ options, component }); }
	}
};
exportsObject.apply(ctx);

check("注册了一个设置页条目", registrations.length === 1, registrations.length + " 个");

const SettingsComponent = registrations[0].component;
const settingsTree = await settle(SettingsComponent, runtime);

const settingsText = collectText(settingsTree).join(" | ");
check("设置页渲染出原有说明文案", settingsText.includes("控制\"结论锚点注入\""));
check("设置页渲染出总开关行", settingsText.includes("启用 CoT 静默采集"));
// 面板是惰性 React 元素：它的文案此刻不会出现在父树文本里，必须单独渲染才可见。
check("父树文本不含面板文案（惰性求值，符合预期）", !settingsText.includes("COT 静默采集与经验增补"));

// --- 定位并真实执行 CotHarvestPanel ---------------------------------------
const functionElements = collectFunctionElements(settingsTree);
check("树中存在函数组件子元素（采集面板）", functionElements.length >= 1, functionElements.length + " 个");

const Panel = functionElements[0].type;
const panelTree = await settle(Panel, runtime);
const panelText = collectText(panelTree).join(" | ");

check("面板已进入「已加载」帧而非加载中", !panelText.includes("正在读取采集状态"), panelText.slice(0, 120));
check("面板渲染出样本计数", panelText.includes("样本 42 条"), panelText.slice(0, 200));
check("面板渲染出未分析计数", panelText.includes("未分析 7 条"));
check("面板渲染出候选条数", panelText.includes("待审候选 1 条"));
check("面板渲染出已采纳条数", panelText.includes("已采纳 1 条"));
check("面板渲染出候选标题", panelText.includes("中文短句空转"));
check("面板渲染出候选字面量", panelText.includes("再捋一遍"));
check("面板渲染出置信度百分比", panelText.includes("72%"), panelText.slice(0, 300));
check("面板渲染出影子期模式说明", panelText.includes("影子期（只计数）"));
check("面板渲染出影子期命中数", panelText.includes("本会打断 4 次"));
check("面板渲染出存储路径", panelText.includes("samples.jsonl"));

// --- 按钮动作真的绑到了 POST ----------------------------------------------
const buttons = collectButtons(panelTree);
const labels = buttons.map((button) => (button.children || []).filter((child) => typeof child === "string").join(""));
check("面板渲染出「立即分析」按钮", labels.some((label) => label.includes("立即分析")), labels.join(" / "));
check("面板渲染出「采纳」按钮", labels.some((label) => label.includes("采纳")));
check("面板渲染出「转正」按钮（影子期模式）", labels.some((label) => label.includes("转正")));
check("全部按钮都绑定了 onClick", buttons.every((button) => typeof button.props.onClick === "function"));

// 真实点一次「立即分析」
const analyzeButton = buttons.find((button) => (button.children || []).join("").includes("立即分析"));
analyzeButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
const analyzeCall = fetchCalls.find((call) => call.method === "POST" && call.body && call.body.action === "analyze");
check("点「立即分析」发出了 POST action=analyze", analyzeCall !== undefined, JSON.stringify(analyzeCall && analyzeCall.body));

// 真实点一次「采纳」
const approveButton = buttons.find((button) => (button.children || []).join("").includes("采纳"));
approveButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
const approveCall = fetchCalls.find((call) => call.method === "POST" && call.body && call.body.action === "approve");
check("点「采纳」发出了 POST action=approve 且带候选 id",
	approveCall !== undefined && approveCall.body.id === "prp_abc123",
	JSON.stringify(approveCall && approveCall.body));

// 真实点一次「转正」
const promoteButton = buttons.find((button) => (button.children || []).join("").includes("转正"));
promoteButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
const promoteCall = fetchCalls.find((call) => call.method === "POST" && call.body && call.body.action === "promote");
check("点「转正」发出了 POST action=promote 且带模式 id",
	promoteCall !== undefined && promoteCall.body.id === "pat_xyz789",
	JSON.stringify(promoteCall && promoteCall.body));

check("面板首次加载走的是 GET", fetchCalls.some((call) => call.method === "GET" && call.url === "/plugins/cot-anchor/harvest"));

if (failed === 0) console.log("\n全部采集面板断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
