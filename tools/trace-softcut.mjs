/**
 * 移植工具配套的验证脚本 —— 从会话日志判断"软切是否真的发生"。
 *
 * ## 为什么要看日志而不是看界面
 *
 * 界面上"模型好像被拦了一下"无法区分两种情况：软切（切断后从断点继续）与整轮
 * 急停（回合直接结束）。会话事件里有确定性的判据：
 *
 * | 观察字段 | 软切 | 整轮急停 |
 * | --- | --- | --- |
 * | 被切前那条 assistant/message 的 `interrupted` | `false` | `true` |
 * | 同一 turn 内 `step/start` 数量 | ≥ 2 | 不产生续跑 step |
 * | `turn/end` 的 `reason.kind` | `completed` | `aborted` |
 * | 是否有插件注入的 user/message | 是 | 否 |
 *
 * ## 用法
 *
 *   node trace-softcut.mjs <session.jsonl>
 *
 * 其中 <session.jsonl> 是解包后的会话日志。DSH 的会话日志是 zstd 压缩的
 * `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`，需先解包成明文 JSONL。
 *
 * 也可以直接传入日志目录路径，本脚本会递归查找最新的 zstd 会话文件并提示
 * 你先用解包工具转换。
 *
 * @module tools/trace-softcut
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const input = process.argv[2];
if (!input) {
	console.log("用法: node trace-softcut.mjs <session.jsonl>");
	process.exit(1);
}

if (!existsSync(input)) {
	console.log(`✗ 路径不存在：${input}`);
	process.exit(1);
}

// 传入目录时，提示可用的会话日志文件。
if (statSync(input).isDirectory()) {
	console.log("检测到传入的是目录。会话日志是 zstd 压缩的，需先解包为明文 JSONL：");
	const sessionsRoot = input;
	const candidates = [];
	const walk = (dir, depth) => {
		if (depth > 3) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name.endsWith(".zstd")) candidates.push(full);
		}
	};
	walk(sessionsRoot, 0);
	for (const path of candidates.slice(0, 5)) console.log(`  ${path}`);
	console.log("");
	console.log("解包后重跑：node trace-softcut.mjs <解包出的 .jsonl>");
	process.exit(1);
}

const events = [];
for (const line of readFileSync(input, "utf8").split("\n").filter(Boolean)) {
	try {
		events.push(JSON.parse(line));
	} catch {
		// 会话可能仍在写入，末尾帧不完整属正常，忽略。
	}
}

const textOf = (message) => {
	const content = message?.content;
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
};

let index = 0;
for (const event of events) {
	index += 1;
	const { type, data } = event;

	if (["step/start", "step/end", "turn/start", "turn/end"].includes(type)) {
		const reason = data?.reason ? ` ${JSON.stringify(data.reason)}` : "";
		console.log(`[${String(index).padStart(3)}] == ${type} == turn=${data?.turn} step=${data?.step ?? ""}${reason}`);
		continue;
	}

	if (type === "assistant/message") {
		const text = textOf(data?.message);
		const finish = data?.stream?.finish?.kind ?? "";
		console.log(
			`[${String(index).padStart(3)}] ASSISTANT turn=${data?.turn} step=${data?.step} ` +
				`interrupted=${data?.interrupted === true} finish=${finish} textLen=${text.length}`
		);
		console.log(`       开头: ${JSON.stringify(text.slice(0, 40))}`);
		console.log(`       结尾: ${JSON.stringify(text.slice(-40))}`);
		continue;
	}

	if (type === "user/message") {
		const source = data?.message?.source?.kind ?? data?.source?.kind ?? "";
		const text = textOf(data?.message ?? data);
		const injected = String(source).includes("cot-anchor") || String(source).includes("plugin");
		console.log(
			`[${String(index).padStart(3)}] USER source=${source}${injected ? " ← 插件注入" : ""} ` +
				`len=${text.length} 开头=${JSON.stringify(text.slice(0, 40))}`
		);
		continue;
	}

	if (type === "agent/inbox/spliced") {
		console.log(
			`[${String(index).padStart(3)}] INBOX/SPLICED target=${data?.target} ` +
				`inserted=${data?.inserted?.length ?? 0}`
		);
	}
}

const steps = events.filter((e) => e.type === "step/start").length;
const assistant = events.filter((e) => e.type === "assistant/message").length;
const injected = events.filter(
	(e) =>
		e.type === "user/message" &&
		String(e.data?.message?.source?.kind ?? "").includes("cot-anchor")
).length;

console.log("");
console.log(`汇总: step/start=${steps}  assistant/message=${assistant}  插件注入=${injected}`);

const turns = new Map();
for (const event of events) {
	const turn = event.data?.turn;
	if (turn === undefined) continue;
	if (!turns.has(turn)) turns.set(turn, { steps: 0, assistant: 0, interrupted: 0 });
	const info = turns.get(turn);
	if (event.type === "step/start") info.steps += 1;
	if (event.type === "assistant/message") {
		info.assistant += 1;
		if (event.data?.interrupted === true) info.interrupted += 1;
	}
}

for (const [turn, info] of turns) {
	const verdict =
		info.steps >= 2 && info.assistant >= 2 && info.interrupted === 0
			? "← 符合软切特征（多步、前缀未标 interrupted）"
			: "";
	console.log(`  turn ${turn}: step=${info.steps} assistant=${info.assistant} interrupted=${info.interrupted}${verdict}`);
}
