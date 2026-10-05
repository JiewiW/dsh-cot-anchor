import { readFileSync } from "node:fs";

/**
 * 分析层解析单元测试（docs/cot-harvest-design.md §4.3）。
 *
 * 契约：解析必须容错（模型可能包 ```json 围栏或加前导语），但绝不猜测。
 * 解析失败返回 null，由调用方标记该批次失败、样本保持未分析。
 */
const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return {
	parseHarvestFindings,
	mergeHarvestProposal,
	harvestProposalKey,
	normalizeHarvestFeatureSpec,
	selectAnalyzeOutput,
	describeFinishFailure
};`);
const api = factory();

let failed = 0;
function check(label, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const validFinding = {
	kind: "new-pattern",
	detector: "churn",
	title: "中文短句空转",
	observation: "反复「再捋一遍」但本地 churn 命中数低于阈值。",
	evidence: ["smp_7f3a", "smp_91c2"],
	featureSpec: { literals: ["再捋一遍"], coOccurrence: [], minHitsPer1000Chars: 5, negatives: [] },
	confidence: 0.72,
	suggestedAction: "add-churn-phrase"
};

// --- 正常解析 -------------------------------------------------------------
const bare = api.parseHarvestFindings(JSON.stringify({ findings: [validFinding] }));
check("裸 JSON 可解析", Array.isArray(bare) && bare.length === 1);
check("字段被完整保留", bare[0].detector === "churn" && bare[0].confidence === 0.72 && bare[0].evidence.length === 2);
check("featureSpec 字面量被保留", bare[0].featureSpec.literals[0] === "再捋一遍");

const fenced = api.parseHarvestFindings("```json\n" + JSON.stringify({ findings: [validFinding] }) + "\n```");
check("```json 围栏可解析", Array.isArray(fenced) && fenced.length === 1);

const noLang = api.parseHarvestFindings("```\n" + JSON.stringify({ findings: [validFinding] }) + "\n```");
check("无语言标记围栏可解析", Array.isArray(noLang) && noLang.length === 1);

const withPreamble = api.parseHarvestFindings("好的，以下是分析结果：\n" + JSON.stringify({ findings: [validFinding] }) + "\n以上。");
check("带前导语可解析", Array.isArray(withPreamble) && withPreamble.length === 1);

// --- 只缺结尾闭合定界符时可补全（实测：模型正文完整但不吐最外层 `}`）-----
const completeJson = JSON.stringify({ findings: [validFinding] });
const missingOuterBrace = api.parseHarvestFindings(completeJson.slice(0, -1));
check("只缺最外层 } 时可解析", Array.isArray(missingOuterBrace) && missingOuterBrace.length === 1);
check("补全后字段仍完整", missingOuterBrace?.[0]?.detector === "churn" && missingOuterBrace?.[0]?.confidence === 0.72);
check("补全不新增候选", missingOuterBrace?.length === 1);
const missingArrayAndBrace = api.parseHarvestFindings(completeJson.slice(0, -2));
check("缺 ]} 两个定界符时可解析", Array.isArray(missingArrayAndBrace) && missingArrayAndBrace.length === 1);

// 截断与真畸形不得被"补全"成看似合法的结果
check("字符串被截断仍返回 null", api.parseHarvestFindings('{"findings":[{"title":"没写完') === null);
check("缺逗号仍返回 null", api.parseHarvestFindings('{"findings":[{"kind":"new-pattern"} {"kind":"new-pattern"}]') === null);
check("闭合符顺序错仍返回 null", api.parseHarvestFindings('{"findings":[}]') === null);
check("引号内花括号不干扰补全", api.parseHarvestFindings('{"findings":[{"title":"含 } 和 ] 的说明"}]'.slice(0, -2)) !== null);

// --- 坏输入必须失败而非猜测 ----------------------------------------------
check("空串返回 null", api.parseHarvestFindings("") === null);
check("纯文本返回 null", api.parseHarvestFindings("我没有发现任何异常。") === null);
check("坏 JSON 返回 null", api.parseHarvestFindings('{"findings": [{"kind": ') === null);
check("缺少 findings 数组返回 null", api.parseHarvestFindings('{"result": []}') === null);
check("findings 不是数组返回 null", api.parseHarvestFindings('{"findings": "none"}') === null);
check("null 输入返回 null", api.parseHarvestFindings(null) === null);
check("无 JSON 对象返回 null", api.parseHarvestFindings("[1,2,3]") === null);

// --- provider 级失败要原样透出，且不冒充解析失败 --------------------------
check("未知模型报错透出原文", api.describeFinishFailure({
	kind: "error",
	failure: { code: "UNKNOWN_MODEL", message: 'pi-ai provider "trae" has no configured model "x"' }
}).includes("has no configured model"));
check("未知模型报错带错误码", api.describeFinishFailure({
	kind: "error",
	failure: { code: "UNKNOWN_MODEL", message: "boom" }
}).includes("UNKNOWN_MODEL"));
check("缺 message 时有兜底文案", api.describeFinishFailure({ kind: "error", failure: {} }).length > 0);
check("正常结束不报 provider 失败", api.describeFinishFailure({ kind: "stop" }) === "");
check("finish 缺失不报 provider 失败", api.describeFinishFailure(undefined) === "");
check("aborted 不由本函数处理", api.describeFinishFailure({ kind: "aborted" }) === "");

