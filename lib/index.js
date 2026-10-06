/**
 * COT Anchor — extract a small number of genuine conclusion sentences
 * from the latest assistant reasoning block and inject them once per user turn
 * as a "COT anchor" notice, so the model does not re-derive already
 * established conclusions during a multi-tool step chain.
 *
 * Host-only plugin: no client half.
 *
 * Stability contract (learned from first-release failures):
 *  - Every injected context MUST carry a stable unique `id` and be deep-frozen,
 *    exactly like the official repeat-tool-reminder notices.  DSH's agent loop
 *    appends each additionalContext into its durable inbox["next-step"] and
 *    hard-rejects duplicate ids (dsh-agent-loop: 43, 194, 1134).  A missing id
 *    surfaces as `message "undefined" is already pending`.
 *  - Injection runs on EVERY tool post-execute (deliberate: this plugin exists to
 *    keep forgetful models like deepseek-v4.1-flash constantly reminded of the
 *    conclusions they just drew, so density is the point).  Because each injected
 *    message carries a unique random id, a long tool chain simply accrues many
 *    distinct pending anchors without colliding.
 *  - Conclusion extraction is conservative: only complete, declarative sentences
 *    that open with a strong conclusion signal are kept.
 *
 * @module dsh-cot-anchor
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

const name = "dsh-cot-anchor";

/**
 * The Settings tab needs the web server to register its route, and the route
 * MUST be registered during `apply`.  Declaring it here (rather than reading
 * `ctx.get('webServer')` inside apply) is what guarantees the service is ready
 * at apply time — resolving it softly inside apply leaves the route
 * unregistered and the tab silently 404s.
 */
const inject = ["webServer"];

/**
 * Source marker for every anchor message this plugin injects.
 *
 * 2026-10-05 修复 "format v4 message requires a producer-owned source kind"：
 * 内核 0.2.0 起废弃了笼统的 `kind:"plugin"` 包装 —— dsh-session-persistence-jsonl
 * 的 worker 在**写入前的行级准入**（assertV4SourceRowAdmission）与读取时的
 * assertV4MessageSources 都会对它直接抛 SessionFormatError，导致本插件注入的
 * 锚点消息写不进会话、整轮运行失败（报错出现在"已调用工具"之后，
 * 因为注入发生在 tool/post-execute 阶段）。
 *
 * 改为内核迁移器对未知插件使用的标准形态 `plugin:<name>`
 * （见 dsh-session-format-v3-to-v4 的 producerKind 末行 return `plugin:${plugin}`）。
 * 这个形态与本插件历史 v4 会话里已落盘的 428 条记录完全一致，老代码读新消息、
 * 新代码读老消息行为统一。
 *
 * `plugin` 字段保留：第 2558 行靠它识别"这是我自己注入的"以避免自采样放大。
 */
const PLUGIN_SOURCE = {
	kind: "plugin:dsh-cot-anchor",
	plugin: "dsh-cot-anchor"
};

/**
 * 内核能力的"插座探测"结果缓存 —— 只在首次 `apply` 时算一次。
 *
 * ## 为什么需要它（2026-10-05 事故）
 *
 * 本插件的"生成中途截停"能力，全部挂在宿主钩子 `agent/soft-cut` 上。该钩子
 * 是上游**自 0.1.5-rc.3 起主动移除**的（0.1.5-rc.1/rc.2 有，0.1.6 / 0.1.7 /
 * 0.2.0 / 0.2.1-alpha.1 全无）。升级到 0.2.0-rc.2 后，`ctx.on("agent/soft-cut", …)`
 * 注册的是一个**永不触发**的钩子名：插件加载无报错、日志照常、`tools/post-execute`
 * 的锚点注入也照常工作，唯独截停静默失效。
 *
 * 事故代价是真实的：模型把异常指令和巨量重复内容直接吐进正文，turn 被干停，
 * 全靠用户手动中断（见 docs/soft-cut-missing-rootcause-20261005.md）。
 *
 * ## 移植补丁后的状态（2026-10-06 补记）
 *
 * "上游已移除"只描述**未打补丁的官方内核**。若已用随包工具
 * `tools/apply-softcut-port.mjs` 把软切移植回内核（内核源码中带
 * `DSH-SOFT-CUT-PORT` 标记），钩子恢复、本插件注册的回调正常触发——
 * 实测在 0.2.0 系列已移植内核上单会话触发 8 次（见
 * docs/softcut-kernel-port.md「移植后的一次实测确认」）。能力有无一律以
 * probe 结果（present / absent / unknown）为准，不要据本注释的版本论断
 * 反推运行时状态。
 *
 * 教训不是"插件坏了"，而是"**东西悄悄坏了，没有任何提示**"。因此这里主动探测
 * 一次，把能力的有无明明白白暴露到启动日志和设置页，而不是等故障倒推。
 *
 * ## 探测手段
 *
 * cordis 没有公开的事件自省接口（`ctx.events._hooks` 是内部实现，不作依赖），
 * 所以改为**直接读内核包源码**：解析 `@deepseek-ai/dsh-agent-loop`，在其
 * `lib/index.js` 中查找钩子名字面量。探测失败（包解析不到、读不到、无该文件）
 * 一律返回 `"unknown"`，**绝不让探测本身影响插件加载**。
 */

/**
 * 承载"生成中途截停"能力的宿主钩子名。未打补丁的官方内核自 0.1.5-rc.3 起
 * 移除；经 tools/apply-softcut-port.mjs 移植后恢复（见上方头注释）。
 */
const SOFT_CUT_HOOK = "agent/soft-cut";

/** 0.2.0 起仍存在的流式通知钩子（仅 emit 通知，不能返回 cut 决策）。 */
const ASSISTANT_STREAM_HOOK = "agent/assistant-stream";

/** 探测结果的三种状态。 */
const CAPABILITY_UNKNOWN = "unknown";
const CAPABILITY_PRESENT = "present";
const CAPABILITY_ABSENT = "absent";

/**
 * 在宿主内核里查找一个钩子名是否仍然存在。
 *
 * @param {string} hookName - 形如 `agent/soft-cut` 的钩子名字面量。
 * @returns {"present"|"absent"|"unknown"} 存在 / 不存在 / 无法确定。
 */
function probeKernelHook(hookName) {
	// 候选解析基点，按可靠性排序：进程入口最贴近真实运行的内核；
	// 其后是 cwd 与插件自身，用于入口不可用的场合。
	const bases = [];
	if (typeof process !== "undefined" && Array.isArray(process.argv) && process.argv[1]) {
		bases.push(process.argv[1]);
	}
	if (typeof process !== "undefined" && typeof process.cwd === "function") {
		try {
			bases.push(join(process.cwd(), "package.json"));
		} catch {
			// cwd 不可用（已被删除等）：跳过该基点。
		}
	}
	for (const base of bases) {
		try {
			const require_ = createRequire(base);
			const kernelPath = require_.resolve("@deepseek-ai/dsh-agent-loop");
			const source = readFileSync(kernelPath, "utf8");
			return source.includes(hookName) ? CAPABILITY_PRESENT : CAPABILITY_ABSENT;
		} catch {
			// 该基点解析或读取失败：换下一个基点。
		}
	}
	return CAPABILITY_UNKNOWN;
}

/**
 * Strong conclusion markers — sentence OPENERS (start of sentence), not mere
 * substrings.  Kept deliberately narrow to avoid pulling in mid-reasoning
 * fragments that merely contain a marker.
 */
const CONCLUSION_OPENERS = [
	// Chinese, anchored at sentence start
	/^因此/,
	/^所以/,
	/^综上/,
	/^结论[是：:]/,
	/^由此(可知|可见)/,
	/^这说明/,
	/^这表明/,
	/^这(就)?意味(着|：)/,
	/^也就是说/,
	/^等价(地|于)/,
	/^因此结论/,
	/^综上(所述)?/,
	/^总结[：:]/,
	// English, anchored at sentence start
	/^therefore/i,
	/^thus[, ]/i,
	/^hence[, ]/i,
	/^in conclusion/i,
	/^consequently/i,
	/^as a result/i,
	/^this (shows|means|implies|indicates) that/i,
	/^it follows that/i,
	/^to summarize/i,
	/^we conclude/i,
	/^the (bottom line|takeaway) is/i
];

/** Characters that signal a sentence is NOT a clean conclusion (throwaway). */
const WEAK_SENTENCE_PATTERNS = [
	/[？！?]/u, // questions / exclamations
	/^(\s*[-*•÷\d.,]|\])/u, // list bullets / code-ish fragments
	/\b(if|whether|maybe|perhaps|could|might)\b/i, // hedged / conditional
	/\b(let'?s|let me|i'?ll|i will|i am going to|i need to|i want to|i should|i must)\b/i, // action intent, not conclusion
	/^[\s\S]{0,2}$/u // too short
];

/**
 * Correction/retraction signals.  These mark the single most valuable content a
 * reasoning chain can hold: the model realising its earlier idea was wrong.  An
 * anchor that preserves "X was wrong, use Y instead" is exactly what stops the
 * next phase from re-deriving the discarded idea.
 */
const CORRECTION_PATTERNS = [
	/其实/, /实际上/, /等等/, /不对/, /错了/, /搞错/, /误(解|判|以为)/, /修正/, /推翻/, /并非/,
	/\bactually\b/i, /\bwait\b/i, /\bcorrection\b/i, /\bwas wrong\b/i, /\bmistaken\b/i, /\brevert\b/i
];

/**
 * Concrete-content signals.  A sentence naming a file, path, line number,
 * identifier or quantity is almost always usable regardless of how it opens —
 * this is what makes the extractor work on models that state things plainly
 * instead of writing "therefore".
 */
