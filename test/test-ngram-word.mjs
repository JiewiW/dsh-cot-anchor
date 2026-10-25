/**
 * NGram 语义指纹检测器——英文词级 n-gram 修复回归测试（node:test）。
 *
 * 覆盖三个修复方向：
 *  ① 英文改词级 n-gram（根治英文技术术语误报）：英文主导文本只走词级 2-gram，
 *     英文单词作为原子 token，不产生单词内部子串 gram；
 *  ② 英文技术停用词 + 下划线剥离；
 *  ③ NGram 三参数（ngramPhraseMin / ngramMinCount / ngramCoverageRatio）
 *     经 applyRuntimeSettings 接线到检测路径。
 *
 * 加载方式沿用包内既有 test-*.mjs 惯例：读 lib/index.js 源码、剥掉
 * import/export 行后用 new Function 工厂还原模块作用域。
 *
 * 运行：node test/test-ngram-word.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── 模块加载：剥 import/export 后以工厂还原 ──
let source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
source = source.replace(/^import .*$/gm, "").replace(/^export .*$/gm, "");

const factory = new Function(`${source}; return {
	normalizeForNGram, computeNGramFingerprint, computeWordBigramFingerprint,
	detectNGramLoop, NGram_STOPWORDS,
	NGram_PHRASE_MIN, NGram_MIN_COUNT, NGram_COVERAGE_RATIO,
	DEFAULT_SETTINGS, SETTINGS_SCHEMA, applyRuntimeSettings
};`);

/** 每个测试独立加载一份模块实例，避免 applyRuntimeSettings 跨用例污染模块级 let 绑定。 */
function loadApi() {
	return factory();
}

// ════════════════════════════════════════════════════════════════
// 用例 A：防误报·英文术语高频（settings×8 / entry·path·config 各 ×5），
// 各句结构不同、无真正循环 → 不得触发 ngram-loop cut。
// 文本为英文主导、总长 ≥ 8000 字符（尾窗口径固定，不依赖执行者自选尾窗长度）。
// ════════════════════════════════════════════════════════════════

