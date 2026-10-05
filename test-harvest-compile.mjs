import { readFileSync } from "node:fs";

/**
 * 安全编译单元测试（docs/cot-harvest-design.md §5.2）。
 *
 * 这是本方案最重要的一条安全约束：LLM 永远不写正则。测试要证明的是
 * 「编译产物只可能是字面量匹配」——即无论输入什么，结果里都不可能出现
 * 量词、分组、字符类等可导致灾难性回溯的结构。
 */
const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return {
	compileLearnedLiteralPhrase,
	selfCheckLearnedLiteral,
	LEARNED_LITERAL_MAX_CHARS,
	LEARNED_SELF_CHECK_CORPUS
};`);
const { compileLearnedLiteralPhrase, selfCheckLearnedLiteral, LEARNED_LITERAL_MAX_CHARS, LEARNED_SELF_CHECK_CORPUS } = factory();

let failed = 0;
function check(label, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
	if (!condition) failed += 1;
}

// --- 基本编译 -------------------------------------------------------------
const plain = compileLearnedLiteralPhrase("再捋一遍");
check("普通字面量可编译", plain instanceof RegExp);
check("普通字面量 source 原样", plain.source === "再捋一遍", plain.source);
check("编译为全局匹配", plain.flags === "g");

check("空字符串返回 null", compileLearnedLiteralPhrase("") === null);
check("null 返回 null", compileLearnedLiteralPhrase(null) === null);
check("undefined 返回 null", compileLearnedLiteralPhrase(undefined) === null);

// --- 元字符全部被转义 -----------------------------------------------------
const metachars = ".*+?^${}()|[]\\";
const escaped = compileLearnedLiteralPhrase(metachars);
check("全部元字符被转义", escaped.source === "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\", escaped.source);
check("转义后按字面量匹配自身", escaped.test(metachars));
escaped.lastIndex = 0;
check("转义后不匹配无关文本", escaped.test("abc") === false);

// --- 危险输入编译后不含量词 ----------------------------------------------
const dangerous = ["(a+)+", "a*", "a{1,9999}", "(x|y)*", ".*.*.*", "[a-z]+", "^$"];
let quantifierFree = true;
for (const input of dangerous) {
	const compiled = compileLearnedLiteralPhrase(input);
	// 去掉转义后的反斜杠再检查，确保剩下的都是普通字符
	const unescaped = compiled.source.replace(/\\./g, "");
	if (/[+*?{}]/.test(unescaped)) {
		quantifierFree = false;
		console.log(`      泄漏：${input} → ${compiled.source}`);
	}
}
check("危险输入编译后不含任何量词", quantifierFree);

// 灾难性回溯的实际验证：编译后的正则对恶意长串必须是线性的（立即返回）
const catastrophic = compileLearnedLiteralPhrase("(a+)+");
const hostile = `${"a".repeat(50000)}!`;
const startedAt = Date.now();
catastrophic.lastIndex = 0;
catastrophic.test(hostile);
const elapsed = Date.now() - startedAt;
check("恶意长串不触发回溯（<500ms）", elapsed < 500, `${elapsed}ms`);

// --- 长度硬上限 -----------------------------------------------------------
const overlong = "长".repeat(200);
const capped = compileLearnedLiteralPhrase(overlong);
check(`超长字面量被截断到 ${LEARNED_LITERAL_MAX_CHARS}`, capped.source.length === LEARNED_LITERAL_MAX_CHARS, `len=${capped.source.length}`);

// --- 采纳前自检 -----------------------------------------------------------
check("普通技术语料能通过自检", selfCheckLearnedLiteral("再捋一遍") === null);
check("语料条数为 3", LEARNED_SELF_CHECK_CORPUS.length === 3);
check("空字面量自检失败", selfCheckLearnedLiteral("") === "字面量为空");
// 自检必须能抓住「会误伤正常语料」的字面量
const common = LEARNED_SELF_CHECK_CORPUS[0].slice(0, 4);
check(`命中正常语料的字面量「${common}」被拒绝`, selfCheckLearnedLiteral(common) !== null, String(selfCheckLearnedLiteral(common)));

if (failed === 0) console.log("\n全部安全编译断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