const DENSITY_PATTERNS = [
	/`[^`]+`/, // inline code
	/[\w.-]+\.(?:js|ts|mjs|cjs|jsx|tsx|json|md|yml|yaml|m|py|css|html)\b/i, // file name
	/[\w.-]+[\\/][\w.-]+/, // path
	/(?:line|第)\s*\d+/i, // line reference
	/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/, // dotted identifier
	/\d/ // any quantity
];

/** Hedging that marks a sentence as provisional rather than settled. */
const HEDGE_PATTERNS = [
	/\b(?:maybe|perhaps|possibly|might|could|unsure|not sure|probably)\b/i,
	/也许/, /或许/, /可能/, /不确定/, /大概/
];

/** Score contributed by an explicit conclusion marker; clears the tier on its own. */
const OPENER_TIER_SCORE = 100;
/**
 * Historic numeric floor for fallback-tier admission, superseded by
 * `hasContentSignal` (admission now requires a concrete content signal, not a
 * raw score).  Kept as documentation of the tier's original tuning; the
 * position bonus inside `scoreSentence` still contributes to ranking within
 * both tiers but can no longer admit a sentence on its own.
 */
const FALLBACK_TIER_SCORE = 8;
/**
 * Minimum length for a fallback-tier sentence.  Short lead-ins ("先看了两处代码。")
 * carry no conclusion value and are excluded regardless of position.
 */
const FALLBACK_MIN_CHARS = 12;

/**
 * Conclusion-predicate signals: a sentence that names WHAT the conclusion is
 * ("根因是…", "改法是…", "The fix is…") carries concrete content even when it
 * mentions no file, path or number.  Kept tighter than bare modal verbs
 * ("需要/应该") so an action-intent lead-in like "我需要确认一下参数" stays out
 * of the fallback tier.
 */
const CONCLUSION_PREDICATE_PATTERNS = [
	/根因(是|为)/, /原因(是|为)/, /问题(是|在于)/, /改法(是|为)/,
	/修复(是|为|方式|办法)/, /解决(办法|方式是|方法)/, /做法(是|为)/,
	/方案(是|为)/, /关键(是|在于)/, /核心(是|在于)/, /症结(是|在于)/,
	/结论(是|为)/, /要点(是|为)/, /之所以/,
	/\bthe (fix|issue|root cause|problem|solution|key|point) is\b/i,
	/\bthis is because\b/i, /\bthe reason is\b/i, /\bthat'?s why\b/i,
	/\bit boils down to\b/i
];

/**
 * Whether a sentence reads as throwaway rather than a settled conclusion.
 * Fallback-tier admission requires BOTH a content signal and NOT a weak
 * sentence, so a churning "Actually, let me just re-run first." (correction
 * word + action intent) stays out while a true "Actually, the issue is X."
 * gets in.
 * @param {string} sentence
 * @returns {boolean}
 */
function isWeakSentence(sentence) {
	return WEAK_SENTENCE_PATTERNS.some((pattern) => pattern.test(sentence));
}

/**
 * Whether a sentence carries a concrete content signal beyond its position.
 * Fallback-tier admission requires this, so a trailing "我先把思路记下来。" that
 * merely scores its position bonus can never be mistaken for a conclusion.
 * Position is a ranking hint inside a tier, never an admission signal.
 * @param {string} sentence
 * @returns {boolean}
 */
function hasContentSignal(sentence) {
	if (CORRECTION_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
	if (CONCLUSION_PREDICATE_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
	for (const pattern of DENSITY_PATTERNS) {
		if (pattern.test(sentence)) return true;
	}
	return false;
}

/**
 * Score one sentence as a candidate conclusion.  Explicit discourse markers
 * dominate by design: they clear `OPENER_TIER_SCORE` alone, so the softer
 * features below can only reorder candidates inside a tier and can never move a
 * sentence between tiers by accident.
 * @param {string} sentence
 * @param {number} index - position within the reasoning text.
 * @param {number} total - total sentence count.
 * @returns {number}
 */
function scoreSentence(sentence, index, total) {
	let score = 0;
	if (CONCLUSION_OPENERS.some((pattern) => pattern.test(sentence))) score += OPENER_TIER_SCORE;
	if (CORRECTION_PATTERNS.some((pattern) => pattern.test(sentence))) score += 30;

	let density = 0;
	for (const pattern of DENSITY_PATTERNS) {
		if (pattern.test(sentence)) density += 1;
	}
	score += Math.min(density, 4) * 8;

	// Later sentences are likelier to hold the settled conclusion.
	score += total > 1 ? Math.round((index / (total - 1)) * 15) : 15;

	if (HEDGE_PATTERNS.some((pattern) => pattern.test(sentence))) score -= 25;
	if (WEAK_SENTENCE_PATTERNS.some((pattern) => pattern.test(sentence))) score -= 40;
	return score;
}

/**
 * Extract the most valuable conclusion sentences from a reasoning block.
 *
 * Tiered selection rather than a single keyword gate:
 *  - Tier 1 — sentences opening with an explicit marker ("所以…", "therefore…").
 *    When any exist they are the only candidates, which keeps the long-standing
 *    behavior (and its tests) stable.
 *  - Tier 2 — when NO marker exists anywhere, fall back to the highest-scoring
 *    declarative sentences instead of returning nothing.  This is the case the
 *    old keyword-only gate silently dropped: a model that simply states
 *    "根因是 CSS 覆盖了定位" without any discourse marker.
 * @param {string} reasoning - full reasoning text.
 * @param {number} minReasoningChars - skip entirely when reasoning is shorter.
 * @param {number} maxPoints - max conclusions to keep.
 * @param {number} maxPointChars - cap per point.
 * @returns {string[]}
 */
function extractConclusions(reasoning, minReasoningChars, maxPoints, maxPointChars) {
	if (typeof reasoning !== "string" || reasoning.length < minReasoningChars) return [];

	const sentences = splitSentences(reasoning);
	if (sentences.length === 0) return [];

	const scored = sentences.map((text, index) => ({
		text,
		index,
		score: scoreSentence(text, index, sentences.length)
	}));

	let pool = scored.filter((item) => item.score >= OPENER_TIER_SCORE);
	if (pool.length === 0) {
		pool = scored.filter((item) => item.text.length >= FALLBACK_MIN_CHARS && hasContentSignal(item.text) && !isWeakSentence(item.text));
	}
	if (pool.length === 0) return [];

	pool.sort((a, b) => b.score - a.score || b.index - a.index);

	const picked = [];
	const seen = new Set();
	for (const item of pool) {
		if (picked.length >= maxPoints) break;
		const key = item.text.slice(0, 40).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		picked.push(item);
	}

	// Restore reading order so the rendered anchor reads like the original.
	picked.sort((a, b) => a.index - b.index);
	return picked.map((item) => item.text.length > maxPointChars
		? `${item.text.slice(0, maxPointChars).trimEnd()}…`
		: item.text);
}

/**
 * Split reasoning text into sentences on terminal punctuation, preserving the
 * sentence including its trailing stop.  Newlines and semicolons are NOT treated
 * as boundaries because reasoning often wraps clauses across lines.  A period
 * immediately following a digit is NOT a boundary either: numbered steps are
 * written as "1. ... 2. ..." and splitting there truncates a conclusion at its
 * first list item (the same rule also keeps decimals like "3.14" intact).
 * A period (or Chinese stop) whose next token is another numbered item
 * ("do x. 2. do y." / "参数。 2. 再执行") is kept as well, so a step body
 * ending in a stop does not split the list.  Recognized numbering marks are
 * ".", "、" and ")".
 * An ASCII period is a boundary ONLY when followed by whitespace or the end
 * of the text: a period glued to the next word character belongs to code or
 * a dotted identifier ("card.openCard", "file.js", "obj.method"), never a
 * sentence stop, so splitting there truncated conclusions mid-token.
 * A period that is itself adjacent to another period is NEVER a boundary: a
 * run of periods is an ellipsis ("(j1,k1),(j2,k1),...,(jL,k1)") or a dotted
 * leader, and treating the last dot as a sentence stop truncated enumerations
 * at the "..." and dropped everything after it.
 * @param {string} text - raw reasoning text.
 * @returns {string[]} sentences, trimmed, blanks removed.
 */
function splitSentences(text) {
	const raw = text
		.replace(/\n+/g, " ")
		.split(/(?<=[。！？!?](?!\s*\d+[.、)])|(?<![\d.])\.(?!\.)(?!\s*\d+[.、)])(?=\s|$))\s*/u);
	return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Build the anchor body from conclusions.
 * @param {string[]} points
 * @param {boolean} [softCut] - use the mid-stream continuation wording.
 * @returns {string|null} rendered anchor text, or null when empty.
 */
function renderAnchor(points, softCut = false) {
	if (points.length === 0) return null;
	const lines = points.map((p, i) => `${i + 1}. ${p}`).join("\n");
	if (softCut) {
		return `COT anchor — conclusions established above, before this continuation. Do not re-derive them; build on them and continue:\n${lines}`;
	}
	return `COT anchor — conclusions established before the last tool call. Do not re-derive these; build on them:\n${lines}`;
}

/**
 * Gate for the transition soft-cut: at least one settled conclusion marked by
 * an EXPLICIT conclusion opener ("所以/因此/综上/therefore …") must already
 * exist before the transition phrase.
 *
 * Why Tier-1 only: the transition cut means "phase A reached conclusions, the
 * model is now starting phase B — split and anchor".  Allowing the Tier-2
 * fallback (any declarative sentence carrying a file name / backtick / number
 * counts as a "conclusion") made the gate fire on ordinary technical reasoning
 * — such prose almost always contains those density signals, so a cut landed
 * at 5–10 % of the generation with nothing actually settled.  Tier-2 fallback
 * stays available for the post-execute anchor, where erring toward reminding
 * is cheap; the mid-stream cut is destructive and must stay conservative.
 * @param {string} reasoning
 * @param {number} minReasoningChars
 * @returns {boolean}
 */
function hasExplicitConclusion(reasoning, minReasoningChars) {
	if (typeof reasoning !== "string" || reasoning.length < minReasoningChars) return false;
	return splitSentences(reasoning).some((sentence) =>
		CONCLUSION_OPENERS.some((pattern) => pattern.test(sentence))
	);
}

/**
 * Walk the surface backwards for the most recent assistant message's reasoning.
 * @param {object} session
 * @returns {string} joined reasoning text, or "" when none.
 */
function latestReasoningText(session) {
	const nodes = session.surface?.nodes;
	if (!nodes || nodes.length === 0) return "";

	for (let i = nodes.length - 1; i >= 0; i--) {
		const event = session.eventAt(nodes[i]);
		if (!event || event.type !== "assistant/message") continue;
		const blocks = event.data?.message?.content;
		if (!Array.isArray(blocks)) continue;
		const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => b.text || "").join("\n");
		return reasoning;
	}
	return "";
}

/**
 * Walk the surface backwards for the most recent assistant message's thinking
 * content as an anchor source, DECRADING to the text block when no reasoning
 * block exists.
 *
 * Rationale (2026-10-03): with the current model, roughly 80% of assistant
 * messages carry NO reasoning block — the model streams its thinking directly
 * into the text block.  Anchor extraction that only reads `type==="reasoning"`
 * therefore returns empty in most turns and cot-anchor silently stops
 * reminding.  This fallback feeds the SAME scoring/extraction pipeline (which
 * already filters weak sentences via isWeakSentence / hasContentSignal), so
 * extracting "settled conclusions" from a text block is semantically safe: a
 * conclusion reached in text is just as established as one reached in
 * reasoning.  Prefer reasoning when present (stable long-standing behavior);
 * text is used only as a fallback so the reminder mechanism keeps working on
 * reasoning-less turns.
 * @param {object} session
 * @returns {string} joined thinking text (reasoning preferred, else text), or "" when none.
 */
function latestThinkingText(session) {
	const nodes = session.surface?.nodes;
	if (!nodes || nodes.length === 0) return "";

	for (let i = nodes.length - 1; i >= 0; i--) {
		const event = session.eventAt(nodes[i]);
		if (!event || event.type !== "assistant/message") continue;
		const blocks = event.data?.message?.content;
		if (!Array.isArray(blocks)) continue;
		const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => b.text || "").join("\n");
		if (reasoning.length > 0) return reasoning;
		const text = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
		if (text.length > 0) return text;
	}
	return "";
}

/**
 * Walk the surface backwards for the most recent assistant message's
 * provider/model, used as the LLM-refinement fallback route.
 * @param {object} session
 * @returns {{provider?:string, model?:string}|null}
 */
function latestAssistantSource(session) {
	const nodes = session.surface?.nodes;
	if (!nodes || nodes.length === 0) return null;

	for (let i = nodes.length - 1; i >= 0; i--) {
		const event = session.eventAt(nodes[i]);
		if (!event || event.type !== "assistant/message") continue;
		const source = event.data?.message?.source;
		if (source && (source.provider || source.model)) {
			return { provider: source.provider, model: source.model };
		}
	}
	return null;
}

/**
 * Deep-freeze a plain object so inbox mutation can never alias or double-commit
 * the same anchor under a shared reference.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return Object.freeze(value);
}

/**
 * Build one anchor context entry: stable unique id + deep-frozen, matching the
 * official repeat-tool-reminder notice shape.
 * @param {string} text
 * @param {string} summary
 */
function buildAnchorContext(text, summary) {
	return deepFreeze(structuredClone({
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: {
			...PLUGIN_SOURCE,
			form: "notice",
			summary
		}
	}));
}

/**
 * Transition sentences that mark the START of a new reasoning phase inside a
 * single generation ("long think A → I will now… → long think B").  These are
 * the soft-cut triggers: when the model emits one just after already reaching
 * conclusions, the loop should split here and inject an anchor so phase B does
 * not re-derive phase A's conclusions.  Kept deliberately as a small tail scan:
 * the trigger must appear in the most recent tail of the generated text.
 */
const TRANSITION_PATTERNS = [
	/(^|[\n。！？!?.;；])\s*接下来(我|我们)?(要|将|准备|先)?/u,
	/(^|[\n。！？!?.;；])\s*下一步(我|我们)?(要|将|会|先|打算)?/u,
	/(^|[\n。！？!?.;；])\s*下面(我|我们)?(要|将|开始|先)?/u,
	/(^|[\n。！？!?.;；])\s*现在(我|我们)?(开始|来|先|准备)?/u,
	/(^|[\n。！？!?.;；])\s*那我就(先|开始|直接)?/u,
	/(^|[\n。！？!?.;；])\s*那么(我|我们就)?(先|开始|直接)/u,
	/(^|[\n。！？!?.;；])\s*我先/u,
	/(^|[\s.。;；])\b(now|next|then)\b[, ]?\s+(i|let'?s|i'?ll|i will|i am going to)\b/i,
	// 裸 "let me"（let me check/read/verify 这类普通工作短语）不是阶段转折，
	// 曾在真实英文推理中造成大量提前软切断；只有显式宣布进入新阶段时才算转折，
	// 与中文侧要求"接下来/下一步/现在开始"的口径对齐。
	/(^|[\s.。;；])\blet\s+me\s+(now|start|begin|move on|proceed|go ahead)\b/i,
	/(^|[\s.。;；])\bi\s+(will|am going to|'ll)\s+now\b/i
];

/**
 * Decide whether the current generation prefix should be soft-cut so an anchor
 * can be injected before the next reasoning phase.  Requires BOTH enough prior
 * text (real conclusions already reified) AND a transition sentence near the
 * newest tail, AND that the transition has actually started to unfold.
 *
 * The unfold rule exists because soft-cut is consulted mid-stream (every
 * ~32 new chars): the moment the model emits "我先" the transition pattern
 * fires, but the thought has barely begun.  Cutting there truncates the
 * generation at the transition's first two characters, and the conclusion
 * extractor then has to work with a broken tail ("所以步骤： 1. 先") — the
 * exact corrupt anchor observed in production logs.  So we require enough
 * FOLLOW-ON content after the transition word before cutting.
 *
 * The threshold is deliberately NOT terminal punctuation: streaming output may
 * end a sentence with a right paren, a quote, a code fence, or simply not have
 * produced the full stop yet — none of those mean the model is stuck at the
 * transition word.
 * @param {string} fullVisibleText - all visible text (text + reasoning) generated so far.
 * @param {number} minReasoningChars - minimum length before which soft-cut is never triggered.
 * @returns {boolean}
 */
function wantsSoftCut(fullVisibleText, minReasoningChars) {
	if (typeof fullVisibleText !== "string" || fullVisibleText.length < minReasoningChars) return false;
	const tail = fullVisibleText.slice(-SOFT_CUT_SCAN_TAIL);

	// Locate the LAST transition match and its end offset within the tail.
	// Patterns carry no /g flag, so loop with a global copy to walk all matches.
	let transitionEnd = -1;
	for (const pattern of TRANSITION_PATTERNS) {
		const globalPattern = new RegExp(pattern.source, `${pattern.flags.includes("g") ? "" : "g"}${pattern.flags.includes("i") ? "i" : ""}${pattern.flags.includes("u") ? "u" : ""}`);
		let match;
		while ((match = globalPattern.exec(tail)) !== null) {
			transitionEnd = Math.max(transitionEnd, match.index + match[0].length);
		}
	}
	if (transitionEnd < 0) return false;

	// A transition that is only a connective cascade mid-sentence is not a cut.
	if (CASCADING_PATTERNS.some((pattern) => pattern.test(tail))) return false;

	// The transition must have started to unfold: enough characters after the
	// transition word, so a bare "我先" (2 chars) never triggers a cut.
	const followLen = tail.length - transitionEnd;
	if (followLen < SOFT_CUT_MIN_FOLLOW_CHARS) return false;

	// The transition must be an EXECUTION announcement, not an ongoing
	// investigation.  A transition whose leading action is investigative
	// ("我先读一下 X", "next i will check the call chain") is the model still
	// researching — cutting there severs ordinary continuing text.  Only an
	// execution announcement (write/edit/refactor/run/…) is the phase-B cut
	// this detector targets.
	if (transitionLeadsToInvestigation(tail.slice(transitionEnd)) ) return false;

	// The transition must be in the LAST sentence-ish chunk, not buried mid-answer.
	const lastBreak = Math.max(tail.lastIndexOf("。"), tail.lastIndexOf("！"), tail.lastIndexOf("？"), tail.lastIndexOf("\n"), tail.lastIndexOf("."), tail.lastIndexOf(";"), tail.lastIndexOf("；"));
	if (lastBreak >= 0 && tail.slice(lastBreak + 1).length > SOFT_CUT_TRANSITION_WINDOW) return false;
	return true;
}

let SOFT_CUT_SCAN_TAIL = 160;
let SOFT_CUT_TRANSITION_WINDOW = 48;
/**
 * Minimum characters AFTER the transition word before a soft-cut is allowed.
 * "我先" alone (2 chars) means the thought just started — cut nothing.  A real
 * follow-on like "我先看一下配置" (7) or longer means the transition is
 * unfolding and the cut lands on a boundary the extractor can handle.
 */
let SOFT_CUT_MIN_FOLLOW_CHARS = 6;

/**
 * Cascading conjunctions that introduce a transition WITHOUT starting a new
 * phase ("…, and now i will…", "so now let's reduce the formula case").  These
 * are continuation/connective phrases, not the "conclusions reached, move to
 * execution" cut the plugin targets.  When a transition is fronted by one of
 * these conjunctions the cut is skipped.
 */
const CASCADING_PATTERNS = [
	/(^|[，,\s])(?:and|so|but|because)\s+(?:now|next|then)\b/i,
	/(^|[，,\s])(?:and|so|but|because)\s+(?:let'?s|let\s+me)\b/i,
	/(^|[，,\s])(?:and|so|but|because)\s+i\s+(?:will|'ll|am\s+going\s+to)\b/i
];

/**
 * Tokens that can LEAD a transition announcement; stripped from the follow text
 * before testing whether the leading action is investigative.
 */
const INVESTIGATIVE_TRANSITION_PREFIXES = ["我先", "接下来我", "接下来", "下一步我", "下一步", "下面我", "下面", "现在开始", "现在就", "然后我", "然后", "我接下来", "那就先", "先将"];

/**
 * Single-character investigative verbs (Chinese) and their 2-char look-ahead
 * steps.  A transition whose leading action is one of these ("我先读…", "下一步我看…")
 * is the model STILL researching — cut is skipped.  Execution verbs (改/写/删/
 * 生成/落地/替换/调用/跑/更新/加/建) are intentionally absent.
 */
const INVESTIGATIVE_CJK_VERB_CHARS = ["读", "看", "查", "审", "核", "找", "搜", "翻", "查证", "确认", "验证", "确认一下"];

/**
 * True when the text right after a transition word leads with an investigative
 * (research/verify) action rather than an execution one.  Used to stop the
 * transition soft-cut from severing ordinary continuing-research text.
 *
 * The predicate is deliberately structural, not regex-heavy: a CJK verb char
 * has no word boundary (`\b`), so we strip any leading transition prefix and
 * test the first actionable token against a small verb set.  "我先读…" reads
 * "我先" (prefix) + "读" (verb) -> investigative -> skip cut.
 * @param {string} followText - the characters after the transition word.
 * @returns {boolean}
 */
function transitionLeadsToInvestigation(followText) {
	if (typeof followText !== "string") return false;
	let rest = followText.trimStart();
	for (const p of INVESTIGATIVE_TRANSITION_PREFIXES) {
		if (rest.startsWith(p)) { rest = rest.slice(p.length).trimStart(); break; }
	}
	// Leading execution announcement (English) never counts as investigation.
	if (/^(?:write|edit|rewrite|refactor|delete|replace|deploy|implement|update|build|run|create|add|make|fix|move|open)\b/i.test(rest)) return false;
	if (/^(?:(?:i|let'?s|we|you)\s+)?(?:read|look at|check|verify|confirm|review|inspect|search|find|examine|look up|go through|re-read)\b/i.test(rest)) return true;
	// English leading execution verb neither investigative (handled above).
	// CJK: peel a leading subject / modal / adverb chain ("我已/我要/我去/我再重新…")
	// then test the leading verb.  Loops because the prefix chain can be long.
	for (let guard = 0; guard < 6; guard++) {
		const before = rest;
		rest = rest.replace(/^(?:我|我们|他|她|它|咱们|就|要|去|来|想|打算|准备|先|再|重新|还|还在|又|已|已经|刚|正在|赶快|赶紧|立刻|马上|于是|然后|现在|试着|再继续|继续)\s*/, "");
		if (rest === before) break;
	}
	if (/^(?:write|edit|rewrite|refactor|delete|replace|deploy|implement|update|build|run|create|add|make|fix|move|open)\b/i.test(rest)) return false;
	const first = rest.length > 0 ? rest[0] : "";
	return INVESTIGATIVE_CJK_VERB_CHARS.includes(first);
}

/**
 * Degenerate-loop detection ("原地打转"): a weak model can emit the SAME block
 * over and over inside one generation (observed: one 587-char tool-call snippet
 * repeated 403 times ≈ 240k chars) until the output budget is gone.  This is a
 * different failure than the A→transition→B case, but it rides the same
 * soft-cut path: when a period is found, the loop is cut and an anchor is
 * injected; `trimTo` additionally tells the kernel to persist only ONE copy of
 * the repeated block instead of replaying the whole runaway tail back to the
 * model on the next request.
 *
 * Detection is deliberately windowed: the kernel consults a listener every
 * ~32 new chars, so scanning the whole prefix would be O(n²) on a 240k-char
 * runaway.  A short probe is matched inside the trailing window only, from
 * which the period is derived, then the period is verified backwards.
 */
let REPEAT_PROBE_CHARS = 128;
/** Only the trailing slice is searched — bounds each check to O(window). */
let REPEAT_WINDOW_CHARS = 16000;
/**
 * Period floor.  Deliberately low: a real observed runaway was a ~60-char cycle
 * ("OK. / Let me write. / Now. / Final. / Output. / Writing. / Go.") repeated
 * hundreds of times.  A short period is NOT evidence of normal writing — the
 * repeat COUNT is what separates a loop from ordinary emphasis (see the two
 * thresholds below).
 */
let REPEAT_MIN_PERIOD = 12;
/**
 * A tokenizer-level death loop can collapse to an even shorter period: a
 * corrupted closing tag ("</…>") repeatedly re-emitted as a stream of
 * `er4er4er4…` (period 3) is one observed instance.  Periods this short were
 * previously rejected outright (`period < REPEAT_MIN_PERIOD`), so a genuine
 * biological loop of 2–11 chars sailed past every detector even when it ran
 * for thousands of characters.  We relax that gate for ultra-short periods
 * but hold them to a MUCH higher repeat count, because 2–3 char cycles are
 * also ordinary emphasis / padding ("===", "aaaa", "-----") that only becomes
 * pathological at a pathological frequency.  Separation: a short period
 * repeated dozens of times is never normal writing.
 */
let REPEAT_ULTRA_SHORT_MIN_COUNT = 30;
/** Periods below this are held to the stricter repeat count. */
let REPEAT_SHORT_PERIOD = 96;
/** Periods longer than this are not the runaway pattern we target. */
let REPEAT_MAX_PERIOD = 8000;
/**
 * A LONG block repeated this many times is already a runaway.  Set to 2 rather
 * than 3 on purpose: repeating several hundred bytes verbatim is never normal
 * prose (quotation and summaries paraphrase), so the cheaper miss costs more
 * than the rare false cut.  Interference is further bounded by the kernel's
 * per-turn cut cap.
 */
let REPEAT_MIN_COUNT = 2;
/**
 * A SHORT cycle must repeat many more times before it counts, but still tuned
 * aggressively: ordinary prose may repeat a short phrase two or three times,
 * five identical cycles is already a stuck model.
 */
let REPEAT_MIN_COUNT_SHORT = 5;
/** Below this prefix length the detector never runs (avoids short-answer false hits). */
let REPEAT_MIN_TEXT_CHARS = 800;

/**
 * Find a degenerate repeating tail in the generated text.
 *
 * Two stages, because the kernel calls this on every ~32 new characters:
 *  1. Cheap windowed pre-filter — a short probe is matched inside the trailing
 *     window (never the full prefix), giving the period.  This rejects normal
 *     prose in O(window).
 *  2. Expensive-but-rare exact localization — only once a period is confirmed
 *     does it walk the WHOLE text.  Backward doubling jumps (1, 2, 4, 8, … full
 *     periods at a time) find the true start of the run in O(n) with a tiny
 *     constant, so a 240k-char runaway still resolves to a single kept copy.
 *     It runs at most once per cut in practice: the cut aborts the stream.
 * @param {string} fullVisibleText - all visible text (text + reasoning) so far.
 * @returns {{period:number,count:number,trimTo:number}|null} loop info, or null.
 */
function findRepeatingTail(fullVisibleText) {
	if (typeof fullVisibleText !== "string" || fullVisibleText.length < REPEAT_MIN_TEXT_CHARS) return null;
	const textLength = fullVisibleText.length;

	// --- stage 1: windowed period pre-filter ---------------------------------
	const windowStart = Math.max(0, textLength - REPEAT_WINDOW_CHARS);
	const window = fullVisibleText.slice(windowStart);
	if (window.length < REPEAT_PROBE_CHARS * 2) return null;
	const probe = window.slice(-REPEAT_PROBE_CHARS);
	const previous = window.lastIndexOf(probe, window.length - REPEAT_PROBE_CHARS - 1);
	if (previous < 0) return null;
	const period = window.length - REPEAT_PROBE_CHARS - previous;
	if (period > REPEAT_MAX_PERIOD) return null;
	// Single-char cycles ("=====", "aaaa", "\n\n\n") are ordinary emphasis or
	// padding and are never held up as a loop, so the ultra-short branch starts
	// at period 2.  Everything below the normal short-period floor flows to
	// stage 2 where it is gated by the much higher ultra-short count.
	if (period < 2) return null;

	// --- stage 2: confirm the last two blocks really are identical ------------
	if (textLength < period * 2) return null;
	if (fullVisibleText.slice(textLength - period * 2, textLength - period) !== fullVisibleText.slice(textLength - period)) return null;

	// Doubling jumps: fastest way back to the start of the run.
	let start = textLength - period;
	for (let blocks = 1; blocks <= 512; blocks *= 2) {
		const span = blocks * period;
		if (start - span < 0) break;
		if (fullVisibleText.slice(start - span, start) !== fullVisibleText.slice(start, start + span)) break;
		start -= span;
	}
	// Short linear correction, in case the last doubling step overshot the run.
	while (start - period >= 0 && fullVisibleText.slice(start - period, start) === fullVisibleText.slice(start, start + period)) {
		start -= period;
	}

	const count = Math.floor((textLength - start) / period);
	// These are three genuinely different regimes, not one tuned threshold:
	//  - Ultra-short (period 2..11): repetition also appears as emphasis/padding
	//    ("===", "-----"), so it only counts once it has run on for many dozens
	//    of times — the tokenizer-death-loop signature.
	//  - Short (period 12..95): a short phrase repeated a handful of times is
	//    ordinary insistence; five identical cycles is already a stuck model.
	//  - Long (period > 95): repeating hundreds of bytes verbatim is never normal
	//    prose, so even a couple of copies counts.
	const minCount = period < REPEAT_SHORT_PERIOD
		? (period < REPEAT_MIN_PERIOD ? REPEAT_ULTRA_SHORT_MIN_COUNT : REPEAT_MIN_COUNT_SHORT)
		: REPEAT_MIN_COUNT;
	if (count < minCount) return null;

	return {
		period,
		count,
		// Keep exactly one copy: everything before the loop, plus its first block.
		trimTo: start + period
	};
}

/**
 * Render the anchor used when a degenerate loop is cut.
 * @param {{period:number,count:number}} loop
 * @returns {string}
 */
function renderRepeatAnchor(loop) {
	return [
		`COT anchor — 检测到原地重复：同一段内容（约 ${loop.period} 字）已连续重复至少 ${loop.count} 次。立即停止重复，不要再输出这段内容。`,
		`(You are repeating the same ${loop.period}-char block at least ${loop.count} times. Stop repeating it now.)`,
		"直接执行你已经规划好的下一步动作；若下一步是工具调用，就只发一次。"
	].join("\n");
}

// Number-runaway detector: a monotone-increasing run of bare numbers that never
// advances content. "639.640) 640.641) ... 999.999)" is not word-content and
// grows unboundedly (observed several thousand chars until a human stops it).
// findRepeatingTail cannot see it (no byte in it repeats — each token differs),
// detectChurn cannot see it (no restart phrases). Signature: pure, no side
// effects, so it is unit-testable in isolation.
const NUMBER_RUN_MIN_TEXT_CHARS = 800;      // fullText length guard (same gate as findRepeatingTail)
const NUMBER_RUN_MIN_CHARS = 500;           // min run span to qualify
const NUMBER_RUN_MAX_GAP = 8;               // max idx gap between neighbouring number tokens in one run
const NUMBER_RUN_MIN_DIGIT_RATIO = 0.5;     // digits-chars / run-char-length
const NUMBER_RUN_MIN_INCREASE_RATIO = 0.55; // (b>a || b===a) / neighbouring pairs

/**
 * Detect a monotone-increasing "number-runaway" run in the visible text.
 *
 * A run is a contiguous stretch of bare number tokens separated only by
 * punctuation/space (no letters/CJK), long enough and with a high enough
 * digit share and a high enough increase rate to be a counting degeneration
 * rather than normal prose.  Thresholds are tuned for a real positive sample
 * (a Doubao trace whose reasoning tail ran "639.640) 640.641) …" for ~7000
 * chars, stopping only when the user interrupted).
 *
 * @param {string} fullVisibleText reasoning+tail concatenated visible text.
 * @returns {{chars:number,digitRatio:number,increaseRatio:number,trimTo:number}|null}
 *     hit info (trimTo = run start) or null when nothing qualifies.
 */
function detectNumberRunaway(fullVisibleText) {
	if (typeof fullVisibleText !== "string" || fullVisibleText.length < NUMBER_RUN_MIN_TEXT_CHARS) return null;
	const DIGIT_RE = /\b\d{1,4}\b/g;
	const toks = [];
	let m;
	while ((m = DIGIT_RE.exec(fullVisibleText)) !== null) {
		toks.push({ v: Number(m[0]), idx: m.index });
	}
	if (toks.length < 2) return null;
	// group consecutive tokens into runs; a new run starts whenever the gap is
	// too wide or a letter/CJK sits between the two tokens.
	const runs = [];
	let cur = [toks[0]];
	for (let i = 1; i < toks.length; i++) {
		const prevTok = toks[i - 1], nowTok = toks[i];
		const gap = nowTok.idx - (prevTok.idx + String(prevTok.v).length);
		if (gap <= NUMBER_RUN_MAX_GAP) {
			const between = fullVisibleText.slice(prevTok.idx + String(prevTok.v).length, nowTok.idx);
			if (!/[A-Za-z\u4e00-\u9fff]/.test(between)) { cur.push(nowTok); continue; }
		}
		runs.push(cur);
		cur = [nowTok];
	}
	runs.push(cur);
	// evaluate each run
	for (const run of runs) {
		if (run.length < 2) continue;
		const runStart = run[0].idx;
		const lastTok = run[run.length - 1];
		const runEnd = lastTok.idx + String(lastTok.v).length;
		const span = runEnd - runStart;
		if (span < NUMBER_RUN_MIN_CHARS) continue;
		let digitChars = 0;
		for (const t of run) digitChars += String(t.v).length;
		const digitRatio = digitChars / span;
		if (digitRatio < NUMBER_RUN_MIN_DIGIT_RATIO) continue;
		let inc = 0;
		for (let i = 1; i < run.length; i++) {
			if (run[i].v >= run[i - 1].v) inc++;
		}
		const increaseRatio = inc / (run.length - 1);
		if (increaseRatio < NUMBER_RUN_MIN_INCREASE_RATIO) continue;
		return { chars: span, digitRatio, increaseRatio, trimTo: runStart };
	}
	return null;
}

/**
 * Render the anchor used when a number-runaway run is cut.
 * @param {{chars:number}} nr
 * @returns {string}
 */
function renderNumberRunawayAnchor(nr) {
	return [
		`COT anchor — 检测到数字递增流退化：你已连续输出约 ${nr.chars} 字符的递增数字流，而没有推进任何内容。立即停止数数，不要再输出"序号→更大数字"的流水。`,
		"回到你退化前正在写的那句话，直接给结论或执行下一步；若下一步是工具调用，就只发一次。",
		`(You are emitting a ${nr.chars}-char monotone-increasing number stream. Stop counting; resume from the last real sentence.)`
	].join("\n");
}

/**
 * Text spellings that a model invents for tool calls.  DSH has no parser for
 * any of these: a tool call only exists as a structured tool-call block
 * produced from the provider's native `tool_calls` field.  Text like
 * `<seed:tool_call><function name="edit">…` is therefore just prose — it is
 * never dispatched, the model sees no result, and a weak model can retry it
 * until the whole output budget is gone (observed: 403 identical copies).
 * Detecting it lets the plugin cut the attempt and explain the format instead
 * of merely asking the model to stop repeating.
 *
 * DETECTION IS PAIRED ON PURPOSE.  A single tag on its own is ambiguous — the
 * model may be DISCUSSING the format ("如果模型输出了 <seed:tool_call> 这种
 * 文本…") rather than attempting it, and cutting that analysis is a false
 * positive that derails a normal train of thought (observed in production:
 * a plain mention triggered the soft-cut three times in a row).  The strong
 * forms are unambiguous because they are complete call-shaped blocks; the weak
 * forms only count when a SECOND structural tag appears alongside, which prose
 * about the format does not produce.
 */
/**
 * Unambiguous: a COMPLETE call-shaped block (opener plus closer).  Bare
 * openers used to match when the model merely rehearses or quotes a call
 * inside reasoning/prose — the kernel concatenates text and reasoning into
 * one stream, so the channel cannot disambiguate; an unclosed draft followed
 * by the genuine structured call produced a false cut.  Requiring the closer
 * keeps this set to finished blocks; an opener-only runaway is still caught
 * by the repetition detector, and the weak path requires a closer too.
 */
const PSEUDO_STRONG_PATTERNS = [
	/<seed:tool_call>\s*<function\s+name\s*=[\s\S]{0,1200}?<\/function>\s*<\/seed:tool_call>/i,
	/<seed:call>\s*<function\s+name\s*=[\s\S]{0,1200}?<\/function>\s*<\/seed:call>/i,
	/<seed:tool_call>\s*<function\s+name\s*=[\s\S]{0,1200}?<\/seed:tool_call>/i,
	/<seed:call>\s*<function\s+name\s*=[\s\S]{0,1200}?<\/seed:call>/i,
	/<tool_call>\s*[^\n]{0,300}<\/tool_call>/i,
	/<\|tool[▁_]?calls?[▁_]?begin\|>[\s\S]{0,400}<\|tool[▁_]?calls?[▁_]?end\|>/i,
	/antml:invoke\s*<\s*function[\s\S]{0,1200}?<\/antml:invoke>/i,
	/antml:invoke\s+name\s*=[\s\S]{0,1200}?<\/antml:invoke>/i
];
/** Ambiguous alone: only counts when another structural tag co-occurs. */
const PSEUDO_WEAK_PATTERNS = [
	/<seed:tool_call>/i,
	/<seed:call>/i,
	/<tool_call>/i,
	/<tool_use>/i,
	/<tool_calls>/i,
	/<\|tool[▁_]?calls?[▁_]?begin\|>/i
];
/** Co-occurrence form: a function tag WITH parameter tags is a call attempt, not prose about one. */
const PSEUDO_FUNCTION_TAG = /<function\s+name\s*=/i;
const PSEUDO_PARAMETER_TAG = /<parameter\s+name\s*=/i;
/**
 * Closing structures proving the text-spelled block was actually FINISHED.
 * Required on the weak/co-occurrence path as well: an opener plus a function
 * or parameter tag also appears while the model rehearses an upcoming call in
 * its reasoning (the real structured call then follows and works), which must
 * not be cut.  An opener-only runaway without a closer is still stopped by the
 * repetition detector instead.
 */
const PSEUDO_CLOSER_PATTERNS = [
	/<\/seed:tool_call>/i,
	/<\/seed:call>/i,
	/<\/tool_call>/i,
	/<\|tool[▁_]?calls?[▁_]?end\|>/i,
	/<\/antml:invoke>/i,
	/<\/function>/i
];
/** How much of the tail to scan for a call attempt (the observed block was 587 chars). */
let PSEUDO_TOOL_SCAN_TAIL = 4000;

/**
 * Decide whether the generated tail contains a FINISHED text-spelled tool call
 * attempt (as opposed to a mere mention of the format, or an unclosed draft in
 * reasoning).  Strong complete blocks count alone; weak single tags require
 * both a second structural tag and a closing structure.
 * @param {string} fullVisibleText - all visible text (text + reasoning) so far.
 * @returns {boolean}
 */
function hasPseudoToolCall(fullVisibleText) {
	if (typeof fullVisibleText !== "string" || fullVisibleText.length === 0) return false;
	const tail = fullVisibleText.slice(-PSEUDO_TOOL_SCAN_TAIL);
	if (PSEUDO_STRONG_PATTERNS.some((pattern) => pattern.test(tail))) return true;
	const weakHits = PSEUDO_WEAK_PATTERNS.filter((pattern) => pattern.test(tail)).length;
	const functionTag = PSEUDO_FUNCTION_TAG.test(tail);
	const parameterTag = PSEUDO_PARAMETER_TAG.test(tail);
	const hasCloser = PSEUDO_CLOSER_PATTERNS.some((pattern) => pattern.test(tail));
	// Without a closing structure the block is either prose about the format or
	// an in-progress rehearsal — both must be left alone.
	if (!hasCloser) return false;
	return (weakHits >= 1 && (functionTag || parameterTag))
		|| (functionTag && parameterTag);
}

/**
 * Render the anchor that corrects an unrecognized tool call.
 * Deliberately does NOT quote the raw tag spellings (e.g. the seed-style
 * call tag): the anchor text itself becomes part of the visible text, and
 * spelling the trigger verbatim would re-trigger the detector on the very
 * next soft-cut check — a self-sustaining loop observed in production.
 * @param {boolean} alsoLooping - whether the same attempt was also repeating.
 * @param {{count:number}|null} loop - loop details when `alsoLooping`.
 * @returns {string}
 */
function renderPseudoToolAnchor(alsoLooping, loop) {
	const lines = [
		"COT anchor — 你刚才输出的工具调用是**文本**形式，系统不会识别、也不会执行它。",
		"不要再写尖括号拼出来的调用标签（比如 seed 风格或 function/parameter 标签）；它们只是普通文字。",
		"请直接发起工具调用（使用工具调用能力本身），一次就够，不要重复输出同一段内容。",
		"若确实无法发起工具调用，就用一句话说明你需要什么，不要再贴工具调用的文本。"
	];
	if (alsoLooping && loop) {
		lines.push(`（该无效调用已被识别为重复 ${loop.count} 次，重复部分已丢弃。）`);
	}
	lines.push("(Your tool call was written as plain text, so the Harness never executed it. Emit a real tool call instead — once.)");
	return lines.join("\n");
}

/**
 * "Churn" phrases: restart/transition words a stuck model emits over and over
 * while re-analyzing the SAME problem from scratch in slightly different words
 * ("Let me…", "Hmm.", "Wait. Actually, let me reconsider…").
 *
 * The periodic-loop detector cannot see this: nothing is byte-identical, so
 * there is no period to find.  But the restart words themselves recur at a
 * pathological rate.  The observed sample (another runaway) contained
 * "Let me" 638 times in 61k chars — roughly once every 95 characters, which
 * normal prose never approaches.  Counting only high-signal restart phrases
 * keeps the false-positive rate low: common words such as "ok", "now" or
 * "wait" are deliberately NOT counted.
 */
let CHURN_PHRASES = [
	/\blet me\b/gi,
	/\bhmm+\b/gi,
	/\breconsider\b/gi,
	/\bre-?read\b/gi,
	/\bi need to\b/gi,
	/让我(再|重新|先)?(想想|想一下|理一下|重新)/g,
	/再重新(看|想|分析)/g
];
/** Only the trailing slice is counted — the same window bound as the loop detector. */
let CHURN_WINDOW_CHARS = 3000;
/**
 * Hits required inside that window.  Tuned aggressively but NOT to the extreme:
 * this is the only heuristic trigger (the others detect content that is literally
 * pathological), and a hard problem legitimately restarts analysis several times.
 * Real data: the observed runaway scored 41–42 per window; ordinary technical
 * prose scores ~2.  18 ≈ one restart phrase every 165 chars leaves a wide margin
 * below the runaway while still firing earlier than the original 25.
 */
let CHURN_MIN_HITS = 18;
/** Churn is only meaningful in an already long generation (lowered to fire sooner). */
let CHURN_MIN_TEXT_CHARS = 800;

/**
 * Count restart-phrase hits in the trailing window.
 * @param {string} fullVisibleText
 * @returns {number}
 */
function countChurnHits(fullVisibleText, phrases) {
	const tail = fullVisibleText.slice(-CHURN_WINDOW_CHARS);
	const list = Array.isArray(phrases) ? phrases : effectiveChurnPhrases();
	let hits = 0;
	for (const pattern of list) {
		pattern.lastIndex = 0;
		const matched = tail.match(pattern);
		if (matched) hits += matched.length;
	}
	return hits;
}

/**
 * Decide whether the model is churning — repeatedly restarting its analysis
 * without advancing — rather than writing distinct content.
 * @param {string} fullVisibleText
 * @returns {{hits:number}|null}
 */
function detectChurn(fullVisibleText) {
	if (typeof fullVisibleText !== "string" || fullVisibleText.length < CHURN_MIN_TEXT_CHARS) return null;
	const hits = countChurnHits(fullVisibleText);
	if (hits < effectiveChurnMinHits()) return null;
	return { hits };
}

/**
 * Render the anchor that breaks a churn loop.
 * @param {{hits:number}} churn
 * @returns {string}
 */
function renderChurnAnchor(churn) {
	return [
		`COT anchor — 你正在原地空转：最近约 ${CHURN_WINDOW_CHARS} 字里出现了 ${churn.hits} 次"让我想想/重新分析"这类重启用语，说明你在反复重新分析同一个问题而没有推进。`,
		"立即停止重新分析。不要再复述已知信息、不要重新检查已经确认过的结论。",
		"直接给出当前结论，或执行你已经决定的下一步；只输出你尚未说过的内容。",
		`(You are churning: ${churn.hits} restart phrases in the last ~${CHURN_WINDOW_CHARS} chars. Stop re-analyzing; emit only what you have not said yet, then act.)`
	].join("\n");
}

/**
 * True when the tail sits inside an unclosed fenced code block.  Cutting there
 * would persist a half-written code block and ask the model to continue from
 * the middle of it, which is worse than the churn we were trying to stop.
 * Only the HEURISTIC trigger backs off here: exact repetition and an invalid
 * tool call are garbage regardless of where they appear, so they still cut.
 * @param {string} fullVisibleText
 * @returns {boolean}
 */
function insideUnclosedCodeFence(fullVisibleText) {
	const tail = fullVisibleText.slice(-4000);
	const fences = tail.match(/```/g);
	return fences !== null && fences.length % 2 === 1;
}

