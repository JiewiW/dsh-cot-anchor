/**
 * 2026-10-01 软切断误判修复回归：
 *  1) 裸 "Let me check/read/verify" 的正常英文推理不判转折；
 *  2) 起草但未闭合的调用标签不判伪调用；
 *  3) 显式结论 + 接下来 / Now let me start 仍判转折；
 *  4) 完整闭合的伪调用块仍被拦截；
 *  5) 讨论文本（规则源码片段）不判伪调用。
 * 标签一律用字符码拼接，避免在源码里出现可被检测器误读的连续标签文本。
 */
import { readFileSync } from "node:fs";

let source = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(
	`${source}; return { hasPseudoToolCall, hasExplicitConclusion, wantsSoftCut };`
);
const { hasPseudoToolCall, hasExplicitConclusion, wantsSoftCut } = factory();

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const SL = String.fromCharCode(47);
const seedOpen = LT + "seed:tool_call" + GT;
const seedClose = LT + SL + "seed:tool_call" + GT;
const fnOpen = LT + 'function name="write"' + GT;
const param = LT + 'parameter name="file_path"' + GT + "D:\\tmp\\x.mjs" + LT + SL + "parameter" + GT;

let failed = 0;
function check(label, actual, expected) {
	const ok = actual === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${label} -> ${actual} (expect ${expected})`);
	if (!ok) failed += 1;
}

// 1) 普通英文工作短语不判转折
const englishWorking = "We need to understand the boot sequence before changing anything. ".repeat(12)
	+ "Let me check the entry file first and report what it exports.";
check("bare let me check is not transition", wantsSoftCut(englishWorking, 250), false);
check("ordinary reasoning has no explicit conclusion", hasExplicitConclusion(englishWorking, 250), false);

// 2) 未闭合草稿（有开标签和参数，无任何闭合标签）不判伪调用
const unclosedDraft = "I will issue the write call next: " + seedOpen + fnOpen + param;
check("unclosed drafted tags are not a pseudo call", hasPseudoToolCall(unclosedDraft), false);

// 3) 显式结论 + 明确阶段宣布仍判转折
const realZh = "配置项缺失导致加载失败。因此根因是 profile 里没有声明该依赖。".repeat(10)
	+ "\n接下来我先修复挂载行，再重启验证。";
check("zh explicit conclusion + transition", wantsSoftCut(realZh, 250), true);
check("zh explicit conclusion recognized", hasExplicitConclusion(realZh, 250), true);

const realEn = "Therefore the loader failure is caused by the missing dependency, not the plugin code. ".repeat(3)
	+ " Now let me start by fixing the mount entry.";
check("en explicit conclusion + now let me start", wantsSoftCut(realEn, 250), true);

// 4) 完整闭合的伪调用块仍被拦截
const completePseudo = "some prose before the attempt. " + seedOpen + fnOpen + param + seedClose;
check("closed pseudo call is still blocked", hasPseudoToolCall(completePseudo), true);

// 5) 讨论规则源码：antml 规则文本片段（无闭合标签）不判伪调用
const discussingSource = "the detector rule is antml:invoke then up to 80 chars then antml:parameter, "
	+ "which can match its own source text when quoted";
check("discussing regex source is not a pseudo call", hasPseudoToolCall(discussingSource), false);

if (failed === 0) console.log("\nALL SOFT-CUT FIX ASSERTIONS PASSED");
else console.log(`\n${failed} ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
