/**
 * soft-cut 内核移植工具 —— 为 DSH 0.1.5-rc.3 及以上版本补回"生成中途软切"能力。
 *
 * ## 背景
 *
 * DSH 自 0.1.5-rc.3 起移除了宿主钩子 `agent/soft-cut` 及其配套的流内中断机构
 * （0.1.5-rc.1 / rc.2 具备；0.1.6 / 0.1.7 / 0.2.x / 0.2.1-alpha.1 均无）。
 * dsh-cot-anchor 的"打转打断"判定全部挂在这个钩子上，因此在这些版本上会
 * **静默失效**：插件加载无报错、日志正常、结论注入照常工作，唯独打断不触发。
 *
 * 本工具把 0.1.5-rc.2 的实现移植回新版内核，恢复"切断当前生成、从断点继续"的
 * 语义。结论注入功能不受影响，无需移植。
 *
 * ## 用法
 *
 *   node apply-softcut-port.mjs            # 应用（幂等：已应用则跳过）
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
 * 1. 改写前逐个校验替换锚点在目标文件中**恰好出现一次**；任一不匹配即整体中止，
 *    不写入任何内容（内核文件被改坏会导致 DSH 无法启动）。
 * 2. 首次改写自动创建 `<file>.bak-pre-softcut-port`，`--revert` 读它还原。
 *    重应用流程必须 revert-first：先 `--revert`（此时 `--check` 须为退出码 1、
 *    内核无 marker），再应用本脚本；在含旧 marker 的内核上直接 apply 会被幂等
 *    短路 exit 0 但零改写（假成功）。
 * 3. 改写内容以注释标记 `DSH-SOFT-CUT-PORT` 标识，可随时用 `--check` 确认状态。
 *
 * ## 移植的 6 处改动
 *
 * | 处 | 位置（按代码语义定位，勿按行号） | 内容 |
 * | --- | --- | --- |
 * | A | 最后一条 import 之后 | 检查间隔/尾部窗口常量；三类有界预算常量 HEURISTIC_CUT_MAX=6 / CONFIRMED_REPEAT_CUT_MAX=20 / CONFIRMED_PSEUDO_CUT_MAX=3；hard-abort 固定错误串常量；limits 常量对象；2 个自包含纯函数 createSoftCutBudget / decideSoftCut |
 * | B | `wakeDriver()` 的 `setPhase({kind:"running",…})` | 新增 `softCutBudget: createSoftCutBudget()`（turn 重置点，防跨 turn 泄漏） |
 * | C1 | `step()` 中 `firstAttempt = false;` 之后 | 独立 `softCutAbort` + `requestSignal`；`buildRequest()` 末参改用它 |
 * | C2 | `for await (const chunk of stream)` 循环内 | 累积可见文本，按间隔调用 `agent/soft-cut` waterfall（payload 带 sessionId 与 budgets 快照）；无 waterfall 前总闸；返回 cut 后经 decideSoftCut 三分支：cut 才中止上游请求，reject 继续生成，hard-abort 走固定中止序列 |
 * | D1 | `step()` 内 `catch` 开头 | 区分"自己切的"与"真出错" |
 * | D2 | 紧随其后的 `try { const finish = …` 之前 | 软切边界：前缀按正常消息落盘 + 裁掉重复尾巴 + 续跑 |
 *
 * ## 预算语义（2026-10-07 软切配额耗尽事故修复）
 *
 * 软切按 budgetClass 分三类独立有界预算：confirmed-repeat（repeat/numberRunaway，
 * 字节级确证、近零误报）20 次/turn；heuristic（churn/transition，启发式、误报面
 * 大）6 次/turn；confirmed-pseudo（伪工具文本，对合法文本中的工具格式示例有误报
 * 面）3 次/turn。waterfall 前不设总闸，每次间隔检查都征询插件；payload 携带三类
 * 预算快照（budgets）。decideSoftCut 返回三态：
 *
 * - `cut`：该类 used < max，写回 usedAfter 后按既有软切路径中止本次上游请求；
 * - `reject`：heuristic / confirmed-repeat 该类已达上限，不切、流继续生成；
 * - `hard-abort`：confirmed-pseudo 达上限（对合法文本的工具格式示例误报面必须
 *   收敛为硬边界），执行固定中止序列——先 emit `agent/error`（错误串
 *   `cot-anchor-budget-pseudo-abort`），再 `phase.abort.abort()`（turn 主控制器），
 *   然后 break 出流循环。三类均无无限配额。
 *
 * budgetClass 归一化枚举（wire 格式，与插件 decision.budgetClass 同一口径）：
 * `"heuristic" | "confirmed-repeat" | "confirmed-pseudo"`；缺失或未知取值一律按
 * heuristic 处理（旧插件不返回该字段 = 旧行为）。预算计数对象的键与 waterfall
 * payload 的 budgets 键为驼峰（heuristic / confirmedRepeat / confirmedPseudo）。
 *
 * ## 依赖的内核能力（移植为纯增量，不新增依赖）
 *
 * `interruptedBlocks()`、`inbox.splice()`、`AssistantStreamAttempt`、`live.settle()`、
 * `createAssistantMessage`、`AbortSignal.any`、`dispatch.emit("agent/error",…)`、
 * `phase.abort.abort()`。
 *
 * @module tools/apply-softcut-port
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** 备份后缀，`--revert` 据此定位备份。 */
const BACKUP_SUFFIX = ".bak-pre-softcut-port";