// ---------------------------------------------------------------------------
// COT harvest — silent sampling (L1), LLM pattern mining (L2), learned overlay (L3)
// ---------------------------------------------------------------------------
//
// Three layers, each independently switchable and independently failable:
//   L1 Harvest  `session/event` observer -> samples.jsonl   (off by default)
//   L2 Analyze  batched `llm.stream`     -> proposals.json  (manual trigger)
//   L3 Apply    explicit user approval   -> patterns.json   (runtime overlay)
//
// Hard safety rules (docs/cot-harvest-design.md §5.2):
//  - The model NEVER writes a regex.  It emits a `featureSpec` of literals; a
//    fixed template escapes every metacharacter and caps the length, so the
//    compiled matcher is a plain literal with no quantifier at all and
//    catastrophic backtracking is structurally impossible.
//  - A learned pattern starts in `shadow` mode: it counts would-be cuts but
//    does not actually cut until the user promotes it.
//  - With `enableHarvest` off the observer returns on its first line, and with
//    an empty patterns.json every detector behaves byte-for-byte as before.
//
// Nothing in this section touches the filesystem at module scope: the unit
// tests strip this module's import/export lines, so any module-scope fs call
// would break them.

/** Plugin storage subdirectory holding every harvest artifact. */
const HARVEST_DIR_NAME = "cot-anchor";
/** Append-only JSONL log of collected samples. */
const HARVEST_SAMPLES_FILE = "samples.jsonl";
/** Pending candidate list produced by the analysis layer. */
const HARVEST_PROPOSALS_FILE = "proposals.json";
/** Adopted overlay the detectors merge at runtime. */
const HARVEST_PATTERNS_FILE = "patterns.json";
/** Subdirectory for exported "harvest request" reports. */
const HARVEST_REPORTS_DIR = "reports";
/** Route the client drives the harvest pipeline through. */
const HARVEST_ROUTE = "/plugins/cot-anchor/harvest";
/** Purpose tag of the analysis call; the call is deliberately session-less. */
const HARVEST_ANALYZE_PURPOSE = "cot-anchor-harvest-analyze";
/**
 * How many times one sample may fail analysis before batch selection skips it.
 * The sample stays unanalyzed and keeps its content; only selection moves on,
 * so a batch the model keeps answering badly cannot block the backlog.
 */
