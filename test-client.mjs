import { readFileSync } from "node:fs";

/**
 * 客户端半边的可执行校验：在 mock 的 __ModuleLoader__ / React 下真实执行
 * lib/client.js，确认
 *   1) 模块格式正确（不是顶层 return，而是 __ModuleLoader__.load 壳）；
 *   2) factory 返回的对象带 inject/apply；
 *   3) apply 真的注册了 settings.section 标签页（含 id/label）；
 *   4) 组件能完成一次渲染而不抛错。
 * 这补上了"node --check 抓不到模块格式错误"与"必须人工开页面"之间的空档。
 */

let loaded = null;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded = definition;
		}
	}
};

const code = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
// 以脚本形态执行（非 ESM），与 combo 拼接后的真实情形一致
new Function(code)();

let failed = 0;
function check(label, condition, extra) {
	const ok = Boolean(condition);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` → ${extra}`}`);
	if (!ok) failed += 1;
}

check("client.js 调用了 __ModuleLoader__.load", loaded !== null);
check("模块 id 正确", loaded && loaded.id === "dsh-cot-anchor", loaded && loaded.id);

// 极简 React 替身：只覆盖组件用到的 API
const ReactStub = {
	createElement(type, props, ...children) {
		return { type, props: props || {}, children };
	},
	useState(initial) {
		return [initial, function () {}];
	},
	useEffect() {}
};

const exportsObject = loaded.factory(function (name) {
	if (name === "react") return ReactStub;
	throw new Error("unexpected require: " + name);
});

check("factory 返回 inject 含 slots", Array.isArray(exportsObject.inject) && exportsObject.inject.includes("slots"));
check("factory 返回 apply 函数", typeof exportsObject.apply === "function");

const registrations = [];
const ctx = {
	slots: {
		inject(key, callback) {
			// 同步执行注册逻辑（真实实现是 fiber 调度，这里只验形状）
			callback();
		},
		register(options, component) {
			registrations.push({ options, component });
		}
	}
};

try {
	exportsObject.apply(ctx);
	check("apply 执行无异常", true);
} catch (error) {
	check("apply 执行无异常", false, String(error && error.message ? error.message : error));
}

check("注册了一个设置页条目", registrations.length === 1, registrations.length + " 个");
if (registrations.length > 0) {
	const { options, component } = registrations[0];
	check("注册槽位为 settings.section", options.name === "settings.section", options.name);
	check("注册 id 为 cot-anchor", options.id === "cot-anchor", options.id);
	check("注册 label 非空", typeof options.label === "string" && options.label.length > 0, options.label);
	check("注册 order 为数字", typeof options.order === "number", options.order);

	try {
		const tree = component();
		check("组件首次渲染返回元素", tree !== null && tree !== undefined && typeof tree === "object");
	} catch (error) {
		check("组件首次渲染返回元素", false, String(error && error.message ? error.message : error));
	}
}

if (failed === 0) console.log("\n全部客户端半边断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);