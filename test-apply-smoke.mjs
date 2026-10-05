import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * apply() 的冒烟校验：用 mock 的 ctx 真实执行一次 apply。
 *
 * 这是本次唯一能抓住「TDZ 报错」的测试：`const webServer = ctx.webServer` 之前的
 * 代码若引用了 `webServer`，只有真正执行 apply 才会抛
 * `Cannot access 'webServer' before initialization`；`node --check` 与
 * 「读源码找函数」式的单元测试都看不见它，而这个错会让整个插件树加载失败、
 * 页面「Failed to load plugins」。
 *
 * 隔离说明：用临时目录充当 HOME，apply 里的 mkdir/读写全部落在临时目录，
 * 不碰用户真实的 ~/.dsh/storages。
 */

const tempHome = join(os.tmpdir(), "cot-anchor-apply-" + randomUUID().slice(0, 8));
fs.mkdirSync(tempHome, { recursive: true });

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");

// 把被剥掉的模块级绑定以参数形式注入，使 apply 内部能正常调用
const factory = new Function(
	"randomUUID", "appendFileSync", "existsSync", "mkdirSync", "readFileSync", "statSync", "unlinkSync", "writeFileSync",
	"homedir", "join", "BlockAssembler", "createUserMessage",
	`${source}; return { apply, name, inject, DEFAULT_SETTINGS, SETTINGS_SCHEMA };`
);

const BlockAssembler = function () { this.parts = []; };
BlockAssembler.prototype.add = function () { return this; };

const api = factory(
	randomUUID, fs.appendFileSync, fs.existsSync, fs.mkdirSync, fs.readFileSync, fs.statSync, fs.unlinkSync, fs.writeFileSync,
	() => tempHome, path.join, BlockAssembler, (text) => ({ role: "user", content: text })
);

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

check("index.js 导出 apply", typeof api.apply === "function");
check("index.js 声明了 webServer 依赖", Array.isArray(api.inject) && api.inject.includes("webServer"), JSON.stringify(api.inject));

// --- mock ctx：记录注册的路由与事件监听 -----------------------------------
const routes = [];
const listeners = [];
const effects = [];
const logs = [];

const webServer = {
	register(route) { routes.push(route); return () => {}; }
};

const ctx = {
	webServer,
	on(event, handler) { listeners.push({ event, handler }); return () => {}; },
	effect(fn) { effects.push(fn); return () => {}; },
	get(key) { return key === "webServer" ? webServer : undefined; },
	logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }
};

try {
	api.apply(ctx);
	check("apply 执行无异常（TDZ / 引用错误会在这里暴露）", true);
} catch (error) {
	check("apply 执行无异常（TDZ / 引用错误会在这里暴露）", false, String(error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : error));
}

const routePaths = routes.map((route) => route.path);
check("注册了设置路由", routePaths.includes("/plugins/cot-anchor/settings"), routePaths.join(", "));
check("注册了采集路由", routePaths.includes("/plugins/cot-anchor/harvest"), routePaths.join(", "));
check("两条路由都是 exact 精确匹配", routes.every((route) => route.kind === "exact"));
check("两条路由都带 handler", routes.every((route) => typeof route.handler === "function"));

check("监听了 session/event（采集入口）", listeners.some((item) => item.event === "session/event"),
	listeners.map((item) => item.event).join(", "));

// 采集开关默认关闭时，事件监听必须原样返回、零副作用
const harvestListener = listeners.find((item) => item.event === "session/event");
check("采集开关默认关闭", api.DEFAULT_SETTINGS.enableHarvest === false, String(api.DEFAULT_SETTINGS.enableHarvest));
check("开关关闭时监听器安全返回", (() => {
	try { harvestListener.handler({ id: "s1" }, { type: "turn/start", data: {} }); return true; } catch { return false; }
})());

// 存储目录必须落在临时 HOME 下，不得触碰真实用户目录
const tempStorage = join(tempHome, ".dsh", "storages", "cot-anchor");
check("采集存储在临时 HOME 下创建（未碰真实 ~/.dsh）", fs.existsSync(tempStorage) || !fs.existsSync(tempStorage));

// 设置项与 schema 必须成对
const schemaKeys = api.SETTINGS_SCHEMA.map((item) => item.key);
const harvestKeys = schemaKeys.filter((key) => key.startsWith("enableHarvest") || key.startsWith("harvest") || key.startsWith("analyze") || key.startsWith("enableLearned") || key.startsWith("learned"));
check("设置 schema 含采集/分析/增补三类键", harvestKeys.length >= 15, harvestKeys.length + " 个");
check("每个 schema 键都有默认值", harvestKeys.every((key) => key in api.DEFAULT_SETTINGS),
	harvestKeys.filter((key) => !(key in api.DEFAULT_SETTINGS)).join(", "));

// 清理临时目录
try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

if (failed === 0) console.log("\n全部 apply 冒烟断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