const HARVEST_ANALYZE_MAX_ATTEMPTS = 3;
/** Hard character cap for one learned literal (bounds the match cost). */
const LEARNED_LITERAL_MAX_CHARS = 48;
/** Maximum adopted learned patterns, enforced at approval time. */
const LEARNED_PATTERN_DEFAULT_LIMIT = 60;
/** Maximum tag-shaped candidates kept per sample. */
const TAG_CANDIDATE_LIMIT = 12;
/** Maximum characters kept per tag candidate. */
const TAG_CANDIDATE_MAX_CHARS = 48;
/** Leading characters kept verbatim in every sample. */
const SAMPLE_HEAD_CHARS = 400;
/** Trailing characters kept verbatim in every sample. */
const SAMPLE_TAIL_CHARS = 1200;
/** Evidence ids retained per candidate. */
const PROPOSAL_EVIDENCE_LIMIT = 20;
/** Confidence added each time an independent batch re-discovers a candidate. */
const PROPOSAL_CONFIDENCE_STEP = 0.05;
/** Upper bound on a candidate's confidence. */
const PROPOSAL_CONFIDENCE_MAX = 0.99;
/** Shape of a text-spelled tool call worth recording as a tag candidate. */
const TAG_CANDIDATE_PATTERN = /<[A-Za-z_][^<>\n]{0,60}>/g;
/** Detector ids a finding may target. */
const HARVEST_DETECTORS = ["churn", "repeat", "pseudoTool", "transition", "conclusion"];
/** Finding kinds the analysis layer may report. */
const HARVEST_FINDING_KINDS = ["new-pattern", "missed-by-detector", "false-positive", "threshold-too-high"];
/**
 * Threshold keys the learned overlay can actually tune at runtime.
 * `learnedThresholdShift` is only queried for these keys; any other key would
 * be written but never read, producing dead data. `churnMinHits` is the only
 * one wired today (see `effectiveChurnMinHits`).
 */
const LEARNED_TUNABLE_KEYS = ["churnMinHits"];
/**
 * Literal kinds that a learned overlay entry can actually influence.
 * `learnedPatternsFor` is only consulted on the churn path, so a literal aimed
 * at any other detector is dead data that would silently inflate the pattern
 * budget. Only churn-detector literals are adoptable.
 */
const LEARNED_LITERAL_DETECTORS = ["churn"];
/**
 * Bare single-token literals that read as ordinary prose filler on a plain
 * non-word-boundary substring match. They are rejected at approval time to
 * keep the learned phrase list aligned with the shipped philosophy: common
 * words ("ok", "now", "wait") are deliberately not counted.
 */
const LEARNED_BARE_LITERAL_BLOCKLIST = [
	"wait", "hmm", "hm", "actually", "better", "simpler", "cleaner", "ok",
	"now", "重新", "再", "等等", "权衡", "决策", "再看", "再看下", "大概"
];
/** Per-session anchor bookkeeping limit (mirrors the injection dedup bound). */
const LAST_ANCHOR_MAP_LIMIT = 32;

/**
 * Ordinary prose used to self-check a freshly compiled learned literal: a
 * literal that already matches everyday technical writing would fire on normal
 * generations, so it is rejected at approval time instead of after it has cut
 * somebody's real answer in half.
 */
const LEARNED_SELF_CHECK_CORPUS = [
	"我先读一下这个文件，确认接口定义，再决定改哪里。",
	"Let me check the configuration first and then update the handler.",
	"接下来我要修改 lib/index.js 里的检测器逻辑，并补一个单元测试。"
];

/**
 * Extract tag-shaped fragments ("<seed:tool_call>") from free text.  This is
 * the only route by which a NEW text-spelled tool-call spelling becomes
 * visible: a pattern the shipped detector cannot match still shows up verbatim
 * here, which is exactly what the analysis layer needs to see.
 * @param {string} text
 * @returns {string[]} unique candidates, capped in count and length.
 */
function collectTagCandidates(text) {
	if (typeof text !== "string" || text.length === 0) return [];
	const found = text.match(TAG_CANDIDATE_PATTERN);
	if (!found) return [];
	const unique = [];
	for (const raw of found) {
		const candidate = raw.slice(0, TAG_CANDIDATE_MAX_CHARS);
		if (unique.includes(candidate)) continue;
		unique.push(candidate);
		if (unique.length >= TAG_CANDIDATE_LIMIT) break;
	}
	return unique;
}

/**
 * Compile one learned literal into a safe global matcher.
 *
 * Every regex metacharacter is escaped and the input is length-capped, so the
 * result can only ever be a plain literal match: it contains no quantifier, and
 * catastrophic backtracking is therefore not constructible from model output.
 * @param {string} literal
 * @returns {RegExp|null} `null` when the literal is empty after cleaning.
 */
function compileLearnedLiteralPhrase(literal) {
	const cleaned = String(literal ?? "").slice(0, LEARNED_LITERAL_MAX_CHARS);
	if (cleaned.length === 0) return null;
	return new RegExp(cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

/**
 * Reject a literal that already fires on ordinary prose.
 * @param {string} literal
 * @returns {string|null} the offending corpus line, or `null` when clean.
 */
function selfCheckLearnedLiteral(literal) {
	const compiled = compileLearnedLiteralPhrase(literal);
	if (!compiled) return "字面量为空";
	for (const corpus of LEARNED_SELF_CHECK_CORPUS) {
		compiled.lastIndex = 0;
		if (compiled.test(corpus)) return corpus;
	}
	return null;
}

/**
 * Judge whether one learned literal is worth adopting as a churn phrase.
 *
 * The compiled matcher is a bare substring (no word boundary), so a single
 * short token such as "wait" or "决策" fires inside every ordinary technical
 * sentence that happens to contain that word — this is exactly what the
 * shipped phrase list deliberately avoids. We only keep literals that are
 * meaningfully specific on their own: a multi-word ASCII phrase, a CJK phrase
 * of at least 4 characters, or a single ASCII token with a trailing semicolon
 * ("Simpler:") that marks a self-restart rather than prose.
 * @param {string} literal
 * @returns {boolean} whether the literal is specific enough to adopt.
 */
function isLearnedLiteralSpecific(literal) {
	const text = String(literal ?? "").trim();
	if (text.length === 0 || text.length < 4) return false;
	const bare = text.toLowerCase().replace(/\s+/g, " ");
	for (const blocked of LEARNED_BARE_LITERAL_BLOCKLIST) {
		if (bare === blocked) return false;
	}
	const hasSpace = /\s/.test(text);
	const ascii = /^[\x20-\x7E]+$/.test(text);
	const cjk = /[\u4e00-\u9fff]/.test(text);
	if (ascii) {
		if (hasSpace) return text.length >= 8;
		return /[:;]$/.test(text);
	}
	if (cjk) return text.replace(/[\u4e00-\u9fff]/g, "").length > 0 || text.length >= 4;
	return hasSpace && text.length >= 8;
}

/**
 * Clamp an arbitrary value into [0, 1]; non-numbers become 0.
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 0;
	return Math.min(1, Math.max(0, numeric));
}

/**
 * Mint a short prefixed identifier for a harvest record.
 *
 * The unit tests strip this module's `import` lines and evaluate the body with
 * `new Function`, so `randomUUID` is genuinely absent there; `typeof` on an
 * undeclared binding is safe, which lets the same code path serve both the real
 * host (crypto uuid) and the test harness (time + random suffix).
 * @param {string} prefix - e.g. "smp", "prp", "pat".
 * @returns {string}
 */
function harvestUniqueId(prefix) {
	if (typeof randomUUID === "function") {
		return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	}
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Keep only the feature-spec fields the plugin understands, dropping anything
 * the model may have invented (this is the boundary that keeps model output
 * from reaching the detector in an unexpected shape).
 * @param {object} spec
 * @returns {object}
 */
function normalizeHarvestFeatureSpec(spec) {
	const source = spec && typeof spec === "object" ? spec : {};
	const strings = (value, limit) => Array.isArray(value)
		? value.filter((item) => typeof item === "string" && item.length > 0)
			.map((item) => item.slice(0, LEARNED_LITERAL_MAX_CHARS)).slice(0, limit)
		: [];
	const normalized = {
		literals: strings(source.literals, 8),
		coOccurrence: strings(source.coOccurrence, 8),
		negatives: strings(source.negatives, 8)
	};
	const minHits = Number(source.minHitsPer1000Chars);
	if (Number.isFinite(minHits)) normalized.minHitsPer1000Chars = Math.max(0, Math.round(minHits));
	if (typeof source.thresholdKey === "string" && source.thresholdKey.length > 0) normalized.thresholdKey = source.thresholdKey;
	const suggested = Number(source.suggestedValue);
	if (Number.isFinite(suggested)) normalized.suggestedValue = Math.round(suggested);
	return normalized;
}

/**
 * Close a JSON object whose only defect is missing trailing closing delimiters.
 *
 * Observed from a reasoning model: the body arrives complete — every finding
 * closed, the `findings` array closed — but the final `}` of the outer object
 * never comes, and the provider still reports a clean stop.  Appending the
 * missing closers restores the text the model meant to send without inventing
 * or altering a single character of content; anything else (a half-written
 * string, a missing comma, unbalanced quotes) is left untouched and still
 * fails downstream.
 * @param {string} text - the candidate JSON text.
 * @returns {string} the text, with at most the missing closers appended.
 */
function closeUnbalancedJsonTail(text) {
	const closers = [];
	let inString = false;
	let escaped = false;
	for (const char of text) {
		if (escaped) { escaped = false; continue; }
		if (char === "\\") { if (inString) escaped = true; continue; }
		if (char === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (char === "{" || char === "[") closers.push(char === "{" ? "}" : "]");
		else if (char === "}" || char === "]") closers.pop();
	}
	// An unterminated string is a truncation, not a missing closer: repairing it
	// would mean inventing text.
	if (inString) return text;
	// Only the trailing run of closers is restored.  If the stack is empty the
	// text is already balanced; if a closer appears out of order the stack goes
	// negative-free and the appended tail simply fails to parse.
	return text + closers.reverse().join("");
}

/**
 * Slice the JSON object that starts at `start`.
 *
 * String-aware, so a `}` or `]` inside a string literal neither ends the slice
 * nor perturbs the depth count.  Scanning stops at the character that closes
 * the object, which also drops any trailing prose the model appended.  An
 * object that never closes returns the remainder so the caller can try
 * restoring its missing closers.
 * @param {string} body
 * @param {number} start - index of the opening `{`.
 * @returns {string}
 */
function sliceJsonObject(body, start) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < body.length; index += 1) {
		const char = body[index];
		if (escaped) { escaped = false; continue; }
		if (char === "\\") { if (inString) escaped = true; continue; }
		if (char === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") {
			depth -= 1;
			if (depth <= 0) return body.slice(start, index + 1);
		}
	}
	return body.slice(start);
}

/**
 * Parse the analysis model's reply into validated findings.
 *
 * Tolerant about framing (```json fences, a leading sentence, and missing
 * trailing closing delimiters) but never about content: an unparseable or
 * off-schema reply returns `null` so the caller can mark the batch failed and
 * keep the samples unanalyzed.  Guessing is explicitly not allowed here.
 * @param {string} rawText
 * @returns {object[]|null} findings, or `null` when the reply is unusable.
 */
function parseHarvestFindings(rawText) {
	const text = String(rawText ?? "").trim();
	if (text.length === 0) return null;
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fenced ? fenced[1].trim() : text;
	const start = body.indexOf("{");
	if (start < 0) return null;
	const candidate = sliceJsonObject(body, start);
	let parsed;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		try {
			parsed = JSON.parse(closeUnbalancedJsonTail(candidate));
		} catch {
			return null;
		}
	}
	if (!parsed || !Array.isArray(parsed.findings)) return null;
	const findings = [];
	for (const item of parsed.findings) {
		if (!item || typeof item !== "object") continue;
		if (!HARVEST_FINDING_KINDS.includes(item.kind)) continue;
		if (!HARVEST_DETECTORS.includes(item.detector)) continue;
		findings.push({
			kind: item.kind,
			detector: item.detector,
			title: String(item.title ?? "").slice(0, 200),
			observation: String(item.observation ?? "").slice(0, 1000),
			evidence: Array.isArray(item.evidence)
				? item.evidence.filter((id) => typeof id === "string").slice(0, PROPOSAL_EVIDENCE_LIMIT)
				: [],
			featureSpec: normalizeHarvestFeatureSpec(item.featureSpec),
			confidence: clamp01(item.confidence),
			suggestedAction: String(item.suggestedAction ?? "").slice(0, 64)
		});
	}
	return findings;
}

/**
 * Stable identity of a candidate, so the same discovery re-reported by an
 * independent batch accumulates instead of duplicating.
 * @param {object} finding
 * @returns {string}
 */
function harvestProposalKey(finding) {
	const spec = finding?.featureSpec ?? {};
	return [
		finding?.detector ?? "",
		(spec.literals ?? []).join("\u0001"),
		spec.thresholdKey ?? "",
		String(spec.suggestedValue ?? "")
	].join("\u0002");
}

/**
 * Fold one batch of findings into the pending list.  A repeated candidate keeps
 * its id, merges evidence, and gains a confidence step so that patterns found
 * independently by several batches float to the top.
 * @param {object[]} proposals - current list.
 * @param {object} finding - one validated finding.
 * @param {number} now - timestamp in ms.
 * @returns {object[]} the new list.
 */
function mergeHarvestProposal(proposals, finding, now) {
	const list = Array.isArray(proposals) ? proposals.slice() : [];
	const key = harvestProposalKey(finding);
	const index = list.findIndex((item) => item && item.key === key);
	if (index < 0) {
		list.push({
			id: harvestUniqueId("prp"),
			key,
			kind: finding.kind,
			detector: finding.detector,
			title: finding.title,
			observation: finding.observation,
			evidence: finding.evidence,
			featureSpec: finding.featureSpec,
			confidence: finding.confidence,
			suggestedAction: finding.suggestedAction,
			seenCount: 1,
			firstSeenAt: now,
			lastSeenAt: now,
			status: "pending"
		});
		return list;
	}
	const previous = list[index];
	const evidence = Array.from(new Set([...(previous.evidence ?? []), ...(finding.evidence ?? [])]))
		.slice(0, PROPOSAL_EVIDENCE_LIMIT);
	list[index] = {
		...previous,
		title: finding.title || previous.title,
		observation: finding.observation || previous.observation,
		featureSpec: finding.featureSpec ?? previous.featureSpec,
		confidence: Math.min(PROPOSAL_CONFIDENCE_MAX, (previous.confidence ?? 0) + PROPOSAL_CONFIDENCE_STEP),
		evidence,
		seenCount: (previous.seenCount ?? 1) + 1,
		lastSeenAt: now
	};
	return list;
}

/**
 * The learned overlay currently in force.  Empty until `apply` loads
 * patterns.json, so every helper below degrades to shipped behavior.
 */
let learnedOverlay = { version: 1, patterns: [], thresholdShifts: [] };

/**
 * Enabled learned patterns for one detector.
 * @param {string} detector
 * @returns {object[]}
 */
function learnedPatternsFor(detector) {
	if (!settings.enableLearnedPatterns) return [];
	return (learnedOverlay.patterns ?? []).filter(
		(pattern) => pattern && pattern.enabled !== false && pattern.detector === detector
	);
}

/**
 * Churn phrase list in force: the shipped set, plus every adopted literal.
 * With no adopted pattern this returns the shipped array itself, so behavior is
 * byte-for-byte identical to the pre-harvest plugin.
 * @returns {RegExp[]}
 */
function effectiveChurnPhrases() {
	const extra = [];
	for (const pattern of learnedPatternsFor("churn")) {
		if (pattern.kind !== "literal-phrase") continue;
		const compiled = compileLearnedLiteralPhrase(pattern.literal);
		if (compiled) extra.push(compiled);
	}
	return extra.length === 0 ? CHURN_PHRASES : CHURN_PHRASES.concat(extra);
}

/**
 * Bounded sum of adopted threshold deltas for one settings key.
 * @param {string} key - settings key, e.g. "churnMinHits".
 * @returns {number} clamped to ±settings.learnedMaxShift.
 */
function learnedThresholdShift(key) {
	if (!settings.enableLearnedPatterns) return 0;
	let shift = 0;
	for (const item of learnedOverlay.thresholdShifts ?? []) {
		if (!item || item.enabled === false || item.key !== key) continue;
		const delta = Number(item.delta);
		if (Number.isFinite(delta)) shift += delta;
	}
	const bound = Math.max(0, Number(settings.learnedMaxShift) || 0);
	return Math.min(bound, Math.max(-bound, shift));
}

/**
 * Churn hit threshold in force (shipped value shifted by adopted tuning).
 * @returns {number}
 */
function effectiveChurnMinHits() {
	return Math.max(1, CHURN_MIN_HITS + learnedThresholdShift("churnMinHits"));
}

/**
 * True when the cut was produced ONLY by learned additions — the shipped
 * configuration alone would not have fired.  Such a cut is what the shadow
 * period exists to absorb.
 * @param {string} fullVisibleText
 * @returns {boolean}
 */
function isLearnedOnlyChurnTrigger(fullVisibleText) {
	const hasLearned = learnedPatternsFor("churn").length > 0 || learnedThresholdShift("churnMinHits") !== 0;
	if (!hasLearned) return false;
	return countChurnHits(fullVisibleText, CHURN_PHRASES) < CHURN_MIN_HITS;
}

/**
 * Count the hits a shadow-mode learned churn addition WOULD have produced, so
 * the settings panel can say "this pattern would have cut 7 times" before the
 * user promotes it.  Counting only; nothing here changes a decision.
 * @param {string} fullVisibleText
 * @returns {boolean} whether any shadow counter moved.
 */
function noteChurnShadowHits(fullVisibleText) {
	const tail = fullVisibleText.slice(-CHURN_WINDOW_CHARS);
	let moved = false;
	for (const pattern of learnedOverlay.patterns ?? []) {
		if (!pattern || pattern.detector !== "churn" || pattern.enabled === false || pattern.mode !== "shadow") continue;
		const compiled = compileLearnedLiteralPhrase(pattern.literal);
		if (!compiled) continue;
		const matched = tail.match(compiled);
		if (matched && matched.length > 0) {
			pattern.shadowHits = (pattern.shadowHits ?? 0) + matched.length;
			moved = true;
		}
	}
	for (const item of learnedOverlay.thresholdShifts ?? []) {
		if (!item || item.key !== "churnMinHits" || item.enabled === false || item.mode !== "shadow") continue;
		item.shadowHits = (item.shadowHits ?? 0) + 1;
		moved = true;
	}
	return moved;
}

/** Last anchor injected per session, for the sample's `anchorPoints` signal. */
const lastAnchorBySession = new Map();

/**
 * Remember the anchor most recently injected for a session (bounded, oldest
 * entry dropped first).
 * @param {string} sessionId
 * @param {number} points
 * @param {string} text
 */
function rememberLastAnchor(sessionId, points, text) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	if (lastAnchorBySession.size >= LAST_ANCHOR_MAP_LIMIT && !lastAnchorBySession.has(sessionId)) {
		const oldest = lastAnchorBySession.keys().next().value;
		if (oldest !== undefined) lastAnchorBySession.delete(oldest);
	}
	lastAnchorBySession.set(sessionId, { points, text: String(text ?? "").slice(0, SAMPLE_HEAD_CHARS) });
}

/**
 * The anchor most recently injected for a session, or `null`.
 * @param {string} sessionId
 * @returns {{points:number,text:string}|null}
 */
function readLastAnchor(sessionId) {
	if (typeof sessionId !== "string") return null;
	return lastAnchorBySession.get(sessionId) ?? null;
}

