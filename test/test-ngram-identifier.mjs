/**
 * NGram 语义指纹检测器——「带数字标识符被哨兵切碎」误切修复回归测试（node:test）。
 *
 * 事故背景（session-f72141c6，2026-11-17）：
 * 模型在推理里逐条核对 MATLAB 列名映射，写了 5 行
 *   `- mins1_accY → mins1AccY_r32`
 * 旧归一化先用大写哨兵替换数字（\d+ → "DIGIT"），而词轨取词正则是 [a-z]{2,}
 * （只认小写），于是 `mins1_accY` → `minsDIGIT_accy` → 粘合 → `minsDIGITaccy`
 * 被**从中间劈成** `mins` / `accy` 两个假英文词。5 行结构相同的映射行把
 * 4-gram "mins accy mins accyr" 凑到 count=5、上下文稳定性 100%、覆盖率 16.8%，
 * 三项守卫被同一个表格形态同时满足 → 判为语义循环 → 软切 5 次
 * （turn4/step15、turn4/step16、turn5/step4、turn5/step5、turn5/step7）。
 *
 * 修复：哨兵改为小写 "digit"，与周围字母连成单个原子 token，标识符不再被切碎，
 * 4 词 gram 无法在单行内成形——这正是原设计注释「标识符必须保持原子 token」
 * 的本来意图，只是大写哨兵把它破坏了。
 *
 * 运行：node test/test-ngram-identifier.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");

globalThis.setTraceConfig ??= () => "sha256:test-trace-config";
globalThis.trace ??= {
	emit() {},
	bind() {},
	recordConfigChange() {},
	getBinding() { return null; },
	hashInput() { return "sha256:test-trace-input"; }
};
const factory = new Function(`${source}; return {
	normalizeForNGram, extractEnglishWordSegments, computeNGramFingerprint,
	detectNGramLoop, NGram_WORD_GRAM_SIZE, NGram_MIN_COUNT
};`);

function loadApi() {
	return factory();
}

/** 12 条互不相同的自然语言推进句，用来把清单夹在中间并撑过 REPEAT_MIN_TEXT_CHARS=800。
 *  两段合并后单段约 620 字符，足够把清单夹在中间。 */
const PROSE = [
	"先确认用户提到的四列在原始数据里的实际命名，避免按猜测改动脚本。",
	"接着查看 extract_accY.m 里 data_112 的读取逻辑，确认当前只取一列。",
	"然后核对 source_column_map 的规范化目标，确保映射前后能对上。",
	"再检查预设结构体里字段顺序是否与列顺序一致，防止错位。",
	"之后验证语法是否合法，用 Octave 做一次纯 parse 检查。",
	"最后把改动点列成清单，逐条确认没有遗漏再动手。",
	"补充确认：内核 heuristic 桶的计数上限需要单独查文档。",
	"另外要注意 bTrap 这一路在原始数据中是否真的存在对应列。",
	"同时确认 fins 与 ftrap 的命名大小写是否与映射目标一致。",
	"此外还要检查是否有其他脚本也引用了同一批列名。",
	"并确认这次改动不会影响已有的调用方。",
	"整体上按最小改动原则推进，先规范列名再改读取逻辑。",
	"复核阶段要把每一处改动都对回原始需求，避免顺手扩大了范围。",
	"任何不确定的命名都先查数据字典，而不是按语义猜一个近似值。",
	"如果发现文档与代码冲突，以实际运行的代码行为为准再回头修文档。",
	"回归验证要跑全量用例，只跑新增用例不足以证明没有引入回归。",
	"真实事故文本的回放是最终判据，合成样例只能覆盖已知形态。",
	"把被误切的五段推理逐段回放，确认修复前后判定从命中翻转为未命中。",
	"同时要确认反向边界：真正打转的推理不能被这次改动放过。",
	"最后把结论写进改动说明，交代根因、修复点与验证方式。",
	"任何一处判定翻转都要能追溯到具体代码行，而不是笼统地说改好了。"
].join("\n");

/** 把一组清单行夹在自然语言中间，构造出与事故同形态的尾窗文本。 */
function withList(rows) {
	return [PROSE, "映射关系如下：", ...rows, "以上映射已逐条确认，接下来按清单推进。"].join("\n");
}

// ════════════════════════════════════════════════════════════════
// 用例 1（事故原形）：列名映射清单——5 行同结构 `- a → b`，全部带数字。
// 修复前：count=5 / stability=1.00 / coverage 16.8% → 误切。
// 修复后：标识符原子化，单行只有 2 个 token，4-gram 无法成形 → 不触发。
// ════════════════════════════════════════════════════════════════
const incidentRows = [
	"- mins1_accY → mins1AccY_r32",
	"- mins2_accY → mins2AccY_r32",
	"- fins_accY → finsAccY_r32",
	"- ftrap_accY → fTrapAccY_r32",
	"- bTrap_accY → bTrapAccY_r32"
];