const caseASentences = [
	// settings ×8（每次搭配不同动词/介词短语，不形成重复 2-gram）
	"Alpha: the settings panel exposes the api endpoint used by the dashboard widgets, and it aggregates the weekly metrics into a single chart for the operations review meeting.",
	"Bravo: review the settings section before committing the configuration changes, because the repository policy requires a second approver for any modification of the deployment files.",
	"Charlie: each settings field must be validated against the declared schema at runtime, so the loader module rejects malformed input with a clear error message instead of crashing silently.",
	"Delta: we store the settings record inside the session store for the current user context, and the active profile is picked from the cookie header when the request arrives at the gateway.",
	"Echo: call the settings loader to refresh the cached values after the update has been applied to the service, then broadcast the new snapshot to every worker node in the cluster.",
	"Foxtrot: the settings object is serialized into the profile file on shutdown, preserving the runtime choices that were made during the interactive configuration wizard.",
	"Golf: inspect the settings tree to locate the missing key in the nested structure, and report the failure code to the tracing system for the nightly regression run.",
	"Hotel: apply the settings patch only when the feature flag is enabled, and let the migration script verify the checksum before the rollout proceeds to the canary group.",
	// entry ×5
	"India: the entry point of the dispatcher service hands the request to the handler chain, then records the latency histogram and the status code for the observability dashboard.",
	"Juliet: each entry row in the audit table carries a timestamp, a principal id, and a status flag that drives the retention job running every midnight.",
	"Kilo: verify the entry marker before the parser decides which grammar rule applies to the incoming line, otherwise the token stream loses the context of the enclosing block.",
	"Lima: the first entry in the queue is the oldest one, and the worker will retry it with an exponential backoff strategy until the upstream database accepts the transaction.",
	"Mike: remove the stale entry after the collector has processed its payload and acknowledged the receipt, so the same event is never delivered twice to the downstream consumers.",
	// path ×5
	"November: the path variable in the route template must match the segment count, or the router rejects the request with a four oh four response and logs the mismatch reason.",
	"Oscar: resolve the path alias to its real location before the bundler computes the dependency graph, because the symlink indirection confuses the fingerprinting stage otherwise.",
	"Papa: the output path under the temp directory is cleaned at startup by the maintenance hook of the daemon, preventing stale artifacts from leaking into the release bundle.",
	"Quebec: trace the path traversal from the root node down to the leaf, collecting every intermediate label so the debugger can render the full ancestry of the failing assertion.",
	"Romeo: cache the canonical path keyed by the content hash, so repeated lookups do not walk the whole tree again and the cold start latency stays below the budget.",
	// config ×5（Sierra/Tango 用 "config"，其余 filler 也用 "config" 单词以达 \bconfig\b ≥5）
	"Sierra: the config object loaded at boot overrides the defaults with the values found in the environment block, and the missing keys fall back to the compiled constants.",
	"Tango: reload the config watcher when the file changes on disk, and propagate the diff to every subscribed consumer through the event bus without restarting the process.",
	"Uniform: the new config schema is versioned alongside the codebase, and the validator rejects unknown keys with a descriptive error at startup.",
	"Victor: the merged config profile is cached after the first read, and the reload endpoint invalidates the cache when the admin pushes an update.",
	"Whiskey: the diff between the old and the new config is logged at the debug level, so the audit trail explains why the service restarted overnight.",
	// filler（不同主题，保持 2-gram 多样性）
	"Xray: the consensus protocol requires a quorum of five nodes before the committee agrees on the proposed transaction, and the leader election uses a randomized timeout to break ties.",
	"Yankee: the rolling window average smooths the noisy signal while preserving the sharp transitions at the boundaries, trading a small lag for a much lower variance.",
	"Zulu: the shadow deployment mirrors the traffic to the canary instance and compares the outcome distributions in real time, flagging any drift above the alert threshold.",
	"Alpha2: the database planner reorders the join sequence based on the cardinality estimates, and the statistics refresh job keeps those estimates within the staleness window to avoid bad plans.",
	"Bravo2: the replication lag between the primary and the standby exceeds the safety margin whenever the bulk import runs, so the monitor raises the severity level to warning.",
	"Charlie2: the certificate rotation schedule overlaps with the maintenance window this quarter, forcing the ops team to coordinate the restart sequence across the whole fleet.",
	"Delta2: the flaky test suite was quarantined after the investigation traced the nondeterminism to the shared counter that the parallel workers incremented without a lock.",
	"Echo2: the memory allocator uses the arena strategy to reduce the fragmentation, but the arena reset forces a full sweep that pauses the request threads for several milliseconds.",
	"Foxtrot2: the rate limiter keys the bucket by the client subnet, so a noisy neighbor cannot starve the other tenants sharing the same edge gateway.",
	"Golf2: the query planner pushes the filter down into the storage layer, cutting the rows scanned from millions to a few thousand for the common dashboard query.",
	"Hotel2: the image pipeline rescales the thumbnails in the background queue, while the original files are moved to the cold archive after the retention period expires.",
	"India2: the anomaly detector compares the weekly seasonality profile with the current window, and it fires an alert when the deviation stays above three sigma for an hour.",
	"Juliet2: the upgrade procedure drains the connections, applies the schema migration, then restarts the worker pool before the traffic is routed back to the cluster.",
	"Kilo2: the feature matrix tracks the compatibility across the supported browsers, and the nightly job screenshots every page to catch the layout regressions early.",
	"Lima2: the budget scheduler allocates the compute quota per team, and the unused capacity is reclaimed at midnight to fund the urgent experiments.",
	"Mike2: the garbage collector switches to the concurrent mode when the heap occupancy crosses the threshold, avoiding the long pauses during the promotion cycles.",
	"November2: the wavelet decomposition separates the trend from the noise, and the reconstruction keeps only the coefficients above the energy cutoff for the compact summary.",
	"Oscar2: the bloom filter rejects the nonexistent keys with high probability, reducing the disk lookups by an order of magnitude for the sparse index workload.",
	"Papa2: the circuit breaker opens after the failure ratio exceeds the limit, and the probe requests resume the traffic once the backend recovers from the outage.",
	"Quebec2: the differential backup stores only the changed blocks since the last snapshot, shrinking the nightly transfer window from hours to minutes.",
	// 补足长度到 ≥8000
	"Sierra2: the semantic cache stores the embeddings in the vector index and evicts the least recently used entries when the memory pressure rises above the soft limit.",
	"Tango2: the canary analysis compares the conversion funnel between the variants and stops the experiment early when the result reaches the significance boundary.",
	"Uniform2: the batch processor partitions the input stream by the tenant identifier and balances the load across the worker pool with the consistent hashing scheme.",
	"Victor2: the configuration drift detector scans the fleet hourly and diffs the declared state against the live values, escalating the mismatches to the oncall channel.",
	"Whiskey2: the regression harness replays the recorded traffic against the new build and asserts that the response shapes remain compatible within the tolerance window.",
	"Alpha3: the interrupt coalescing strategy batches the hardware notifications and reduces the wakeup frequency, trading a small latency increase for a much lower power draw.",
	"Bravo3: the static analysis pipeline runs the linter, the type checker, and the vulnerability scanner in parallel, and the merge gate blocks the diff when any stage reports a blocker.",
	"Charlie3: the session affinity cookie is scoped to the origin domain and expires after one hour, so the load balancer can pin the sticky connection to the same replica.",
	"Delta3: the columnar storage engine compresses the repeated values with the run length encoding, and the scan operator skips the blocks that fall outside the predicate range.",
	"Echo3: the dead letter queue retains the poison messages for thirty days, and the replay job redelivers them after the producer fixes the serialization bug."
];