/** Monotonic count of soft cuts performed by this plugin. */
let softCutCount = 0;
/** Last `softCutCount` observed while sampling, per session. */
const softCutSeenBySession = new Map();

/**
 * Note that a soft cut just happened, so the next sample can attribute it.
 */
function noteSoftCutFired() {
	softCutCount += 1;
}

/**
 * Whether a soft cut happened since this session was last sampled.
 * @param {string|null} sessionId
 * @returns {boolean}
 */
function consumeSoftCutFlag(sessionId) {
	const key = typeof sessionId === "string" ? sessionId : "";
	const seen = softCutSeenBySession.get(key) ?? 0;
	softCutSeenBySession.set(key, softCutCount);
	return softCutCount > seen;
}

/**
 * Build the "local signals" block of a sample by REUSING the shipped detectors,
 * so the analysis layer can compare what the plugin saw against what it missed.
 * A detector throwing must never break sampling.
 * @param {string} fullVisibleText
 * @param {object[]} toolCalls
 * @returns {object}
 */
function collectHarvestLocalSignals(fullVisibleText, toolCalls) {
	const text = typeof fullVisibleText === "string" ? fullVisibleText : "";
	const signals = {
		detectorHits: { repeat: null, churn: null, pseudoTool: false, transition: false },
		tagCandidates: collectTagCandidates(text),
		toolCalls: Array.isArray(toolCalls) ? toolCalls : []
	};
	try {
		if (text.length > 0) {
			if (settings.enableRepeat) {
				const loop = findRepeatingTail(text);
				if (loop) signals.detectorHits.repeat = { count: loop.count };
			}
			if (settings.enableChurn && !insideUnclosedCodeFence(text)) {
				const churn = detectChurn(text);
				if (churn) signals.detectorHits.churn = { hits: churn.hits };
			}
			signals.detectorHits.pseudoTool = settings.enablePseudoTool && hasPseudoToolCall(text);
			signals.detectorHits.transition = settings.enableTransition && wantsSoftCut(text, MIN_REASONING_CHARS);
		}
	} catch {
		// A detector failure must never break sampling.
	}
	return signals;
}

/**
 * Decide whether one assistant settlement is worth a full-text record, and
 * assemble the bounded sample record.
 *
 * Breadth is unconditional (metadata + head/tail slice); depth is earned by
 * length or by a local signal, because sampling only detector hits would make
 * the whole feature structurally blind to the misses it exists to find.
 * @param {object} input - see `harvestOnEvent` for the producer.
 * @returns {object} the sample record.
 */
function buildHarvestSample(input) {
	const text = typeof input.fullVisibleText === "string" ? input.fullVisibleText : "";
	const reasoningChars = Number.isFinite(input.reasoningChars) ? input.reasoningChars : 0;
	const toolCalls = Array.isArray(input.toolCalls) ? input.toolCalls : [];
	const localSignals = collectHarvestLocalSignals(text, toolCalls);
	const hits = localSignals.detectorHits;
	const tagOnly = localSignals.tagCandidates.length > 0 && toolCalls.length === 0;
	const interesting = hits.repeat !== null || hits.churn !== null || hits.pseudoTool || tagOnly;
	const deep = reasoningChars >= settings.harvestMinTextChars || interesting;
	const sample = {
		id: input.id,
		ts: input.ts,
		sessionId: input.sessionId ?? null,
		workspace: input.workspace ?? null,
		turn: input.turn ?? null,
		step: input.step ?? null,
		provider: input.provider ?? null,
		model: input.model ?? null,
		reasoningChars,
		textChars: text.length,
		reasoningHead: text.slice(0, SAMPLE_HEAD_CHARS),
		reasoningTail: text.slice(-SAMPLE_TAIL_CHARS),
		localSignals,
		outcome: input.outcome ?? "completed",
		analyzedAt: null
	};
	sample.localSignals.softCutFired = input.softCutFired === true;
	sample.localSignals.anchorPoints = input.anchorPoints ?? 0;
	sample.localSignals.anchorText = input.anchorText ?? "";
	if (deep) sample.reasoningFull = text.slice(-settings.harvestMaxTextChars);
	return sample;
}

/**
 * Sort key for batch selection: anomalies first, then long unclassified text,
 * then ordinary samples.
 * @param {object} sample
 * @returns {number}
 */
function harvestSamplePriority(sample) {
	const hits = sample?.localSignals?.detectorHits ?? {};
	if (hits.pseudoTool || hits.repeat) return 0;
	if (hits.churn) return 1;
	if (typeof sample?.reasoningFull === "string" && sample.reasoningFull.length > 0) return 2;
	return 3;
}

/**
 * Order the pending backlog for batch selection.  Priority tier comes first;
 * within a tier, samples that already failed an attempt sink below their peers
 * so one doomed batch cannot monopolize every retry.
 * @param {object[]} pending
 * @returns {object[]} a new, ordered array.
 */
function orderAnalyzeBatch(pending) {
	return pending.slice().sort((left, right) => {
		const tier = harvestSamplePriority(left) - harvestSamplePriority(right);
		if (tier !== 0) return tier;
		return (Number(left?.analyzeAttempts) || 0) - (Number(right?.analyzeAttempts) || 0);
	});
}

/**
 * Turn a provider-level finish failure into a user-readable sentence.
 *
 * These are configuration or transport failures, not "the model wrote bad
 * JSON": an unknown model name, an unowned provider, a network error.  They
 * are surfaced verbatim because only the user can fix them, and they must not
 * be charged against a sample's attempt budget — the sample was never
 * actually analyzed.
 * @param {object|undefined} finish - `assembler.finish`.
 * @returns {string} the message, or `""` when this is not a provider failure.
 */
function describeFinishFailure(finish) {
	if (finish?.kind !== "error") return "";
	const message = finish?.failure?.message;
	const code = finish?.failure?.code;
	const detail = typeof message === "string" && message.length > 0 ? message : "分析请求失败";
	return code ? `分析模型调用失败（${code}）：${detail}` : `分析模型调用失败：${detail}`;
}

/**
 * A batch that fails validation leaves its samples unanalyzed, so without a
 * cap the same doomed samples would be picked again on every click and the
 * whole backlog would never move past them.  The sample keeps its content and
 * its unanalyzed status; only batch selection skips it.
 * @param {object} sample
 * @returns {boolean}
 */
function harvestSampleExhausted(sample) {
	return Number(sample?.analyzeAttempts) >= HARVEST_ANALYZE_MAX_ATTEMPTS;
}

/**
 * Record one failed analysis attempt against the samples of the failed batch.
 * @param {object[]} samples - full sample list.
 * @param {object[]} attempted - samples the failed batch tried to analyze.
 * @param {number} now - timestamp in ms.
 * @returns {object[]} the updated list.
 */
function markAnalyzeAttempts(samples, attempted, now) {
	const ids = new Set(attempted.map((sample) => sample?.id));
	return samples.map((sample) => {
		if (!ids.has(sample?.id)) return sample;
		return {
			...sample,
			analyzeAttempts: (Number(sample.analyzeAttempts) || 0) + 1,
			lastAnalyzeAttemptAt: now
		};
	});
}

/**
 * Render the analysis batch as the model's user message, capped by character
 * budget so one runaway sample cannot consume the whole call.
 * @param {object[]} samples - already ordered.
 * @param {number} maxChars
 * @returns {string}
 */
function renderAnalyzeBatch(samples, maxChars) {
	const chunks = [];
	let used = 0;
	for (const sample of samples) {
		const body = typeof sample.reasoningFull === "string" && sample.reasoningFull.length > 0
			? sample.reasoningFull
			: `${sample.reasoningHead ?? ""}\n…\n${sample.reasoningTail ?? ""}`;
		const rendered = [
			`### ${sample.id}`,
			`len=${sample.reasoningChars} outcome=${sample.outcome} provider=${sample.provider ?? "-"} model=${sample.model ?? "-"}`,
			`localHits=${JSON.stringify(sample.localSignals?.detectorHits ?? {})}`,
			`tags=${JSON.stringify(sample.localSignals?.tagCandidates ?? [])}`,
			`tools=${JSON.stringify(sample.localSignals?.toolCalls ?? [])}`,
			"```text",
			body,
			"```"
		].join("\n");
		if (used + rendered.length > maxChars && chunks.length > 0) break;
		chunks.push(rendered);
		used += rendered.length;
	}
	return chunks.join("\n\n");
}

/** System prompt of the analysis call: structured findings only, never code. */
const HARVEST_ANALYZE_SYSTEM_PROMPT = [
	"你是 COT 异常形态归纳器。输入是一批模型思考样本，每条带 id、长度、本地检测器命中情况、标签候选与文本。",
	"你的任务是找出「本地检测器看不见、但确实属于病态打转或无效工具调用」的形态，以及本地检测器误伤正常思考的形态。",
	"只输出一个 JSON 对象 {\"findings\":[...]}，不要解释、不要输出 JSON 以外的任何文字。",
	"每个 finding 的字段：kind(new-pattern|missed-by-detector|false-positive|threshold-too-high)、detector(churn|repeat|pseudoTool|transition|conclusion)、title、observation、evidence(样本 id 数组)、featureSpec、confidence(0~1)、suggestedAction。",
	"featureSpec 只允许两种形态：① {\"literals\":[\"普通文字片段\"],\"negatives\":[],\"minHitsPer1000Chars\":数字}；② {\"thresholdKey\":\"设置项名\",\"suggestedValue\":数字}。",
	"限制①：literals 形态只能用于 detector=churn。其它检测器（repeat|pseudoTool|transition|conclusion）的发现请改用 kind=false-positive 或 kind=threshold-too-high，不要给出 literals——学习层只读取 churn 的字面量，其它检测器的字面量采纳后不生效。",
	"限制②：thresholdKey 只能取 \"churnMinHits\" 这一个设置项名。系统当前只为 churnMinHits 提供运行时读取，其它设置项名（如 repeat.minChars、minReasoningChars 等）采纳后不生效；发现其它检测器的阈值问题请改用 kind=false-positive。",
	"限制③：literals 必须是多词短语（英文至少含一个空格、不少于 8 个字符）或至少 4 个字的中文短语，不要输出单个常见词（wait/hmm/actually/better/simpler/cleaner/ok/now/等等/权衡/决策/再看 等）——这类裸词会在正常语料中误命中，不会被采纳。",
	"限制④：kind=false-positive 表示「本地检测器不该断言异常」。请写明误伤的检测器名，不要附 literals（本工程抑制层尚未实现，误报当前只能人工处置，不作为可采纳候选）。",
	"严禁输出正则表达式、严禁输出可执行代码；literals 只能是普通文字片段（不超过 48 字），不要包含 . * + ? ( ) [ ] { } | \\ 这些符号。",
	"evidence 只能引用输入里真实出现过的样本 id，不得编造；没有发现就输出 {\"findings\":[]}。"
].join("\n");

// ---------------------------------------------------------------------------
// Runtime settings — editable from Settings → COT Anchor
// ---------------------------------------------------------------------------
//
// Every tunable lives here.  The detection functions read the mutable
// module-level bindings declared above; `applyRuntimeSettings` is the single
// writer, so the shipped defaults stay in one place and the Settings tab can
// change behavior without a restart.
//
// Node built-ins (fs) are imported at the top but only USED inside `apply` and
// the settings helpers below, never at module scope: the unit tests import this
// module with its `import`/`export` lines stripped, so any module-scope fs call
// would break them.

/** Shipped defaults for every tunable. */
const DEFAULT_SETTINGS = {	// Master switches
	enableToolInject: true,
	enableSoftCut: true,
	// Per-detector switches
	enablePseudoTool: true,
	enableRepeat: true,
	enableChurn: true,
	enableTransition: true,
	enableNumberRunaway: true,
	// Notice/anchor shaping
	minReasoningChars: 250,
	maxPoints: 3,
	maxPointChars: 220,
	// Transition (soft-cut) detector
	softCutScanTail: 160,
	softCutTransitionWindow: 48,
	softCutMinFollowChars: 6,
	// Repetition detector
	repeatProbeChars: 128,
	repeatWindowChars: 16000,
	repeatMinPeriod: 12,
	repeatShortPeriod: 96,
	repeatMaxPeriod: 8000,
	repeatMinCount: 2,
	repeatMinCountShort: 5,
	repeatUltraShortMinCount: 30,
	repeatMinTextChars: 800,
	// Churn detector
	churnWindowChars: 3000,
	churnMinHits: 18,
	churnMinTextChars: 800,
	// Number-runaway detector
	numberRunMinTextChars: 800,
	numberRunMinChars: 500,
	numberRunMaxGap: 8,
	numberRunMinDigitRatio: 0.5,
	numberRunMinIncreaseRatio: 0.55,
	// Invalid tool-call detector
	pseudoToolScanTail: 4000,
	// LLM refinement (optional, off by default)
	enableLlmRefine: false,
	llmRefineProvider: "",
	llmRefineModel: "",
	llmRefineMaxTokens: 256,
	llmRefineTimeoutMs: 20000,
	llmRefineMaxInputChars: 12000,
	// COT harvest — L1 collection (off by default: zero cost when disabled)
	enableHarvest: false,
	harvestIncludeToolTrace: true,
	harvestMaxRecords: 200,
	harvestRetentionDays: 14,
	harvestMinTextChars: 3000,
	harvestMaxTextChars: 8000,
	harvestFlushDebounceMs: 5000,
	// COT harvest — L2 analysis
	enableAutoAnalyze: false,
	analyzeTriggerSamples: 50,
	analyzeProvider: "",
	analyzeModel: "",
	// 4000, not 1500: the analysis call often inherits a reasoning model, which
	// spends tokens thinking before it emits any text.  A small cap is consumed
	// entirely by reasoning and returns an empty answer.
	// 4000 = the ceiling SETTINGS_SCHEMA declares for this key; keeping the
	// default inside the declared range so the Settings tab cannot show a
	// value that the input control would immediately clamp.
	analyzeMaxTokens: 4000,
	// 180s, not 60s: the analysis call often inherits a reasoning model, which
	// can spend a minute or more thinking before it emits any text.  At 60s the
	// request was aborted mid-reasoning, and a text-only read then saw an empty
	// reply and reported it as malformed JSON.
	analyzeTimeoutMs: 180000,
	// Measured against a reasoning model (Doubao-Seed-2.1-Pro via trae): a batch
	// of 3 samples finishes in ~96s, a batch of 5 needs ~168s, and a batch of 20
	// never finished — the model kept reasoning past 180s and emitted no JSON at
	// all.  Reasoning length grows with the input, so the batch is what actually
	// bounds the wall-clock time; keep the default on the measured-safe side.
	analyzeMaxInputChars: 8000,
	analyzeMaxSamples: 3,
	// One "立即分析" click keeps running batches until this budget is spent, so a
	// large backlog does not need one click per three samples.  Each batch takes
	// roughly 100s with a reasoning model, so this is about three batches.
	analyzeRunBudgetMs: 300000,
	// COT harvest — L3 learned overlay
	enableLearnedPatterns: true,
	learnedMaxPhrases: 60,
	learnedMaxShift: 20,
	learnedShadowRounds: 20
};

/** Currently applied settings (booleans are read directly from here). */
let settings = { ...DEFAULT_SETTINGS };

/** Notice/anchor shaping parameters, mirrored as mutable bindings. */
let MIN_REASONING_CHARS = DEFAULT_SETTINGS.minReasoningChars;
let MAX_POINTS = DEFAULT_SETTINGS.maxPoints;
let MAX_POINT_CHARS = DEFAULT_SETTINGS.maxPointChars;

/**
 * Settings metadata: the single source of truth for the client form.  The
 * client renders rows from this list, so a new tunable only needs an entry
 * here plus a line in `applyRuntimeSettings`.
 */