// --- 非法枚举值被丢弃，而不是被猜测 --------------------------------------
const mixed = api.parseHarvestFindings(JSON.stringify({
	findings: [
		validFinding,
		{ ...validFinding, kind: "made-up-kind" },
		{ ...validFinding, detector: "not-a-detector" },
		{ ...validFinding, detector: "repeat", kind: "missed-by-detector" }
	]
}));
check("非法 kind/detector 被丢弃、合法项保留", Array.isArray(mixed) && mixed.length === 2, `len=${mixed?.length}`);

// --- 置信度与证据的边界 ---------------------------------------------------
const clamped = api.parseHarvestFindings(JSON.stringify({
	findings: [{ ...validFinding, confidence: 42 }, { ...validFinding, confidence: -3 }]
}));
check("confidence 被夹到 [0,1]", clamped[0].confidence === 1 && clamped[1].confidence === 0);

const badEvidence = api.parseHarvestFindings(JSON.stringify({
	findings: [{ ...validFinding, evidence: ["ok", 42, null, "fine"] }]
}));
check("evidence 只保留字符串", badEvidence[0].evidence.join(",") === "ok,fine", badEvidence[0].evidence.join(","));

// --- featureSpec 归一化：未知字段被丢弃 ----------------------------------
const normalized = api.normalizeHarvestFeatureSpec({
	literals: ["a", 1, "", "b"],
	thresholdKey: "churnMinHits",
	suggestedValue: 12,
	evil: "rm -rf /",
	regex: "(a+)+"
});
check("literals 只保留非空字符串", normalized.literals.join(",") === "a,b");
check("未知字段 evil 被丢弃", normalized.evil === undefined);
check("未知字段 regex 被丢弃", normalized.regex === undefined);
check("thresholdKey/suggestedValue 被保留", normalized.thresholdKey === "churnMinHits" && normalized.suggestedValue === 12);
check("超长字面量被截断", api.normalizeHarvestFeatureSpec({ literals: ["x".repeat(200)] }).literals[0].length === 48);

// --- 候选去重与置信累积 ---------------------------------------------------
const now = Date.now();
let proposals = api.mergeHarvestProposal([], bare[0], now);
check("首次发现新增一条候选", proposals.length === 1);
check("首次 seenCount=1", proposals[0].seenCount === 1);
check("首次 firstSeenAt 被记录", proposals[0].firstSeenAt === now);

const secondFinding = { ...bare[0], evidence: ["smp_55de", "smp_7f3a"] };
proposals = api.mergeHarvestProposal(proposals, secondFinding, now + 1000);
check("同一 featureSpec 不新增条目", proposals.length === 1, `len=${proposals.length}`);
check("seenCount 累加", proposals[0].seenCount === 2);
check("confidence 提升 0.05", Math.abs(proposals[0].confidence - 0.77) < 1e-9, String(proposals[0].confidence));
check("证据合并去重", proposals[0].evidence.length === 3, proposals[0].evidence.join(","));
check("lastSeenAt 被刷新", proposals[0].lastSeenAt === now + 1000);

const different = { ...bare[0], featureSpec: { literals: ["往回倒一下"] } };
proposals = api.mergeHarvestProposal(proposals, different, now + 2000);
check("不同 featureSpec 新增条目", proposals.length === 2);

check("proposalKey 对相同 spec 稳定",
	api.harvestProposalKey(bare[0]) === api.harvestProposalKey(secondFinding));
check("proposalKey 对不同 spec 不同",
	api.harvestProposalKey(bare[0]) !== api.harvestProposalKey(different));

// confidence 上限
let cappedProposals = proposals;
for (let i = 0; i < 20; i++) cappedProposals = api.mergeHarvestProposal(cappedProposals, secondFinding, now);
check("confidence 不超过 0.99", cappedProposals[0].confidence <= 0.99, String(cappedProposals[0].confidence));

// --- 分析输出取用：text 优先，reasoning 仅在 text 全空时兜底 ----------------
const findingsJson = JSON.stringify({ findings: [validFinding] });

const textOnly = api.selectAnalyzeOutput([{ type: "reasoning", text: "想一下" }, { type: "text", text: findingsJson }]);
check("有 text 时取 text", textOnly.parsedFrom === "text" && textOnly.raw === findingsJson);
check("有 text 时 reasoningChars 仍被记录", textOnly.reasoningChars === 3);

const reasoningOnly = api.selectAnalyzeOutput([{ type: "reasoning", text: findingsJson }]);
check("text 全空时回退 reasoning", reasoningOnly.parsedFrom === "reasoning" && reasoningOnly.raw === findingsJson);
check("回退时 textChars 为 0", reasoningOnly.textChars === 0);

const nothing = api.selectAnalyzeOutput([{ type: "reasoning", text: "" }, { type: "text", text: "" }]);
check("两路都空时 parsedFrom=none", nothing.parsedFrom === "none" && nothing.raw === "");

check("空数组不抛错", api.selectAnalyzeOutput([]).parsedFrom === "none");
check("null 不抛错", api.selectAnalyzeOutput(null).parsedFrom === "none");

// 兜底不等于放松校验：reasoning 里只是"提到" JSON 仍必须解析失败
const reasoningProse = api.selectAnalyzeOutput([{ type: "reasoning", text: "我会输出 {\"findings\": [...]} 这样的结构。" }]);
check("reasoning 兜底后仍走严格校验", api.parseHarvestFindings(reasoningProse.raw) === null);
check("reasoning 兜底不改写内容", reasoningProse.raw.includes("[...]"));

// 多块拼接
const multi = api.selectAnalyzeOutput([{ type: "text", text: '{"findings":' }, { type: "text", text: "[]}" }]);
check("多个 text 块按换行拼接", multi.raw === '{"findings":\n[]}', JSON.stringify(multi.raw));

if (failed === 0) console.log("\n全部解析层断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
