#!/usr/bin/env node
/**
 * soft-cut 内核移植工具（单一事实源主副本）—— 为 DSH 0.2.0-rc.2 补回
 * "生成中途软切"能力，并一次性叠加与线上同源的 P4/P5 agent-loop 增量。
 *
 * ## 背景
 *
 * 上游自 0.1.5-rc.3 起移除了宿主钩子 `agent/soft-cut` 及其配套的流内中断机构
 * （0.1.5-rc.1 / rc.2 具备；0.1.6 / 0.1.7 / 0.2.x 均无）。dsh-cot-anchor 的
 * "打转打断"判定全部挂在这个钩子上，在这些版本上会**静默失效**：插件加载无报错、
 * 日志正常、结论注入照常工作，唯独打断不触发。
 *
 * 本工具一次产出 = 基础移植 A-D（从 0.1.5-rc.2 搬回流内软切）+ P4/P5 agent-loop
 * 增量（软切预算抑制升级、agent/soft-cut-suppressed、agent/abort-turn 粘性终止、
 * transitionTextMode 分流、出站通知、闭标签转写等）。P4/P5 块与
 * 宿主 DSH 仓规范补丁器 tools/patch-agent-loop.mjs 的 AGENT_LOOP_BLOCKS **逐字同源**
 * （2026-10-12 同步）：整改书 FIX-08 要求同步 P4；因 P4/P5 在规范补丁器中同属一个
 * 不可分割的有序块数组、P5 已在线上运行且是 cot-anchor FIX-09 前置（P0-1），
 * 拆分会产出线上从未存在过、无法字节级校验的中间态，故整组同源搬入。
 * compaction-basic / dsh-tools 的补丁块不属于本工具目标（包不同），不在此同步。
 *
 * ## 用法
 *
 *   node apply-softcut-port.mjs            # 应用（要求目标是未改写的原始 0.2.0-rc.2）
 *   node apply-softcut-port.mjs --check    # 只看当前状态，不修改
 *   node apply-softcut-port.mjs --revert   # 回滚到移植前的备份
 *
 * 目标内核文件自动定位，无需手工填路径；如需指定，用环境变量：
 *
 *   PowerShell:  $env:SOFTCUT_TARGET = '<绝对路径>'
 *   bash/zsh:     SOFTCUT_TARGET='<绝对路径>' node apply-softcut-port.mjs
 *
 * ## 安全设计
 *
 * 1. 改写前逐个校验替换锚点在当前文本中**恰好出现一次**；任一不匹配即整体中止，
 *    不写入任何内容（内核文件被改坏会导致 DSH 无法启动）。
 * 2. 首次改写自动创建 `<file>.bak-pre-softcut-port`，`--revert` 读它还原。
 * 3. 写盘后执行 `node --check` 语法校验并逐项核对补丁标记与产出哈希；任一不符
 *    自动回滚备份并以非 0 退出码结束。
 * 4. 【重跑警示】内核升级或本脚本升级后需要重跑时，**必须先 `--revert`**
 *    （或确认目标是未被任何补丁改写的原始 0.2.0-rc.2）。apply 前强制做内核
 *    版本 + 原文 SHA256 双重自检：版本不在支持名单、或原文哈希不是受支持的
 *    原始内核哈希，一律拒跑（退出码 1），不写任何内容——防止在漂移内核上
 *    重复/错位补丁把内核改坏。
 * 5. 移植内容以注释标记 `DSH-SOFT-CUT-PORT` 与行内标记 `@local-patch p4-...` /
 *    `@local-patch p5-...` 标识，可随时用 `--check` 确认状态。
 *
 * ## 移植的基础改动 A-D
 *
 * | 处 | 位置（按代码语义定位，勿按行号） | 内容 |
 * | --- | --- | --- |
 * | A | 最后一条 import 之后 | 检查间隔/尾部窗口常量；分类软切预算 4 常量（heuristic 6 / confirmed-repeat 20 / pseudoTool 3 / total 29）与 3 个模块顶层纯函数（softCutBudgetKey / shouldShortCircuitSoftCut / decideSoftCutBudget） |
 * | B | `wakeDriver()` 的 `setPhase({kind:"running",…})` | 新增 `softCutBudget` 分类计数对象（turn 重置点） |
 * | C1 | `step()` 中 `firstAttempt = false;` 之后 | 独立 `softCutAbort` + `requestSignal`；`buildRequest()` 末参改用它 |
 * | C2 | `for await (const chunk of stream)` 循环内 | 累积可见文本，按间隔调用 `agent/soft-cut` waterfall（payload 带 sessionId）；先过 total 总闸，返回 cut 后按 cutClass 分类判定 take/ignore，take 才中止上游请求 |
 * | D1 | `step()` 内 `catch` 开头 | 区分"自己切的"与"真出错" |
 * | D2 | 紧随其后的 `try { const finish = …` 之前 | 软切边界：前缀按正常消息落盘 + 裁掉重复尾巴 + 续跑 |
 *
 * ## 预算语义
 *
 * 软切按 cutClass 分三类独立计数：confirmed-repeat（repeat/numberRunaway，字节级
 * 确证）20 次/turn；heuristic（churn/transition，启发式）6 次/turn；pseudoTool
 * （伪工具文本，有误报面）3 次/turn。waterfall 前有 total>=29 廉价总闸（到达发
 * agent/soft-cut-suppressed reason="total-gate"，每 turn 仅首次通知）。P4 策略下
 * confirmed-repeat/pseudoTool 恒 take、计数仅作观测；heuristic 额度耗尽不再静默，
 * 发 reason="budget-exhausted" 并升级为 agent/abort-turn（步边界粘性终止）。
 *
 * @module tools/apply-softcut-port
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** 备份后缀，`--revert` 据此定位备份。 */
const BACKUP_SUFFIX = ".bak-pre-softcut-port";

/** 移植标记：文件中出现即视为已应用基础移植。 */
const MARKER = "DSH-SOFT-CUT-PORT";

/** 内核包名与包内相对路径。 */
const KERNEL_PACKAGE = "@deepseek-ai/dsh-agent-loop";
const KERNEL_RELATIVE = join("node_modules", "@deepseek-ai", KERNEL_PACKAGE, "lib", "index.js");

/**
 * 受支持的内核版本白名单。版本不在名单内一律拒跑——不同版本锚点排版可能不同，
 * 错位补丁会把内核改坏；升级支持版本时必须先在新内核上逐锚点核对再扩名单。
 */
const SUPPORTED_KERNEL_VERSIONS = ["0.2.0-rc.2"];

/**
 * 受支持原始内核（未打任何本地补丁）的 SHA256 白名单。
 * 00c4814d… = 0.2.0-rc.2 原始 lib/index.js（72994 字节，未移植 soft-cut）。
 */
const EXPECTED_PRISTINE_SHA256 = new Set([
	"00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2"
]);

/**
 * A-D 移植完成后的中间态 SHA256（81312 字节，仅基础移植、未叠加 P4/P5）。
 * 用作两阶段自检的第一道字节级证据；不符说明 A-D edits 与事实源已漂移。
 */
const EXPECTED_PORTED_SHA256 = "d9f686c388140378afdbde2e21a94a0353bcb286dc316b4c098c502834e0e758";

/**
 * 全部补丁完成后的产出 SHA256（97540 字节 = A-D + P4/P5 agent-loop 全量）。
 * 与宿主 DSH 仓规范补丁器 tools/patch-agent-loop.mjs 对同一中间态的产出逐字节一致；
 * 写后核对不符即回滚。注意：线上 98846 字节副本另含 2026-10-12 pre-step-undef-guard
 * 热修（不在本脚本范围），属预期差异。
 */
const EXPECTED_PATCHED_SHA256 = "6c47058f0524e917a1293f2db26af341e793b743cb99ced0269e2b175c24b2b9";

/**
 * 定位 dsh-agent-loop 的 lib/index.js。
 *
 * 内核装在 pnpm 的内容寻址目录下（路径中段带版本与内容哈希），每次 DSH 升级
 * 该哈希都会变化，因此不能写死路径。查找顺序：环境变量 → createRequire
 * （从进程入口与 cwd 解析）→ 常见 store 目录扫描。
 *
 * @returns {string|null} 绝对路径；找不到返回 null。
 */
function locateKernelFile() {
	if (process.env.SOFTCUT_TARGET) return process.env.SOFTCUT_TARGET;

	for (const base of [process.argv[1], join(process.cwd(), "package.json")]) {
		if (!base) continue;
		try {
			return createRequire(base).resolve(KERNEL_PACKAGE);
		} catch {
			// 该基点解析失败：试下一个。
		}
	}

	const storeRoots = [
		join(process.cwd(), "node_modules", ".pnpm"),
		join(dirname(dirname(process.argv[1] ?? "")), "node_modules", ".pnpm")
	];
	for (const store of storeRoots) {
		if (!store || !existsSync(store)) continue;
		let entries;
		try {
			entries = readdirSync(store, { withFileTypes: true });
		} catch {
			continue;
		}
		const hits = entries
			.filter((e) => e.isDirectory() && e.name.startsWith("@deepseek-ai+dsh-agent-loop"))
			.map((e) => join(store, e.name, KERNEL_RELATIVE))
			.filter((p) => existsSync(p))
			.sort((a, b) => a.length - b.length);
		if (hits.length > 0) return hits[0];
	}
	return null;
}

/** 计算文本 SHA256（十六进制）。 */
function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/** 统计 needle 在 text 中的出现次数（非重叠）。 */
function countOccurrences(text, needle) {
	return text.split(needle).length - 1;
}