const SETTINGS_SCHEMA = [
	{ key: "enableToolInject", label: "工具结果后注入锚点", type: "boolean", group: "总开关",
		hint: "每次工具执行后，把已确立的结论摘要插回上下文（代价最低的提醒方式）。" },
	{ key: "enableSoftCut", label: "允许生成中途打断（软切断）", type: "boolean", group: "总开关",
		hint: "关闭后只保留工具边界的注入，不再在生成过程中切断。" },

	{ key: "enablePseudoTool", label: "识别伪工具调用", type: "boolean", group: "打断判定",
		hint: "模型把工具调用写成文本（如 <seed:tool_call>）时打断并纠正格式。" },
	{ key: "enableRepeat", label: "识别重复循环", type: "boolean", group: "打断判定",
		hint: "同一段内容被反复吐出时打断，并裁掉落盘的重复部分。" },
	{ key: "enableChurn", label: "识别语义空转", type: "boolean", group: "打断判定",
		hint: "措辞不同但反复\"重新分析\"时打断。属启发式判定，遇到未闭合代码块会自动让路。" },
	{ key: "enableTransition", label: "识别转折句", type: "boolean", group: "打断判定",
		hint: "\"接下来我要……\"这类转折句出现时打断，先注入结论锚点。" },
	{ key: "enableNumberRunaway", label: "识别数字递增流退化", type: "boolean", group: "打断判定",
		hint: "长段递增数字流（如 639.640) 640.641)…）连续多字且无实质内容时打断。启发式判定，仅在数字流足够长时触发。" },

	{ key: "minReasoningChars", label: "最少思考字数", type: "number", min: 50, max: 5000, group: "锚点内容",
		hint: "思考短于此长度时不提取结论、不注入。" },
	{ key: "maxPoints", label: "锚点最多结论条数", type: "number", min: 1, max: 8, group: "锚点内容" },
	{ key: "maxPointChars", label: "单条结论最大字数", type: "number", min: 40, max: 1000, group: "锚点内容" },

	{ key: "repeatMinCount", label: "长块重复次数阈值", type: "number", min: 2, max: 10, group: "重复循环参数",
		hint: "长内容（超过下方\"短周期分界\"）重复达到此次数即判定打转。" },
	{ key: "repeatMinCountShort", label: "短周期重复次数阈值", type: "number", min: 2, max: 30, group: "重复循环参数",
		hint: "短内容循环需重复更多次才判定打转；调低则更激进。" },
	{ key: "repeatUltraShortMinCount", label: "超短周期重复次数阈值", type: "number", min: 5, max: 200, group: "重复循环参数",
		hint: "周期 2~11 字的极小循环（如 `er4er4…` token 卡死）须重复到这么多次才判定；正常强调/分隔线（====、-----）不构成威胁。" },
	{ key: "repeatMinPeriod", label: "最小周期字数", type: "number", min: 4, max: 500, group: "重复循环参数" },
	{ key: "repeatShortPeriod", label: "短周期分界字数", type: "number", min: 16, max: 2000, group: "重复循环参数" },
	{ key: "repeatMaxPeriod", label: "最大周期字数", type: "number", min: 500, max: 50000, group: "重复循环参数" },
	{ key: "repeatWindowChars", label: "重复检查窗口", type: "number", min: 1000, max: 60000, group: "重复循环参数",
		hint: "只在文本尾部这段长度内做周期性预筛（性能保护）。" },
	{ key: "repeatProbeChars", label: "周期探针长度", type: "number", min: 16, max: 2000, group: "重复循环参数" },
	{ key: "repeatMinTextChars", label: "启用最小文本长度", type: "number", min: 500, max: 50000, group: "重复循环参数" },

	{ key: "churnMinHits", label: "空转词命中阈值", type: "number", min: 5, max: 100, group: "语义空转参数",
		hint: "窗口内出现这么多次\"让我想想/重新分析\"类用语即判定空转；调低则更激进。" },
	{ key: "churnWindowChars", label: "空转统计窗口", type: "number", min: 500, max: 20000, group: "语义空转参数" },
	{ key: "churnMinTextChars", label: "启用最小文本长度", type: "number", min: 500, max: 50000, group: "语义空转参数" },

	{ key: "softCutScanTail", label: "转折句扫描窗口", type: "number", min: 40, max: 2000, group: "转折句参数" },
	{ key: "softCutTransitionWindow", label: "转折词距句末窗口", type: "number", min: 8, max: 500, group: "转折句参数" },
	{ key: "softCutMinFollowChars", label: "转折词后最少展开字数", type: "number", min: 2, max: 200, group: "转折句参数",
		hint: "转折词（如\"我先\"）之后至少输出这么多字才允许切断，防止在句子刚开头就切断思考、截出半句结论。" },
	{ key: "pseudoToolScanTail", label: "伪调用扫描窗口", type: "number", min: 200, max: 20000, group: "转折句参数" },

	{ key: "enableLlmRefine", label: "启用 LLM 提炼结论", type: "boolean", group: "LLM 提炼",
		hint: "用一次小模型调用把整段思考压成摘要式结论（比摘句更准）。开启后每个助手回合多一次小调用；失败会自动退回打分提取。provider/model 留空则沿用会话当前模型。" },
	{ key: "llmRefineProvider", label: "提炼用 provider（留空=跟随会话）", type: "text", group: "LLM 提炼" },
	{ key: "llmRefineModel", label: "提炼用 model（留空=跟随会话）", type: "text", group: "LLM 提炼" },
	{ key: "llmRefineMaxTokens", label: "提炼输出上限", type: "number", min: 64, max: 2000, group: "LLM 提炼" },
	{ key: "llmRefineTimeoutMs", label: "提炼超时（毫秒）", type: "number", min: 3000, max: 120000, group: "LLM 提炼" },
	{ key: "llmRefineMaxInputChars", label: "提炼输入截断字数", type: "number", min: 1000, max: 60000, group: "LLM 提炼" },

	{ key: "enableHarvest", label: "启用 CoT 静默采集", type: "boolean", group: "CoT 采集",
		hint: "关闭时零采集、零额外调用、零磁盘写入。开启后每个助手回合都会留一条样本，用于事后归纳「现有检测器看不见」的打转形态。" },
	{ key: "harvestIncludeToolTrace", label: "记录工具调用轨迹", type: "boolean", group: "CoT 采集",
		hint: "记录该步调用了哪些工具、是否报错，用于分析「反复重试同一工具」。" },
	{ key: "harvestMaxRecords", label: "样本条数上限", type: "number", min: 20, max: 2000, group: "CoT 采集" },
	{ key: "harvestRetentionDays", label: "样本保留天数", type: "number", min: 1, max: 90, group: "CoT 采集" },
	{ key: "harvestMinTextChars", label: "存全文的最小思考字数", type: "number", min: 500, max: 50000, group: "CoT 采集" },
	{ key: "harvestMaxTextChars", label: "单条全文上限", type: "number", min: 500, max: 40000, group: "CoT 采集" },
	{ key: "harvestFlushDebounceMs", label: "落盘去抖（毫秒）", type: "number", min: 500, max: 60000, group: "CoT 采集",
		hint: "这段时间内的多次事件合并成一次追加写，避免每个 token 步都落盘。" },

	{ key: "enableAutoAnalyze", label: "自动分析", type: "boolean", group: "CoT 分析",
		hint: "未分析样本达到下方阈值时自动跑一次归纳；关闭则只能手动点「立即分析」。" },
	{ key: "analyzeTriggerSamples", label: "自动分析触发条数", type: "number", min: 5, max: 500, group: "CoT 分析" },
	{ key: "analyzeProvider", label: "分析用 provider（留空=跟随样本）", type: "text", group: "CoT 分析" },
	{ key: "analyzeModel", label: "分析用 model（留空=跟随样本）", type: "text", group: "CoT 分析" },
	{ key: "analyzeMaxTokens", label: "分析输出上限", type: "number", min: 256, max: 4000, group: "CoT 分析" },
	{ key: "analyzeTimeoutMs", label: "分析超时（毫秒）", type: "number", min: 5000, max: 180000, group: "CoT 分析" },
	{ key: "analyzeMaxInputChars", label: "分析输入截断字数", type: "number", min: 2000, max: 120000, group: "CoT 分析" },
	{ key: "analyzeMaxSamples", label: "单批样本数", type: "number", min: 3, max: 60, group: "CoT 分析" },
	{ key: "analyzeRunBudgetMs", label: "单次分析总时长上限（毫秒）", type: "number", min: 0, max: 1800000, group: "CoT 分析" },

	{ key: "enableLearnedPatterns", label: "加载已采纳的学习模式", type: "boolean", group: "CoT 增补",
		hint: "关闭后运行时只用出厂模式；patterns.json 保留不删，随时可再打开。" },
	{ key: "learnedMaxPhrases", label: "学习模式条数上限", type: "number", min: 4, max: 200, group: "CoT 增补" },
	{ key: "learnedMaxShift", label: "阈值允许最大偏移", type: "number", min: 0, max: 50, group: "CoT 增补",
		hint: "学习层对出厂阈值的调整幅度上限，防止判定漂移。" },
	{ key: "learnedShadowRounds", label: "影子期命中次数（0=直接生效）", type: "number", min: 0, max: 200, group: "CoT 增补",
		hint: "学习模式首次生效时只统计「本会打断」的次数、不真的打断；累计够次数后再由你决定转正。" }
];

/**
 * Merge a settings patch, clamp numbers, and publish the values into the
 * mutable bindings the detectors read.  Unknown keys are dropped; invalid
 * numbers fall back to the shipped default.
 * @param {object|null|undefined} raw - partial settings from config or the UI.
 * @returns {object} the effective settings after clamping.
 */
function applyRuntimeSettings(raw) {
	const incoming = raw && typeof raw === "object" ? raw : {};
	const known = {};
	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		if (Object.prototype.hasOwnProperty.call(incoming, key)) known[key] = incoming[key];
	}
	const merged = { ...DEFAULT_SETTINGS, ...known };
	const specOf = new Map(SETTINGS_SCHEMA.map((entry) => [entry.key, entry]));
	const clampNumber = (key) => {
		const spec = specOf.get(key);
		const value = Math.round(Number(merged[key]));
		if (!Number.isFinite(value)) return DEFAULT_SETTINGS[key];
		const low = spec?.min ?? 0;
		const high = spec?.max ?? Number.MAX_SAFE_INTEGER;
		return Math.min(high, Math.max(low, value));
	};
	const flag = (key) => merged[key] !== false;
	const text = (key) => typeof merged[key] === "string" ? merged[key].trim() : DEFAULT_SETTINGS[key];

	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		const type = specOf.get(key)?.type;
		if (type === "boolean") merged[key] = flag(key);
		else if (type === "text") merged[key] = text(key);
		else merged[key] = clampNumber(key);
	}

	// One-time migration for settings persisted before the timeout was raised.
	// A stored value equal to the old default means the user never touched the
	// field, so it is safe to lift it to the new default; any other value is an
	// explicit choice and is left alone.
	for (const [key, retiredValues] of Object.entries(SUPERSEDED_NUMBER_DEFAULTS)) {
		if (retiredValues.includes(known[key])) merged[key] = DEFAULT_SETTINGS[key];
	}

	settings = merged;
	MIN_REASONING_CHARS = merged.minReasoningChars;
	MAX_POINTS = merged.maxPoints;
	MAX_POINT_CHARS = merged.maxPointChars;
	SOFT_CUT_SCAN_TAIL = merged.softCutScanTail;
	SOFT_CUT_TRANSITION_WINDOW = merged.softCutTransitionWindow;
	SOFT_CUT_MIN_FOLLOW_CHARS = merged.softCutMinFollowChars;
	REPEAT_PROBE_CHARS = merged.repeatProbeChars;
	REPEAT_WINDOW_CHARS = merged.repeatWindowChars;
	REPEAT_MIN_PERIOD = merged.repeatMinPeriod;
	REPEAT_SHORT_PERIOD = merged.repeatShortPeriod;
	REPEAT_MAX_PERIOD = merged.repeatMaxPeriod;
	REPEAT_MIN_COUNT = merged.repeatMinCount;
	REPEAT_MIN_COUNT_SHORT = merged.repeatMinCountShort;
	REPEAT_ULTRA_SHORT_MIN_COUNT = merged.repeatUltraShortMinCount;
	REPEAT_MIN_TEXT_CHARS = merged.repeatMinTextChars;
	CHURN_WINDOW_CHARS = merged.churnWindowChars;
	CHURN_MIN_HITS = merged.churnMinHits;
	CHURN_MIN_TEXT_CHARS = merged.churnMinTextChars;
	PSEUDO_TOOL_SCAN_TAIL = merged.pseudoToolScanTail;
	return settings;
}

/**
 * Number defaults that were later raised.  A persisted value equal to one of
 * these is indistinguishable from "never customized", so it is migrated to the
 * current default on load.  Values outside this table are always respected.
 * A key may list several retired defaults when it was raised more than once.
 */
const SUPERSEDED_NUMBER_DEFAULTS = {
	analyzeTimeoutMs: [60000],
	// 1500 was the shipped value; 4000 was briefly the default and still left
	// no room for the answer once a reasoning model spent the budget thinking.
	analyzeMaxTokens: [1500, 4000],
	analyzeMaxSamples: [20],
	analyzeMaxInputChars: [40000]
};

/**
 * Path of the persisted settings file (alongside the other plugin storages). */
const SETTINGS_FILE = "cot-anchor.json";
/** Exact route the client reads and writes settings through. */
const SETTINGS_ROUTE = "/plugins/cot-anchor/settings";

/** Send one JSON response. */
function sendJson(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}

/** Collect and parse a JSON request body (empty body reads as `{}`). */
function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try {
				resolve(JSON.parse(body || "{}"));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

/**
 * Hash a reasoning block to a stable cache key.
 * @param {string} text
 * @returns {string}
 */
function reasoningKey(text) {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	return `${text.length}:${hash.toString(16)}`;
}

/**
 * Fingerprint of a reasoning block for per-session injection dedup.
 *
 * Whitespace is collapsed and only the leading 120 characters are kept, so a
 * model that re-emits the SAME reasoning across a multi-tool chain (the
 * "原地转圈" failure that previously stacked one anchor per tool call into the
 * durable next-step inbox, eventually overflowing the context window) maps to
 * one stable fingerprint and is injected exactly once.  A genuinely new
 * reasoning phase (different opening) gets a new fingerprint and injects again,
 * so normal multi-step progress keeps its per-phase reminders.
 * @param {string} text
 * @returns {string}
 */
function reasoningFingerprint(text) {
	if (typeof text !== "string" || text.length === 0) return "";
	return text.trim().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Per-session record of the reasoning fingerprint already injected via
 * tools/post-execute.  Keyed by session id so parallel sessions never
 * suppress each other's anchors; bounded so a host with many short-lived
 * sessions cannot leak memory.
 */
const injectedReasoningBySession = new Map();
/** Upper bound on `injectedReasoningBySession` entries (LRU-ish: drops oldest). */
const INJECTED_REASONING_MAP_LIMIT = 32;

/**
 * Remember that `fingerprint` was injected for `sessionId`, dropping the
 * oldest session entry when the map exceeds its bound.
 * @param {string} sessionId
 * @param {string} fingerprint
 */
function rememberInjectedReasoning(sessionId, fingerprint) {
	injectedReasoningBySession.set(sessionId, fingerprint);
	if (injectedReasoningBySession.size > INJECTED_REASONING_MAP_LIMIT) {
		const oldestKey = injectedReasoningBySession.keys().next().value;
		if (oldestKey !== undefined) injectedReasoningBySession.delete(oldestKey);
	}
}

/**
 * Parse a model-written conclusion list into trimmed, capped points.  Accepts
 * plain lines and bullet/numbered prefixes; anything empty is dropped.
 * @param {string} text - raw model output.
 * @param {number} maxPoints
 * @param {number} maxPointChars
 * @returns {string[]}
 */
function parseRefinedPoints(text, maxPoints, maxPointChars) {
	const points = [];
	for (const raw of String(text || "").split(/\r?\n+/)) {
		if (points.length >= maxPoints) break;
		const cleaned = raw.replace(/^\s*(?:[-*•]|\d+[.)]|（?\d+[）.)]?)\s*/, "").trim();
		// A real conclusion carries at least a few characters; filter stray
		// filler lines ("OK", "无关话") that the model may emit between points.
		if (cleaned.length < 8) continue;
		points.push(cleaned.length > maxPointChars ? `${cleaned.slice(0, maxPointChars).trimEnd()}…` : cleaned);
	}
	return points;
}

/**
 * System prompt for the refinement call: terse extractive-to-abstractive
 * conclusion list, no preamble, no markdown framing.
 */
const LLM_REFINE_SYSTEM_PROMPT = [
	"你是结论提炼器。从给定的思考文本中提取最多 3 条最重要的、已确立的结论（事实判定、根因、决定、修正）。",
	"只输出结论本身，每条一行，不要编号、不要引导语、不要解释。",
	"优先保留：修正/推翻旧假设的内容、具体根因、可执行的下一步决定。",
	"丢弃：疑问、猜测、过程复述、客套话。",
	"(Extract at most 3 settled conclusions from the reasoning. One per line, no prefixes, no commentary.)"
].join(" ");

/** Refinement results by reasoning key; `null` marks a finished-but-empty/failed entry. */
const refineCache = new Map();
/** Keys with an in-flight refinement, to avoid duplicate concurrent calls. */
const refineInFlight = new Set();
const REFINE_CACHE_LIMIT = 96;

/**
 * Run one LLM refinement in the background.  Never throws: every failure path
 * writes `null` into the cache so the caller falls back to the scoring extractor.
 * @param {object} ctx - host context (service resolution happens at call time).
 * @param {object} session - session for provider/model fallback and ids.
 * @param {string} reasoning - full reasoning text.
 * @param {string} key - cache key for `reasoning`.
 * @returns {Promise<void>}
 */
async function runRefinement(ctx, session, reasoning, key) {
	try {
		const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
		if (!llm || typeof llm.stream !== "function") {
			refineCache.set(key, null);
			return;
		}
		const source = latestAssistantSource(session);
		const provider = settings.llmRefineProvider || source?.provider;
		const model = settings.llmRefineModel || source?.model;
		if (!provider || !model) {
			refineCache.set(key, null);
			return;
		}

		const inputText = reasoning.slice(-settings.llmRefineMaxInputChars);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), settings.llmRefineTimeoutMs);
		try {
			const assembler = new BlockAssembler();
			for await (const chunk of llm.stream({
				provider,
				model,
				messages: [createUserMessage({
					content: [{ type: "text", text: inputText }],
					source: PLUGIN_SOURCE
				})],
				system: LLM_REFINE_SYSTEM_PROMPT,
				maxTokens: settings.llmRefineMaxTokens,
				sessionId: typeof session.id === "string" ? session.id : undefined,
				purpose: "cot-anchor-refine",
				signal: controller.signal
			})) {
				assembler.push(chunk);
			}
			const text = assembler.blocks()
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const points = parseRefinedPoints(text, MAX_POINTS, MAX_POINT_CHARS);
			refineCache.set(key, points.length > 0 ? points : null);
		} finally {
			clearTimeout(timer);
		}
	} catch {
		refineCache.set(key, null);
	} finally {
		refineInFlight.delete(key);
	}
}

/**
 * Get refined conclusions for a reasoning block, kicking off a background
 * refinement on a miss.  Returns the cached refined points, or `null` when not
 * ready/failed — the caller then uses the scoring extractor and this result will
 * be ready for the next injection of the same reasoning.
 * @param {object} ctx
 * @param {object} session
 * @param {string} reasoning
 * @returns {string[]|null}
 */
function getRefinedConclusions(ctx, session, reasoning) {
	if (!settings.enableLlmRefine || typeof reasoning !== "string" || reasoning.length === 0) return null;
	const key = reasoningKey(reasoning);
	if (refineCache.has(key)) return refineCache.get(key);
	if (refineInFlight.has(key)) return null;
	refineInFlight.add(key);
	void runRefinement(ctx, session, reasoning, key);
	// Keep the cache bounded: drop the oldest entry when over the limit.
	if (refineCache.size > REFINE_CACHE_LIMIT) {
		const oldest = refineCache.keys().next().value;
		if (oldest !== undefined) refineCache.delete(oldest);
	}
	return null;
}

/**
 * Pick the analysis text out of an assembled reply.
 *
 * The text block is the answer and is used whenever it has content.  The
 * reasoning block is only a fallback for the case where the adapter emitted NO
 * text at all: some routes deliver the entire reply inside the reasoning block,
 * and a text-only read then discards a perfectly good answer and reports it as
 * malformed.  The fallback does not relax the contract — the same strict
 * validator must still find a well-formed findings object, so a reasoning block
 * that merely mentions JSON still yields null downstream.
 * @param {object[]} blocks - assembled content blocks.
 * @returns {{raw: string, parsedFrom: "text"|"reasoning"|"none", textChars: number, reasoningChars: number}}
 */
