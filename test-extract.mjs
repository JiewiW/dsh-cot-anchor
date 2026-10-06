import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { extractConclusions, scoreSentence, splitSentences };`);
const { extractConclusions, scoreSentence, splitSentences } = factory();

/**
 * 这一组用例专门覆盖"旧版关键词门槛会漏掉"的形态：
 * 模型直接陈述结论、不写"因此/所以"这类连接词。
 */
const cases = [
	{
		label: "直陈根因（无结论词）→ 应抓到",
		reasoning: "我先看了两处代码。根因是 CSS 的 border 覆盖了定位，导致浮层偏移。改法是去掉那行 border。",
		expectAtLeast: 1,
		expectFragments: ["border 覆盖了定位"]
	},
	{
		label: "英文直陈（无 therefore）→ 应抓到",
		reasoning: "I traced the call chain twice. The loader resolves module A before the scheduler runs, which breaks ordering. The fix is to await the loader first.",
		expectAtLeast: 1,
		// 收紧后只抓带结论谓词的句子（The fix is…），不再抓纯问题描述（breaks ordering）
		expectFragments: ["The fix is to await the loader first"]
	},
	{
		label: "自我修正（最高价值）→ 应抓到",
		reasoning: "我原以为问题在渲染层。其实之前的假设是错的，真正的原因是缓存没失效。清掉缓存就好。",
		expectAtLeast: 1,
		expectFragments: ["缓存没失效"]
	},
	{
		label: "显式结论词仍然优先",
		reasoning: "所以修复点是用 card 容器挂载。另外我还看了一下别的地方，没什么问题。",
		expectAtLeast: 1,
		expectFragments: ["card 容器挂载"]
	},
	{
		label: "全是疑问与对冲 → 不应乱抓",
		reasoning: "是不是这里有问题？也许该看看那边？可能还需要再确认一下？",
		expectAtLeast: 0,
		expectFragments: []
	},
	{
		label: "过短文本 → 不抓",
		reasoning: "根因是缓存。",
		expectAtLeast: 0,
		expectFragments: []
	},
	{
		label: "纯标记句（Actually, wait.）→ 不抓",
		reasoning: "I'm burning turns. Actually, wait. Hmm, hold on. OK so let me reconsider.",
		expectAtLeast: 0,
		expectFragments: []
	},
	{
		label: "中文纯标记句（其实，等等。）→ 不抓",
		reasoning: "其实。等等，嗯，好的，那个。",
		expectAtLeast: 0,
		expectFragments: []
	},
	{
		label: "路线意图宣告（decisive route）→ 不抓",
		reasoning: "I have enough. Actually — the FASTEST decisive route: ask the user to open devtools and run one line. That's a small ask.",
		expectAtLeast: 0,
		expectFragments: []
	},
	{
		label: "标记词 + 事实命题 → 仍要抓到（不得误杀）",
		reasoning: "Actually, wait — the kernel never renders data-turn-process-member under the verbose policy, so every plugin branch misses.",
		expectAtLeast: 1,
		expectFragments: ["verbose"]
	},
	{
		label: "Wait 领起的自我修正事实 → 仍要抓到",
		reasoning: "Wait, I was wrong about the cache layer; the real cause is the missing abort signal in the request.",
		expectAtLeast: 1,
		expectFragments: ["abort signal"]
	}
];

let failed = 0;
for (const testCase of cases) {
	const points = extractConclusions(testCase.reasoning, 0, 3, 220);
	const combined = points.join("");
	const countOk = points.length >= testCase.expectAtLeast;
	const fragmentsOk = testCase.expectFragments.every((fragment) => combined.includes(fragment));
	const ok = countOk && fragmentsOk;
	console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label} → ${points.length} 条`);
	console.log(`     ${JSON.stringify(points)}`);
	if (!ok) failed += 1;
}

// 打分器自身：修正句必须显著高于对冲句
const correction = scoreSentence("其实之前的假设是错的，真正原因是缓存没失效。", 1, 3);
const hedge = scoreSentence("也许可以再看看那边是不是有问题。", 1, 3);
const opener = scoreSentence("所以修复点是用 card 容器挂载。", 1, 3);
const tierOk = opener >= 100 && correction < 100 && correction > hedge;
console.log(`${tierOk ? "PASS" : "FAIL"} 分档正确（结论词 ${opener} / 修正 ${correction} / 对冲 ${hedge}）`);
if (!tierOk) failed += 1;

// 无结论词时必须走兜底档，而不是返回空
const plainOnly = extractConclusions("先看了两处代码。根因是缓存没失效导致重复请求。改法是加一层去重。", 0, 3, 220);
const fallbackOk = plainOnly.length >= 1;
console.log(`${fallbackOk ? "PASS" : "FAIL"} 无结论词时兜底档生效（${plainOnly.length} 条）`);
if (!fallbackOk) failed += 1;

if (failed === 0) console.log("\n全部结论提取断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);