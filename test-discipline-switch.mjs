/**
 * FIX-09 的 enableExecDisciplineBlock 开关（v0.2.2 合并后）端到端测试。
 *
 * 命令执行纪律段不再走 post-execute 单独注入，而是经 apply 内的
 * ctx.inject(['systemPrompt']) 注册为运行时上下文快照段
 * （dsh:cot-anchor-exec-discipline, order=20000）。FIX-09 开关语义保留，
 * 改为门控快照段的 text：(开关开) 返回纪律全文；(开关关) 返回空串，
 * 内核装配快照遇空文本即省略该段。
 *
 * 断言：
 *  ① 注册段存在且 name/order 正确；inject 声明含 systemPrompt；
 *  ② 默认开（DEFAULT_SETTINGS.enableExecDisciplineBlock === true）时，
 *     text() 返回纪律全文（与开关引入前 e2f2926 的文案逐字一致）；
 *  ③ applyRuntimeSettings({enableExecDisciplineBlock:false}) 后 text() 返回空串；
 *  ④ 重新开（true）后 text() 恢复全文；
 *  ⑤ 开关只影响纪律段文本，不影响注册段的存在性。
 *
 * 「逐字一致」的基线是开关引入前提交 post-execute 注入的同一纪律文案；
 * 此处内嵌为 EXPECTED_DISCIPLINE_TEXT 常量做回归锁，任何文案漂移都会让
 * 本测试失败，防止开关化改了文案。
 */
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const tempHome = path.join(os.tmpdir(), "cot-discipline-" + randomUUID().slice(0, 8));
fs.mkdirSync(tempHome, { recursive: true });

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "").replace(/^export \{[^\n]*$/gm, "");

const factory = new Function(
	"randomUUID", "appendFileSync", "existsSync", "mkdirSync", "readFileSync", "statSync", "unlinkSync", "writeFileSync",
	"homedir", "join", "createRequire", "BlockAssembler", "createUserMessage",
	`${source}; return { apply, applyRuntimeSettings, DEFAULT_SETTINGS, inject };`
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

// --- mock ctx：捕获 apply 内注册的 systemPrompt 快照段 ----------------------
const contexts = [];
const webServer = { register() { return () => {}; } };
const ctx = {
	webServer,
	on(event, handler) { event; handler; return () => {}; },
	effect() { return () => {}; },
	// v0.2.1/v0.2.2：纪律段走 ctx.inject(['systemPrompt'], scope => scope.effect(...)) 挂载。
	inject(services, callback) {
		if (services.includes("systemPrompt")) {
			callback({
				effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
				systemPrompt: {
					context(segment) { contexts.push(segment); return () => {}; }
				}
			});
		}
		return () => {};
	},
	get(key) { return key === "webServer" ? webServer : undefined; },
	emit() {},
	logger: { info() {}, warn() {}, error() {} }
};

try {
	api.apply(ctx);
	check("apply 执行无异常（TDZ / 引用错误会在这里暴露）", true);
} catch (error) {
	check("apply 执行无异常（TDZ / 引用错误会在这里暴露）", false, String(error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : error));
}

// 开关引入前（e2f2926）post-execute 注入的纪律文案，逐字基线，禁止漂移。
const EXPECTED_DISCIPLINE_TEXT = "⓪ 命令执行纪律（最高优先，高于一切）：跑任何命令（pwsh/bash/node/npm/安装/构建/下载/测试/长任务）都不许盲等，且必须核验结果。"
	+ "① 单次等待 ≤10 秒；禁止 timeout_ms≥60000 的阻塞等待、禁止 Start-Sleep/Sleep 长延时、禁止 sleep N && 检查。"
	+ "② 每轮必须查并打印一个『增长型标量』——文件/目录是否出现、字节数是否变大、日志是否追加、已下载量是否增加、输出行数是否增加。"
	+ "③ 『进程还在』『任务 state=running』不算进展证据，禁止据此继续等；连续 2 轮零增长即判僵死，"
	+ "用精确 PID 中断（禁止按命令名通配批量杀）并立刻换办法（换镜像源→换工具/协议→复用本机缓存→降级最小子集→报告用户）。"
	+ "④ 起长任务前把精确 PID 落盘。⑤ 长任务按固定短间隔（≤10 秒）轮询等待，禁止盲等。"
	+ "⑥ 命令结束必须核验：看退出码、看产物是否真的生成、看日志关键行，不以『命令跑了没报错』当成功。"
	+ "⑦ 输出为空/被吞/返回 -1 时，第一动作是读该命令本应写出的报告或产物判成功，不要追加复查命令。"
	+ "⑧ 同一命令同样参数失败最多重试 2 次，之后换办法或上报。详见 ~/.dsh/AGENTS.md 第 0 节。";

const DISCIPLINE_CONTEXT_NAME = "dsh:cot-anchor-exec-discipline";

check("index.js 声明了 systemPrompt 依赖", Array.isArray(api.inject) && api.inject.includes("systemPrompt"), JSON.stringify(api.inject));
check("FIX-09 DEFAULT_SETTINGS.enableExecDisciplineBlock === true", api.DEFAULT_SETTINGS.enableExecDisciplineBlock === true, String(api.DEFAULT_SETTINGS.enableExecDisciplineBlock));

// 注册段定位：apply 时应恰好注册一条纪律快照段。
const disciplineSegment = contexts.find((segment) => segment?.name === DISCIPLINE_CONTEXT_NAME);
check("注册了 dsh:cot-anchor-exec-discipline 快照段", typeof disciplineSegment === "object");
check("该段 order === 20000", disciplineSegment?.order === 20000, String(disciplineSegment?.order));

// ① 默认开态：text() 返回纪律全文且与基线逐字一致
const defaultText = typeof disciplineSegment?.text === "function" ? disciplineSegment.text() : "";
check("开态（默认）：text() 返回纪律全文", typeof defaultText === "string" && defaultText.length > 0, `${defaultText.length} 字符`);
check("开态（默认）：文案与基线逐字一致", defaultText === EXPECTED_DISCIPLINE_TEXT);
check("开态（默认）：以『⓪ 命令执行纪律』起头", defaultText.startsWith("⓪ 命令执行纪律"));
check("开态（默认）：含 AGENTS.md 指引", defaultText.includes("AGENTS.md 第 0 节"));

// ② 关态：开关关闭后 text() 返回空串（内核装配遇空文本即省略该段）
api.applyRuntimeSettings({ enableExecDisciplineBlock: false });
const offText = typeof disciplineSegment?.text === "function" ? disciplineSegment.text() : "NOT_FUNCTION";
check("关态：text() 返回空串", offText === "", `len=${offText.length}`);
check("关态：注册段仍存在（开关只门控文本，不动注册）", contexts.some((segment) => segment?.name === DISCIPLINE_CONTEXT_NAME));

// ③ 重新开：text() 恢复全文
api.applyRuntimeSettings({ enableExecDisciplineBlock: true });
const reonText = typeof disciplineSegment?.text === "function" ? disciplineSegment.text() : "NOT_FUNCTION";
check("重开：text() 恢复纪律全文", reonText === EXPECTED_DISCIPLINE_TEXT);

try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

if (failed === 0) console.log("\n全部 FIX-09 纪律块开关断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);