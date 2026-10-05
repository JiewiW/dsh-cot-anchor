/**
 * 真浏览器渲染校验：用 Chrome DevTools 协议驱动真实 Chrome 打开页面，
 * 读取真实 DOM 与控制台报错。
 *
 * 为什么不用 --dump-dom：DSH 页面会长期保持一条 WebSocket，`--virtual-time-budget`
 * 永远等不到「网络空闲」，Chrome 因此不会退出、dump 也是空的。
 * 走 CDP 则可以显式等待、显式取 DOM、显式收集 console/异常。
 *
 * 用法：node verify-browser.mjs <url> [等待毫秒] [点击路径,逗号分隔]
 * 点击路径用于真实打开「设置 → COT 锚点」，确认面板真的渲染出来；
 * 这是真实浏览器里的真实点击，不是伪造的断言。
 * 输出：JSON 摘要到 stdout；退出码非 0 表示页面存在加载失败信号。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

const targetUrl = process.argv[2];
const waitMs = Number(process.argv[3] || 12000);
const clickPath = (process.argv[4] || "").split(",").map((text) => text.trim()).filter(Boolean);
if (!targetUrl) {
	console.error("用法: node verify-browser.mjs <url> [等待毫秒]");
	process.exit(2);
}

const debugPort = 9333 + Math.floor(Math.random() * 200);
const userDataDir = mkdtempSync(join(tmpdir(), "cot-cdp-"));
let chrome = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(path) {
	const response = await fetch(`http://127.0.0.1:${debugPort}${path}`);
	return response.json();
}

/** 等待 DevTools HTTP 端点可用。 */
async function waitForDevTools(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetchJson("/json/version");
			return true;
		} catch {
			await sleep(300);
		}
	}
	return false;
}

/** 极简 CDP 客户端：发命令、等响应、收事件。 */
function connectCdp(wsUrl) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(wsUrl);
		let nextId = 1;
		const pending = new Map();
		const events = [];

		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id && pending.has(message.id)) {
				const { resolve: done, reject: fail } = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) fail(new Error(JSON.stringify(message.error)));
				else done(message.result);
				return;
			}
			if (message.method) events.push(message);
		});
		socket.addEventListener("error", (error) => reject(error));
		socket.addEventListener("open", () => resolve({
			events,
			send(method, params = {}) {
				const id = nextId++;
				return new Promise((done, fail) => {
					pending.set(id, { resolve: done, reject: fail });
					socket.send(JSON.stringify({ id, method, params }));
				});
			},
			close() { try { socket.close(); } catch { /* 已关闭 */ } }
		}));
	});
}

function cleanup() {
	try { if (chrome) chrome.kill(); } catch { /* 已退出 */ }
	try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const executable = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!executable) {
	console.error("未找到 Chrome/Edge 可执行文件");
	process.exit(2);
}

