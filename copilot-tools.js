import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_SNAPSHOTS = 5;
const MAX_CHAT_MESSAGES = 80;

export const COPILOT_TOOL_HELP = [
	'可用工具（需要时只输出一行 JSON，不要加解释、不要加代码块围栏）：',
	'【只读查询与诊断 · L0 直接执行】',
	'{"tool":"workbench.inspect","args":{}}  → 查看当前模块全流程状态、产物数量、审查统计与阻塞原因',
	'{"tool":"project.summary","args":{}}  → 项目资料清单（PRD / 信号 / 设计文件）',
	'{"tool":"evidence.search","args":{"query":"关键词","limit":8}}  → 检索证据，返回 E-xxxx 编号与片段',
	'{"tool":"evidence.read","args":{"id":"E-0001","offset":0,"limit":4000}}  → 读取某条证据正文',
	'{"tool":"signal.lookup","args":{"name":"<信号名或报文名>"}}  → 在信号矩阵中查信号定义、方向与枚举',
	'{"tool":"design.search","args":{"query":"<控件名>","limit":10}}  → 在设计稿里按文字/控件名搜节点',
	'{"tool":"design.node","args":{"id":"pixso.x::node::123:456"}}  → 读一个设计节点详情',
	'{"tool":"history.search","args":{"query":"<功能名>"}}  → 查历史项目定义/用例',
	'{"tool":"artifact.query","args":{"kind":"points|cases|facts|features|questions","query":"关键词","status":"approved|draft|待修改|待证据","code":"审查错误码","ids":["C-0001"],"limit":20}}  → 筛选查看模块产物',
	'{"tool":"impact.analyze","args":{"path":"prd/xxx.pdf"}}  → 分析资料变更影响哪些事实、测试点与用例',
	'',
	'【资料准备与局部改写 · L1 自动执行并留快照（>3 条批量改写自动先请用户确认）】',
	'{"tool":"materials.configure","args":{"paths":["prd/xxx.pdf","signals/xxx.xlsx"],"coverage_mode":"standard|exhaustive"}}  → 关联模块资料并更新覆盖模式',
	'{"tool":"evidence.build_and_bind","args":{}}  → 构建当前模块证据索引并自动推荐信号/UI绑定',
	'{"tool":"artifact.patch","args":{"kind":"points|cases","op":"add|update|delete","items":[{"id":"C-0001","patch":{"title":"...","precondition":"...","steps":["..."],"expected":"..."}}]}}  → 增删改指定测试点或用例',
	'{"tool":"artifact.batch_status","args":{"kind":"points|cases","action":"approve|reject","scope":"all_pending|ids","ids":["T-0001"]}}  → 批量批准或驳回条目',
	'{"tool":"review.batch_repair","args":{"case_ids":["C-0001"],"code":"PREPARE_NO_READBACK","limit":10}}  → 针对审查打回项自动生成修订并应用',
	'{"tool":"questions.resolve","args":{"resolutions":[{"id":"Q-0001","answer":"答复内容"}]}}  → 批量回答待决问题',
	'{"tool":"delivery.export","args":{"template":"standard|zentao|jira"}}  → 导出当前模块用例 Excel 并返回下载链接',
	'{"tool":"copilot.undo","args":{}}  → 撤销助手在当前模块最近一次写入修改',
	'',
	'【流水线生成与端到端编排 · 增量 L1 / 覆盖或全量 L2 确认】',
	'{"tool":"pipeline.generate","args":{"kind":"facts|features|states|points|cases","replace":false,"coverage_mode":"standard|exhaustive","point_ids":["T-0001"]}}  → 运行单个生成阶段（可指定 point_ids 局部重跑）',
	'{"tool":"pipeline.review","args":{"stage":"cases","case_ids":[],"auto_repair":true}}  → 对用例发起独立质量审查（auto_repair=true 时自动对打回项执行一轮定向返修与增量复审）',
	'{"tool":"pipeline.autopilot","args":{"coverage_mode":"standard|exhaustive","include_review":false,"export_template":"standard"}}  → 端到端自动串联：建证据→抽事实→推绑定→产测试点→批量批准→展用例→(可选)审查→导出',
	'',
	'规则：',
	'1. 遇到资料缺口、歧义或高风险决定时，输出一行：{"gate":{"question":"要问用户的一句话","options":["可选项1","可选项2"]}}',
	'2. 用户说“修这条 / 查这几条”时，优先结合首轮提供的【当前界面上下文】中的选中/勾选 ID，无需反复追问编号。',
	'3. 工具执行完拿到结果后直接用简洁中文总结结果与下一步建议，不要再输出 JSON。'
].join('\n');