const caseAText = caseASentences.join("\n");

test("A：英文术语高频（settings×8 等）且无真正循环 → 不触发 ngram-loop cut", () => {
	assert.ok(caseAText.length >= 8000,
		`用例 A 尾窗文本长度必须 ≥8000（口径固定），实际 ${caseAText.length}`);
	assert.ok((caseAText.match(/settings/g) || []).length >= 8, "settings 出现 ≥8 次");
	for (const word of ["entry", "path", "config"]) {
		assert.ok((caseAText.match(new RegExp(`\\b${word}\\b`, "g")) || []).length >= 5,
			`${word} 出现 ≥5 次`);
	}
	const api = loadApi();
	const result = api.detectNGramLoop(caseAText);
	assert.equal(result, null,
		`英文术语高频但无循环不应触发，实际命中 maxGram=${result?.maxGram} count=${result?.count} coverage=${result?.coverage}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 B：英文主导真循环（措辞漂移型，数字归一后结构相同）→ 仍命中，
// maxGram 必须是英文词级 2-gram，count ≥ NGram_MIN_COUNT。
// ════════════════════════════════════════════════════════════════

const driftLoopText = Array.from({ length: 8 }, (_, i) =>
	`Let me re-analyze the settings path for attempt ${i} and verify the outcome again before proceeding.`
).join(" ") + "\n" + [
	"Additionally the monitoring agent samples the heap usage every ten seconds and logs the outliers to the diagnostics file for later inspection.",
	"The nightly job aggregates the access counters across the region and publishes the digest to the internal wiki before the standup meeting."
].join(" ");

test("B：英文措辞漂移型循环 → 词级 2-gram 命中", () => {
	assert.ok(driftLoopText.length >= 800, `用例 B 文本长度需 ≥800 过入口门槛，实际 ${driftLoopText.length}`);
	const api = loadApi();
	const result = api.detectNGramLoop(driftLoopText);
	assert.ok(result !== null, "真循环应命中");
	assert.ok(result.count >= api.NGram_MIN_COUNT,
		`count=${result.count} 应 ≥ NGram_MIN_COUNT=${api.NGram_MIN_COUNT}`);
	assert.match(result.maxGram, /^[a-z]+ [a-z]+$/, `maxGram="${result.maxGram}" 应是英文词级 2-gram`);
	assert.equal(result.maxGram.split(" ").length, 2, "词级 gram 恰为两个英文词");
});

// ════════════════════════════════════════════════════════════════
// 用例 C：中文真循环不回归 → 非英文主导走字符 5-gram 路径仍命中。
// 每句循环短语出现 2 次（count=16）并带独特长后缀，总长 ≥ 800 过入口门槛，
// 且 coverage = 16×5/len ≥ 0.05（len ≤ 1600 即可，本文构造 ~1100）。
// ════════════════════════════════════════════════════════════════

const chineseLoopSentence = (i) =>
	`让我重新分析一下这个问题，让我重新分析一下这个问题，第 ${i} 次检查边界条件与依赖关系后依然没有发现异常，因此需要继续验证输出目录中的残留文件与调用链上的参数传递。`;

const chineseCaseCFiller = [
	"此外还要核对数据库连接池的空闲连接数是否低于水位线，并观察慢查询日志里有没有新增的超时条目。",
	"接口层返回的状态码与文档描述一致，但重试逻辑在并发场景下可能重复提交，需要加上幂等键来兜底。",
	"前端渲染依赖的字段名已经冻结，旧的缓存版本在下次发布时会被整体清除，不影响增量数据的读取。",
	"监控面板上的错误率曲线在凌晨出现一个尖峰，初步判断与定时任务的调度窗口重叠有关，继续跟踪即可。"
].join(" ");

const caseCText = Array.from({ length: 8 }, (_, i) => chineseLoopSentence(i)).join("\n")
	+ "\n" + chineseCaseCFiller;

test("C：中文真循环（循环短语 ×16）→ 字符 5-gram 路径仍命中", () => {
	assert.ok(caseCText.length >= 800, `用例 C 文本长度需 ≥800 过入口门槛，实际 ${caseCText.length}`);
	const api = loadApi();
	const result = api.detectNGramLoop(caseCText);
	assert.ok(result !== null, "中文真循环应命中");
	assert.ok(result.count >= api.NGram_MIN_COUNT,
		`count=${result.count} 应 ≥ NGram_MIN_COUNT=${api.NGram_MIN_COUNT}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 D：下划线剥离——web_fetch 高频（×8）不误报；归一化后不再产生
// 含下划线的 gram。每句 web_fetch 搭配不同结构，避免共享 "the agent" 之类
// 非停用 2-gram。
// ════════════════════════════════════════════════════════════════

const caseDSentences = [
	"Alpha: the agent invokes web_fetch to retrieve the page for module one and parses the response headers before continuing the analysis.",
	"Bravo: we call web_fetch with the target url and decode the returned body using the standard library routine for the second module.",
	"Charlie: each web_fetch request goes through the shared proxy, and the connection pool keeps the sockets warm for the third module.",
	"Delta: the cached web_fetch result is reused when the etag matches, avoiding an extra round trip for the fourth module in the list.",
	"Echo: wrap the web_fetch invocation in a retry loop that backs off exponentially on the transient errors for the fifth module.",
	"Foxtrot: the response of web_fetch is decoded as utf eight and then validated against the schema before the sixth module consumes it.",
	"Golf: avoid blocking the worker thread when web_fetch runs, and offload the network wait to the event loop for the seventh module.",
	"Hotel: the payload returned by web_fetch is written to the temp file, and the checksum is verified before the eighth module imports it."
].join("\n");

test("D：下划线剥离——web_fetch×8 归一化后无下划线 gram 且不误报", () => {
	const api = loadApi();
	const norm = api.normalizeForNGram(caseDSentences);
	assert.ok(!norm.includes("_"), "归一化后不应再含下划线");
	const fp = api.computeNGramFingerprint(norm, api.NGram_PHRASE_MIN);
	assert.ok(fp, "指纹应可计算");
	for (const map of [fp.charFp?.gramCount, fp.wordFp?.gramCount]) {
		if (!map) continue;
		for (const g of map.keys()) {
			assert.ok(!g.includes("_"), `gram "${g}" 不应含下划线`);
		}
	}
	const result = api.detectNGramLoop(caseDSentences);
	assert.equal(result, null,
		`web_fetch 高频（工具名，非循环）不应误报，实际命中 ${JSON.stringify(result)}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 E：设置项接线·三参数全覆盖（E1/E2/E3 各用独立模块实例；
// 断言「行为变化」，即每组覆盖都实际改变检测结果）
// ════════════════════════════════════════════════════════════════

/** 英文循环文本：最高频 2-gram "please verify" count=6（含 filler 拉长过 800 门槛）。 */
const countSixLoopText = Array.from({ length: 6 }, () =>
	"Please verify the checksum of the artifact before releasing the build to the staging environment, and notify the owner by email after the smoke test completes."
).join(" ") + "\n" + [
	"Additionally the monitoring agent samples the heap usage every ten seconds and logs the outliers to the diagnostics file for later inspection.",
	"The nightly job aggregates the access counters across the region and publishes the digest to the internal wiki before the standup meeting."
].join(" ");

/** 中文循环文本：6 字单元 ×48 + 多样化中文 filler（总长 ≥800 过入口门槛）。
 *  phraseMin=5：5-gram "让我重新分" count=48、coverage=240/len ≥ 0.05 → 命中；
 *  phraseMin=8：6 字单元的 8-gram 必然跨空格 → 字符 8-gram 全被跳过 → 不命中。 */
const chineseShortLoop = "让我重新分析。".repeat(48);
const caseEFiller = [
	"配置文件的初始化顺序会影响环境变量的取值，文档里对每个阶段的说明都需要与实际日志逐一比对，任何不一致的地方都要回到配置中心确认最新的版本。",
	"告警条目里出现了两次连接超时，对应的服务在重试三次后恢复，后续观察窗口内没有新的抖动记录，于是把这条规则加入了回归用例库防止类似问题复发。",
	"查询计划在关联顺序上做了调整，基数估计来自统计信息的定时刷新任务，目前误差在可接受范围内，但索引碎片率偏高需要在下一个维护窗口重建一次。",
	"监控探针每十秒采样一次堆内存占用，异常值会写入诊断文件供离线分析使用，不阻塞主流程，同时把采样间隔作为可配置项开放给运维团队自行调整。",
	"夜间任务会把访问计数器按区域汇总，并在站会之前把摘要发布到内部维基页面供团队查阅，汇总过程对超大区域采用分片并行处理以缩短执行时间。",
	"缓存失效策略采用时间与容量双阈值，最近最少使用的条目会在内存压力升高时被优先淘汰，命中率的统计曲线在每次发布后自动对比前一周的基线值。",
	"影子部署把流量镜像到金丝雀实例，实时比较两个版本的结果分布，漂移超过阈值就会触发告警，运维团队据此决定是否立即回滚到上一个稳定版本。",
	"证书轮换计划与维护窗口本季度重叠，运维团队需要协调整个机群的重启顺序以避免服务中断，同时把每台机器的轮换状态登记到共享表格里供审计使用。"
].join(" ");

const caseEText = chineseShortLoop + "\n" + caseEFiller;

test("E1：ngramMinCount 覆盖——默认（count=6≥5）触发，ngramMinCount=10 不触发", () => {
	const api = loadApi();
	assert.equal(api.DEFAULT_SETTINGS.ngramMinCount, 5, "默认 ngramMinCount=5");
	assert.ok(api.detectNGramLoop(countSixLoopText) !== null, "默认阈值下应触发");
	const ret = api.applyRuntimeSettings({ ngramMinCount: 10 });
	assert.equal(ret.ngramMinCount, 10, "applyRuntimeSettings 返回对象含新值");
	assert.equal(api.detectNGramLoop(countSixLoopText), null, "ngramMinCount=10 时 count=6 不触发");
});

test("E2：ngramCoverageRatio 覆盖——默认阈值触发，ngramCoverageRatio=0.5 不触发", () => {
	const api = loadApi();
	assert.equal(api.DEFAULT_SETTINGS.ngramCoverageRatio, 0.05, "默认 ngramCoverageRatio=0.05");
	assert.ok(api.detectNGramLoop(countSixLoopText) !== null, "默认覆盖率阈值下应触发");
	const ret = api.applyRuntimeSettings({ ngramCoverageRatio: 0.5 });
	assert.equal(ret.ngramCoverageRatio, 0.5, "applyRuntimeSettings 返回对象含新值");
	assert.equal(api.detectNGramLoop(countSixLoopText), null, "ngramCoverageRatio=0.5 时覆盖率不足不触发");
});

test("E3：ngramPhraseMin 覆盖——默认 phraseMin=5 触发，ngramPhraseMin=8 不触发（滑窗粒度变化生效）", () => {
	const api = loadApi();
	assert.equal(api.DEFAULT_SETTINGS.ngramPhraseMin, 5, "默认 ngramPhraseMin=5");
	assert.ok(api.detectNGramLoop(caseEText) !== null, "默认字符 5-gram 下中文循环应触发");
	const ret = api.applyRuntimeSettings({ ngramPhraseMin: 8 });
	assert.equal(ret.ngramPhraseMin, 8, "applyRuntimeSettings 返回对象含新值");
	assert.equal(api.detectNGramLoop(caseEText), null, "ngramPhraseMin=8 时 6 字单元的 8-gram 全跨空格 → 不触发");
});

// ════════════════════════════════════════════════════════════════
// 接线完整性：DEFAULT_SETTINGS 键、SETTINGS_SCHEMA 条目、默认值在 schema 范围内
// ════════════════════════════════════════════════════════════════

test("接线：DEFAULT_SETTINGS 含 ngram* 三键且默认值在 SETTINGS_SCHEMA 范围内", () => {
	const api = loadApi();
	assert.equal(api.DEFAULT_SETTINGS.ngramPhraseMin, 5);
	assert.equal(api.DEFAULT_SETTINGS.ngramMinCount, 5);
	assert.equal(api.DEFAULT_SETTINGS.ngramCoverageRatio, 0.05);
	for (const key of ["ngramPhraseMin", "ngramMinCount", "ngramCoverageRatio"]) {
		const entry = api.SETTINGS_SCHEMA.find((item) => item.key === key);
		assert.ok(entry, `SETTINGS_SCHEMA 应含 ${key} 条目`);
		assert.equal(entry.type, "number");
		assert.equal(entry.group, "重复循环参数");
		assert.equal(entry.advanced, true);
		const value = api.DEFAULT_SETTINGS[key];
		assert.ok(value >= entry.min && value <= entry.max,
			`默认值 ${value} 必须在 schema 范围 [${entry.min}, ${entry.max}] 内（避免设置页 clamp）`);
	}
	// applyRuntimeSettings 空对象：默认值发布不改变三绑定行为（默认仍触发）
	const api2 = loadApi();
	api2.applyRuntimeSettings({});
	assert.ok(api2.detectNGramLoop(countSixLoopText) !== null, "空设置后默认阈值行为不变");
});

// ════════════════════════════════════════════════════════════════
// 用例 F（本次修复核心盲区）：中英混合文本——中文为主体、英文术语分散高频
// 复用（session/anchor/settings/tool），内容逐句推进、无真正循环。
// 修复前：字符 5-gram 轨把英文词内部子串（sessi/ancho）独立计数 → 误触发
// （本会话实测复现 count 16 / coverage 8.8%）。修复后：字符轨隔离纯英文
// gram、词轨并行但需整词对重复达标 → 不得触发。
// ════════════════════════════════════════════════════════════════

const caseFSentences = [
	"先看 session 的创建流程，确认 anchor 在会话里如何被注入，settings 的默认值来自哪里。",
	"接着对比 tool 的注册表，session 对象在运行时持有哪些字段，anchor 的渲染函数何时被调用。",
	"settings 里 enableRepeat 为假时，session 的注入路径是否还走 anchor 的检测分支。",
	"从源码看 tool 调用链，session 上下文里的 anchor 文本来自上次思考的结论区。",
	"验证 settings 改动后是否需要重启，session 持久化文件的位置在 profile 目录下。",
	"检查 anchor 是否在工具结果后注入，session 的尾窗大小由 settings 的窗口参数控制。",
	"对照 tool 的返回格式，session 里 anchor 的注入不改变原始结果的内容。",
	"确认 settings 的重复检测阈值，session 的 ngram 指纹在 anchor 决策前计算。",
];

test("F：中英混合（术语高频、内容推进）→ 不触发 ngram-loop cut（词内子串隔离 + 词轨并行）", () => {
	const api = loadApi();
	let text = "";
	for (let i = 0; i < 30; i++) text += caseFSentences[i % 8] + "\n";
	while (text.length < 800) text += caseFSentences[0] + "\n"; // 过入口门槛
	const result = api.detectNGramLoop(text);
	assert.equal(result, null, `中英混合无真循环不应触发，实际 ${JSON.stringify(result)}`);
});

// ════════════════════════════════════════════════════════════════
// 用例 G（词轨并行）：中英混合但英文整词对真循环（"verify anchor" ×N 反复，
// 两个词均非英文停用词）→ 即使英文不占主导（中文主体）也必须经词轨命中，
// 不得因 englishDominant 互斥漏检。词轨选词需避让停用词表（call/tool 均在
// 表中会被 pickHighestNonStopwordBigram 过滤），故用 verify/anchor。
// ════════════════════════════════════════════════════════════════

test("G：中英混合英文整词对真循环 → 词轨并行命中", () => {
	const api = loadApi();
	const loop = "我需要 verify anchor 再来 verify anchor 检查结果，然后 verify anchor 重复这个过程，继续 verify anchor 直到拿到答复。";
	let text = "";
	for (let i = 0; i < 60; i++) text += loop + "\n";
	while (text.length < 800) text += loop + "\n";
	const result = api.detectNGramLoop(text);
	assert.ok(result !== null, `英文整词对真循环应命中，实际 ${JSON.stringify(result)}`);
	assert.equal(result.maxGram.split(" ").length, 2, "词轨 gram 恰为两个英文词");
	assert.equal(result.maxGram, "verify anchor", "命中词对应为 verify anchor");
});
