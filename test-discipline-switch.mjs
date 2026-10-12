/**
 * FIX-09：命令执行纪律块独立开关（enableExecDisciplineBlock）端到端测试。
 *
 * 纪律块只挂在 tools/post-execute 正常锚点注入路径（INVALID_ARGS 恢复分支
 * 本就不含纪律块）。两组断言：
 *  ① 关态（false）：纪律块不构造、不注入——additionalContexts 里只有结论
 *     锚点，没有 summary === "cot-anchor: exec-discipline" 的条目；结论锚点
 *     本身照常注入（其余锚点链不受影响）。
 *  ② 开态（true，默认）：纪律块随锚点同车注入且与开关引入前逐字一致——
 *     同一固定文案、同一 summary、同一顺序（纪律在前、锚点在后）。
 *
 * 「逐字一致」的基线是开关引入前提交（e2f2926）post-execute 注入的同一
 * 纪律文案；此处内嵌为 EXPECTED_DISCIPLINE_TEXT 常量做回归锁，任何文案
 * 漂移都会让本测试失败，防止开关化顺手改了文案。
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
	`${source}; return { apply, applyRuntimeSettings, injectedAnchorHashesBySession, DEFAULT_SETTINGS };`
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

// --- mock ctx：捕获 tools/post-execute 处理器 --------------------------------
const listeners = [];
const webServer = { register() { return () => {}; } };
const ctx = {
	webServer,
	on(event, handler) { listeners.push({ event, handler }); return () => {}; },
	effect() { return () => {}; },
	get(key) { return key === "webServer" ? webServer : undefined; },
	emit() {},
	logger: { info() {}, warn() {}, error() {} }
};
api.apply(ctx);

const postExecuteHandler = listeners.find((item) => item.event === "tools/post-execute")?.handler;
check("FIX-09 捕获 tools/post-execute 处理器", typeof postExecuteHandler === "function");

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
const DISCIPLINE_SUMMARY = "cot-anchor: exec-discipline";

// ≥250 字符、含 3 条显式结论句的推理（保证正常路径提取非空、锚点确实注入）。
const c1 = "所以根因是灰度分组对旧版本客户端回退到了缓存的默认模板，键位读到了旧值。";
const c2 = "所以修复方向是灰度期间冻结比例，并在读取侧补齐回读校验。";
const c3 = "所以回归验证必须覆盖双版本客户端的键位兼容场景。";
const fillerBase = "先交代一下背景，刚才把两边的日志并排看完，时间线已经对齐了，中间那段波动的来源也定位到了。接下来把每一步的先后顺序再顺一遍，确认没有遗漏的分支，也确认回滚脚本在两个环境里都演练过一遍。";
const fillerExtra = "观察窗口的指标基线没有漂移，采集到的样本量足够支撑结论";
let reasoningText = fillerBase;
while (`${reasoningText}${c1}${c2}${c3}`.length < 260) reasoningText += fillerExtra;
reasoningText = `${reasoningText}${c1}${c2}${c3}`;

// 默认值客观核对（默认必须开）。
check("FIX-09 DEFAULT_SETTINGS.enableExecDisciplineBlock === true", api.DEFAULT_SETTINGS.enableExecDisciplineBlock === true, String(api.DEFAULT_SETTINGS.enableExecDisciplineBlock));

const contextText = (entry) => entry?.content?.[0]?.text ?? "";
const isDiscipline = (entry) => entry?.source?.summary === DISCIPLINE_SUMMARY;

async function runInjectionOnce(sessionId, flagValue) {
	api.applyRuntimeSettings({ enableExecDisciplineBlock: flagValue });
	api.injectedAnchorHashesBySession.clear();
	const session = {
		id: sessionId,
		surface: { nodes: ["node-1"] },
		eventAt() {
			return { type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: reasoningText }] } } };
		}
	};
	const exec = { agent: { session } };
	const result = { isError: false };
	const next = async () => ({});
	return postExecuteHandler(exec, result, next);
}

// ① 关态：纪律块不注入，结论锚点仍在且不受影响
{
	const out = await runInjectionOnce("sess-discipline-off", false);
	const contexts = out?.additionalContexts ?? [];
	const disciplineEntries = contexts.filter(isDiscipline);
	check("关态：additionalContexts 中无纪律块（0 条）", disciplineEntries.length === 0, `${disciplineEntries.length} 条`);
	check("关态：结论锚点照常注入（锚点链不受影响）", contexts.length === 1 && contexts[0]?.source?.summary?.includes("cot-anchor:"), `contexts=${contexts.length}`);
	check("关态：锚点正文仍含结论句", contextText(contexts[0]).includes("灰度期间冻结比例"));
	check("关态：注入文本中不含纪律文案", !contexts.some((entry) => contextText(entry).includes("命令执行纪律")));
}

// ② 开态：纪律块注入，文案/summary/顺序与开关引入前逐字一致
{
	const out = await runInjectionOnce("sess-discipline-on", true);
	const contexts = out?.additionalContexts ?? [];
	check("开态：additionalContexts 恰 2 条（纪律 + 锚点）", contexts.length === 2, `${contexts.length} 条`);
	const disciplineEntry = contexts[0];
	const anchorEntry = contexts[1];
	check("开态：第 1 条是纪律块（summary 逐字）", isDiscipline(disciplineEntry), disciplineEntry?.source?.summary);
	check("开态：纪律文案与基线逐字一致", contextText(disciplineEntry) === EXPECTED_DISCIPLINE_TEXT);
	check("开态：第 2 条是结论锚点", typeof anchorEntry?.source?.summary === "string" && anchorEntry.source.summary.includes("points"));
	check("开态：锚点正文含结论句", contextText(anchorEntry).includes("灰度期间冻结比例"));
	check("开态：纪律块文本以『⓪ 命令执行纪律』起头", contextText(disciplineEntry).startsWith("⓪ 命令执行纪律"));
}

// ③ 两态锚点正文一致（开关只影响纪律块，不动锚点本身）
{
	const offOut = await runInjectionOnce("sess-compare-off", false);
	const onOut = await runInjectionOnce("sess-compare-on", true);
	const offAnchor = offOut.additionalContexts.find((entry) => !isDiscipline(entry));
	const onAnchor = onOut.additionalContexts.find((entry) => !isDiscipline(entry));
	check("两态：结论锚点正文逐字一致", contextText(offAnchor) === contextText(onAnchor));
}

try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

if (failed === 0) console.log("\n全部 FIX-09 纪律块开关断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