/** 移植标记：文件中出现即视为已应用。 */
const MARKER = "DSH-SOFT-CUT-PORT";

/** 内核包名与包内相对路径。 */
const KERNEL_PACKAGE = "@deepseek-ai/dsh-agent-loop";
const KERNEL_RELATIVE = join("node_modules", "@deepseek-ai", KERNEL_PACKAGE, "lib", "index.js");

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

	// 1) Node 模块解析：从进程入口与当前工作目录各试一次。
	for (const base of [process.argv[1], join(process.cwd(), "package.json")]) {
		if (!base) continue;
		try {
			return createRequire(base).resolve(KERNEL_PACKAGE);
		} catch {
			// 该基点解析失败：试下一个。
		}
	}

	// 2) 扫描常见的 pnpm store。
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

const args = process.argv.slice(2);
const mode = args.includes("--revert") ? "revert" : args.includes("--check") ? "check" : "apply";

const log = (message) => console.log(message);

const TARGET = locateKernelFile();
if (!TARGET) {
	log("✗ 未找到 dsh-agent-loop 内核文件。");
	log("  原因可能是 DSH 不在当前工作目录下。");
	log("  请用环境变量指定：");
	log("    PowerShell:  $env:SOFTCUT_TARGET = '<内核 lib/index.js 绝对路径>'");
	log("  查找方法：在 DSH 安装目录的 node_modules 下找 @deepseek-ai/dsh-agent-loop/lib/index.js");
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

let source = readFileSync(TARGET, "utf8");
const applied = source.includes(MARKER);

if (mode === "check") {
	log(`内核文件：${TARGET}`);
	log(`移植状态：${applied ? "已应用 ✓" : "未应用 ✗"}`);
	log(`备份存在：${existsSync(backupPath) ? "是" : "否"}`);
	process.exit(applied ? 0 : 1);
}

if (applied) {
	log("✓ 已是应用状态，无需重复移植（幂等）。");
	log("  如需重做：先 --revert 再应用。");
	process.exit(0);
}

// ---------------------------------------------------------------------------
// 替换点：from 必须在目标文件中恰好出现一次，否则整体中止、不落盘。
// 定位一律按代码语义，不依赖行号——内核每次升级行号都会变。
// ---------------------------------------------------------------------------
const edits = [
	{
		name: "A. 新增 soft-cut 常量与分类预算纯函数",
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
			"// 分类软切预算（2026-10-07 软切配额耗尽事故修复）：旧版单一上限被 churn\n" +
			"// 类启发式决策耗尽后，字节级复读（confirmed-repeat）失去拦截配额。三类按\n" +
			"// 误报面差异独立配额：churn/transition 是启发式、误报面大；repeat/numberRunaway\n" +
			"// 字节级确证、近零误报；pseudoTool 对合法文本中的工具格式示例存在误报面。\n" +
			"/** heuristic 类（churn/transition，启发式、误报面大）每 turn 上限。 */\n" +
			"const HEURISTIC_CUT_MAX = 6;\n" +
			"/** confirmed-repeat 类（repeat/numberRunaway，字节级确证、近零误报）每 turn 上限。 */\n" +
			"const CONFIRMED_REPEAT_CUT_MAX = 20;\n" +
			"/** confirmed-pseudo 类（伪工具文本，对工具格式示例有误报面）每 turn 上限。 */\n" +
			"const CONFIRMED_PSEUDO_CUT_MAX = 3;\n" +
			"/** confirmed-pseudo 预算耗尽硬中止的固定错误串（插件契约值，不可改）。 */\n" +
			'const SOFT_CUT_PSEUDO_ABORT_MESSAGE = "cot-anchor-budget-pseudo-abort";\n' +
			"/** 三类预算上限表（键 = 预算计数对象键，驼峰）；decideSoftCut 与 waterfall payload 共用。 */\n" +
			"const SOFT_CUT_LIMITS = {\n" +
			"\theuristic: HEURISTIC_CUT_MAX,\n" +
			"\tconfirmedRepeat: CONFIRMED_REPEAT_CUT_MAX,\n" +
			"\tconfirmedPseudo: CONFIRMED_PSEUDO_CUT_MAX\n" +
			"};\n" +
			"/**\n" +
			" * 新建一个归零的分类软切预算计数对象（turn 起始调用一次，防跨 turn 泄漏）。\n" +
			" * 纯函数：不引用 this/内核类/模块级可变状态。\n" +
			" * @returns {{heuristic:number, confirmedRepeat:number, confirmedPseudo:number}}\n" +
			" */\n" +
			"function createSoftCutBudget() {\n" +
			"\treturn { heuristic: 0, confirmedRepeat: 0, confirmedPseudo: 0 };\n" +
			"}\n" +
			"/**\n" +
			" * 分类预算判定。完全自包含纯函数：不引用 this/内核类/其他函数/模块级常量，\n" +
			" * 仅做状态运算；不修改入参之外的任何外部状态（写回计数由调用点完成）。\n" +
			" *\n" +
			" * decision.budgetClass 归一化枚举：\"heuristic\" | \"confirmed-repeat\" |\n" +
			" * \"confirmed-pseudo\"；缺失（旧插件）或未知取值一律视同 \"heuristic\"。\n" +
			" * budget 键与 limits 键为驼峰（heuristic/confirmedRepeat/confirmedPseudo）。\n" +
			" *\n" +
			" * @param {{heuristic:number, confirmedRepeat:number, confirmedPseudo:number}} budget 分类计数\n" +
			" * @param {{budgetClass?:string}} decision 插件软切决策（kind===\"cut\" 已由调用点保证）\n" +
			" * @param {{heuristic:number, confirmedRepeat:number, confirmedPseudo:number}} limits 三类上限\n" +
			" * @returns {{action:\"cut\", budgetClass:string, usedAfter:number}|{action:\"reject\", budgetClass:string, usedAfter:number}|{action:\"hard-abort\", budgetClass:\"confirmed-pseudo\"}}\n" +
			" */\n" +
			"function decideSoftCut(budget, decision, limits) {\n" +
			'\tconst requested = typeof decision?.budgetClass === "string" ? decision.budgetClass : "";\n' +
			'\tconst key = requested === "confirmed-repeat" ? "confirmedRepeat"\n' +
			'\t\t: requested === "confirmed-pseudo" ? "confirmedPseudo" : "heuristic";\n' +
			'\tconst wireClass = key === "confirmedRepeat" ? "confirmed-repeat"\n' +
			'\t\t: key === "confirmedPseudo" ? "confirmed-pseudo" : "heuristic";\n' +
			"\tconst used = budget[key] ?? 0;\n" +
			"\tconst max = limits[key];\n" +
			"\tif (used < max) {\n" +
			'\t\treturn { action: "cut", budgetClass: wireClass, usedAfter: used + 1 };\n' +
			"\t}\n" +
			'\tif (key === "confirmedPseudo") return { action: "hard-abort", budgetClass: "confirmed-pseudo" };\n' +
			'\treturn { action: "reject", budgetClass: wireClass, usedAfter: used };\n' +
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
			`\t\t\t// ${MARKER}：本 turn 软切分类预算（turn 重置点；setPhase running 时归零，\n` +
			"\t\t\t// 防止计数跨 turn 泄漏）。\n" +
			"\t\t\tsoftCutBudget: createSoftCutBudget(),\n" +
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
		name: "C2. 流循环内按间隔调用 agent/soft-cut 并按分类预算裁决",
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
			"\t\t\t\t\t\t?? (this.phase.softCutBudget = createSoftCutBudget());\n" +
			"\t\t\t\t\t// 无 waterfall 前总闸：每次间隔检查都征询插件，预算裁决统一由\n" +
			"\t\t\t\t\t// decideSoftCut 在收到 cut 决策后进行。\n" +
			"\t\t\t\t\tlet cutDecision = null;\n" +
			"\t\t\t\t\ttry {\n" +
			'\t\t\t\t\t\tcutDecision = await this.dispatch.waterfall("agent/soft-cut", {\n' +
			"\t\t\t\t\t\t\tsessionId: this.session.id,\n" +
			"\t\t\t\t\t\t\tturn,\n" +
			"\t\t\t\t\t\t\tstep,\n" +
			"\t\t\t\t\t\t\tvisibleLength: visibleText.length,\n" +
			"\t\t\t\t\t\t\ttail: visibleText.slice(-SOFT_CUT_TAIL_CHARS),\n" +
			"\t\t\t\t\t\t\tfullVisibleText: visibleText,\n" +
			"\t\t\t\t\t\t\tbudgets: {\n" +
			"\t\t\t\t\t\t\t\theuristic: { used: budgetState.heuristic, max: SOFT_CUT_LIMITS.heuristic },\n" +
			"\t\t\t\t\t\t\t\tconfirmedRepeat: { used: budgetState.confirmedRepeat, max: SOFT_CUT_LIMITS.confirmedRepeat },\n" +
			"\t\t\t\t\t\t\t\tconfirmedPseudo: { used: budgetState.confirmedPseudo, max: SOFT_CUT_LIMITS.confirmedPseudo }\n" +
			"\t\t\t\t\t\t\t},\n" +
			"\t\t\t\t\t\t\tsignal: requestSignal\n" +
			"\t\t\t\t\t\t}, () => Promise.resolve(null));\n" +
			"\t\t\t\t\t} catch {\n" +
			"\t\t\t\t\t\t// 软切只是可选优化：监听器抛错（正则写坏、决策畸形）绝不能\n" +
			"\t\t\t\t\t\t// 影响主生成流 —— 当作「不切」继续。\n" +
			"\t\t\t\t\t\tcutDecision = null;\n" +
			"\t\t\t\t\t}\n" +
			'\t\t\t\t\tif (cutDecision?.kind !== "cut" || !Array.isArray(cutDecision.contexts) || cutDecision.contexts.length === 0) continue;\n' +
			"\t\t\t\t\t// 分类预算三分支裁决：cut 才切，reject 继续生成，hard-abort 走\n" +
			"\t\t\t\t\t// 固定中止序列（先广播错误，再中止 turn 主控制器）。\n" +
			"\t\t\t\t\tconst budgetVerdict = decideSoftCut(budgetState, cutDecision, SOFT_CUT_LIMITS);\n" +
			'\t\t\t\t\tif (budgetVerdict.action === "reject") continue;\n' +
			'\t\t\t\t\tif (budgetVerdict.action === "hard-abort") {\n' +
			"\t\t\t\t\t\tthis.dispatch.emit(\"agent/error\", { error: new Error(SOFT_CUT_PSEUDO_ABORT_MESSAGE) });\n" +
			"\t\t\t\t\t\tthis.phase.abort.abort(new Error(SOFT_CUT_PSEUDO_ABORT_MESSAGE));\n" +
			"\t\t\t\t\t\tbreak;\n" +
			"\t\t\t\t\t}\n" +
			"\t\t\t\t\t// action === \"cut\"：按裁决结果写回分类计数，走既有软切路径。\n" +
			'\t\t\t\t\tconst budgetKey = budgetVerdict.budgetClass === "confirmed-repeat" ? "confirmedRepeat"\n' +
			'\t\t\t\t\t\t: budgetVerdict.budgetClass === "confirmed-pseudo" ? "confirmedPseudo" : "heuristic";\n' +
			"\t\t\t\t\tbudgetState[budgetKey] = budgetVerdict.usedAfter;\n" +
			"\t\t\t\t\tsoftCutDecision = cutDecision;\n" +
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

// 全量校验锚点唯一性，全部通过才落盘。
const problems = [];
for (const edit of edits) {
	const count = source.split(edit.from).length - 1;
	if (count !== 1) problems.push(`${edit.name}：锚点出现 ${count} 次（应为 1）`);
}
if (problems.length > 0) {
	log("✗ 锚点校验失败，未改动任何内容：");
	for (const problem of problems) log(`   · ${problem}`);
	log("");
	log("  通常意味着当前内核版本的代码排版与移植脚本假设不一致。");
	log("  请勿放宽匹配（可能导致改坏内核）；对照报错行号人工确认后再调整本脚本。");
	process.exit(1);
}

copyFileSync(TARGET, backupPath);
log(`已备份 → ${backupPath}`);

for (const edit of edits) {
	source = source.replace(edit.from, edit.to);
	log(`  ✓ ${edit.name}`);
}

writeFileSync(TARGET, source, "utf8");
log(`✓ 移植完成。`);
log("");
log("下一步：重启 DSH 实例，然后到设置 → COT 锚点 确认顶部提示条为「掐断能力正常」。");
log("回滚：node apply-softcut-port.mjs --revert");