function selectAnalyzeOutput(blocks) {
	const list = Array.isArray(blocks) ? blocks : [];
	const joinType = (type) => list
		.filter((block) => block && block.type === type && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	const text = joinType("text");
	const reasoning = joinType("reasoning");
	if (text.length > 0) {
		return { raw: text, parsedFrom: "text", textChars: text.length, reasoningChars: reasoning.length };
	}
	if (reasoning.length > 0) {
		return { raw: reasoning, parsedFrom: "reasoning", textChars: 0, reasoningChars: reasoning.length };
	}
	return { raw: "", parsedFrom: "none", textChars: 0, reasoningChars: 0 };
}

/**
 * Install the plugin's listeners.
 * @param {object} ctx
 * @param {object} [config]
 */
function apply(ctx, config) {
	// --- 内核能力探测（先做，结果既进日志也进设置接口）----------------------
	// 探测"生成中途截停"所依赖的宿主钩子是否仍然存在。缺失时**不静默**：
	// 启动日志明确告警，设置接口把结果下发给设置页，由界面明示展示。
	const softCutProbe = probeKernelHook(SOFT_CUT_HOOK);
	const streamProbe = probeKernelHook(ASSISTANT_STREAM_HOOK);
	if (softCutProbe === CAPABILITY_ABSENT) {
		console.warn(
			"[cot-anchor] 当前内核没有掐断能力：宿主钩子 " + SOFT_CUT_HOOK +
			" 不存在（上游自 0.1.5-rc.3 起移除）。" +
			"插件的「生成中途截停」（伪工具调用 / 重复循环 / 语义空转 / 转折句 / 数字流退化）本次全部不会生效；" +
			"工具执行后的锚点注入不受影响。"
		);
	} else if (softCutProbe === CAPABILITY_UNKNOWN) {
		console.warn(
			"[cot-anchor] 无法确认内核是否提供掐断能力（未能读取 dsh-agent-loop 源码）。" +
			"若宿主钩子 " + SOFT_CUT_HOOK + " 已被移除，" +
			"插件的「生成中途截停」会静默失效；请以设置页的能力行显示为准。"
		);
	}

	// Declarative config still seeds the initial values; the Settings tab
	// overrides them at runtime without a restart.
	const declarative = config && typeof config === "object" ? config : {};
	applyRuntimeSettings(declarative);

	// --- persistence ---------------------------------------------------------
	// Stored as a plain JSON file next to the other plugin storages.  A missing
	// or corrupt file simply falls back to the shipped defaults: settings are a
	// convenience, never a reason to fail plugin startup.
	const settingsDir = join(homedir(), ".dsh", "storages");
	const settingsPath = join(settingsDir, SETTINGS_FILE);

	function loadPersistedSettings() {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	}

	function savePersistedSettings(value) {
		try {
			mkdirSync(settingsDir, { recursive: true });
			writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
			return true;
		} catch (error) {
			console.warn(`[cot-anchor] 设置写入失败：${error?.message ?? error}`);
			return false;
		}
	}

	const persisted = loadPersistedSettings();
	if (persisted) applyRuntimeSettings({ ...declarative, ...persisted });

	// --- COT harvest: storage, observer, routes ------------------------------
	// Everything below is inert until `enableHarvest` is turned on: the observer
	// returns on its first line, and the analysis route is the only caller that
	// ever reaches the LLM.
	const storageRoot = join(homedir(), ".dsh", "storages", HARVEST_DIR_NAME);
	const samplesPath = join(storageRoot, HARVEST_SAMPLES_FILE);
	const proposalsPath = join(storageRoot, HARVEST_PROPOSALS_FILE);
	const patternsPath = join(storageRoot, HARVEST_PATTERNS_FILE);
	const reportsDir = join(storageRoot, HARVEST_REPORTS_DIR);

	/** Create the storage directory; a failure is reported, never thrown. */
	function ensureStorageDir() {
		try {
			mkdirSync(storageRoot, { recursive: true });
			return true;
		} catch {
			return false;
		}
	}

	/** Read a JSON object, falling back to `fallback` on any failure. */
	function readJsonFile(path, fallback) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			return parsed && typeof parsed === "object" ? parsed : fallback;
		} catch {
			return fallback;
		}
	}

	/** Write a JSON object without a BOM; returns whether it landed. */
	function writeJsonFile(path, value) {
		try {
			ensureStorageDir();
			writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
			return true;
		} catch (error) {
			console.warn(`[cot-anchor] 写入失败 ${path}：${error?.message ?? error}`);
			return false;
		}
	}

	/** Load patterns.json into the module-level overlay. */
	function loadLearnedOverlay() {
		const raw = readJsonFile(patternsPath, null);
		learnedOverlay = {
			version: 1,
			patterns: Array.isArray(raw?.patterns) ? raw.patterns : [],
			thresholdShifts: Array.isArray(raw?.thresholdShifts) ? raw.thresholdShifts : []
		};
		return learnedOverlay;
	}

	/** Persist the current overlay. */
	function saveLearnedOverlay() {
		return writeJsonFile(patternsPath, learnedOverlay);
	}

	/** Read the pending candidate list. */
	function loadProposals() {
		const raw = readJsonFile(proposalsPath, null);
		return Array.isArray(raw?.proposals) ? raw.proposals : [];
	}

	/** Persist the pending candidate list. */
	function saveProposals(proposals) {
		return writeJsonFile(proposalsPath, { version: 1, updatedAt: Date.now(), proposals });
	}

	/** Read samples.jsonl, skipping any torn or corrupt line. */
	function readSamples() {
		let text = "";
		try {
			text = readFileSync(samplesPath, "utf8");
		} catch {
			return [];
		}
		const list = [];
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				list.push(JSON.parse(trimmed));
			} catch {
				// A torn final line is expected after a crash; skip it.
			}
		}
		return list;
	}

	/** Rewrite samples.jsonl wholesale (used by compaction and analysis). */
	function writeSamples(list) {
		try {
			ensureStorageDir();
			const body = list.map((sample) => JSON.stringify(sample)).join("\n");
			writeFileSync(samplesPath, body.length > 0 ? `${body}\n` : "", "utf8");
			return true;
		} catch (error) {
			console.warn(`[cot-anchor] 样本重写失败：${error?.message ?? error}`);
			return false;
		}
	}

	/** Samples waiting to be analyzed, counting what is still buffered. */
	const harvestBuffer = [];
	let harvestFlushTimer = null;
	let analyzeInFlight = false;

	/** Count of samples that no analysis batch has consumed yet. */
	function pendingSampleCount() {
		return readSamples().filter((sample) => sample && !sample.analyzedAt).length + harvestBuffer.length;
	}

	/** Enforce the record-count and retention-day bounds; best-effort. */
	function compactSamples() {
		try {
			const list = readSamples();
			const cutoff = Date.now() - settings.harvestRetentionDays * 86400000;
			let kept = list.filter((sample) => Number(sample?.ts) >= cutoff);
			if (kept.length > settings.harvestMaxRecords) kept = kept.slice(-settings.harvestMaxRecords);
			if (kept.length !== list.length) writeSamples(kept);
		} catch {
			// Compaction is best-effort and must never disturb collection.
		}
	}

	/** Append the debounced buffer, then compact and maybe auto-analyze. */
	function flushHarvestBuffer() {
		harvestFlushTimer = null;
		if (harvestBuffer.length === 0) return;
		const batch = harvestBuffer.splice(0, harvestBuffer.length);
		try {
			ensureStorageDir();
			appendFileSync(samplesPath, batch.map((sample) => `${JSON.stringify(sample)}\n`).join(""), "utf8");
		} catch (error) {
			console.warn(`[cot-anchor] 样本落盘失败：${error?.message ?? error}`);
			return;
		}
		compactSamples();
		if (settings.enableAutoAnalyze && pendingSampleCount() >= settings.analyzeTriggerSamples) {
			void runHarvestAnalyze().catch(() => {});
		}
	}

	/** Coalesce bursts of events into a single append. */
	function scheduleHarvestFlush() {
		if (harvestFlushTimer !== null) return;
		const delay = Math.max(500, Number(settings.harvestFlushDebounceMs) || 5000);
		harvestFlushTimer = setTimeout(flushHarvestBuffer, delay);
		if (typeof harvestFlushTimer?.unref === "function") harvestFlushTimer.unref();
	}

	/** Tool calls accumulated since the last sampled assistant settlement. */
	const pendingToolTrace = new Map();

	/**
	 * Observe one durable session event.  Called only when `enableHarvest` is
	 * on, and wrapped in try/catch by the caller so an observer failure can
	 * never disturb the session it is watching.
	 * @param {object} session
	 * @param {object} event
	 */
	function harvestOnEvent(session, event) {
		const type = event?.type;
		const sessionId = typeof session?.id === "string" ? session.id : null;
		if (type === "tool/call" || type === "tool/result") {
			if (!settings.harvestIncludeToolTrace) return;
			const key = sessionId ?? "";
			const list = pendingToolTrace.get(key) ?? [];
			const data = event?.data ?? {};
			list.push({ name: String(data.name ?? data.toolName ?? ""), isError: data.isError === true });
			if (list.length > 24) list.shift();
			pendingToolTrace.set(key, list);
			return;
		}
		if (type !== "assistant/message") return;
		const message = event?.data?.message;
		if (!message) return;
		// Never sample our own injected anchors: that would feed the plugin's own
		// text back in as if it were model reasoning (self-amplification).
		if (message.source?.plugin === PLUGIN_SOURCE.plugin) return;
		const blocks = Array.isArray(message.content) ? message.content : [];
		let reasoning = "";
		let text = "";
		for (const block of blocks) {
			if (!block || typeof block.text !== "string") continue;
			if (block.type === "reasoning") reasoning += block.text;
			else if (block.type === "text") text += block.text;
		}
		const fullVisibleText = `${reasoning}${text}`;
		const key = sessionId ?? "";
		const toolCalls = settings.harvestIncludeToolTrace ? (pendingToolTrace.get(key) ?? []) : [];
		pendingToolTrace.set(key, []);
		const source = latestAssistantSource(session) ?? {};
		const anchor = readLastAnchor(sessionId);
		harvestBuffer.push(buildHarvestSample({
			id: harvestUniqueId("smp"),
			ts: Date.now(),
			sessionId,
			workspace: typeof session?.workspace === "string" ? session.workspace : null,
			turn: Number.isFinite(event?.data?.turn) ? event.data.turn : null,
			step: Number.isFinite(event?.data?.step) ? event.data.step : null,
			provider: typeof source.provider === "string" ? source.provider : null,
			model: typeof source.model === "string" ? source.model : null,
			reasoningChars: reasoning.length,
			fullVisibleText,
			toolCalls,
			softCutFired: consumeSoftCutFlag(sessionId),
			anchorPoints: anchor?.points ?? 0,
			anchorText: anchor?.text ?? "",
			outcome: event?.data?.interrupted === true ? "interrupted" : "completed"
		}));
		scheduleHarvestFlush();
	}

	/**
	 * Persist one analysis attempt for after-the-fact inspection.
	 *
	 * The analysis call is the only place this plugin talks to a model, so when
	 * it yields nothing usable the raw reply is the only evidence of why.  The
	 * route can only carry a short error string, so the full reply, the finish
	 * reason and the token usage go to disk instead.
	 * @param {object} record - diagnostic payload.
	 * @returns {string|null} written path, or null when it could not be written.
	 */
	function writeAnalyzeDiagnostic(record) {
		const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
		const path = join(reportsDir, `analyze-${stamp}-${harvestUniqueId("diag").slice(-6)}.json`);
		try {
			mkdirSync(reportsDir, { recursive: true });
			writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
			return path;
		} catch (error) {
			console.warn(`[cot-anchor] 诊断落盘失败：${error?.message ?? error}`);
			return null;
		}
	}

	/**
	 * Run analysis until the pending backlog is drained or the run budget is
	 * spent.  A single batch has to stay small because the analysis call often
	 * inherits a reasoning model whose thinking time grows with the input, so
	 * one click loops over batches instead of asking the user to click again.
	 * @returns {Promise<object>} aggregate result for the route.
	 */
	async function runHarvestAnalyze() {
		if (analyzeInFlight) return { ok: false, error: "已有分析在进行中" };
		const startedAt = Date.now();
		const budgetMs = Math.max(0, Number(settings.analyzeRunBudgetMs) || 0);
		let analyzed = 0;
		let findings = 0;
		let batches = 0;
		let lastError = null;
		let consecutiveFailures = 0;
		for (;;) {
			if (batches > 0 && Date.now() - startedAt >= budgetMs) break;
			const result = await runAnalyzeBatch();
			if (!result.ok) {
				lastError = result.error ?? "分析失败";
				consecutiveFailures += 1;
				// A failed batch charges its samples an attempt, so retrying is
				// not a no-op: the next batch picks different samples.  The cap
				// stops a broken provider from burning the whole budget.
				if (consecutiveFailures >= HARVEST_ANALYZE_MAX_ATTEMPTS) break;
				continue;
			}
			consecutiveFailures = 0;
			lastError = null;
			batches += 1;
			analyzed += Number(result.analyzed) || 0;
			findings += Number(result.findings) || 0;
			if (result.drained) break;
		}
		if (batches === 0) return { ok: false, error: lastError ?? "没有未分析的样本" };
		return { ok: true, analyzed, findings, batches, stoppedBy: lastError ? "error" : "budget", error: lastError };
	}

	/**
	 * Run one analysis batch.  Returns a result object rather than throwing so
	 * the route can report the reason to the UI.
	 * @returns {Promise<object>}
	 */
	async function runAnalyzeBatch() {
		if (analyzeInFlight) return { ok: false, error: "已有分析在进行中" };
		if (harvestBuffer.length > 0) flushHarvestBuffer();
		const samples = readSamples();
		const unanalyzed = samples.filter((sample) => sample && !sample.analyzedAt);
		const pending = unanalyzed.filter((sample) => !harvestSampleExhausted(sample));
		if (pending.length === 0) {
			if (unanalyzed.length > 0) {
				return {
					ok: false,
					error: `剩余 ${unanalyzed.length} 条样本都已连续失败 ${HARVEST_ANALYZE_MAX_ATTEMPTS} 次，`
						+ "已跳过以免堵住积压；请检查分析模型或改用非推理模型后再试"
				};
			}
			return { ok: false, error: "没有未分析的样本" };
		}
		const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
		if (!llm || typeof llm.stream !== "function") return { ok: false, error: "llm 服务不可用" };
		const ordered = orderAnalyzeBatch(pending).slice(0, settings.analyzeMaxSamples);
		const batchText = renderAnalyzeBatch(ordered, settings.analyzeMaxInputChars);
		const newest = ordered[ordered.length - 1] ?? pending[pending.length - 1];
		const provider = settings.analyzeProvider || newest?.provider;
		const model = settings.analyzeModel || newest?.model;
		if (!provider || !model) return { ok: false, error: "无法确定分析用的 provider/model，请在设置里显式填写" };
		analyzeInFlight = true;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), settings.analyzeTimeoutMs);
		try {
			const assembler = new BlockAssembler();
			for await (const chunk of llm.stream({
				provider,
				model,
				messages: [createUserMessage({
					content: [{ type: "text", text: batchText }],
					source: PLUGIN_SOURCE
				})],
				system: HARVEST_ANALYZE_SYSTEM_PROMPT,
				maxTokens: settings.analyzeMaxTokens,
				// Deliberately NOT bound to the observed session: an analysis call
				// that re-entered the sampled session would collect its own output.
				sessionId: undefined,
				purpose: HARVEST_ANALYZE_PURPOSE,
				signal: controller.signal
			})) {
				assembler.push(chunk);
			}
			const blocks = assembler.blocks();
			const selected = selectAnalyzeOutput(blocks);
			const raw = selected.raw;
			const findings = parseHarvestFindings(raw);
			if (findings === null) {
				const diagnostic = writeAnalyzeDiagnostic({
					at: new Date().toISOString(),
					provider,
					model,
					maxTokens: settings.analyzeMaxTokens,
					timeoutMs: settings.analyzeTimeoutMs,
					batchSamples: ordered.length,
					batchChars: batchText.length,
					finish: assembler.finish,
					usage: assembler.usage ?? null,
					blocks: blocks.map((block) => ({
						type: block.type,
						chars: typeof block.text === "string" ? block.text.length : null
					})),
					textChars: selected.textChars,
					reasoningChars: selected.reasoningChars,
					parsedFrom: selected.parsedFrom,
					text: selected.parsedFrom === "text" ? raw.slice(0, 4000) : "",
					reasoningHead: selected.parsedFrom === "reasoning" ? raw.slice(0, 4000) : ""
				});
				const where = diagnostic ? `（诊断已写入 ${diagnostic}）` : "";
				// A provider or configuration failure is not this batch's fault.
				// Charging it an attempt would retire healthy samples that were
				// never actually analyzed — a one-second "unknown model" reply
				// would silently burn three good samples.  Report it verbatim
				// instead; the caller stops after the consecutive-failure limit.
				const finishFailure = describeFinishFailure(assembler.finish);
				if (finishFailure) return { ok: false, error: `${finishFailure}${where}`, raw: "" };
				// Charge the failure to this batch's samples so a batch the model
				// keeps mangling eventually stops being selected.
				const failBatch = (error, rawExcerpt) => {
					writeSamples(markAnalyzeAttempts(samples, ordered, Date.now()));
					return { ok: false, error, raw: rawExcerpt };
				};
				if (selected.parsedFrom === "none") {
					return failBatch(
						`分析模型没有返回任何内容（finish=${assembler.finish?.kind ?? "unknown"}，`
							+ `输出上限 ${settings.analyzeMaxTokens} tokens）${where}`,
						""
					);
				}
				// A truncated call is the one failure the user can fix from the
				// settings tab, so name it instead of reporting a generic parse
				// failure.  Reasoning models burn the budget before emitting any
				// text, which is exactly how an empty or half reply happens.
				// The provider does not always say "length" when it stops at the
				// cap (observed: kind "stop" with outputTokens == maxTokens and a
				// half-written JSON string), so the usage reading counts too.
				const outputTokens = Number(assembler.usage?.outputTokens);
				const hitTokenCap = Number.isFinite(outputTokens) && outputTokens >= settings.analyzeMaxTokens;
				if (assembler.finish?.kind === "length" || hitTokenCap) {
					return failBatch(
						`分析输出被 ${settings.analyzeMaxTokens} tokens 上限截断，请调大"分析输出上限"后重试${where}`,
						raw.slice(0, 400)
					);
				}
				// Aborted means the timeout fired mid-flight.  A reasoning model
				// can spend the whole window thinking and never reach its answer,
				// which is the same user-visible symptom as a truncated reply but
				// needs the opposite fix.
				if (assembler.finish?.kind === "aborted") {
					return failBatch(
						`分析在 ${settings.analyzeTimeoutMs} 毫秒超时被中止（模型仍在推理，未输出结果），`
							+ `请调大"分析超时"或改用非推理模型后重试${where}`,
						raw.slice(0, 400)
					);
				}
				return failBatch(`分析输出不是合法 JSON${where}`, raw.slice(0, 400));
			}
			const now = Date.now();
			let proposals = loadProposals();
			for (const finding of findings) proposals = mergeHarvestProposal(proposals, finding, now);
			saveProposals(proposals);
			const consumed = new Set(ordered.map((sample) => sample.id));
			writeSamples(samples.map((sample) => consumed.has(sample?.id) ? { ...sample, analyzedAt: now } : sample));
			return {
				ok: true,
				analyzed: ordered.length,
				findings: findings.length,
				drained: pending.length <= ordered.length
			};
		} catch (error) {
			// A thrown failure (network, abort, provider error) also counts as an
			// attempt, otherwise the same batch would be retried forever.
			writeSamples(markAnalyzeAttempts(samples, ordered, Date.now()));
			return { ok: false, error: String(error?.message ?? error) };
		} finally {
			clearTimeout(timer);
			analyzeInFlight = false;
		}
	}

	/**
	 * Adopt one candidate into the overlay.  Literals are self-checked against
	 * ordinary prose and compiled through the fixed template; threshold tuning
	 * is clamped to `learnedMaxShift` relative to the shipped value.
	 * @param {string} id - candidate id.
	 * @returns {object} result.
	 */
	function approveProposal(id) {
		const proposals = loadProposals();
		const index = proposals.findIndex((item) => item?.id === id);
		if (index < 0) return { ok: false, error: "候选不存在" };
		const proposal = proposals[index];
		const spec = proposal.featureSpec ?? {};
		const shadow = Number(settings.learnedShadowRounds) > 0;
		const hasThreshold = typeof spec.thresholdKey === "string" && spec.thresholdKey.length > 0;
		const hasLiterals = Array.isArray(spec.literals) && spec.literals.length > 0;
		// A false-positive candidate is a claim that a detector should NOT fire.
		// Approving it here would adopt its literals as extra trigger phrases —
		// the exact opposite of the intent. Suppression is the suppression layer's
		// job; this route refuses rather than invert the meaning.
		if (proposal.kind === "false-positive") {
			return { ok: false, error: "误报候选需要抑制通道（disable-pattern/negative-literal），本 route 不采纳" };
		}
		if (hasThreshold) {
			if (!LEARNED_TUNABLE_KEYS.includes(spec.thresholdKey)) {
				return { ok: false, error: `阈值 ${spec.thresholdKey} 无运行时读取方，采纳只会产生死数据` };
			}
		} else if (hasLiterals) {
			if (!LEARNED_LITERAL_DETECTORS.includes(proposal.detector)) {
				return { ok: false, error: `${proposal.detector} 检测器的学习字面量当前不被读取（仅 churn 生效），不予采纳` };
			}
		}
		if (typeof spec.thresholdKey === "string" && spec.thresholdKey.length > 0) {
			const base = Number(DEFAULT_SETTINGS[spec.thresholdKey]);
			const suggested = Number(spec.suggestedValue);
			if (!Number.isFinite(base)) return { ok: false, error: `未知阈值 ${spec.thresholdKey}` };
			if (!Number.isFinite(suggested)) return { ok: false, error: "候选缺少 suggestedValue" };
			const bound = Math.max(0, Number(settings.learnedMaxShift) || 0);
			const delta = Math.min(bound, Math.max(-bound, Math.round(suggested - base)));
			if (delta === 0) return { ok: false, error: "建议值与出厂值一致，无需调整" };
			learnedOverlay.thresholdShifts = [
				...(learnedOverlay.thresholdShifts ?? []).filter((item) => item?.key !== spec.thresholdKey),
				{
					key: spec.thresholdKey,
					delta,
					mode: shadow ? "shadow" : "active",
					shadowHits: 0,
					enabled: true,
					title: proposal.title,
					addedAt: Date.now()
				}
			];
		} else {
			const literals = spec.literals ?? [];
			if (literals.length === 0) return { ok: false, error: "该候选没有可编译的字面量" };
			const limit = Number(settings.learnedMaxPhrases) || LEARNED_PATTERN_DEFAULT_LIMIT;
			if ((learnedOverlay.patterns ?? []).length + literals.length > limit) {
				return { ok: false, error: `学习模式条数将超过上限 ${limit}，请先清理` };
			}
			for (const literal of literals) {
				if (!isLearnedLiteralSpecific(literal)) {
					return { ok: false, error: `字面量「${literal}」过于泛化，会作为裸词命中正常语料，不予采纳` };
				}
				const offender = selfCheckLearnedLiteral(literal);
				if (offender !== null) return { ok: false, error: `字面量「${literal}」会误伤正常语料：${offender}` };
				const compiled = compileLearnedLiteralPhrase(literal);
				if (!compiled) continue;
				learnedOverlay.patterns = [...(learnedOverlay.patterns ?? []), {
					id: harvestUniqueId("pat"),
					detector: proposal.detector,
					kind: "literal-phrase",
					literal: String(literal).slice(0, LEARNED_LITERAL_MAX_CHARS),
					regexSource: compiled.source,
					source: "learned",
					title: proposal.title,
					evidence: proposal.evidence ?? [],
					confidence: proposal.confidence ?? 0,
					addedAt: Date.now(),
					mode: shadow ? "shadow" : "active",
					shadowHits: 0,
					enabled: true
				}];
			}
		}
		if (!saveLearnedOverlay()) return { ok: false, error: "patterns.json 写入失败" };
		proposals.splice(index, 1);
		saveProposals(proposals);
		return { ok: true };
	}

	/** Drop one candidate without adopting it. */
	function rejectProposal(id) {
		const proposals = loadProposals();
		const next = proposals.filter((item) => item?.id !== id);
		if (next.length === proposals.length) return { ok: false, error: "候选不存在" };
		saveProposals(next);
		return { ok: true };
	}

	/** Patch one adopted pattern (promote to active, disable, re-enable). */
	function updatePattern(id, patch) {
		let touched = false;
		learnedOverlay.patterns = (learnedOverlay.patterns ?? []).map((pattern) => {
			if (pattern?.id !== id) return pattern;
			touched = true;
			return { ...pattern, ...patch };
		});
		if (!touched) return { ok: false, error: "模式不存在" };
		saveLearnedOverlay();
		return { ok: true };
	}

	/** Remove one adopted pattern outright. */
	function deletePattern(id) {
		const before = (learnedOverlay.patterns ?? []).length;
		learnedOverlay.patterns = (learnedOverlay.patterns ?? []).filter((pattern) => pattern?.id !== id);
		if (learnedOverlay.patterns.length === before) return { ok: false, error: "模式不存在" };
		saveLearnedOverlay();
		return { ok: true };
	}

	/** Discard every collected sample. */
	function clearSamples() {
		harvestBuffer.length = 0;
		writeSamples([]);
		return { ok: true };
	}

	/**
	 * Export the pending candidates as a markdown "harvest request" so a coding
	 * agent can fold them into the shipped constants as a normal code change.
	 */
	function exportHarvestReport() {
		const proposals = loadProposals();
		if (proposals.length === 0) return { ok: false, error: "没有待审候选可导出" };
		const lines = [
			"# COT 增补请求包",
			"",
			`生成时间：${new Date().toISOString()}`,
			"",
			"按本报告修改 `lib/index.js` 的出厂常量，走完整校验闭环后即可成为出厂默认。",
			""
		];
		for (const proposal of proposals) {
			lines.push(`## ${proposal.title || proposal.id}`, "");
			lines.push(`- 目标检测器：\`${proposal.detector}\``);
			lines.push(`- 类型：\`${proposal.kind}\``);
			lines.push(`- 置信度：${proposal.confidence}（被独立发现 ${proposal.seenCount} 次）`);
			lines.push(`- 证据样本：${(proposal.evidence ?? []).join(", ") || "（无）"}`);
			lines.push(`- 建议动作：\`${proposal.suggestedAction}\``);
			lines.push("", "观察：", "", proposal.observation || "（无）", "");
			lines.push("featureSpec：", "", "```json", JSON.stringify(proposal.featureSpec ?? {}, null, 2), "```", "");
		}
		const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
		const path = join(reportsDir, `harvest-request-${stamp}.md`);
		try {
			mkdirSync(reportsDir, { recursive: true });
			writeFileSync(path, lines.join("\n"), "utf8");
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error) };
		}
		return { ok: true, path };
	}

