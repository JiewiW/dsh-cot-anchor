import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { reasoningFingerprint, rememberInjectedReasoning, injectedReasoningBySession, extractConclusions, hasContentSignal };`);
const { reasoningFingerprint, rememberInjectedReasoning, injectedReasoningBySession, extractConclusions, hasContentSignal } = factory();

let failed = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

// ---------- 1. 指纹稳定性 ----------
const sameA = "先看了代码。所以根因是缓存没失效。改法是加一层去重。";
const sameB = "  先看了代码。所以根因是缓存没失效。改法是加一层去重。  ";
// 长文本（>120 字符）：尾部微调不得影响前 120 字符指纹
const longBase = "先检查了入口模块的加载顺序，确认导出关系正确，然后逐项核对调用链路上的关键分支，包括初始化顺序、异常处理和资源释放路径，再对比改动前后的差异，同时留意依赖关系是否被破坏，最后确认测试用例覆盖了新增分支，并检查了错误处理是否有遗漏。所以根因是缓存未清理。";
const longTailTweak = longBase + "尾部补充一句无所谓的说明，不影响已确立的结论内容。";
const diffD = "完全不同的开头：这次是检查权限配置，发现问题在环境变量。";
check("指纹：相同推理（含空白差异）→ 相同指纹", reasoningFingerprint(sameA) === reasoningFingerprint(sameB), `"${reasoningFingerprint(sameA)}" vs "${reasoningFingerprint(sameB)}"`);
check("指纹：长文本尾部微调不影响指纹（前 120 字符稳定）", reasoningFingerprint(longBase) === reasoningFingerprint(longTailTweak));
check("指纹：不同推理开头 → 不同指纹", reasoningFingerprint(sameA) !== reasoningFingerprint(diffD));
check("指纹：空文本 → 空指纹", reasoningFingerprint("") === "");

// ---------- 2. 去重状态：同指纹只注入一次 ----------
injectedReasoningBySession.clear();
const sessionId = "sess-1";
const fp1 = reasoningFingerprint(sameA);
// 第一次：未记录 → 应注入（模拟：注入后记住）
const firstSeen = injectedReasoningBySession.get(sessionId) !== fp1;
rememberInjectedReasoning(sessionId, fp1);
const secondSeen = injectedReasoningBySession.get(sessionId) === fp1;
check("去重：首次注入后记住指纹", firstSeen && secondSeen);
check("去重：同会话同指纹 → 判定为已注入（跳过）", injectedReasoningBySession.get(sessionId) === fp1);
// 新推理：指纹变化 → 判定为新（应再注入）
const fp2 = reasoningFingerprint(diffD);
check("去重：新推理指纹 → 判定为新（可注入）", injectedReasoningBySession.get(sessionId) !== fp2);
rememberInjectedReasoning(sessionId, fp2);
check("去重：更新为最新指纹", injectedReasoningBySession.get(sessionId) === fp2);
// 不同会话互不影响
const otherSession = "sess-2";
check("去重：不同会话互不影响", injectedReasoningBySession.get(otherSession) === undefined);

// ---------- 3. 收紧后的准入信号 ----------
check("准入：真结论（根因是…）→ 有信号", hasContentSignal("根因是缓存没失效导致重复请求。"));
check("准入：修正句 → 有信号", hasContentSignal("其实之前的假设是错的，真正原因是缓存。"));
check("准入：含文件/路径/数字 → 有信号", hasContentSignal("问题在 dock.plugin.js 的第 42 行。"));
check("准入：纯流水账（无谓词/无密度/无修正）→ 无信号", !hasContentSignal("继续检查代码，把相关文件的逻辑梳理清楚，确认每个分支都有对应的处理。"));
check("准入：行动意图句（我需要确认一下参数）→ 无信号", !hasContentSignal("我需要确认一下参数，然后继续往下执行。"));
check("准入：英文结论谓词 → 有信号", hasContentSignal("The fix is to await the loader first."));

// ---------- 4. 收紧后的提取行为 ----------
const churn = "继续检查代码，把相关文件的逻辑梳理清楚，确认每个分支都有对应的处理，避免遗漏边界情况，然后对比一下前后的差异，看看有没有明显的问题，如果发现问题就记录下来，后续再统一修复。同时留意依赖关系的顺序，先确认入口，再往下走，最后再回头检查一遍。";
const churnPoints = extractConclusions(churn, 250, 3, 220);
check("提取：纯流水账（250+ 字符）不再提取结论", churnPoints.length === 0, `提取到 ${churnPoints.length} 条`);
const real = "我先看了两处代码。根因是 CSS 的 border 覆盖了定位，导致浮层偏移。改法是去掉那行 border。验证方式是刷新页面。";
const realPoints = extractConclusions(real, 0, 3, 220);
check("提取：真结论（根因/改法）仍正常提取", realPoints.length >= 1 && realPoints.join("").includes("border 覆盖了定位"), JSON.stringify(realPoints));

if (failed === 0) console.log("\n全部去重与收紧断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