export const COPILOT_TOOL_LABELS = {
	'workbench.inspect': '诊断当前模块态势',
	'project.summary': '读取项目清单',
	'evidence.search': '检索证据',
	'evidence.read': '读取证据',
	'signal.lookup': '查询信号定义',
	'design.search': '查找设计节点',
	'design.node': '读取设计节点',
	'history.search': '查找历史用例',
	'artifact.query': '筛选模块产物',
	'impact.analyze': '分析变更影响面',
	'materials.configure': '配置模块资料与覆盖模式',
	'evidence.build_and_bind': '构建证据并推荐绑定',
	'artifact.patch': '修订模块条目',
	'artifact.batch_status': '批量审批条目',
	'review.batch_repair': '批量修复审查打回项',
	'questions.resolve': '批量裁决待决问题',
	'delivery.export': '导出用例 Excel',
	'copilot.undo': '撤销上次助手修改',
	'pipeline.generate': '运行生成流水线阶段',
	'pipeline.review': '执行独立质量审查',
	'pipeline.autopilot': '端到端自动流水线'
};

/**
 * 三级安全门禁：
 * - L0: 只读查询，直接放行
 * - L1: 局部可逆写入（<=3 条直接落盘配撤销），直接放行
 * - L2: 高消耗 / 覆盖重跑 / >3 条批量修改或删除 / 端到端 autopilot -> 必须弹「执行计划确认卡」
 */
export function assessToolConfirmation(name, args = {}, context = {}) {
	if (name === 'pipeline.autopilot') {
		const mode = args.coverage_mode === 'exhaustive' ? '全覆盖模式' : '标准模式';
		const reviewText = args.include_review ? '含独立审查' : '跳过逐条审查（更快）';
		return {
			level: 'L2',
			title: '确认启动端到端自动流水线',
			question: `将按「${mode} / ${reviewText}」依次执行：构建证据 → 提取事实 → 推荐绑定 → 生成并批准测试点 → 展开用例 → 导出 Excel。是否立即开始？`,
			options: ['确认执行', '改为标准模式执行', '取消'],
			summary: `模式：${mode} · ${reviewText} · 导出模板：${args.export_template || 'standard'}`
		};
	}
	if (name === 'pipeline.generate') {
		const kind = String(args.kind || '');
		const replace = Boolean(args.replace);
		const isSubset = Array.isArray(args.point_ids) && args.point_ids.length > 0;
		const existingCount = Number(context.counts?.[kind] || 0);
		if (replace && existingCount > 0 && !isSubset) {
			return {
				level: 'L2',
				title: `确认覆盖重跑 ${kind}`,
				question: `当前模块已有 ${existingCount} 条 ${kind}，开启 replace=true 将覆盖重跑整个阶段（耗时与额度较高）。是否继续？`,
				options: ['确认覆盖重跑', '改为增量补跑（保留已有）', '取消'],
				summary: `阶段：${kind} · 现有 ${existingCount} 条 · 覆盖模式`
			};
		}
	}
	if (name === 'pipeline.review') {
		const targetCount = Array.isArray(args.case_ids) && args.case_ids.length > 0
			? args.case_ids.length
			: Number(context.counts?.cases || 0);
		if (targetCount > 60) {
			return {
				level: 'L2',
				title: '确认大批量独立审查',
				question: `本次将对 ${targetCount} 条用例逐页调用质量审查 Agent，预计耗时数分钟并消耗较多额度。是否继续？`,
				options: ['确认审查全部', '仅审查前 20 条抽检', '取消'],
				summary: `待审查用例：${targetCount} 条`
			};
		}
	}
	if (name === 'artifact.patch') {
		const items = Array.isArray(args.items) ? args.items : [];
		const op = String(args.op || 'update');
		if (items.length > 3 || (op === 'delete' && items.length > 1)) {
			const verb = op === 'delete' ? '删除' : op === 'add' ? '新增' : '批量修改';
			return {
				level: 'L2',
				title: `确认${verb} ${items.length} 条 ${args.kind || '条目'}`,
				question: `本次将${verb} ${items.length} 条记录（超过 3 条阈值），操作前会自动保存撤销快照。是否确认应用？`,
				options: ['确认应用', '取消'],
				summary: `对象：${args.kind || 'cases'} · 操作：${verb} · 数量：${items.length} 条`
			};
		}
	}
	if (name === 'review.batch_repair') {
		const limit = Math.min(Number(args.limit) || (Array.isArray(args.case_ids) ? args.case_ids.length : 10), 50);
		if (limit > 3) {
			return {
				level: 'L2',
				title: `确认批量修复打回用例（最多 ${limit} 条）`,
				question: `将针对${args.code ? `问题码 ${args.code} 的` : '选定的'}打回用例自动生成修复并落盘（最多 ${limit} 条，支持一键撤销）。是否继续？`,
				options: ['确认批量修复', '仅修复前 3 条试水', '取消'],
				summary: `筛选：${args.code || '指定用例'} · 上限：${limit} 条`
			};
		}
	}
	return null;
}

