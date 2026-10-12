import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { anchorContentHash, alreadyInjectedAnchor, rememberInjectedAnchor, injectedAnchorHashesBySession, INJECTED_ANCHOR_HASH_LIMIT, INJECTED_ANCHOR_SESSION_LIMIT, extractConclusions, hasContentSignal };`);
const {
	anchorContentHash,
	alreadyInjectedAnchor,
	rememberInjectedAnchor,
	injectedAnchorHashesBySession,
	INJECTED_ANCHOR_HASH_LIMIT,
	INJECTED_ANCHOR_SESSION_LIMIT,
	extractConclusions,
	hasContentSignal,
} = factory();

let failed = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

// 模拟一次「渲染正文 → 判重 → 注入后记住」的完整判定。
// pre-step 钩子与 post-execute 钩子在产品代码里调用的就是这同一对函数、
// 同一张模块级 Map；这里不区分调用方，直接以同一 sessionId 复现两条路径。
const judgeAndRemember = (sessionId, renderedBody) => {
	const hash = anchorContentHash(renderedBody);
	const duplicate = alreadyInjectedAnchor(sessionId, hash);
	if (!duplicate) rememberInjectedAnchor(sessionId, hash);
	return { hash, injected: !duplicate };
};

// ---------- 1. 渲染正文内容哈希：归一化后整文哈希 ----------
const bodyA = "根因是缓存没失效。\n改法是加一层去重。";
const bodyAWhitespaceVariant = "  根因是缓存没失效。 改法是加一层去重。\n";
const bodyB = "根因是权限配置缺失，问题在环境变量。";
check("哈希：同一渲染正文（首尾空白/换行差异）→ 相同哈希", anchorContentHash(bodyA) === anchorContentHash(bodyAWhitespaceVariant), `"${anchorContentHash(bodyA)}" vs "${anchorContentHash(bodyAWhitespaceVariant)}"`);
check("哈希：不同渲染正文 → 不同哈希", anchorContentHash(bodyA) !== anchorContentHash(bodyB));
check("哈希：空文本 → 空串（不参与判重）", anchorContentHash("") === "");
check("哈希：非字符串 → 空串", anchorContentHash(null) === "" && anchorContentHash(undefined) === "");

// ---------- 2. 同一会话同一渲染正文仅注入一次；不同正文各注入一次 ----------
injectedAnchorHashesBySession.clear();
const sessionOne = "sess-dedup-1";
const first = judgeAndRemember(sessionOne, bodyA);
check("同文单次：首次出现 → 允许注入", first.injected === true);
const second = judgeAndRemember(sessionOne, bodyA);
check("同文单次：同会话再次出现 → 判为已注入（跳过）", second.injected === false && second.hash === first.hash);
const third = judgeAndRemember(sessionOne, bodyA);
check("同文单次：第三次仍判重，集合只记 1 条", third.injected === false && injectedAnchorHashesBySession.get(sessionOne).size === 1);
const otherBody = judgeAndRemember(sessionOne, bodyB);
check("异文各一次：不同渲染正文 → 允许再注入", otherBody.injected === true && otherBody.hash !== first.hash);
check("异文各一次：两条哈希并存（集合 2 条）", injectedAnchorHashesBySession.get(sessionOne).size === 2);

// 会话隔离
const sessionTwo = "sess-dedup-2";
const otherSessionFirst = judgeAndRemember(sessionTwo, bodyA);
check("会话隔离：同文在另一会话 → 仍允许注入（各会话独立集合）", otherSessionFirst.injected === true);

// ---------- 3. pre-step 与 post-execute 共用同一去重集合 ----------
injectedAnchorHashesBySession.clear();
const sharedSession = "sess-shared-path";
// 顺序一：pre-step 先触发并记住，post-execute 同文必须判重
const preStepHit = judgeAndRemember(sharedSession, bodyA);
const postExecuteHit = judgeAndRemember(sharedSession, bodyA);
check("两路径共用：pre-step 先注入后 post-execute 同文 → 跳过", preStepHit.injected === true && postExecuteHit.injected === false);
// 顺序二：post-execute 先触发，pre-step 同文也必须判重
const reverseSession = "sess-shared-reverse";
const postFirst = judgeAndRemember(reverseSession, bodyB);
const preSecond = judgeAndRemember(reverseSession, bodyB);
check("两路径共用：post-execute 先注入后 pre-step 同文 → 跳过", postFirst.injected === true && preSecond.injected === false);
// 两路径各注一条不同正文：集合里两条都在，证明共用的是累加的同一集合而非各自单值
const accumulatingSession = "sess-shared-accumulate";
judgeAndRemember(accumulatingSession, bodyA); // 视为 pre-step
judgeAndRemember(accumulatingSession, bodyB); // 视为 post-execute
check("两路径共用：两条路径注入的不同正文落在同一集合（2 条并存）", injectedAnchorHashesBySession.get(accumulatingSession).size === 2);

// ---------- 4. 每会话保留最近 N 条（N>=20），超限按最旧顺序淘汰 ----------
check("容量：每会话保留上限常量存在且 N>=20", typeof INJECTED_ANCHOR_HASH_LIMIT === "number" && INJECTED_ANCHOR_HASH_LIMIT >= 20, `N=${INJECTED_ANCHOR_HASH_LIMIT}`);
check("容量：会话数上限常量存在", typeof INJECTED_ANCHOR_SESSION_LIMIT === "number" && INJECTED_ANCHOR_SESSION_LIMIT >= 1);
const lruSession = "sess-lru";
injectedAnchorHashesBySession.clear();
const orderedBodies = [];
for (let index = 0; index < INJECTED_ANCHOR_HASH_LIMIT; index += 1) {
	const body = `结论条目 ${index}：根因位于模块 ${1000 + index} 行的分支。`;
	orderedBodies.push(body);
	const verdict = judgeAndRemember(lruSession, body);
	if (!verdict.injected) {
		check(`容量：前 N 条第 ${index + 1} 条应全部允许注入`, false);
		break;
	}
}
check("容量：注入恰好 N 条 → 集合大小为 N", injectedAnchorHashesBySession.get(lruSession).size === INJECTED_ANCHOR_HASH_LIMIT, `size=${injectedAnchorHashesBySession.get(lruSession).size}`);
const oldestHash = anchorContentHash(orderedBodies[0]);
check("容量：淘汰前最旧一条仍在", alreadyInjectedAnchor(lruSession, oldestHash));
const overflowBody = `结论条目 ${INJECTED_ANCHOR_HASH_LIMIT}：超出容量的新结论，应淘汰最旧条目。`;
const overflowVerdict = judgeAndRemember(lruSession, overflowBody);
check("容量：第 N+1 条不同正文 → 允许注入", overflowVerdict.injected === true);
check("容量：第 N+1 条注入后最旧一条被淘汰（LRU/FIFO 驱逐）", !alreadyInjectedAnchor(lruSession, oldestHash), "oldest hash still present");
check("容量：驱逐后集合大小仍为 N（不无限增长）", injectedAnchorHashesBySession.get(lruSession).size === INJECTED_ANCHOR_HASH_LIMIT);
const secondOldestSurvives = alreadyInjectedAnchor(lruSession, anchorContentHash(orderedBodies[1]));
check("容量：次旧条目仍保留（仅驱逐最旧一条）", secondOldestSurvives);

// ---------- 5. 收紧后的准入信号（回归保护，与 P1-10 同批契约） ----------
check("准入：真结论（根因是…）→ 有信号", hasContentSignal("根因是缓存没失效导致重复请求。"));
check("准入：修正句 → 有信号", hasContentSignal("其实之前的假设是错的，真正原因是缓存。"));
check("准入：含文件/路径/数字 → 有信号", hasContentSignal("问题在 dock.plugin.js 的第 42 行。"));
check("准入：纯流水账（无谓词/无密度/无修正）→ 无信号", !hasContentSignal("继续检查代码，把相关文件的逻辑梳理清楚，确认每个分支都有对应的处理。"));
check("准入：行动意图句（我需要确认一下参数）→ 无信号", !hasContentSignal("我需要确认一下参数，然后继续往下执行。"));
check("准入：英文结论谓词 → 有信号", hasContentSignal("The fix is to await the loader first."));

// ---------- 6. 收紧后的提取行为（回归保护） ----------
const churn = "继续检查代码，把相关文件的逻辑梳理清楚，确认每个分支都有对应的处理，避免遗漏边界情况，然后对比一下前后的差异，看看有没有明显的问题，如果发现问题就记录下来，后续再统一修复。同时留意依赖关系的顺序，先确认入口，再往下走，最后再回头检查一遍。";
const churnPoints = extractConclusions(churn, 250, 3, 220);
check("提取：纯流水账（250+ 字符）不再提取结论", churnPoints.length === 0, `提取到 ${churnPoints.length} 条`);
const real = "我先看了两处代码。根因是 CSS 的 border 覆盖了定位，导致浮层偏移。改法是去掉那行 border。验证方式是刷新页面。";
const realPoints = extractConclusions(real, 0, 3, 220);
check("提取：真结论（根因/改法）仍正常提取", realPoints.length >= 1 && realPoints.join("").includes("border 覆盖了定位"), JSON.stringify(realPoints));

if (failed === 0) console.log("\n全部 P1-10 去重新契约断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