test("1：事故原形·列名映射清单（带数字标识符 ×5 行）→ 不触发 ngram-loop cut", () => {
	const text = withList(incidentRows);
	assert.ok(text.length >= 800, `文本需 ≥800 过入口门槛，实际 ${text.length}`);
	const api = loadApi();
	const result = api.detectNGramLoop(text);
	assert.equal(result, null,
		`列名映射清单不是语义循环，不应触发；实际命中 maxGram="${result?.maxGram}" count=${result?.count} coverage=${result?.coverage}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 2（机制断言）：哨兵必须与字母同大小写，标识符保持原子 token。
// 这是对修复本身的直接断言——比"检测不触发"更早暴露回归。
// ════════════════════════════════════════════════════════════════
test("2：带数字标识符归一化后是单个原子 token（哨兵不再劈开标识符）", () => {
	const api = loadApi();

	// 单行归一化：不应出现大写哨兵残留
	const norm = api.normalizeForNGram("- mins1_accY → mins1AccY_r32");
	assert.ok(!/DIGIT/.test(norm), `归一化后不应残留大写哨兵 DIGIT，实际 "${norm}"`);
	assert.ok(norm.includes("minsdigitaccy"),
		`mins1_accY 应归一化为含小写哨兵的连续串 minsdigitaccy，实际 "${norm}"`);

	// 词段抽取：每行只能切出 2 个 token（映射左值、右值），
	// 绝不能切出 mins / accy 这类"假英文词"
	const segs = api.extractEnglishWordSegments(incidentRows.join("\n"));
	for (const seg of segs) {
		assert.equal(seg.length, 2,
			`单行映射应只含 2 个原子 token，实际 ${seg.length} 个：${JSON.stringify(seg)}`);
		// 每个 token 必须是完整的标识符（含哨兵拼接的痕迹或整词），
		// 不允许出现事故里的碎片 "mins" / "accy" / "accyr"
		for (const tok of seg) {
			assert.ok(!["mins", "accy", "accyr", "fins", "ftrap", "btrap"].includes(tok),
				`标识符不得被切成碎片词，实际出现 "${tok}" —— 整段为 ${JSON.stringify(seg)}`);
		}
	}

	// 4 词 gram 不可能在单行内成形：每段仅 2 词 < gramSize=4
	const fp = api.computeNGramFingerprint(incidentRows.join("\n"), 5);
	assert.ok(!fp.wordFp || fp.wordFp.totalGrams === 0,
		`单行 2 token 无法组成 ${api.NGram_WORD_GRAM_SIZE}-gram，实际 totalGrams=${fp.wordFp?.totalGrams}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 3（自造泛化样例）：其他三类"成对清单"形态——文件路径、函数名对照、
// 参数表。它们与列名映射同属"结构一致的多行清单"，是同一误切机制的邻居形态，
// 必须一并确认不误报。
// ════════════════════════════════════════════════════════════════
const otherLists = {
	"文件路径清单": [
		"- D:/dsh/dsh-cot-anchor/lib/index.js",
		"- D:/dsh/dsh-cot-anchor/lib/client.js",
		"- D:/dsh/dsh-cot-anchor/test/test-ngram-word.mjs",
		"- D:/dsh/dsh-cot-anchor/package.json",
		"- D:/dsh/dsh-cot-anchor/docs/softcut-kernel-port.md"
	],
	"函数名对照表": [
		"- detectNGramLoop → 入口判定",
		"- computeNGramFingerprint → 指纹计算",
		"- extractEnglishWordSegments → 词段抽取",
		"- normalizeForNGram → 归一化",
		"- wordGramContextStability → 上下文稳定度"
	],
	"参数表": [
		"- NGram_WORD_GRAM_SIZE = 4",
		"- NGram_MIN_COUNT = 5",
		"- NGram_COVERAGE_RATIO = 0.05",
		"- NGram_CONTEXT_MIN_RATIO = 0.65",
		"- NGram_WORD_MIN_LETTERS = 10"
	]
};

for (const [name, rows] of Object.entries(otherLists)) {
	test(`3：自造样例·${name} → 不触发 ngram-loop cut`, () => {
		const text = withList(rows);
		const api = loadApi();
		const result = api.detectNGramLoop(text);
		assert.equal(result, null,
			`${name} 是结构化清单不是循环，不应触发；实际命中 "${result?.maxGram}" x${result?.count}`);
	});
}

// ════════════════════════════════════════════════════════════════
// 用例 4（防过度修复）：带数字的真循环必须仍然命中。
// 修复只应让标识符原子化，不能把"数字参与的句子骨架重复"一并放过。
// ════════════════════════════════════════════════════════════════
test("4：带数字的真循环（每轮仅数字变化）→ 仍命中", () => {
	const loop = Array.from({ length: 10 }, () =>
		"Step 42 check the file at line 17 then verify the output before continuing."
	).join(" ") + "\n" + PROSE;
	assert.ok(loop.length >= 800, `文本需 ≥800 过入口门槛，实际 ${loop.length}`);
	const api = loadApi();
	const result = api.detectNGramLoop(loop);
	assert.ok(result !== null, "带数字的句子骨架真循环仍应命中");
	assert.ok(result.count >= api.NGram_MIN_COUNT,
		`count=${result.count} 应 ≥ ${api.NGram_MIN_COUNT}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 5（防过度修复·中文轨）：中文真循环不因归一化改动而失效。
// 哨兵改动同时影响字符轨的归一化文本，必须确认字符轨判定未回归。
// ════════════════════════════════════════════════════════════════
test("5：中文真循环 → 字符 5-gram 轨仍命中", () => {
	const filler = "此外还要核对数据库连接池的空闲连接数是否低于水位线，并观察慢查询日志里有没有新增的超时条目。接口层返回的状态码与文档描述一致，但重试逻辑在并发场景下可能重复提交，需要加上幂等键来兜底。前端渲染依赖的字段名已经冻结，旧的缓存版本在下次发布时会被整体清除，不影响增量数据的读取。监控面板上的错误率曲线在凌晨出现一个尖峰，初步判断与定时任务的调度窗口重叠有关，继续跟踪即可。".repeat(4);
	const text = "让我重新分析一下这个问题，".repeat(20) + filler;
	assert.ok(text.length >= 800, `文本需 ≥800 过入口门槛，实际 ${text.length}`);
	const api = loadApi();
	const result = api.detectNGramLoop(text);
	assert.ok(result !== null, "中文真循环应命中");
	assert.ok(result.count >= api.NGram_MIN_COUNT, `count=${result.count} 应 ≥ ${api.NGram_MIN_COUNT}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 6（防过度修复·边界）：标识符密集但内容推进的技术文本——
// 大量带数字的列名/路径散布在自然语言里（非清单形态）→ 不触发。
// ════════════════════════════════════════════════════════════════
test("6：标识符密集但内容推进的技术文本 → 不触发", () => {
	const text = [
		"先读 mins1_accY 这一列，确认它在 data_112 里的取值分布是否与文档一致。",
		"再看 mins2_accY 与 fins_accY，这两列在预处理阶段会被重命名为 r32 后缀。",
		"ftrap_accY 的命名与 fTrapAccY_r32 对应，注意大小写差异不会被自动纠正。",
		"bTrap_accY 在原始数据中可能不存在，需要先确认列清单再决定是否跳过。",
		"extract_accY.m 当前只按索引 1 取列，改为按列名查找会更稳健。",
		"source_column_map 的键必须与规范化目标严格对应，否则映射会静默失败。",
		"预设结构体里的字段顺序需要与列顺序一致，避免批量赋值时错位。",
		"最后用 Octave 做一次纯 parse 检查，确认语法没有问题再提交。",
		"补充：heuristic 桶的计数上限是 6，超过就会触发 hard abort。",
		"因此这次修复必须保证不引入新的误判，否则推理会被反复截断。",
		"回归测试要同时覆盖误切消除与真循环保持两个方向。",
		"完成后再用真实事故文本回放验证，确认 5 段误切全部消除。",
		"如果回放结果与预期不符，先检查尾窗口径与入口门槛是否一致。",
		"排除环境差异之后仍然不符，才说明修复本身没有覆盖该形态。",
		"这类边界文本的价值在于它同时包含大量标识符与持续推进的内容。",
		"标识符密度高不等于循环，判据必须落在句骨架是否重复上。",
		"把这一点写进回归用例，比只在改动说明里口头强调更可靠。",
		"用例失败时要先判断是语料没到门槛，还是判定逻辑真的变了。",
		"这两类原因的处置方式完全不同，混淆会浪费大量排查时间。",
		"因此断言里一律带上实测长度，让失败原因自解释。",
		"测试文件本身也要能被下一个人读懂，注释交代事故背景与机制。",
		"每个用例只验证一件事，失败时才能一眼定位到对应机制。",
		"正向用例与反向用例成对出现，防止修复滑向另一个极端。",
		"只要判定逻辑改动过归一化层，就必须同时验证字符轨与词轨两条路径。"
	].join("\n");
	assert.ok(text.length >= 800, `文本需 ≥800 过入口门槛，实际 ${text.length}`);
	const api = loadApi();
	const result = api.detectNGramLoop(text);
	assert.equal(result, null,
		`标识符密集但内容推进不应触发；实际命中 "${result?.maxGram}" x${result?.count}`);
});