function moduleDataDir(root, projectId, moduleId) {
	const safeMod = String(moduleId || 'M-main').replace(/[^a-zA-Z0-9._-]/g, '_');
	return path.join(root, 'artifacts', projectId, 'modules', safeMod);
}

/** 保存模块级撤销快照（仅备份指定 kinds，最多保留最近 MAX_SNAPSHOTS 份） */
export async function saveCopilotSnapshot(root, projectId, moduleId, { label, kinds, files }) {
	const snapDir = path.join(moduleDataDir(root, projectId, moduleId), 'copilot-snapshots');
	await fs.mkdir(snapDir, { recursive: true });
	const id = `S-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
	const snapshot = {
		id,
		at: new Date().toISOString(),
		label: String(label || '助手修改'),
		kinds: Array.isArray(kinds) ? kinds : Object.keys(files || {}),
		files: files || {}
	};
	await fs.writeFile(path.join(snapDir, `${id}.json`), JSON.stringify(snapshot, null, 2), 'utf8');
	const entries = (await fs.readdir(snapDir)).filter((name) => name.endsWith('.json')).sort();
	while (entries.length > MAX_SNAPSHOTS) {
		const oldest = entries.shift();
		if (oldest) await fs.unlink(path.join(snapDir, oldest)).catch(() => {});
	}
	return { snapshot_id: id, label: snapshot.label, at: snapshot.at, kinds: snapshot.kinds };
}

/** 取出并消费最近一次撤销快照 */
export async function popLatestCopilotSnapshot(root, projectId, moduleId) {
	const snapDir = path.join(moduleDataDir(root, projectId, moduleId), 'copilot-snapshots');
	let entries = [];
	try {
		entries = (await fs.readdir(snapDir)).filter((name) => name.endsWith('.json')).sort();
	} catch {
		return null;
	}
	if (entries.length === 0) return null;
	const latestFile = path.join(snapDir, entries[entries.length - 1]);
	const raw = await fs.readFile(latestFile, 'utf8');
	const parsed = JSON.parse(raw);
	await fs.unlink(latestFile).catch(() => {});
	return parsed;
}

/** 模块级对话历史读取 */
export async function loadModuleChat(root, projectId, moduleId) {
	if (!projectId) return { messages: [] };
	const file = path.join(moduleDataDir(root, projectId, moduleId), 'copilot-chat.json');
	try {
		const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
		return {
			updatedAt: parsed.updatedAt || null,
			messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_CHAT_MESSAGES) : []
		};
	} catch {
		return { updatedAt: null, messages: [] };
	}
}

/** 模块级对话历史持久化 */
export async function saveModuleChat(root, projectId, moduleId, messages) {
	if (!projectId) return;
	const dir = moduleDataDir(root, projectId, moduleId);
	await fs.mkdir(dir, { recursive: true });
	const trimmed = (Array.isArray(messages) ? messages : []).slice(-MAX_CHAT_MESSAGES).map((m) => ({
		id: m.id,
		role: m.role,
		text: String(m.text || '').slice(0, 12000),
		at: m.at || new Date().toISOString(),
		...(Array.isArray(m.tools) && m.tools.length ? {
			tools: m.tools.slice(-12).map((t) => ({
				callId: t.callId,
				tool: t.tool,
				ok: t.ok,
				running: false,
				summary: String(t.summary || '').slice(0, 300),
				meta: t.meta || null
			}))
		} : {}),
		...(m.undo ? { undo: m.undo } : {}),
		...(m.download ? { download: m.download } : {})
	}));
	await fs.writeFile(path.join(dir, 'copilot-chat.json'), JSON.stringify({
		updatedAt: new Date().toISOString(),
		messages: trimmed
	}, null, 2), 'utf8');
}