/** Everything the settings panel needs in one payload. */
	function harvestStatus() {
		const samples = readSamples();
		return {
			enabled: settings.enableHarvest === true,
			samples: samples.length + harvestBuffer.length,
			pending: samples.filter((sample) => sample && !sample.analyzedAt).length + harvestBuffer.length,
			lastAnalyzedAt: samples.reduce((max, sample) => Math.max(max, Number(sample?.analyzedAt) || 0), 0) || null,
			analyzing: analyzeInFlight,
			proposals: loadProposals(),
			patterns: learnedOverlay.patterns ?? [],
			thresholdShifts: learnedOverlay.thresholdShifts ?? [],
			shadowRounds: settings.learnedShadowRounds,
			paths: { samples: samplesPath, proposals: proposalsPath, patterns: patternsPath, reports: reportsDir }
		};
	}

	// Adopt whatever the user previously approved before the first event lands.
	loadLearnedOverlay();

	// The harvest route sits beside the settings route; the original route and
	// its contract are untouched.  Read the service into a local name here: the
	// settings block below declares its own `webServer` const, and referring to
	// that binding from this earlier point would hit its temporal dead zone.
	const harvestWebServer = ctx.webServer;
	if (harvestWebServer && typeof harvestWebServer.register === "function") {
		harvestWebServer.register({
			kind: "exact",
			path: HARVEST_ROUTE,
			async handler(req, res) {
				try {
					if (req.method === "GET") {
						sendJson(res, 200, { ok: true, ...harvestStatus() });
						return;
					}
					if (req.method !== "POST") {
						sendJson(res, 405, { ok: false, error: "method not allowed" });
						return;
					}
					const body = await readRequestBody(req);
					const action = String(body?.action ?? "");
					const id = typeof body?.id === "string" ? body.id : "";
					let result;
					if (action === "analyze") result = await runHarvestAnalyze();
					else if (action === "approve") result = approveProposal(id);
					else if (action === "reject") result = rejectProposal(id);
					else if (action === "promote") result = updatePattern(id, { mode: "active" });
					else if (action === "disable") result = updatePattern(id, { enabled: false });
					else if (action === "enable") result = updatePattern(id, { enabled: true });
					else if (action === "delete") result = deletePattern(id);
					else if (action === "clear") result = clearSamples();
					else if (action === "export") result = exportHarvestReport();
					else if (action === "reload") { loadLearnedOverlay(); result = { ok: true }; }
					else result = { ok: false, error: `未知动作 ${action}` };
					sendJson(res, result.ok ? 200 : 400, { ...result, ...harvestStatus() });
				} catch (error) {
					sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
				}
			}
		});
	}

	// `session/event` is an emit: the observer is fire-and-forget and its
	// failure is contained by the host, so it can never break the append it is
	// watching.  With the switch off this is the whole cost — one property read.
	ctx.on("session/event", (session, event) => {
		if (!settings.enableHarvest) return;
		try {
			harvestOnEvent(session, event);
		} catch (error) {
			console.warn(`[cot-anchor] 采集失败（已忽略）：${error?.message ?? error}`);
		}
	});

	// --- Settings tab route --------------------------------------------------
	// `webServer` is guaranteed ready by the `inject` declaration above; the
	// guard only covers a host that composes this plugin without that service.
	const webServer = ctx.webServer;
	if (webServer && typeof webServer.register === "function") {
		webServer.register({
			kind: "exact",
			path: SETTINGS_ROUTE,
			async handler(req, res) {
				try {
					if (req.method === "GET") {
						sendJson(res, 200, {
							ok: true,
							schema: SETTINGS_SCHEMA,
							settings,
							defaults: DEFAULT_SETTINGS,
							capabilities: {
								softCut: softCutProbe,
								assistantStream: streamProbe,
								softCutHook: SOFT_CUT_HOOK
							}
						});
						return;
					}
					if (req.method === "POST") {
						const body = await readRequestBody(req);
						const patch = body && typeof body.settings === "object" ? body.settings : body;
						const next = applyRuntimeSettings({ ...settings, ...(patch ?? {}) });
						const saved = savePersistedSettings(next);
						sendJson(res, 200, { ok: true, settings: next, saved });
						return;
					}
					sendJson(res, 405, { ok: false, error: "method not allowed" });
				} catch (error) {
					sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
				}
			}
		});
	}

	// Soft-cut: when the model emits a transition sentence ("接下来我要……") right
	// after already reaching conclusions within ONE generation, ask the loop to
	// split here so a fresh anchor reaches the next reasoning phase.
	//
	// 2026-10-05：该钩子自上游 0.1.5-rc.3 起已被移除。缺失时不注册这个永远
	// 不会触发的回调（避免制造"插件在正常工作"的假象），并已在上方给出明确
	// 告警。`CAPABILITY_UNKNOWN` 时照旧注册：探测失败不代表钩子不存在，
	// 宁可留下回调也不要误伤旧内核上的截停能力。
	if (softCutProbe !== CAPABILITY_ABSENT) {
		ctx.on("agent/soft-cut", async (payload, next) => {
		const upstream = await next();
		if (upstream?.kind === "cut") return upstream;
		if (!settings.enableSoftCut) return null;
		const fullText = payload?.fullVisibleText;
		if (typeof fullText !== "string") return null;

		// (1) A text-spelled tool call wins over every other trigger: it is the
		//     root cause (the model's call was never executed) and it lets us
		//     explain the format instead of only demanding that it stop.  When
		//     the same attempt is also repeating, the loop's `trimTo` is reused
		//     so the runaway copies never reach the session.
		const looping = settings.enableRepeat ? findRepeatingTail(fullText) : null;
		if (settings.enablePseudoTool && hasPseudoToolCall(fullText)) {
			noteSoftCutFired();
			return {
				kind: "cut",
				...(looping ? { trimTo: looping.trimTo } : {}),
				contexts: [buildAnchorContext(
					renderPseudoToolAnchor(looping !== null, looping),
					`cot-anchor: invalid tool-call format${looping ? ` x${looping.count}` : ""}`
				)]
			};
		}

		// (2) Degenerate loop without an invalid call in it.
		if (looping) {
			noteSoftCutFired();
			return {
				kind: "cut",
				trimTo: looping.trimTo,
				contexts: [buildAnchorContext(renderRepeatAnchor(looping), `cot-anchor: loop x${looping.count}`)]
			};
		}

		// Number runaway: a monotone-increasing run of bare numbers. Distinct
		//     from byte-repetition (findRepeatingTail above) and churn (below);
		//     cut to the run start so the runaway copies never reach the session.
		const numberRunaway = settings.enableNumberRunaway
			? detectNumberRunaway(fullText) : null;
		if (numberRunaway) {
			noteSoftCutFired();
			return {
				kind: "cut",
				trimTo: numberRunaway.trimTo,
				contexts: [buildAnchorContext(renderNumberRunawayAnchor(numberRunaway), `cot-anchor: number-runaway x${numberRunaway.chars}`)]
			};
		}

		// (3) Churn: no byte-identical cycle, but restart phrases recur at a
		//     pathological rate — the "re-analyze the same thing in new words"
		//     runaway that the period detector structurally cannot see.  Being a
		//     heuristic, it backs off inside an unclosed code fence.
		const churn = !settings.enableChurn || insideUnclosedCodeFence(fullText) ? null : detectChurn(fullText);
		if (churn) {
			// Shadow period: a cut produced ONLY by learned additions is counted
			// but not taken, so a fresh pattern cannot sever real work before the
			// user has watched it fire a few times.
			if (Number(settings.learnedShadowRounds) > 0 && isLearnedOnlyChurnTrigger(fullText)) {
				noteChurnShadowHits(fullText);
				return null;
			}
			noteSoftCutFired();
			return {
				kind: "cut",
				contexts: [buildAnchorContext(renderChurnAnchor(churn), `cot-anchor: churn x${churn.hits}`)]
			};
		}

		// (4) A→"接下来我要…"→B transition inside one generation.
		//     The cut is destructive, so it requires an EXPLICIT conclusion
		//     ("所以/因此/综上/therefore …") already present — a density-only
		//     Tier-2 sentence (a file name / number in prose) is not "phase A
		//     settled" and must never trigger a mid-stream cut.
		if (!settings.enableTransition) return null;
		if (!wantsSoftCut(fullText, MIN_REASONING_CHARS)) return null;
		if (!hasExplicitConclusion(fullText, MIN_REASONING_CHARS)) return null;
		const points = extractConclusions(fullText, MIN_REASONING_CHARS, MAX_POINTS, MAX_POINT_CHARS);
		const body = renderAnchor(points, true);
		if (!body) return null;
		noteSoftCutFired();
		return {
			kind: "cut",
			contexts: [buildAnchorContext(body, `cot-anchor: ${points.length} points (soft-cut)`)]
		};
		});
	}

	// Inject on EVERY tool post-execute on purpose: the whole point of this plugin
	// is high-frequency reminding for forgetful models (e.g. deepseek-v4.1-flash),
	// so density beats dedup.  Each injection carries its own unique random id, so
	// a long multi-tool chain merely accrues many distinct pending anchors without
	// ever colliding.
	//
	// EXCEPTION — per-session reasoning dedup: a stuck model re-emits the SAME
	// reasoning across many tool calls (observed: the same tool-call snippet
	// repeated 403 times).  Without dedup each call would stack an identical
	// anchor into the durable next-step inbox, and because that inbox only drains
	// on a SUCCESSFUL request, a chain long enough to hit the provider's context
	// limit leaves every pending anchor stuck — the next request carries them all
	// plus new ones and fails again (a dead loop).  Dedup keeps the reminder
	// mechanism untouched while collapsing the pathological case: the same
	// reasoning fingerprint injects once, a new phase injects again.
	ctx.on("tools/post-execute", async (exec, _result, next) => {
		const downstream = await next();
		if (!settings.enableToolInject) return downstream;
		if (!exec.agent?.session) return downstream;

		const reasoning = latestThinkingText(exec.agent.session);
		const fingerprint = reasoningFingerprint(reasoning);
		const sessionId = exec.agent.session.id;
		if (fingerprint !== "" && injectedReasoningBySession.get(sessionId) === fingerprint) {
			return downstream;
		}

		// Prefer a cached LLM-refined summary when available; otherwise use the
		// scoring extractor now and let the background refinement fill the cache
		// for the next time this reasoning block is injected.
		const refined = getRefinedConclusions(ctx, exec.agent.session, reasoning);
		const points = refined ?? extractConclusions(reasoning, MIN_REASONING_CHARS, MAX_POINTS, MAX_POINT_CHARS);
		const body = renderAnchor(points);
		if (!body) return downstream;

		const anchor = buildAnchorContext(body, `cot-anchor: ${points.length} points${refined ? " (llm)" : ""}`);
		// >>> 命令执行纪律（最高优先级）
		// 与推理锚点同一班车：只在锚点实际注入的那一次一起带上，沿用插件自身的
		// 推理指纹去重节奏，因此不会额外增加待处理上下文、不会随工具链无限堆叠。
		// 顺序：纪律（常量）在前、锚点（每次不同）在后。注入走尾部追加（surfaceOp:"append"），
		// 该顺序对 KV 前缀缓存无影响（两种顺序等价），常量在前仅为注入内容的排列一致性。
		const execDisciplineContext = buildAnchorContext(
			"⓪ 命令执行纪律（最高优先，高于一切）：跑任何命令（pwsh/bash/node/npm/安装/构建/下载/测试/长任务）都不许盲等，且必须核验结果。"
			+ "① 单次等待 ≤10 秒；禁止 timeout_ms≥60000 的阻塞等待、禁止 Start-Sleep/Sleep 长延时、禁止 sleep N && 检查。"
			+ "② 每轮必须查并打印一个『增长型标量』——文件/目录是否出现、字节数是否变大、日志是否追加、已下载量是否增加、输出行数是否增加。"
			+ "③ 『进程还在』『任务 state=running』不算进展证据，禁止据此继续等；连续 2 轮零增长即判僵死，"
			+ "用精确 PID 中断（禁止按命令名通配批量杀）并立刻换办法（换镜像源→换工具/协议→复用本机缓存→降级最小子集→报告用户）。"
			+ "④ 起长任务前把精确 PID 落盘。⑤ 长任务按固定短间隔（≤10 秒）轮询等待，禁止盲等。"
			+ "⑥ 命令结束必须核验：看退出码、看产物是否真的生成、看日志关键行，不以『命令跑了没报错』当成功。"
			+ "⑦ 输出为空/被吞/返回 -1 时，第一动作是读该命令本应写出的报告或产物判成功，不要追加复查命令。"
			+ "⑧ 同一命令同样参数失败最多重试 2 次，之后换办法或上报。详见 ~/.dsh/AGENTS.md 第 0 节。",
			"cot-anchor: exec-discipline"
		);
		// <<< 命令执行纪律
		rememberInjectedReasoning(sessionId, fingerprint);
		rememberLastAnchor(sessionId, points.length, body);

		if (downstream.kind === "block") {
			return {
				kind: "block",
				feedback: downstream.feedback,
				additionalContexts: [execDisciplineContext, anchor, ...(downstream.additionalContexts ?? [])]
			};
		}
		return {
			...downstream,
			additionalContexts: [execDisciplineContext, anchor, ...(downstream.additionalContexts ?? [])]
		};
	});
}

export { name, inject, apply };