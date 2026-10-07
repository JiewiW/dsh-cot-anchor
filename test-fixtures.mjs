/**
 * 测试夹具：从真实事故日志中固化下来的样本，内联保存。
 *
 * 为什么内联而不是读文件：这些 log 是用户手工收集的外部文件，会被改名/删除
 * （实际发生过一次：`愤怒的log.txt` 消失导致三个测试直接 ENOENT 崩溃）。
 * 测试必须自包含，不能依赖工作区里可能被移走的文件。
 */

/**
 * 伪工具调用单元（约 587 字符）：模型把 edit 工具调用写成文本，
 * DSH 不识别，于是模型反复重发，实测重复 403 次、约 23.7 万字符。
 */
export const PSEUDO_TOOL_CALL_UNIT = [
	'<seed:tool_call><function name="edit">',
	'<parameter name="file_path">D:\\proj\\sample-plugin\\lib\\client.js</parameter>',
	'<parameter name="old_string">".dsh-cc-tab[data-active=\\"true\\"]{color:var(--dsw-alias-label-primary);font-weight:500;border-bottom:2px solid var(--dsw-alias-brand-primary)}",</parameter>',
	'<parameter name="new_string">".dsh-cc-tab[data-active=\\"true\\"]{color:var(--dsw-alias-brand-primary-invert,#fff);font-weight:600;background:var(--dsw-alias-brand-primary,#3b82f6);border-bottom:none}",</parameter>',
	'</function></seed:tool_call>'
].join("");

/**
 * 短词循环单元（约 58 字符）：模型在一步思考里把
 * "OK. / Let me write. / Now. / Final. / Output. / Writing. / Go." 重复数百次。
 */
export const SHORT_CYCLE_UNIT = "OK.\n\nLet me write.\n\nNow.\n\nFinal.\n\nOutput.\n\nWriting.\n\nGo.\n\n";

/**
 * 超短周期 token 卡死单元（周期 3）：一个被损坏的 HTML 关闭标签（"</…>"）
 * 被模型反复指数喷射成 "er4er4er4…"，前面垫了一个一次性前缀 "erturnde</"。
 * 这是与尾部原文结构一致的单位：前缀 + 一个 3 字周期。
 */
export const ER4_RUN_UNIT = "erturnde</";
/** 一个完整的 3 字周期，直接用真实卡死串里的重复 token。 */
export const ER4_CYCLE = "er4";

/** 非周期的正常长前缀（每段含递增编号），用于把待测循环推到尾部并越过长度门限。 */
export function normalPrefix(segments = 120) {
	return Array.from({ length: segments }, (_, i) =>
		`第 ${i} 步：检查模块 ${i} 的状态与依赖关系，确认第 ${i} 项配置生效。`
	).join("\n");
}

/**
 * MiniMax 家族伪工具方言单元（实测 410 字节、15 个噪声单元）。
 *
 * 来源：真实事故会话 session-cc432df1-bea4-47ff-b9e0-221183ee66c6 中模型吐出的
 * 一段伪 invoke 文本，经 dsh-session-log-extract 解压后固化（该会话日志现已不在
 * 磁盘，本内联即其逐字节留存；与分析卡片
 * output/cot-anchor-budget-card/fixtures/minimax-pseudo-text.txt 双源核对一致）。
 *
 * 结构特征：
 *  - 每个标签前都插噪声单元 `]<]minimax[>[`（13 字符），共 15 个；
 *  - 外层是完整闭合的 tool_call 包裹（强模式辅助，不单独触发）；
 *  - 内含 3 个 invoke 块，其中第 3 个是**替换性损伤**原文：
 *    `<invoke name` + 噪声 + `skill">` —— `="` 被吞掉，标签是坏的，
 *    严禁"修好"它：正是这种残缺形态此前让伪工具检测器漏判（缺陷 5）。
 *
 * 校验：Buffer.byteLength === 410；噪声单元出现 15 次；
 * sha256 = 2f4ecb50a753f13a76f5c47836b064d393585a2374d807bdecc6d86d50dd1ee4。
 */
export const PSEUDO_MINIMAX_PSEUDO_UNIT = "]<]minimax[>[<tool_call>\n]<]minimax[>[<invoke name=\"skill\">]<]minimax[>[<name>no-blind-wait-polling]<]minimax[>[</name>]<]minimax[>[</invoke>\n]<]minimax[>[<invoke name=\"skill\">]<]minimax[>[<name>dsh-plugin-dev-hotrules]<]minimax[>[</name>]<]minimax[>[</invoke>\n]<]minimax[>[<invoke name]<]minimax[>[skill\">]<]minimax[>[<name>dsh-plugin-dev-kb]<]minimax[>[</name>]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>";