import { readFileSync } from "node:fs";
import { PSEUDO_TOOL_CALL_UNIT } from "./test-fixtures.mjs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { hasPseudoToolCall, renderPseudoToolAnchor, findRepeatingTail };`);
const { hasPseudoToolCall, renderPseudoToolAnchor, findRepeatingTail } = factory();

/** 真实事故里的伪工具调用单元（内联夹具，不再依赖可能被移走的外部日志）。 */
const realUnit = PSEUDO_TOOL_CALL_UNIT;
console.log(`伪工具调用单元长度: ${realUnit.length} 字符\n`);

const cases = [
	{
		label: "真实事故：seed:tool_call 伪调用 → 命中",
		text: realUnit,
		expected: true
	},
	{
		label: "真实事故：重复 403 次的伪调用 → 命中",
		text: (realUnit + "\n").repeat(403),
		expected: true
	},
	{
		label: "通用 <tool_call> 标记 → 命中",
		text: "我需要读取文件。<tool_call>{\"name\":\"read\"}</tool_call>",
		expected: true
	},
	{
		label: "Anthropic 风格 antml:invoke 只有开标签（流式中途/思考起草）→ 不命中",
		text: "接下来调用工具。<antml:invoke name=\"edit\">",
		expected: false
	},
	{
		label: "Anthropic 风格 antml:invoke 完整闭合块 → 命中",
		text: (() => { const L = String.fromCharCode(60), S = String.fromCharCode(47), G = String.fromCharCode(62);
			return "接下来调用工具。" + L + "antml:invoke name=\"edit\"" + G + L + "parameter name=\"path\"" + G + "a.js" + L + S + "parameter" + G + L + S + "antml:invoke" + G; })(),
		expected: true
	},
	{
		label: "<function name=> 与 <parameter name=> 同时出现 → 命中",
		text: "<function name=\"edit\"><parameter name=\"path\">a.js</parameter></function>",
		expected: true
	},
	{
		label: "只有 <function name=> 没参数（疑似讨论）→ 不命中",
		text: "文档里写的 <function name=...> 这种写法其实不是标准格式，需要注意。",
		expected: false
	},
	{
		label: "孤立 seed:tool_call 标签（疑似提及而非使用）→ 不命中",
		text: "我在思考里分析：如果模型输出 <seed:tool_call> 这种文本格式，系统不会执行它，应该直接发起结构化调用。",
		expected: false
	},
	{
		label: "孤立 tool_call 标签（疑似提及）→ 不命中",
		text: "以前见过模型把工具调用写成 <tool_call> 文本而不是真的调用，这次要避免。",
		expected: false
	},
	{
		label: "普通文本提到工具调用（无标记）→ 不命中",
		text: "我准备调用 edit 工具来修改这个文件，先确认路径是否正确，然后再执行修改操作。",
		expected: false
	},
	{
		label: "正常长思考（无任何调用标记）→ 不命中",
		text: Array.from({ length: 120 }, (_, i) => `第 ${i} 步分析：检查模块 ${i} 的状态与依赖关系。`).join("\n"),
		expected: false
	}
];

let failed = 0;
for (const testCase of cases) {
	const got = hasPseudoToolCall(testCase.text);
	const ok = got === testCase.expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label} → ${got}`);
	if (!ok) failed += 1;
}

// 组合场景：伪调用 + 重复 → 锚点必须纠正格式，并可复用 loop 的 trimTo
const combined = (realUnit + "\n").repeat(403);
const loop = findRepeatingTail(combined);
const anchorText = renderPseudoToolAnchor(loop !== null, loop);
const anchorOk =
	anchorText.includes("文本") &&
	anchorText.includes("不会识别") &&
	anchorText.includes("直接发起工具调用") &&
	(!loop || anchorText.includes("重复"));
console.log(`${anchorOk ? "PASS" : "FAIL"} 伪调用锚点说明"文本形式不会被识别"并要求直接发起调用`);
if (!anchorOk) failed += 1;

const trimOk = loop !== null && loop.trimTo < 3000;
console.log(`${trimOk ? "PASS" : "FAIL"} 伪调用+重复时 trimTo 裁掉重复（trimTo=${loop ? loop.trimTo : "null"}）`);
if (!trimOk) failed += 1;

// 防自激振荡：锚点文本自身不能再次触发伪调用检测（否则注入后可见文本里出现
// 触发串，下一次 soft-cut 检查又命中 → 无限循环；生产实测连续触发 3 次）。
const selfTrigger = hasPseudoToolCall(anchorText);
console.log(`${selfTrigger ? "FAIL" : "PASS"} 伪调用锚点文本不再自激（不包含原始触发标签）`);
if (selfTrigger) failed += 1;

if (failed === 0) console.log("\n全部伪工具调用断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);