/** 读取目标内核同包 package.json 的 version 字段；读不到返回 "unknown"。 */
function readKernelVersion(target) {
	try {
		const pkg = JSON.parse(readFileSync(join(dirname(target), "..", "package.json"), "utf8"));
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** 对落盘后的内核做 node --check 语法校验；返回 null 表示通过，否则返回错误摘要。 */
function syntaxCheck(file) {
	const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	if (result.error) return `spawn failed: ${result.error.message}`;
	if (result.status !== 0) return (result.stderr ?? "").trim() || `exit ${result.status}`;
	return null;
}

const args = process.argv.slice(2);
const mode = args.includes("--revert") ? "revert" : args.includes("--check") ? "check" : "apply";
const log = (message) => console.log(message);

const TARGET = locateKernelFile();
if (!TARGET) {
	log("✗ 未找到 dsh-agent-loop 内核文件。");
	log("  原因可能是 DSH 不在当前工作目录下。");
	log("  请用环境变量指定：");
	log("    PowerShell:  $env:SOFTCUT_TARGET = '<内核 lib/index.js 绝对路径>'");
	process.exit(1);
}

const backupPath = TARGET + BACKUP_SUFFIX;

if (mode === "revert") {
	if (!existsSync(backupPath)) {
		log(`✗ 找不到备份：${backupPath}`);
		log("  若从未应用过移植，则无需回滚。");
		process.exit(1);
	}
	copyFileSync(backupPath, TARGET);
	log(`✓ 已回滚：${TARGET}`);
	process.exit(0);
}

const source = readFileSync(TARGET, "utf8");
const applied = source.includes(MARKER);
const version = readKernelVersion(TARGET);
const sourceHash = sha256(source);

if (mode === "check") {
	log(`内核文件：${TARGET}`);
	log(`内核版本：${version}（支持：${SUPPORTED_KERNEL_VERSIONS.join(", ")}）`);
	log(`原文哈希：${sourceHash}`);
	log(`移植状态：${applied ? "已应用 ✓" : EXPECTED_PRISTINE_SHA256.has(sourceHash) ? "未应用（原始内核）✗" : "异常漂移（既非原始内核也无移植标记）✗"}`);
	log(`补丁产出：${sourceHash === EXPECTED_PATCHED_SHA256 ? "与 A-D+P4/P5 标准产出一致 ✓" : "非本脚本标准产出（可能含其他热修或版本不同）"}`);
	log(`备份存在：${existsSync(backupPath) ? "是" : "否"}`);
	process.exit(applied ? 0 : 1);
}

// ---- apply ----------------------------------------------------------------
if (applied) {
	log("✓ 目标内核已处于移植状态，不重复补丁（幂等）。");
	log("  内核升级或需要重跑本脚本前，必须先执行：node apply-softcut-port.mjs --revert");
	log("  若内核已被包管理器整体覆盖（无移植标记），直接重新 apply 即可，但需通过下方版本/哈希自检。");
	process.exit(0);
}

// 自检 1：内核版本必须在白名单内。
if (!SUPPORTED_KERNEL_VERSIONS.includes(version)) {
	log("✗ 内核版本自检失败，拒跑（未改动任何内容，退出码 1）。");
	log(`  当前版本：${version}`);
	log(`  支持版本：${SUPPORTED_KERNEL_VERSIONS.join(", ")}`);
	log("  请在对应版本的内核上使用，或更新本脚本的支持名单（更新前须逐锚点核对）。");
	process.exit(1);
}

// 自检 2：原文哈希必须是受支持的原始内核（防止在漂移/半补丁内核上错位补丁）。
if (!EXPECTED_PRISTINE_SHA256.has(sourceHash)) {
	log("✗ 内核原文哈希自检失败，拒跑（未改动任何内容，退出码 1）。");
	log(`  实际哈希：${sourceHash}`);
	log(`  期望哈希（原始 ${version}）：${[...EXPECTED_PRISTINE_SHA256].join(" 或 ")}`);
	log("  目标既不是原始内核，也没有移植标记。常见原因：内核被其他补丁部分改写、");
	log("  文件行尾/内容被编辑器改动，或内核版本与文件内容不一致。");
	log("  处理：先用 node apply-softcut-port.mjs --revert 回到备份的原始内核，");
	log("  或用包管理器修复安装后再 apply；切勿在漂移内核上强制补丁。");
	process.exit(1);
}

// ---- 阶段 1：基础移植 A-D（锚点唯一性在原始内核上全量预检） ----------------

const edits = [
	{
		name: "A. 新增 soft-cut 常量",
		from: 'import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER } from "@deepseek-ai/dsh-tools";\n',
		to:
			'import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER } from "@deepseek-ai/dsh-tools";\n' +
			"\n" +
			`//#region ${MARKER} —— 从 DSH 0.1.5-rc.2 移植的生成中途软切机构\n` +
			"// 上游自 0.1.5-rc.3 起移除了 agent/soft-cut 钩子及其流内中断能力，\n" +
			"// 这里按 0.1.5-rc.2 的原实现补回。升级内核后需重新运行本脚本。\n" +
			"/** 两次 soft-cut 检查之间至少需要累积的新可见字符数。 */\n" +
			"const SOFT_CUT_CHECK_INTERVAL_CHARS = 32;\n" +
			"/** 交给 soft-cut 监听器的尾部可见字符数。 */\n" +
			"const SOFT_CUT_TAIL_CHARS = 240;\n" +
			"// 分类软切预算（缺陷 1 修复，2026-10-07）：按 cutClass 分三类独立计数，\n" +
			"// 取代旧的单一 MAX_SOFT_CUTS_PER_TURN=6。\n" +
			"/** heuristic 类（churn/transition，启发式、有误报余量）每 turn 上限。 */\n" +
			"const BUDGET_HEURISTIC = 6;\n" +
			"/** confirmed-repeat 类（repeat/numberRunaway，字节级确证、近乎零误报）每 turn 上限。 */\n" +
			"const BUDGET_CONFIRMED_REPEAT = 20;\n" +
			"/** pseudoTool 类（伪工具文本，存在误报面）每 turn 上限。 */\n" +
			"const BUDGET_PSEUDO_TOOL = 3;\n" +
			"/**\n" +
			" * waterfall 前的廉价总闸 = 三类预算之和。在 6/20/3 分配下，total 达到 29\n" +
			" * 时任一类必已达其类上限（抽屉原理），故可在调用插件前直接 continue。\n" +
			" * 调大任一类预算时必须同步重算本值。\n" +
			" * 可达性口径：heuristic 超限发生在第 7 次（此时 total=6）、confirmed-repeat\n" +
			" * 超限发生在第 21 次（此时 total=26），二者 total 均 < 29，真实走 waterfall\n" +
			" * 后的 ignore 分支；pseudoTool 超限（第 4 次）恰与 total=29 同时发生，真实\n" +
			" * 流程在 waterfall 前即被本总闸 continue，decideSoftCutBudget 对该态的\n" +
			" * ignore 仅作纯函数防御性分支保留（不代表线上可达路径）。\n" +
			" */\n" +
			"const BUDGET_TOTAL = BUDGET_HEURISTIC + BUDGET_CONFIRMED_REPEAT + BUDGET_PSEUDO_TOOL;\n" +
			"/**\n" +
			" * 把插件返回的 cutClass 映射到分类计数桶键。cutClass 缺省（undefined，\n" +
			" * 旧插件不返回该字段）一律按 heuristic 处理——缺省不漏判，只占启发式额度。\n" +
			" * 纯函数：不引用 this/ctx/dispatch/任何 import。\n" +
			" * @param {string|undefined} cutClass\n" +
			" * @returns {\"heuristic\"|\"confirmedRepeat\"|\"pseudoTool\"}\n" +
			" */\n" +
			"function softCutBudgetKey(cutClass) {\n" +
			'\tif (cutClass === "confirmed-repeat") return "confirmedRepeat";\n' +
			'\tif (cutClass === "pseudoTool") return "pseudoTool";\n' +
			'\treturn "heuristic";\n' +
			"}\n" +
			"/**\n" +
			" * waterfall 之前的廉价总闸：total 已达 BUDGET_TOTAL 时不再询问插件。\n" +
			" * 纯函数：只读 state.total。\n" +
			" * @param {{total:number}} state\n" +
			" * @returns {boolean}\n" +
			" */\n" +
			"function shouldShortCircuitSoftCut(state) {\n" +
			"\treturn state.total >= BUDGET_TOTAL;\n" +
			"}\n" +
			"/**\n" +
			" * waterfall 返回 cut 后的分类预算判定。该类计数已达类上限 → \"ignore\"\n" +
			" *（静默放行：不 abort、不裁尾、不注入，流继续）；否则 \"take\"。\n" +
			" * 不读取 total——调用点保证此刻 total < BUDGET_TOTAL（总闸未拦）。\n" +
			" * 纯函数：不引用 this/ctx/dispatch/任何 import。\n" +
			" * @param {{heuristic:number, confirmedRepeat:number, pseudoTool:number, total:number}} state\n" +
			" * @param {string|undefined} cutClass\n" +
			" * @returns {\"take\"|\"ignore\"}\n" +
			" */\n" +
			"function decideSoftCutBudget(state, cutClass) {\n" +
			"\tconst key = softCutBudgetKey(cutClass);\n" +
			"\tconst limit = key === \"confirmedRepeat\" ? BUDGET_CONFIRMED_REPEAT\n" +
			"\t\t: key === \"pseudoTool\" ? BUDGET_PSEUDO_TOOL : BUDGET_HEURISTIC;\n" +
			"\treturn state[key] >= limit ? \"ignore\" : \"take\";\n" +
			"}\n" +
			`//#endregion ${MARKER}\n`
	},
	{
		name: "B. phase 初始化加 softCutBudget 分类计数",
		from:
			"\t\tthis.setPhase({\n" +
			'\t\t\tkind: "running",\n' +
			"\t\t\tabort: new AbortController(),\n" +
			"\t\t\tturn: this.phase.lastTurn,\n" +
			"\t\t\tstep: 0,\n" +
			"\t\t\twakeRequested: false\n" +
			"\t\t});\n",
		to:
			"\t\tthis.setPhase({\n" +
			'\t\t\tkind: "running",\n' +
			"\t\t\tabort: new AbortController(),\n" +
			"\t\t\tturn: this.phase.lastTurn,\n" +
			"\t\t\tstep: 0,\n" +
			`\t\t\t// ${MARKER}：本 turn 软切分类计数（turn 重置点；setPhase running 时归零）。\n` +
			"\t\t\tsoftCutBudget: { heuristic: 0, confirmedRepeat: 0, pseudoTool: 0, total: 0 },\n" +
			"\t\t\twakeRequested: false\n" +
			"\t\t});\n"
	},
	{
		name: "C1. buildRequest 改用 requestSignal",
		from:
			"\t\t\tfirstAttempt = false;\n" +
			"\t\t\tconst request = this.buildRequest(config, preparedCall, assembly.tools, {\n" +
			"\t\t\t\tturn,\n" +
			"\t\t\t\tstep\n" +
			"\t\t\t}, startsRequestSeries, signal);\n",
		to:
			"\t\t\tfirstAttempt = false;\n" +
			`\t\t\t// ${MARKER} —— 一个独立于 turn 主 signal 的控制器：\n` +
			"\t\t\t// 插件请求软切时只中止「本次上游请求」，不中止整个 turn。\n" +
			"\t\t\tconst softCutAbort = new AbortController();\n" +
			"\t\t\tconst requestSignal = AbortSignal.any([signal, softCutAbort.signal]);\n" +
			"\t\t\tlet softCutDecision = null;\n" +
			'\t\t\tlet visibleText = "";\n' +
			"\t\t\tlet newCharsSinceCheck = 0;\n" +
			"\t\t\tconst request = this.buildRequest(config, preparedCall, assembly.tools, {\n" +
			"\t\t\t\tturn,\n" +
			"\t\t\t\tstep\n" +
			"\t\t\t}, startsRequestSeries, requestSignal);\n"
	},
	{
		name: "C2. 流循环内按间隔调用 agent/soft-cut",
		from:
			"\t\t\t\tfor await (const chunk of stream) {\n" +
			"\t\t\t\t\tsignal.throwIfAborted();\n" +
			"\t\t\t\t\tlive.push(chunk);\n" +
			"\t\t\t\t}\n" +
			"\t\t\t\tsignal.throwIfAborted();\n",
		to:
			"\t\t\t\tfor await (const chunk of stream) {\n" +
			"\t\t\t\t\tsignal.throwIfAborted();\n" +
			"\t\t\t\t\tlive.push(chunk);\n" +
			`\t\t\t\t\t// ${MARKER}：累积可见文本，按字符间隔询问插件是否软切。\n` +
			'\t\t\t\t\tif (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") continue;\n' +
			"\t\t\t\t\tvisibleText += chunk.text;\n" +
			"\t\t\t\t\tnewCharsSinceCheck += chunk.text.length;\n" +
			"\t\t\t\t\tif (newCharsSinceCheck < SOFT_CUT_CHECK_INTERVAL_CHARS) continue;\n" +
			"\t\t\t\t\tnewCharsSinceCheck = 0;\n" +
			"\t\t\t\t\tconst budgetState = this.phase.softCutBudget\n" +
			"\t\t\t\t\t\t?? (this.phase.softCutBudget = { heuristic: 0, confirmedRepeat: 0, pseudoTool: 0, total: 0 });\n" +
			"\t\t\t\t\t// waterfall 前的廉价总闸：三类额度之和已满则不再询问插件。\n" +
			"\t\t\t\t\tif (shouldShortCircuitSoftCut(budgetState)) continue;\n" +
			"\t\t\t\t\tlet cutDecision = null;\n" +
			"\t\t\t\t\ttry {\n" +
			'\t\t\t\t\t\tcutDecision = await this.dispatch.waterfall("agent/soft-cut", {\n' +
			"\t\t\t\t\t\t\tsessionId: this.session.id,\n" +
			"\t\t\t\t\t\t\tturn,\n" +
			"\t\t\t\t\t\t\tstep,\n" +
			"\t\t\t\t\t\t\tvisibleLength: visibleText.length,\n" +
			"\t\t\t\t\t\t\ttail: visibleText.slice(-SOFT_CUT_TAIL_CHARS),\n" +
			"\t\t\t\t\t\t\tfullVisibleText: visibleText,\n" +
			"\t\t\t\t\t\t\tsignal: requestSignal\n" +
			"\t\t\t\t\t\t}, () => Promise.resolve(null));\n" +
			"\t\t\t\t\t} catch {\n" +
			"\t\t\t\t\t\t// 软切只是可选优化：监听器抛错（正则写坏、决策畸形）绝不能\n" +
			"\t\t\t\t\t\t// 影响主生成流 —— 当作「不切」继续。\n" +
			"\t\t\t\t\t\tcutDecision = null;\n" +
			"\t\t\t\t\t}\n" +
			'\t\t\t\t\tif (cutDecision?.kind !== "cut" || !Array.isArray(cutDecision.contexts) || cutDecision.contexts.length === 0) continue;\n' +
			"\t\t\t\t\t// 分类预算判定：该类已达上限则静默忽略本次软切决策（流继续，\n" +
			"\t\t\t\t\t// 不赋值 softCutDecision、不 abort、不裁尾、不 splice）。\n" +
			"\t\t\t\t\tconst budgetKey = softCutBudgetKey(cutDecision.cutClass);\n" +
			'\t\t\t\t\tif (decideSoftCutBudget(budgetState, cutDecision.cutClass) === "ignore") continue;\n' +
			"\t\t\t\t\tsoftCutDecision = cutDecision;\n" +
			"\t\t\t\t\tbudgetState[budgetKey] += 1;\n" +
			"\t\t\t\t\tbudgetState.total += 1;\n" +
			"\t\t\t\t\tsoftCutAbort.abort();\n" +
			"\t\t\t\t\tbreak;\n" +
			"\t\t\t\t}\n" +
			"\t\t\t\tif (!softCutDecision) signal.throwIfAborted();\n"
	},
	{
		name: "D1. catch 分支区分自切与真错",
		from:
			"\t\t\t} catch (error) {\n" +
			"\t\t\t\tif (!started) throw error;\n" +
			"\t\t\t\ttry {\n" +
			"\t\t\t\t\tif (signal.aborted) {\n",
		to:
			"\t\t\t} catch (error) {\n" +
			"\t\t\t\tif (!started) throw error;\n" +
			`\t\t\t\t// ${MARKER}：若这是我们自己软切导致的上游中止，\n` +
			"\t\t\t\t// 属预期行为，落到下方边界逻辑正常结算。\n" +
			"\t\t\t\tif (softCutDecision) {\n" +
			"\t\t\t\t\t// Expected: the upstream request was aborted by our own\n" +
			"\t\t\t\t\t// soft-cut controller. Normal settlement is handled below.\n" +
			"\t\t\t\t} else {\n" +
			"\t\t\t\ttry {\n" +
			"\t\t\t\t\tif (signal.aborted) {\n"
	},
	{
		name: "D2. catch 收尾 + 软切边界落盘续跑",
		from:
			"\t\t\t\t} catch (settlementError) {\n" +
			'\t\t\t\t\tthrow new AggregateError([error, settlementError], "Assistant stream failed and its durable settlement was rejected", { cause: error });\n' +
			"\t\t\t\t}\n" +
			"\t\t\t\tthrow error;\n" +
			"\t\t\t}\n" +
			"\t\t\ttry {\n" +
			"\t\t\t\tconst finish = live.finish;\n",
		to:
			"\t\t\t\t} catch (settlementError) {\n" +
			'\t\t\t\t\tthrow new AggregateError([error, settlementError], "Assistant stream failed and its durable settlement was rejected", { cause: error });\n' +
			"\t\t\t\t}\n" +
			"\t\t\t\tthrow error;\n" +
			"\t\t\t\t}\n" +
			"\t\t\t}\n" +
			"\t\t\ttry {\n" +
			`\t\t\t\t// ${MARKER} —— 软切边界：\n` +
			"\t\t\t\t// 把已生成前缀作为「正常」assistant 消息落盘（不是 interrupted），\n" +
			"\t\t\t\t// 按 trimTo 裁掉重复尾巴，把 contexts 排进 next-step，\n" +
			"\t\t\t\t// 再由 turn 循环开一次后续请求，从这条消息接着往下走。\n" +
			"\t\t\t\tif (softCutDecision) {\n" +
			"\t\t\t\tconst cutBlocks = live.interruptedBlocks();\n" +
			"\t\t\t\tif (cutBlocks.length === 0) {\n" +
			'\t\t\t\t\tlive.settle("assistant/attempt", () => this.session.append("assistant/attempt", {\n' +
			"\t\t\t\t\t\tturn,\n" +
			"\t\t\t\t\t\tstep,\n" +
			"\t\t\t\t\t\tstream: live.stream\n" +
			"\t\t\t\t\t}).seq);\n" +
			'\t\t\t\t\tthrow new Error("agent/soft-cut returned a cut decision but the stream had no visible content");\n' +
			"\t\t\t\t}\n" +
			"\t\t\t\t// 可选：检测到退化重复的监听器会给出字符偏移 trimTo，\n" +
			"\t\t\t\t// 让落盘的前缀停在重复开始处 —— 跑飞的尾巴既不进会话，\n" +
			"\t\t\t\t// 也不会在下次请求里被回放给模型。\n" +
			"\t\t\t\tconst trimTo = Number.isInteger(softCutDecision.trimTo) && softCutDecision.trimTo > 0 ? softCutDecision.trimTo : null;\n" +
			"\t\t\t\tlet keptBlocks = cutBlocks;\n" +
			"\t\t\t\tif (trimTo !== null) {\n" +
			"\t\t\t\t\tkeptBlocks = [];\n" +
			"\t\t\t\t\tlet used = 0;\n" +
			"\t\t\t\t\tfor (const block of cutBlocks) {\n" +
			"\t\t\t\t\t\tif (used >= trimTo) break;\n" +
			'\t\t\t\t\t\tconst text = typeof block.text === "string" ? block.text : "";\n' +
			"\t\t\t\t\t\tconst room = trimTo - used;\n" +
			"\t\t\t\t\t\tif (text.length <= room) {\n" +
			"\t\t\t\t\t\t\tkeptBlocks.push(block);\n" +
			"\t\t\t\t\t\t\tused += text.length;\n" +
			"\t\t\t\t\t\t} else {\n" +
			"\t\t\t\t\t\t\tkeptBlocks.push({ ...block, text: text.slice(0, room) });\n" +
			"\t\t\t\t\t\t\tused = trimTo;\n" +
			"\t\t\t\t\t\t\tbreak;\n" +
			"\t\t\t\t\t\t}\n" +
			"\t\t\t\t\t}\n" +
			"\t\t\t\t\tif (keptBlocks.length === 0) keptBlocks = cutBlocks;\n" +
			"\t\t\t\t}\n" +
			"\t\t\t\tconst cutMessage = createAssistantMessage({\n" +
			"\t\t\t\t\tcontent: keptBlocks,\n" +
			"\t\t\t\t\tsource: {\n" +
			"\t\t\t\t\t\tprovider: request.provider,\n" +
			"\t\t\t\t\t\tmodel: request.model,\n" +
			"\t\t\t\t\t\t...live.replayState === void 0 ? {} : { replayState: live.replayState }\n" +
			"\t\t\t\t\t}\n" +
			"\t\t\t\t});\n" +
			'\t\t\t\tlive.settle("assistant/message", () => this.session.append("assistant/message", {\n' +
			"\t\t\t\t\tturn,\n" +
			"\t\t\t\t\tstep,\n" +
			"\t\t\t\t\tmessage: cutMessage,\n" +
			"\t\t\t\t\t...live.usage === void 0 ? {} : { usage: live.usage },\n" +
			"\t\t\t\t\tstream: live.stream\n" +
			'\t\t\t\t}, { surfaceOp: "append" }).seq);\n' +
			'\t\t\t\tthis.inbox.splice("next-step", this.inbox.nextStep.length, 0, softCutDecision.contexts);\n' +
			"\t\t\t\treturn null;\n" +
			"\t\t\t}\n" +
			"\t\t\t\tconst finish = live.finish;\n"
	}
];

// 补丁块文本按行拼接辅助（与规范补丁器同源定义）。
const L = (...lines) => lines.join("\n")

const AGENT_LOOP_BLOCKS = [
  {
    name: 'p4-budget-policy',
    find: L(
      'function decideSoftCutBudget(state, cutClass) {',
      '\tconst key = softCutBudgetKey(cutClass);',
      '\tconst limit = key === "confirmedRepeat" ? BUDGET_CONFIRMED_REPEAT',
      '\t\t: key === "pseudoTool" ? BUDGET_PSEUDO_TOOL : BUDGET_HEURISTIC;',
      '\treturn state[key] >= limit ? "ignore" : "take";',
      '}',
    ),
    replace: L(
      'function decideSoftCutBudget(state, cutClass) {',
      '\tconst key = softCutBudgetKey(cutClass);',
      '\t/* @local-patch p4-budget-policy */',
      '\t// P4 预算策略（2026-10-09）：confirmed-repeat（字节级确证）与 pseudoTool 高置信',
      '\t// 命中不计入可耗尽预算——恒 "take"，计数器仍照常累加供观测；仅 heuristic',
      '\t// 保留类上限（>= BUDGET_HEURISTIC → "ignore"，由调用点升级为 abort-turn）。',
      '\tif (key !== "heuristic") return "take";',
      '\t/* @local-patch-end */',
      '\treturn state[key] >= BUDGET_HEURISTIC ? "ignore" : "take";',
      '}',
    ),
  },
  {
    name: 'p4-soft-cut-gate-notify',
    // runtime upgrade pair (2026-10-11): upgrade old-patched files
    oldClose: `\t\t\t\t\t\t\t\t\tbudgetState: { ...budgetState }\n\t\t\t\t\t\t\t\t});`,
    newClose: `\t\t\t\t\t\t\t\t\tbudgetState: { ...budgetState }\n\t\t\t\t\t\t\t\t}, { ignorable: true });`,
    find: L(
      '\t\t\t\t\t// waterfall 前的廉价总闸：三类额度之和已满则不再询问插件。',
      '\t\t\t\t\tif (shouldShortCircuitSoftCut(budgetState)) continue;',
    ),
    replace: L(
      '\t\t\t\t\t// waterfall 前的廉价总闸：total 达 BUDGET_TOTAL 时不再询问插件。',
      '\t\t\t\t\t// P4：不再静默——首次到达时发 agent/soft-cut-suppressed(total-gate)，',
      '\t\t\t\t\t// 之后保持静默（每 turn 一次通知，避免事件风暴）。',
      '\t\t\t\t\tif (shouldShortCircuitSoftCut(budgetState)) {',
      '\t\t\t\t\t\t/* @local-patch p4-soft-cut-suppressed */',
      '\t\t\t\t\t\tif (this.phase.softCutGateNotified !== true) {',
      '\t\t\t\t\t\t\tthis.phase.softCutGateNotified = true;',
      '\t\t\t\t\t\t\ttry {',
      '\t\t\t\t\t\t\t\tconst gateEvent = this.session.append("agent/soft-cut-suppressed", {',
      '\t\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\t\treason: "total-gate",',
      '\t\t\t\t\t\t\t\t\tthreshold: BUDGET_TOTAL,',
      '\t\t\t\t\t\t\t\t\tbudgetState: { ...budgetState }',
      '\t\t\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\t\t\tthis.dispatch.emit("agent/soft-cut-suppressed", {',
      '\t\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\t\treason: "total-gate",',
      '\t\t\t\t\t\t\t\t\tthreshold: BUDGET_TOTAL,',
      '\t\t\t\t\t\t\t\t\tbudgetState: { ...budgetState },',
      '\t\t\t\t\t\t\t\t\tevidenceSeq: gateEvent.seq',
      '\t\t\t\t\t\t\t\t});',
      '\t\t\t\t\t\t\t} catch {',
      '\t\t\t\t\t\t\t}',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t\t/* @local-patch-end */',
      '\t\t\t\t\t\tcontinue;',
      '\t\t\t\t\t}',
    ),
  },
  {
    name: 'p4-soft-cut-ignore-upgrade',
    // runtime upgrade pair (2026-10-11): upgrade old-patched files
    oldClose: `\t\t\t\t\t\t\t\tbudgetState: { ...budgetState }\n\t\t\t\t\t\t\t});`,
    newClose: `\t\t\t\t\t\t\t\tbudgetState: { ...budgetState }\n\t\t\t\t\t\t\t}, { ignorable: true });`,
    find: L(
      '\t\t\t\t\t// 分类预算判定：该类已达上限则静默忽略本次软切决策（流继续，',
      '\t\t\t\t\t// 不赋值 softCutDecision、不 abort、不裁尾、不 splice）。',
      '\t\t\t\t\tconst budgetKey = softCutBudgetKey(cutDecision.cutClass);',
      '\t\t\t\t\tif (decideSoftCutBudget(budgetState, cutDecision.cutClass) === "ignore") continue;',
    ),
    replace: L(
      '\t\t\t\t\t// 分类预算判定（P4）：heuristic 类额度耗尽时不再静默——发',
      '\t\t\t\t\t// agent/soft-cut-suppressed(budget-exhausted) 并升级为 agent/abort-turn',
      '\t\t\t\t\t//（在步边界终止 turn，上下文保留）；confirmed-repeat/pseudoTool 恒',
      '\t\t\t\t\t// take，不会到达本分支。',
      '\t\t\t\t\tconst budgetKey = softCutBudgetKey(cutDecision.cutClass);',
      '\t\t\t\t\t/* @local-patch p4-soft-cut-suppressed */',
      '\t\t\t\t\tif (decideSoftCutBudget(budgetState, cutDecision.cutClass) === "ignore") {',
      '\t\t\t\t\t\ttry {',
      '\t\t\t\t\t\t\tconst suppressEvent = this.session.append("agent/soft-cut-suppressed", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: "budget-exhausted",',
      '\t\t\t\t\t\t\t\tcutClass: cutDecision.cutClass ?? "heuristic",',
      '\t\t\t\t\t\t\t\tbudgetState: { ...budgetState }',
      '\t\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\t\tthis.dispatch.emit("agent/soft-cut-suppressed", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: "budget-exhausted",',
      '\t\t\t\t\t\t\t\tcutClass: cutDecision.cutClass ?? "heuristic",',
      '\t\t\t\t\t\t\t\tbudgetState: { ...budgetState },',
      '\t\t\t\t\t\t\t\tevidenceSeq: suppressEvent.seq',
      '\t\t\t\t\t\t\t});',
      '\t\t\t\t\t\t} catch {',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t\tthis.phase.abortTurn = {',
      '\t\t\t\t\t\t\treason: "soft-cut-budget-exhausted",',
      '\t\t\t\t\t\t\tdetail: { cutClass: cutDecision.cutClass ?? "heuristic" }',
      '\t\t\t\t\t\t};',
      '\t\t\t\t\t\tcontinue;',
      '\t\t\t\t\t}',
      '\t\t\t\t\t/* @local-patch-end */',
    ),
  },
  {
    name: 'p4-transition-decls',
    find: L(
      '\t\t\tlet softCutDecision = null;',
      '\t\t\tlet visibleText = "";',
      '\t\t\tlet newCharsSinceCheck = 0;',
    ),
    replace: L(
      '\t\t\tlet softCutDecision = null;',
      '\t\t\tlet visibleText = "";',
      '\t\t\t/* @local-patch p4-transition-mode */',
      '\t\t\tlet textStreamText = "";',
      '\t\t\tlet reasoningStreamText = "";',
      '\t\t\t/* @local-patch-end */',
      '\t\t\tlet newCharsSinceCheck = 0;',
    ),
  },
  {
    name: 'p4-transition-accumulate',
    find: L(
      '\t\t\t\t\tif (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") continue;',
      '\t\t\t\t\tvisibleText += chunk.text;',
      '\t\t\t\t\tnewCharsSinceCheck += chunk.text.length;',
    ),
    replace: L(
      '\t\t\t\t\t/* @local-patch p4-transition-mode */',
      '\t\t\t\t\tif (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") continue;',
      '\t\t\t\t\tvisibleText += chunk.text;',
      '\t\t\t\t\tif (chunk.type === "text-delta") textStreamText += chunk.text;',
      '\t\t\t\t\telse reasoningStreamText += chunk.text;',
      '\t\t\t\t\t// separateThreshold 模式只按 text 流长度推进检查间隔。',
      '\t\t\t\t\tnewCharsSinceCheck += DSH_TRANSITION_TEXT_MODE === "separateThreshold" && chunk.type !== "text-delta" ? 0 : chunk.text.length;',
      '\t\t\t\t\t/* @local-patch-end */',
    ),
  },
  {
    name: 'p4-transition-waterfall-payload',
    find: L(
      '\t\t\t\t\t\tcutDecision = await this.dispatch.waterfall("agent/soft-cut", {',
      '\t\t\t\t\t\t\tsessionId: this.session.id,',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\tvisibleLength: visibleText.length,',
      '\t\t\t\t\t\t\ttail: visibleText.slice(-SOFT_CUT_TAIL_CHARS),',
      '\t\t\t\t\t\t\tfullVisibleText: visibleText,',
      '\t\t\t\t\t\t\tsignal: requestSignal',
      '\t\t\t\t\t\t}, () => Promise.resolve(null));',
    ),
    replace: L(
      '\t\t\t\t\t\t/* @local-patch p4-transition-mode */',
      '\t\t\t\t\t\tcutDecision = await this.dispatch.waterfall("agent/soft-cut", {',
      '\t\t\t\t\t\t\tsessionId: this.session.id,',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\tvisibleLength: visibleText.length,',
      '\t\t\t\t\t\t\ttail: visibleText.slice(-SOFT_CUT_TAIL_CHARS),',
      '\t\t\t\t\t\t\tfullVisibleText: visibleText,',
      '\t\t\t\t\t\t\t...(DSH_TRANSITION_TEXT_MODE === "separateThreshold" ? {',
      '\t\t\t\t\t\t\t\tstreams: {',
      '\t\t\t\t\t\t\t\t\tmode: "separateThreshold",',
      '\t\t\t\t\t\t\t\t\ttextLength: textStreamText.length,',
      '\t\t\t\t\t\t\t\t\ttextTail: textStreamText.slice(-SOFT_CUT_TAIL_CHARS),',
      '\t\t\t\t\t\t\t\t\treasoningLength: reasoningStreamText.length,',
      '\t\t\t\t\t\t\t\t\treasoningTail: reasoningStreamText.slice(-SOFT_CUT_TAIL_CHARS)',
      '\t\t\t\t\t\t\t\t}',
      '\t\t\t\t\t\t\t} : {}),',
      '\t\t\t\t\t\t\tsignal: requestSignal',
      '\t\t\t\t\t\t}, () => Promise.resolve(null));',
      '\t\t\t\t\t\t/* @local-patch-end */',
    ),
  },
  {
    name: 'p4-abort-turn-consume',
    find: L(
      '\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\tif (turnEnds && this.inbox.nextStep.length === 0) {',
    ),
    replace: L(
      '\t\t\t\t/* @local-patch p4-abort-turn */',
      '\t\t\t\tconst pendingAbortTurn = phase.abortTurn;',
      '\t\t\t\tif (pendingAbortTurn !== void 0) {',
      '\t\t\t\t\tphase.abortTurn = void 0;',
      '\t\t\t\t\tconst abortDecision = await this.dispatch.waterfall("agent/abort-turn", {',
      '\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\tdetail: pendingAbortTurn.detail,',
      '\t\t\t\t\t\tsignal',
      '\t\t\t\t\t}, () => Promise.resolve({ kind: "abort" }));',
      '\t\t\t\t\tif (abortDecision?.kind !== "continue") turnEnds = {',
      '\t\t\t\t\t\tkind: "abort-turn",',
      '\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\tdetail: pendingAbortTurn.detail',
      '\t\t\t\t\t};',
      '\t\t\t\t}',
      '\t\t\t\t/* @local-patch-end */',
      '\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\tif (turnEnds && this.inbox.nextStep.length === 0) {',
    ),
  },
  {
    name: 'p4-abort-turn-clear-on-turn-start',
    find: L(
      '\t\tlet turnEnds = null;',
      '\t\tlet target = "next-turn";',
    ),
    replace: L(
      '\t\tlet turnEnds = null;',
      '\t\t/* @local-patch p4-abort-turn */',
      '\t\tphase.abortTurn = void 0;',
      '\t\t/* @local-patch-end */',
      '\t\tlet target = "next-turn";',
    ),
  },
  {
    name: 'p4-helpers',
    find: L('var AgentLoop = class extends Service {'),
    replace: L(
      '/* @local-patch p4-outbound-notify */',
      'const NOTIFY_GUI_EVENT = "agent/notify";',
      'function createOutboundNotify(ctx) {',
      '\tconst channels = (process.env.DSH_NOTIFY_CHANNELS ?? "GUI").split(",").map((channel) => channel.trim().toUpperCase()).filter((channel) => channel.length > 0);',
      '\tconst webhookUrl = process.env.DSH_NOTIFY_WEBHOOK_URL;',
      '\tconst webhookTimeoutMsRaw = Number.parseInt(process.env.DSH_NOTIFY_WEBHOOK_TIMEOUT_MS ?? "10000", 10);',
      '\tconst webhookTimeoutMs = Number.isNaN(webhookTimeoutMsRaw) ? 10000 : webhookTimeoutMsRaw;',
      '\tconst effective = channels.filter((channel) => {',
      '\t\tif (channel === "IM") {',
      '\t\t\tctx.logger?.warn?.("agent-notify: IM channel is not implemented in P4; route it through the webhook channel instead");',
      '\t\t\treturn false;',
      '\t\t}',
      '\t\treturn channel === "GUI" || channel === "WEBHOOK" || channel === "BOARD";',
      '\t});',
      '\treturn {',
      '\t\tchannels: effective,',
      '\t\tnotify({ title, body, severity = "info", sessionId } = {}) {',
      '\t\t\tconst payload = { title, body, severity, sessionId, ts: new Date().toISOString(), source: "dsh-agent-notify" };',
      '\t\t\tfor (const channel of effective) {',
      '\t\t\t\ttry {',
      '\t\t\t\t\tif (channel === "GUI") {',
      '\t\t\t\t\t\tconst args = [NOTIFY_GUI_EVENT, payload];',
      '\t\t\t\t\t\tfor (const callback of ctx.events.dispatch("emit", args)) try {',
      '\t\t\t\t\t\t\tconst returned = callback(...args);',
      '\t\t\t\t\t\t\tPromise.resolve(returned).catch(() => {});',
      '\t\t\t\t\t\t} catch {',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t} else if (channel === "WEBHOOK") {',
      '\t\t\t\t\t\tif (webhookUrl === void 0 || webhookUrl === "") continue;',
      '\t\t\t\t\t\tvoid fetch(webhookUrl, {',
      '\t\t\t\t\t\t\tmethod: "POST",',
      '\t\t\t\t\t\t\theaders: { "content-type": "application/json" },',
      '\t\t\t\t\t\t\tbody: JSON.stringify(payload),',
      '\t\t\t\t\t\t\tsignal: AbortSignal.timeout(webhookTimeoutMs)',
      '\t\t\t\t\t\t}).catch((error) => {',
      '\t\t\t\t\t\t\tctx.logger?.warn?.(`agent-notify: webhook POST failed: ${error instanceof Error ? error.message : String(error)}`);',
      '\t\t\t\t\t\t});',
      '\t\t\t\t\t}',
      '\t\t\t\t\t// BOARD 渠道：面板看板由宿主消费 agent/notify 事件呈现，此处无需额外动作。',
      '\t\t\t\t} catch (error) {',
      '\t\t\t\t\tctx.logger?.warn?.(`agent-notify: channel "${channel}" failed: ${error instanceof Error ? error.message : String(error)}`);',
      '\t\t\t\t}',
      '\t\t\t}',
      '\t\t}',
      '\t};',
      '}',
      '/* @local-patch-end */',
      '/* @local-patch p4-escape-closing-tags */',
      'const P4_ESCAPE_MAP = [',
      '\t[/<\\/parameter>/g, "＜/parameter＞"],',
      '\t[/<\\/function>/g, "＜/function＞"]',
      '];',
      '/** Escape literal closing tags in one text (fullwidth form); invert with p4UnescapeClosingTags. */',
      'function p4EscapeClosingTags(text) {',
      '\tlet escaped = text;',
      '\tfor (const [pattern, fullwidth] of P4_ESCAPE_MAP) escaped = escaped.replace(pattern, fullwidth);',
      '\treturn escaped;',
      '}',
      'function p4UnescapeClosingTags(text) {',
      '\tlet unescaped = text;',
      '\tfor (const [pattern, fullwidth] of P4_ESCAPE_MAP) unescaped = unescaped.replace(fullwidth, pattern.source.replace(/\\\\/g, ""));',
      '\treturn unescaped;',
      '}',
      '/** Escape literal closing tags across assistant content blocks (length-preserving per replacement pair). */',
      'function p4EscapeBlocks(blocks) {',
      '\tif (!Array.isArray(blocks)) return { blocks, escapedAny: false };',
      '\tlet escapedAny = false;',
      '\tconst next = blocks.map((block) => {',
      '\t\tif (typeof block?.text !== "string" || !block.text.includes("</")) return block;',
      '\t\tconst text = p4EscapeClosingTags(block.text);',
      '\t\tif (text !== block.text) escapedAny = true;',
      '\t\treturn text === block.text ? block : { ...block, text };',
      '\t});',
      '\treturn { blocks: next, escapedAny };',
      '}',
      '/* @local-patch-end */',
      'var AgentLoop = class extends Service {',
    ),
  },
  {
    name: 'p4-provide-agent-notify',
    find: L('\t\tctx.effect(() => ctx.agents.setFactory(this), "agentLoop.setFactory()");'),
    replace: L(
      '\t\tctx.effect(() => ctx.agents.setFactory(this), "agentLoop.setFactory()");',
      '\t\t/* @local-patch p4-outbound-notify */',
      '\t\t// P4 出站通知最小服务：渠道 DSH_NOTIFY_CHANNELS（GUI|WEBHOOK|BOARD，默认 GUI），',
      '\t\t// webhook 目标 DSH_NOTIFY_WEBHOOK_URL，超时 DSH_NOTIFY_WEBHOOK_TIMEOUT_MS（默认 10000）。',
      '\t\tctx.provide("agent-notify", createOutboundNotify(ctx));',
      '\t\t/* @local-patch-end */',
    ),
  },
  {
    name: 'p4-escape-interrupted',
    find: L('\t\t\t\t\t\tconst content = live.interruptedBlocks();'),
    replace: L('\t\t\t\t\t\tconst content = p4EscapeBlocks(live.interruptedBlocks()).blocks;'),
  },
  {
    name: 'p4-escape-cut-message',
    find: L('\t\t\t\t\tcontent: keptBlocks,'),
    replace: L('\t\t\t\t\tcontent: p4EscapeBlocks(keptBlocks).blocks,'),
  },
  {
    name: 'p4-escape-normal-message',
    find: L('\t\t\t\t\tcontent: live.blocks(),'),
    replace: L('\t\t\t\t\tcontent: p4EscapeBlocks(live.blocks()).blocks,'),
  },
  {
    name: 'p4-transition-mode-const',
    find: L('//#endregion DSH-SOFT-CUT-PORT'),
    replace: L(
      '//#endregion DSH-SOFT-CUT-PORT',
      '/* @local-patch p4-transition-mode */',
      '/** text/reasoning delta 合并策略："merged"（默认，合流入 visibleText）|"separateThreshold"（分流累计，检查间隔只看 text 流）。 */',
      'const DSH_TRANSITION_TEXT_MODE = process.env.DSH_TRANSITION_TEXT_MODE === "separateThreshold" ? "separateThreshold" : "merged";',
      '/* @local-patch-end */',
    ),
  },
  {
    name: 'p5-abort-env',
    find: L('const DSH_TRANSITION_TEXT_MODE = process.env.DSH_TRANSITION_TEXT_MODE === "separateThreshold" ? "separateThreshold" : "merged";'),
    replace: L(
      'const DSH_TRANSITION_TEXT_MODE = process.env.DSH_TRANSITION_TEXT_MODE === "separateThreshold" ? "separateThreshold" : "merged";',
      '/* @local-patch p5-abort-turn */',
      '// P5 硬 break 后门（仅测试用）：置 DSH_ABORT_TURN_HARD_BREAK=1 时，abort-turn 确认后不授予 draining step，',
      '// 直接 break 丢弃未投递 contexts（已在会话日志保存，不丢信息）。默认关闭，走粘性 draining。',
      'const DSH_ABORT_TURN_HARD_BREAK = process.env.DSH_ABORT_TURN_HARD_BREAK === "1";',
      '// P5：为续命/被丢弃的 additionalContexts 生成只读来源描述符，供事故回放客观定位是哪个插件挂的 context。',
      '// dispatcher 不暴露监听器身份，故以 context 自带标识字段 + 内容头作为归因证据。',
      'function p5DescribeAbortContexts(contexts) {',
      '  return (contexts ?? []).map((context) => {',
      '    if (context === null || typeof context !== "object") return { type: typeof context };',
      '    const descriptor = {};',
      '    for (const key of ["role", "type", "tag", "source", "origin", "plugin", "pluginId"]) {',
      '      if (context[key] !== void 0) descriptor[key] = String(context[key]).slice(0, 80);',
      '    }',
      '    if (typeof context.content === "string") descriptor.contentHead = context.content.slice(0, 120);',
      '    else if (context.content !== void 0) descriptor.contentType = Array.isArray(context.content) ? "array" : typeof context.content;',
      '    return descriptor;',
      '  });',
      '}',
      '/* @local-patch-end */',
    ),
  },
  {
    name: 'p5-exec-budget',
    find: L(
      '\tconst planned = toolCalls.map((block) => ({',
      '\t\tblock,',
      '\t\texec: {',
      '\t\t\tcallId: block.id,',
      '\t\t\tname: block.name,',
      '\t\t\targuments: parseArguments(block.arguments),',
      '\t\t\tagent,',
      '\t\t\tsignal',
      '\t\t}',
      '\t}));',
    ),
    replace: L(
      '\tconst planned = toolCalls.map((block) => ({',
      '\t\tblock,',
      '\t\texec: {',
      '\t\t\tcallId: block.id,',
      '\t\t\tname: block.name,',
      '\t\t\targuments: parseArguments(block.arguments),',
      '\t\t\tagent,',
      '\t\t\tsignal,',
      '\t\t\t/* @local-patch p5-exec-budget */',
      '\t\t\t// P5：向 exec 载荷透出只读的终止状态，供插件在 tools/post-execute / guards 感知。',
      '\t\t\tget budgetState() {',
      '\t\t\t\tconst budget = agent.phase?.softCutBudget;',
      '\t\t\t\treturn budget === void 0 ? { heuristic: 0, confirmedRepeat: 0, pseudoTool: 0, total: 0 } : {',
      '\t\t\t\t\theuristic: budget.heuristic,',
      '\t\t\t\t\tconfirmedRepeat: budget.confirmedRepeat,',
      '\t\t\t\t\tpseudoTool: budget.pseudoTool,',
      '\t\t\t\t\ttotal: budget.total',
      '\t\t\t\t};',
      '\t\t\t},',
      '\t\t\tget abortTurn() {',
      '\t\t\t\tconst pending = agent.phase?.abortTurn;',
      '\t\t\t\treturn pending === void 0 ? null : { reason: pending.reason, detail: pending.detail };',
      '\t\t\t}',
      '\t\t\t/* @local-patch-end */',
      '\t\t}',
      '\t}));',
    ),
  },
  {
    name: 'p5-soft-cut-taken',
    find: L(
      '\t\t\t\t\tsoftCutDecision = cutDecision;',
      '\t\t\t\t\tbudgetState[budgetKey] += 1;',
      '\t\t\t\t\tbudgetState.total += 1;',
      '\t\t\t\t\tsoftCutAbort.abort();',
    ),
    replace: L(
      '\t\t\t\t\tsoftCutDecision = cutDecision;',
      '\t\t\t\t\tbudgetState[budgetKey] += 1;',
      '\t\t\t\t\tbudgetState.total += 1;',
      '\t\t\t\t\t/* @local-patch p5-soft-cut-taken */',
      '\t\t\t\t\t// P5：记录一次"实际 take"的软切（区别于 suppressed）。三态可观测：',
      '\t\t\t\t\t// 无 suppressed=检测器未触发；suppressed+draining=触发被续跑吃掉；vetoed=升级被否决。',
      '\t\t\t\t\ttry {',
      '\t\t\t\t\t\tconst takenEvent = this.session.append("agent/soft-cut-taken", {',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\tcutClass: cutDecision.cutClass ?? "heuristic",',
      '\t\t\t\t\t\t\tbudgetKey,',
      '\t\t\t\t\t\t\tbudgetState: { ...budgetState }',
      '\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\tthis.dispatch.emit("agent/soft-cut-taken", {',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\tcutClass: cutDecision.cutClass ?? "heuristic",',
      '\t\t\t\t\t\t\tbudgetKey,',
      '\t\t\t\t\t\t\tbudgetState: { ...budgetState },',
      '\t\t\t\t\t\t\tevidenceSeq: takenEvent.seq',
      '\t\t\t\t\t\t});',
      '\t\t\t\t\t} catch {',
      '\t\t\t\t\t}',
      '\t\t\t\t\t/* @local-patch-end */',
      '\t\t\t\t\tsoftCutAbort.abort();',
    ),
  },
  {
    name: 'p5-sticky-exempt',
    find: L(
      '\t\t\t\t\tconst stepEnd = await this.step(decision);',
      '\t\t\t\t\tif (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;',
    ),
    replace: L(
      '\t\t\t\t\tconst stepEnd = await this.step(decision);',
      '\t\t\t\t\t/* @local-patch p5-sticky-exempt */',
      '\t\t\t\t\t// P5：draining step 期间 turnEnds 是粘性 abort-turn，禁止被 stepEnd（新一步的结束原因）覆盖。',
      '\t\t\t\t\tif (this.phase.p5AbortDraining !== true && (turnEnds === null || turnEnds.kind !== "max-tokens")) turnEnds = stepEnd;',
      '\t\t\t\t\t/* @local-patch-end */',
    ),
  },
  {
    name: 'p5-abort-turn',
    find: L(
      '\t\t\t\t/* @local-patch p4-abort-turn */',
      '\t\t\t\tconst pendingAbortTurn = phase.abortTurn;',
      '\t\t\t\tif (pendingAbortTurn !== void 0) {',
      '\t\t\t\t\tphase.abortTurn = void 0;',
      '\t\t\t\t\tconst abortDecision = await this.dispatch.waterfall("agent/abort-turn", {',
      '\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\tdetail: pendingAbortTurn.detail,',
      '\t\t\t\t\t\tsignal',
      '\t\t\t\t\t}, () => Promise.resolve({ kind: "abort" }));',
      '\t\t\t\t\tif (abortDecision?.kind !== "continue") turnEnds = {',
      '\t\t\t\t\t\tkind: "abort-turn",',
      '\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\tdetail: pendingAbortTurn.detail',
      '\t\t\t\t\t};',
      '\t\t\t\t}',
      '\t\t\t\t/* @local-patch-end */',
      '\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\tif (turnEnds && this.inbox.nextStep.length === 0) {',
      '\t\t\t\t\tawait this.dispatch.serial("agent/turn-stopping", {',
      '\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\tsignal',
      '\t\t\t\t\t});',
      '\t\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\t}',
      '\t\t\t\tif (turnEnds && this.inbox.nextStep.length === 0) break;',
      '\t\t\t\ttarget = "next-step";',
    ),
    replace: L(
      '\t\t\t\t/* @local-patch p5-abort-turn */',
      '\t\t\t\t// P5 粘性终止：若前一 loop 迭代已授予一个 draining step（p5AbortDraining），',
      '\t\t\t\t// 该 step 现已完成——无条件收尾，不再检查 inbox（防插件每步挂 context 无限续命）。',
      '\t\t\t\tif (this.phase.p5AbortDraining === true) {',
      '\t\t\t\t\tthis.phase.p5AbortDraining = false;',
      '\t\t\t\t\tif (this.phase.p5AbortSticky !== null) turnEnds = this.phase.p5AbortSticky;',
      '\t\t\t\t\tconst p5StickyReason = turnEnds === null ? void 0 : turnEnds.reason;',
      '\t\t\t\t\tconst p5StickyDetail = turnEnds === null ? void 0 : turnEnds.detail;',
      '\t\t\t\t\tthis.phase.p5AbortSticky = null;',
      '\t\t\t\t\t// 防御：draining step 内即使再次置了 abortTurn 也不得二次生效（本 turn 已确定终止）。',
      '\t\t\t\t\tphase.abortTurn = void 0;',
      '\t\t\t\t\tconst p5Dropped = this.inbox.nextStep.slice();',
      '\t\t\t\t\ttry {',
      '\t\t\t\t\t\tconst finalEvent = this.session.append("agent/abort-turn-final", {',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\treason: p5StickyReason,',
      '\t\t\t\t\t\t\tdetail: p5StickyDetail,',
      '\t\t\t\t\t\t\tvia: "draining",',
      '\t\t\t\t\t\t\tdroppedContexts: p5Dropped.length,',
      '\t\t\t\t\t\t\tcontexts: p5DescribeAbortContexts(p5Dropped)',
      '\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\tthis.dispatch.emit("agent/abort-turn-final", {',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\treason: p5StickyReason,',
      '\t\t\t\t\t\t\tdetail: p5StickyDetail,',
      '\t\t\t\t\t\t\tvia: "draining",',
      '\t\t\t\t\t\t\tdroppedContexts: p5Dropped.length,',
      '\t\t\t\t\t\t\tcontexts: p5DescribeAbortContexts(p5Dropped),',
      '\t\t\t\t\t\t\tevidenceSeq: finalEvent.seq',
      '\t\t\t\t\t\t});',
      '\t\t\t\t\t} catch {',
      '\t\t\t\t\t}',
      '\t\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\t\tawait this.dispatch.serial("agent/turn-stopping", {',
      '\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\tsignal',
      '\t\t\t\t\t});',
      '\t\t\t\t\t// 只清 next-step 续命队列；next-turn 用户输入必须保留（与原版退出门语义一致）。',
      '\t\t\t\t\tthis.inbox.splice("next-step", 0, this.inbox.nextStep.length, []);',
      '\t\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\t\tbreak;',
      '\t\t\t\t}',
      '\t\t\t\tconst pendingAbortTurn = phase.abortTurn;',
      '\t\t\t\tif (pendingAbortTurn !== void 0) {',
      '\t\t\t\t\tphase.abortTurn = void 0;',
      '\t\t\t\t\tconst abortDecision = await this.dispatch.waterfall("agent/abort-turn", {',
      '\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\tdetail: pendingAbortTurn.detail,',
      '\t\t\t\t\t\tsignal',
      '\t\t\t\t\t}, () => Promise.resolve({ kind: "abort" }));',
      '\t\t\t\t\tif (abortDecision?.kind !== "continue") {',
      '\t\t\t\t\t\tturnEnds = {',
      '\t\t\t\t\t\t\tkind: "abort-turn",',
      '\t\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\t\tdetail: pendingAbortTurn.detail',
      '\t\t\t\t\t\t};',
      '\t\t\t\t\t\ttry {',
      '\t\t\t\t\t\t\tconst decidedEvent = this.session.append("agent/abort-turn-decided", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\t\t\tdetail: pendingAbortTurn.detail,',
      '\t\t\t\t\t\t\t\tdecision: abortDecision?.kind ?? "abort"',
      '\t\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\t\tthis.dispatch.emit("agent/abort-turn-decided", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\t\t\tdetail: pendingAbortTurn.detail,',
      '\t\t\t\t\t\t\t\tdecision: abortDecision?.kind ?? "abort",',
      '\t\t\t\t\t\t\t\tevidenceSeq: decidedEvent.seq',
      '\t\t\t\t\t\t\t});',
      '\t\t\t\t\t\t} catch {',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t} else {',
      '\t\t\t\t\t\t// abort-turn 被插件否决（waterfall 返回 continue）——记录可观测事件，turn 继续。',
      '\t\t\t\t\t\ttry {',
      '\t\t\t\t\t\t\tconst vetoEvent = this.session.append("agent/abort-turn-vetoed", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\t\t\tdetail: pendingAbortTurn.detail',
      '\t\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\t\tthis.dispatch.emit("agent/abort-turn-vetoed", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: pendingAbortTurn.reason,',
      '\t\t\t\t\t\t\t\tdetail: pendingAbortTurn.detail,',
      '\t\t\t\t\t\t\t\tevidenceSeq: vetoEvent.seq',
      '\t\t\t\t\t\t\t});',
      '\t\t\t\t\t\t} catch {',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t}',
      '\t\t\t\t}',
      '\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\tif (turnEnds && turnEnds.kind === "abort-turn") {',
      '\t\t\t\t\t/* @local-patch p5-sticky-break */',
      '\t\t\t\t\t// 粘性终止只作用于 abort-turn；其他种类沿用原版 nextStep 门（见下方 else-if / break）。',
      '\t\t\t\t\tconst p5PendingStep = this.inbox.nextStep.slice();',
      '\t\t\t\t\tif (DSH_ABORT_TURN_HARD_BREAK || p5PendingStep.length === 0) {',
      '\t\t\t\t\t\ttry {',
      '\t\t\t\t\t\t\tconst hardEvent = this.session.append("agent/abort-turn-final", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: turnEnds.reason,',
      '\t\t\t\t\t\t\t\tdetail: turnEnds.detail,',
      '\t\t\t\t\t\t\t\tvia: DSH_ABORT_TURN_HARD_BREAK ? "hard-break" : "immediate",',
      '\t\t\t\t\t\t\t\tdroppedContexts: p5PendingStep.length,',
      '\t\t\t\t\t\t\t\tcontexts: p5DescribeAbortContexts(p5PendingStep)',
      '\t\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\t\tthis.dispatch.emit("agent/abort-turn-final", {',
      '\t\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\t\treason: turnEnds.reason,',
      '\t\t\t\t\t\t\t\tdetail: turnEnds.detail,',
      '\t\t\t\t\t\t\t\tvia: DSH_ABORT_TURN_HARD_BREAK ? "hard-break" : "immediate",',
      '\t\t\t\t\t\t\t\tdroppedContexts: p5PendingStep.length,',
      '\t\t\t\t\t\t\t\tcontexts: p5DescribeAbortContexts(p5PendingStep),',
      '\t\t\t\t\t\t\t\tevidenceSeq: hardEvent.seq',
      '\t\t\t\t\t\t\t});',
      '\t\t\t\t\t\t} catch {',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\t\t\tawait this.dispatch.serial("agent/turn-stopping", {',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tsignal',
      '\t\t\t\t\t\t});',
      '\t\t\t\t\t\tthis.inbox.splice("next-step", 0, this.inbox.nextStep.length, []);',
      '\t\t\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\t\t\tbreak;',
      '\t\t\t\t\t}',
      '\t\t\t\t\t// 授予恰好一个 draining step：消费已投递的 contexts，结束后在本块顶部无条件收尾。',
      '\t\t\t\t\t// contexts 带来源描述符，事故回放可客观定位"否决终止的 context 由哪个插件挂入"。',
      '\t\t\t\t\tthis.phase.p5AbortDraining = true;',
      '\t\t\t\t\tthis.phase.p5AbortSticky = turnEnds;',
      '\t\t\t\t\ttry {',
      '\t\t\t\t\t\tconst drainEvent = this.session.append("agent/abort-turn-draining", {',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\treason: turnEnds.reason,',
      '\t\t\t\t\t\t\tdetail: turnEnds.detail,',
      '\t\t\t\t\t\t\tpendingContexts: p5PendingStep.length,',
      '\t\t\t\t\t\t\tcontexts: p5DescribeAbortContexts(p5PendingStep)',
      '\t\t\t\t\t\t}, { ignorable: true });',
      '\t\t\t\t\t\tthis.dispatch.emit("agent/abort-turn-draining", {',
      '\t\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\t\tstep,',
      '\t\t\t\t\t\t\treason: turnEnds.reason,',
      '\t\t\t\t\t\t\tdetail: turnEnds.detail,',
      '\t\t\t\t\t\t\tpendingContexts: p5PendingStep.length,',
      '\t\t\t\t\t\t\tcontexts: p5DescribeAbortContexts(p5PendingStep),',
      '\t\t\t\t\t\t\tevidenceSeq: drainEvent.seq',
      '\t\t\t\t\t\t});',
      '\t\t\t\t\t} catch {',
      '\t\t\t\t\t}',
      '\t\t\t\t\t/* @local-patch-end */',
      '\t\t\t\t} else if (turnEnds && this.inbox.nextStep.length === 0) {',
      '\t\t\t\t\t// 非 abort-turn 种类：保持厂商原版语义——nextStep 清空才发 turn-stopping。',
      '\t\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\t\tawait this.dispatch.serial("agent/turn-stopping", {',
      '\t\t\t\t\t\tturn,',
      '\t\t\t\t\t\tsignal',
      '\t\t\t\t\t});',
      '\t\t\t\t\tsignal.throwIfAborted();',
      '\t\t\t\t}',
      '\t\t\t\t/* @local-patch-end */',
      '\t\t\t\tif (turnEnds && turnEnds.kind !== "abort-turn" && this.inbox.nextStep.length === 0) break;',
      '\t\t\t\ttarget = "next-step";',
    ),
  },
]

const AGENT_LOOP_VERIFY = [
  '/* @local-patch p4-budget-policy */',
  '/* @local-patch p4-soft-cut-suppressed */',
  '/* @local-patch p4-abort-turn */',
  '/* @local-patch p4-transition-mode */',
  '/* @local-patch p4-outbound-notify */',
  '/* @local-patch p4-escape-closing-tags */',
  '/* @local-patch p5-abort-turn */',
  '/* @local-patch p5-sticky-exempt */',
  '/* @local-patch p5-exec-budget */',
  '/* @local-patch p5-soft-cut-taken */',
  'agent/soft-cut-suppressed',
  'agent/soft-cut-taken',
  'agent/abort-turn',
  'agent/abort-turn-decided',
  'agent/abort-turn-vetoed',
  'agent/abort-turn-draining',
  'agent/abort-turn-final',
  'agent-notify',
  'p4EscapeBlocks',
  'p5AbortDraining',
  'p5DescribeAbortContexts',
  'DSH_ABORT_TURN_HARD_BREAK',
  '}, { ignorable: true })',
]


const PRESENT_MARKERS = {
  'p4-budget-policy': 'p4-budget-policy',
  'p4-soft-cut-gate-notify': 'softCutGateNotified',
  'p4-soft-cut-ignore-upgrade': 'soft-cut-budget-exhausted',
  'p4-transition-decls': 'textStreamText',
  'p4-transition-accumulate': 'reasoningStreamText',
  'p4-transition-waterfall-payload': 'streams: {',
  'p4-abort-turn-consume': 'pendingAbortTurn',
  'p4-abort-turn-clear-on-turn-start': 'p4-abort-turn',
  'p4-helpers': 'createOutboundNotify',
  'p4-provide-agent-notify': 'provide("agent-notify"',
  'p4-escape-interrupted': 'p4EscapeBlocks(live.interruptedBlocks())',
  'p4-escape-cut-message': 'p4EscapeBlocks(keptBlocks)',
  'p4-escape-normal-message': 'p4EscapeBlocks(live.blocks())',
  'p4-transition-mode-const': 'DSH_TRANSITION_TEXT_MODE',
  'p4-breaker-fields': 'p4RefusedStreaks',
  'p4-breaker-helper': 'guardedCompactIfNeeded',
  'p4-breaker-call-pressure': 'guardedCompactIfNeeded(agent, "pressure"',
  'p4-breaker-call-overflow': 'guardedCompactIfNeeded(agent, "context-overflow"',
  'p4-deny-plugin-info': 'p4-deny-plugin-info',
  'p5-abort-env': 'DSH_ABORT_TURN_HARD_BREAK',
  'p5-exec-budget': 'p5-exec-budget',
  'p5-soft-cut-taken': 'p5-soft-cut-taken',
  'p5-sticky-exempt': 'p5AbortDraining',
  'p5-abort-turn': 'abort-turn-draining',
}

const SURVIVING_ANCHOR_SENTINELS = {
  'p4-transition-mode-const': 'const DSH_TRANSITION_TEXT_MODE = process.env.DSH_TRANSITION_TEXT_MODE === "separateThreshold" ? "separateThreshold" : "merged";',
}
// 全量校验 A-D 锚点唯一性，全部通过才进入后续阶段。
const portProblems = [];
for (const edit of edits) {
	const count = countOccurrences(source, edit.from);
	if (count !== 1) portProblems.push(`${edit.name}：锚点出现 ${count} 次（应为 1）`);
}
if (portProblems.length > 0) {
	log("✗ A-D 锚点校验失败，未改动任何内容：");
	for (const problem of portProblems) log(`   · ${problem}`);
	log("  通常意味着当前内核版本的代码排版与移植脚本假设不一致。");
	log("  请勿放宽匹配（可能导致改坏内核）；对照报错人工确认后再调整本脚本。");
	process.exit(1);
}

let ported = source;
for (const edit of edits) {
	ported = ported.replace(edit.from, edit.to);
	log(`  ✓ ${edit.name}`);
}

// 两阶段自检第一道：A-D 中间态必须与事实源字节一致。
const portedHash = sha256(ported);
if (portedHash !== EXPECTED_PORTED_SHA256) {
	log("✗ A-D 中间态哈希与事实源不符，拒跑（未改动任何内容，退出码 1）。");
	log(`  实际：${portedHash}`);
	log(`  期望：${EXPECTED_PORTED_SHA256}`);
	log("  说明本脚本的 A-D edits 已与标准产出漂移，需人工核对后再使用。");
	process.exit(1);
}

// ---- 阶段 2：P4/P5 agent-loop 增量（与规范补丁器同序同块） ----------------
// 逐块在当前文本上锚定：find 恰好 1 次 → replace；锚点已被消费时退回独有产物
// 串判定"已施加"（与规范补丁器同一套 PRESENT_MARKERS / SURVIVING 哨兵机制）。
let patched = ported;
const patchProblems = [];
for (const block of AGENT_LOOP_BLOCKS) {
	const survivingSentinel = SURVIVING_ANCHOR_SENTINELS[block.name];
	if (survivingSentinel !== void 0 && patched.includes(survivingSentinel)) {
		if (block.oldClose && patched.includes(block.oldClose)) {
			patched = patched.split(block.oldClose).join(block.newClose);
		}
		continue;
	}
	const count = countOccurrences(patched, block.find);
	if (count === 1) {
		patched = patched.replace(block.find, block.replace);
		continue;
	}
	const marker = PRESENT_MARKERS[block.name];
	if (marker && patched.includes(marker)) {
		if (block.oldClose && patched.includes(block.oldClose)) {
			patched = patched.split(block.oldClose).join(block.newClose);
		}
		continue;
	}
	patchProblems.push(`${block.name}：find 命中 ${count} 次且无已施加产物串`);
}
if (patchProblems.length > 0) {
	log("✗ P4/P5 锚点校验失败，未改动任何内容：");
	for (const problem of patchProblems) log(`   · ${problem}`);
	process.exit(1);
}
if (patched === ported) {
	log("✗ P4/P5 阶段未产生任何改动，拒跑（未改动任何内容，退出码 1）。");
	process.exit(1);
}

// ---- 落盘 + 写后校验（失败自动回滚） --------------------------------------
copyFileSync(TARGET, backupPath);
log(`已备份 → ${backupPath}`);
writeFileSync(TARGET, patched, "utf8");

const syntaxError = syntaxCheck(TARGET);
if (syntaxError !== null) {
	copyFileSync(backupPath, TARGET);
	log("✗ node --check 语法校验失败，已回滚备份（退出码 1）：");
	log(`  ${syntaxError}`);
	process.exit(1);
}

const afterText = readFileSync(TARGET, "utf8");
const missingMarkers = AGENT_LOOP_VERIFY.filter((marker) => !afterText.includes(marker));
if (missingMarkers.length > 0) {
	copyFileSync(backupPath, TARGET);
	log("✗ 写后补丁标记核对失败，已回滚备份（退出码 1），缺失标记：");
	for (const marker of missingMarkers) log(`  - ${marker}`);
	process.exit(1);
}

const afterHash = sha256(afterText);
if (afterHash !== EXPECTED_PATCHED_SHA256) {
	copyFileSync(backupPath, TARGET);
	log("✗ 写后产出哈希与标准产出不一致，已回滚备份（退出码 1）。");
	log(`  实际：${afterHash}`);
	log(`  期望：${EXPECTED_PATCHED_SHA256}`);
	process.exit(1);
}

log("✓ 移植完成（A-D + P4/P5 agent-loop 增量），语法/标记/哈希三项校验通过。");
log("");
log("下一步：重启 DSH 实例，然后到设置 → COT 锚点 确认顶部提示条为「掐断能力正常」。");
log("回滚：node apply-softcut-port.mjs --revert");