try {
	chrome = spawn(executable, [
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		"--no-first-run",
		"--disable-dev-shm-usage",
		"--disable-extensions",
		`--remote-debugging-port=${debugPort}`,
		`--user-data-dir=${userDataDir}`,
		"about:blank"
	], { stdio: "ignore" });

	if (!await waitForDevTools(30000)) {
		console.log(JSON.stringify({ ok: false, error: "DevTools 端点未就绪" }));
		cleanup();
		process.exit(1);
	}

	const targets = await fetchJson("/json/list");
	const page = targets.find((item) => item.type === "page");
	if (!page) {
		console.log(JSON.stringify({ ok: false, error: "未找到 page target" }));
		cleanup();
		process.exit(1);
	}

	const cdp = await connectCdp(page.webSocketDebuggerUrl);
	await cdp.send("Runtime.enable");
	await cdp.send("Log.enable");
	await cdp.send("Page.enable");
	await cdp.send("Network.enable");
	// 默认 headless 视口是 800x600，顶栏/侧栏的图标按钮会被折叠成 0x0，
	// 点不到。给一个真实桌面视口，界面才会展开。
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: 1680,
		height: 1000,
		deviceScaleFactor: 1,
		mobile: false
	});
	await cdp.send("Page.navigate", { url: targetUrl });
	await sleep(waitMs);

	// 真实点击路径：逐级点开目标界面，每步都等界面稳定
	const clickResults = [];
	for (const text of clickPath) {
		const script = `(function (target) {
			function visible(node) {
				if (!node.getBoundingClientRect) return false;
				var box = node.getBoundingClientRect();
				return box.width > 0 && box.height > 0;
			}
			function labelOf(node) {
				return (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
			}
			// 优先点真正的按钮：按 aria-label / 文本精确匹配，且要求可见。
			var buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
			var hit = buttons.find(function (node) {
				return (labelOf(node) === target || (node.textContent || '').trim() === target) && visible(node);
			});
			if (!hit) {
				var loose = Array.from(document.querySelectorAll('a,li,div,span'));
				hit = loose.find(function (node) {
					return (labelOf(node) === target || (node.textContent || '').trim() === target) && visible(node);
				});
			}
			if (!hit) return 'not-found';
			hit.click();
			return 'clicked:' + hit.tagName;
		})(${JSON.stringify(text)})`;
		const clicked = await cdp.send("Runtime.evaluate", { expression: script, returnByValue: true });
		clickResults.push({ text, result: clicked.result && clicked.result.value });
		// 设置面板与标签页都需要一帧以上才挂载完，等太短会点空。
		await sleep(4000);
	}

	const domResult = await cdp.send("Runtime.evaluate", {
		expression: "document.documentElement.outerHTML",
		returnByValue: true
	});
	const dom = domResult.result && domResult.result.value ? domResult.result.value : "";

	// 控制台与未捕获异常
	const consoleMessages = cdp.events
		.filter((event) => event.method === "Runtime.consoleAPICalled")
		.map((event) => (event.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" "))
		.filter((text) => text.length > 0);
	const exceptions = cdp.events
		.filter((event) => event.method === "Runtime.exceptionThrown")
		.map((event) => event.params.exceptionDetails?.exception?.description
			|| event.params.exceptionDetails?.text || "unknown exception");
	const logErrors = cdp.events
		.filter((event) => event.method === "Log.entryAdded" && event.params.entry.level === "error")
		.map((event) => event.params.entry.text);

	const failureSignals = [
		"Failed to load plugins",
		"module is not defined",
		"Illegal return statement",
		"Cannot access",
		"Uncaught"
	].filter((signal) => dom.includes(signal));

	const allErrors = [...exceptions, ...logErrors];
	const relevantErrors = allErrors.filter((text) => !/favicon|ERR_FILE_NOT_FOUND.*favicon/i.test(text));

	// 具体是哪些资源 404 —— 只有 URL 才能判断它是否与本插件有关
	const failedResponses = cdp.events
		.filter((event) => event.method === "Network.responseReceived")
		.map((event) => ({ url: event.params.response.url, status: event.params.response.status }))
		.filter((item) => item.status >= 400)
		.map((item) => `${item.status} ${item.url}`);

	// 本机还装着别的插件（任务看板/宠物等），它们的后端路由在本实例里本就不存在，
	// 会稳定报 404。判据只对本插件自己的请求负责。
	const ownFailures = [...new Set(failedResponses)].filter((line) => line.includes("cot-anchor"));
	const foreignFailures = [...new Set(failedResponses)].filter((line) => !line.includes("cot-anchor"));
	// 浏览器把每条 404 都记成同一句无 URL 的通用文本；当且仅当本插件无失败请求时，
	// 这些通用条目归因于外部插件，不计入本插件的健康判据。
	const ownConsoleErrors = ownFailures.length > 0
		? relevantErrors
		: relevantErrors.filter((text) => !/Failed to load resource/i.test(text));

	const report = {
		ok: failureSignals.length === 0
			&& ownConsoleErrors.length === 0
			&& ownFailures.length === 0
			&& dom.length > 1000
			&& dom.includes('id="root"'),
		domLength: dom.length,
		hasRoot: dom.includes('id="root"'),
		rendered: /设置|会话|新会话|对话/.test(dom),
		clickResults,
		cotTabFound: dom.includes("COT 锚点"),
		cotPanelFound: dom.includes("COT 静默采集与经验增补"),
		harvestCountersFound: /样本 \d+ 条/.test(dom) && dom.includes("待审候选"),
		failureSignals,
		ownFailures,
		foreignFailures,
		exceptions: exceptions.slice(0, 5),
		logErrors: logErrors.slice(0, 5),
		consoleMessages: consoleMessages.slice(0, 10)
	};
	console.log(JSON.stringify(report, null, 2));
	cdp.close();
	cleanup();
	process.exit(report.ok ? 0 : 1);
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
	cleanup();
	process.exit(1);
}
