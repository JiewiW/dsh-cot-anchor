import { readFileSync } from "node:fs";

const sourcePath = new URL("./lib/index.js", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");
const factory = new Function(`${source}; return { latestThinkingText, latestReasoningText };`);
const { latestThinkingText, latestReasoningText } = factory();

/**
 * mockSession 构造一个含两条 assistant/message 的会话 surface：
 *   - node id 倒序（surface 从新到旧），latestThinkingText 应取最新的那条。
 *   - 每条 eventAt 返回对应 content 块数组。
 */
/**
 * mockSession 参数 messages 按「新 → 旧」排列：messages[0] 是最新一条。
 * surface.nodes 从旧到新排列（最新放末尾）：nodes = [node-(len-1), …, node-0]。
 * latestThinkingText 逆序遍历 nodes，先访问末尾 node-0 → byId 映射到 messages[0]（最新）。
 */
function mockSession(messages) {
	const nodes = messages.map((_, i) => `node-${messages.length - 1 - i}`);
	const byId = new Map(messages.map((m, i) => [`node-${i}`, { type: "assistant/message", data: { message: { content: m } } }]));
	return {
		surface: { nodes },
		eventAt(id) {
			return byId.get(id);
		}
	};
}

let failed = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

// 1. 最新消息有 reasoning → 返回 reasoning
const withReason = mockSession([
	[{ type: "reasoning", text: "思考链：所以根因是缓存。" }, { type: "text", text: "答复。" }],
	[{ type: "text", text: "正式答复，分析到这里。" }]
]);
check("有 reasoning：latestThinkingText 返回 reasoning（不退回 text）", latestThinkingText(withReason) === "思考链：所以根因是缓存。", `"${latestThinkingText(withReason)}"`);

// 2. 最新消息无 reasoning（只有 text）→ 退回 text
const textOnly = mockSession([
	[{ type: "text", text: "我先查看相关测试文件，确认重复检测的覆盖边界。" }],
	[{ type: "text", text: "答复一" }]
]);
check("无 reasoning：latestThinkingText 退回最新 text", latestThinkingText(textOnly) === "我先查看相关测试文件，确认重复检测的覆盖边界。", `"${latestThinkingText(textOnly)}"`);

// 3. 逆序遍历取最新：messages[0]（最新）应被优先选中
const mixedOrder = mockSession([
	[{ type: "text", text: "较新的 text，这是真正的最新思考。" }],
	[{ type: "text", text: "较早的 text" }]
]);
check("逆序遍历：取最新一条消息", latestThinkingText(mixedOrder) === "较新的 text，这是真正的最新思考。");

// 4. 都为空 → 返回空字符串
check("全空：latestThinkingText 返回空串", latestThinkingText(mockSession([[], []])) === "");

// 5. 无 surface → 返回空串
check("无 surface：latestThinkingText 返回空串", latestThinkingText({}) === "");

// 6. 对照旧函数：latestReasoningText 对纯 text 消息返回空（确认降级是新增能力）
check("旧函数 latestReasoningText 对纯 text 返回空（A 补的正是这个洞）", latestReasoningText(textOnly) === "");

// 7. 最新消息 reasoning 为空串（空块）→ 也应回退到 text
const emptyReasoning = mockSession([
	[{ type: "reasoning", text: "" }, { type: "text", text: "只有实义 text。" }]
]);
check("reasoning 为空块：latestThinkingText 回退到 text", latestThinkingText(emptyReasoning) === "只有实义 text。", `"${latestThinkingText(emptyReasoning)}"`);

if (failed === 0) console.log("\n全部 latestThinkingText 断言通过");
else console.log(`\n存在 ${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);