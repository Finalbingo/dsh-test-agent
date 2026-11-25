/**
 * Artifacts: product facts → test points → test cases.
 *
 * Pure data handling plus prompt construction. Model calls live in index.js so
 * the store stays testable without a provider.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { currentModule, surfaces, defaultSurface, signalPrefixes, termsPattern, configTerms, dutNode } from './scope.js';
import { buildWorkbook, buildXlsx } from './xlsx.js';
import { caseFigurePath, renderVisual } from './case-visuals.js';
import { compose } from './skills.js';
import { stepDigest, stepKey } from './steps.js';
import { buildStructuredCase, validateAnchors, withSourceGaps, renderLegacyFields } from './case-structure.js';
import { formatSemanticDesignEvidence, stripDesignComponentPrefix } from './evidence.js';

const KINDS = ['facts', 'points', 'cases'];

export function artifactsDir(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule());
}

export async function load(dataRoot, projectId, kind) {
	try {
		return JSON.parse(await fs.readFile(path.join(artifactsDir(dataRoot, projectId), `${kind}.json`), 'utf8'));
	} catch {
		return { version: 0, updatedAt: null, items: [] };
	}
}

/** Keep the previous revision on disk before an overwrite; cheap undo and audit trail. */
export async function archive(dataRoot, projectId, kind) {
	const dir = path.join(artifactsDir(dataRoot, projectId), 'revisions');
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(artifactsDir(dataRoot, projectId), `${kind}.json`);
	try {
		const text = await fs.readFile(file, 'utf8');
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		await fs.writeFile(path.join(dir, `${kind}-${stamp}.json`), text, 'utf8');
		const entries = (await fs.readdir(dir)).filter((name) => name.startsWith(`${kind}-`)).sort();
		for (const stale of entries.slice(0, Math.max(0, entries.length - 20))) {
			await fs.unlink(path.join(dir, stale)).catch(() => {});
		}
		return true;
	} catch {
		return false;
	}
}

/** Stable digest over the content that matters, used to detect stale references. */
export function digestOf(items) {
	return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
}

export async function save(dataRoot, projectId, kind, document) {
	const dir = artifactsDir(dataRoot, projectId);
	await fs.mkdir(dir, { recursive: true });
	const next = {
		version: (document.version || 0) + 1,
		updatedAt: new Date().toISOString(),
		digest: digestOf(document.items),
		...(document.meta || {}),
		items: document.items
	};
	const target = path.join(dir, `${kind}.json`);
	const staging = target + '.' + crypto.randomUUID() + '.tmp';
	try {
		await fs.writeFile(staging, JSON.stringify(next, null, 1), 'utf8');
		await fs.rename(staging, target);
	} finally {
		await fs.rm(staging, { force: true });
	}
	return next;
}

const list = (value) => (Array.isArray(value) ? value : []).filter((item) => item && typeof item === 'object');
const strings = (value) => (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string');
const text = (value) => String(value ?? '').trim();

export const FACT_TYPES = ['feature', 'state', 'control', 'signal', 'rule', 'criterion'];

/** Task half of the prompt: payload + three-source context + output schema (rules come from the skill). */
export function factTask(items, projectName, history = [], context = null) {
	const normalizedItems = (items || []).map((item) => formatSemanticDesignEvidence(item, context?.designMeta || {}));
	const block = normalizedItems.map((item) => `[${item.id}]（${item.source} · ${item.location}）\n${item.text}`).join('\n\n---\n\n');
	const historyBlock = history.length === 0 ? '' : [
		'历史参照（旧项目对同类功能的定义，只用于理解术语与边界，严禁写入 evidence_refs 或直接照抄）：',
		...history.map((item) => `- [${item.id}] ${item.statement}`),
		''
	].join('\n');
	const signalLines = (context?.signals || []).map((sig) => {
		const parts = [`${sig.name}${sig.description ? `（${sig.description}）` : ''}`, `${sig.message}/${sig.message_id}`];
		if (sig.direction) parts.push(sig.direction);
		if (sig.valueDesc) parts.push(`取值：${sig.valueDesc}`);
		return `- ${parts.join('｜')}`;
	});
	const designLines = (context?.design || []).map((line) => `- ${line}`);
	const refBlock = [
		signalLines.length ? ['本批涉及的协议/信号定义参考（用于核对拼写、方向与枚举；引用仍以本次证据编号为准）：', ...signalLines, ''].join('\n') : '',
		designLines.length ? ['本项目已索引的 UI 页面与控件语义参考（仅用于对齐本批 PRD 证据中的界面入口与控件业务名；请勿在非设计稿批次中脱离本批证据单独为参考列表批量罗列控件事实；不得把设计节点几何尺寸或内部组件分类标记当作功能需求，同名候选歧义保留待核）：', ...designLines, ''].join('\n') : ''
	].filter(Boolean).join('\n');
	return [
		`当前项目：${projectName}。下面是要处理的证据片段，每条都有编号。`,
		historyBlock,
		refBlock,
		'输出 JSON：{"facts":[{"type":"feature|state|control|signal|rule|criterion","statement":"…","evidence_refs":["E-0001"]}]}',
		'',
		block
	].filter(Boolean).join('\n');
}

export function factPrompt(items, projectName, context = null) {
	return compose('cts-facts', factTask(items, projectName, [], context));
}

export function pointPrompt(facts, projectName, machines = [], context = null) {
	const block = facts.map((fact) => `[${fact.fact_id}]（${fact.type}）${fact.statement}  ← ${(fact.evidence_refs || []).join(',')}`).join('\n');
	const machineBlock = machines.length === 0 ? '' : [
		'',
		'该批事实所属功能点的状态机（测试点应覆盖有证据的状态转移与约束）：',
		...machines.map((machine) => [
			`${machine.feature_id} ${machine.name}`,
			`  状态：${machine.states.map((state) => `${state.state_id}=${state.name}`).join('，')}`,
			...machine.transitions.map((transition) => {
				const from = machine.states.find((state) => state.state_id === transition.from)?.name || transition.from;
				const to = machine.states.find((state) => state.state_id === transition.to)?.name || transition.to;
				const cond = transition.conditions?.length ? ` [前提：${transition.conditions.join('；')}]` : '';
				const act = transition.actions?.length ? ` → 动作：${transition.actions.join('；')}` : '';
				return `  [${transition.transition_id}] ${from}→${to}：${transition.trigger}${cond}${act}`;
			})
		].join('\n'))
	].join('\n');
	const surfaceList = surfaces();
	const controlLines = (context?.controls || []).map((c) => {
		const biz = c.businessName || c.name;
		const comp = c.componentName && c.componentName !== biz ? `组件 ${c.componentName}` : '';
		const pg = c.page ? `位于 ${c.page}` : '';
		const meta = [comp, pg].filter(Boolean).join('，');
		return `${biz}${meta ? `（${meta}）` : ''}`;
	});
	const ambiguousLines = (context?.ambiguousControls || []).map((c) => `${c.name}（同名候选待核：${(c.candidates || []).join(' vs ')}）`);
	const signalLines = (context?.signals || []).map((s) =>
		`${s.name}（${s.message}/${s.message_id}${s.direction ? `，${s.direction}` : ''}${s.valueDesc ? `，取值：${s.valueDesc}` : ''}）`);
	const closedLoopLines = (context?.closedLoopCells || []).map((cell) =>
		`- [${cell.cell_id}] 入口「${cell.entry_label}」× 分支「${cell.branch_label}」：${cell.instruction}（必须引用事实：${cell.required_fact_refs.join('、')}）`);
	const hasPassiveSyncRule = facts.some((f) => /(?:无操作|不操作|未操作).*?(?:不发|不外发|不发送).*?(?:根据输入|按照输入).*?显示/.test(f?.statement || ''));
	const passiveSyncHint = (closedLoopLines.length && hasPassiveSyncRule)
		? '- 此外，本批全局规则含「用户无操作时不发送控制信号，根据输入反馈信号显示对应状态」：须同时为本批适用入口对象生成 1 条「用户无操作（不操作该开关），输入状态反馈信号并观察对应显示和控制报文：不发送控制信号，根据输入反馈信号显示对应状态」的独立测试点。'
		: '';
	const exhaustiveLines = context?.coverageMode === 'exhaustive' && Array.isArray(context?.exhaustiveHints) && context.exhaustiveHints.length
		? ['【全枚举/全组合展开模式已开启】请按下列有证据依据的展开维度逐项拆出独立测试点（不得合并成单条抽样点）：', ...context.exhaustiveHints.map((h) => `- ${h}`)].join('\n')
		: '';
	const standardBlock = context?.standardSpec
		? `【通用测试规范参考（仅作为压力/组合/电气/异常处理等测试设计检查清单，不得编造超出本模块范围的功能，fact_refs 仍须引用下方产品事实编号）】：\n${String(context.standardSpec).slice(0, 3500)}`
		: '';
	const contextBlock = [
		surfaceList.length ? `本项目声明的界面/入口表面：${surfaceList.join('、')}` : '',
		controlLines.length ? `已对齐 UI 控件（正文使用 PRD 业务名，组件关联由系统维护）：${controlLines.join('、')}` : '',
		ambiguousLines.length ? `同名候选待核 UI 控件（存在歧义，保留待核，不得自动消解）：${ambiguousLines.join('；')}` : '',
		signalLines.length ? `已对齐协议信号（含方向与枚举，不得互换请求与反馈）：${signalLines.join('；')}` : '',
		closedLoopLines.length ? ['本批涉及的全局通信闭环规则×适用入口×结果分支（每个格子必须单独生成一条可独立追溯的测试点，严禁把多个互斥分支合并到同一条测试点）：', ...closedLoopLines, passiveSyncHint].filter(Boolean).join('\n') : '',
		exhaustiveLines,
		standardBlock
	].filter(Boolean).join('\n');
	return compose('cts-test-design',
		`当前项目：${projectName}。下面是从项目资料抽出的产品事实，每条有编号。`,
		contextBlock,
		'输出 JSON：{"points":[{"requirement":"功能名","condition":"…","action":"…","expected":"…","type":"请求发送|状态显示|边界|异常恢复|联动","priority":"P0|P1|P2","fact_refs":["F-0001"],"transition_ref":""}]}',
		'',
		block,
		machineBlock
	);
}

export function caseVariant(item) {
	const role = item.case_role || 'primary';
	return item.point_id && role !== 'primary' ? `${item.point_id}/${role}` : item.point_id || item.case_id;
}

export function casePrompt(points, projectName, hints = {}) {
	const surface = defaultSurface();
	const block = points.map((point) => {
		const hint = hints[point.point_id] || {};
		const controls = (hint.controls || []).map((item) => {
			const biz = item.businessName || item.name;
			const comp = item.componentName && item.componentName !== biz ? `组件 ${item.componentName}` : '';
			const realStates = (item.states || []).filter((s) => s && s !== '变体' && s !== 'state_variant');
			const meta = [comp, item.page ? `页面 ${item.page}` : '', realStates.length ? `已知状态 ${realStates.join('/')}` : '', item.node_id ? `节点 ${item.node_id}` : ''].filter(Boolean).join('，');
			return `${biz}${meta ? `（${meta}）` : ''}`;
		}).join('、');
		const ambiguousControls = (hint.ambiguousControls || []).map((c) => `${c.name}（候选：${(c.candidates || []).join(' vs ')}）`).join('；');
		const signals = (hint.signals || []).map((item) => {
			const meta = [
				`${item.message}/${item.message_id}`,
				item.direction || '方向待核',
				item.cycle ? `周期 ${item.cycle}ms` : '',
				item.initial ? `矩阵上电初值 ${item.initial}` : '',
				item.invalid ? `无效值 ${item.invalid}` : '',
				item.valueDesc ? `枚举 ${item.valueDesc}` : ''
			].filter(Boolean).join('，');
			return `${item.name}（${meta}）`;
		}).join('；');
		const fbAttr = hint.feedbackAttribution;
		const fbLines = [];
		if (fbAttr) {
			if (fbAttr.status === 'unique_feedback' && fbAttr.attributions?.length) {
				for (const attr of fbAttr.attributions) {
					fbLines.push(`  - 目标初态「${attr.object}=${attr.target_state}」具有唯一独立反馈证据：必须在 prepare_items[].read_back 中写明「${attr.read_back_template}」`
						+ (attr.matrix_initial ? `（注意区分：矩阵默认初值为 ${attr.matrix_initial}，本例所需目标初态对应反馈取值为 ${attr.target_enum}）` : '')
						+ (attr.forbidden_request_signals?.length ? `；严禁在 prepare_items 或步骤中把被测方外发请求信号 ${attr.forbidden_request_signals.join('、')} 当作初态回读或结果反馈` : ''));
				}
			} else if (fbAttr.status === 'only_request') {
				fbLines.push(`  - 初态回读约束：本功能仅有被测方外发请求信号（${(fbAttr.forbidden_request_signals || []).join('、')}），无独立对端状态反馈信号；严禁读回被测方外发请求信号充当初态证据，请优先通过材料明确的独立上级状态确认初态，确无可观测手段时保留具体缺口。`);
			} else if (fbAttr.status === 'ambiguous_feedback' || fbAttr.status === 'insufficient_feedback') {
				fbLines.push(`  - 初态回读约束：${fbAttr.reason || '存在多个候选反馈信号、方向未知或枚举不足'}；不得臆造唯一反馈信号或无依据取值，请优先使用材料明确的独立上级状态确认初态，确无可观测手段时保留具体缺口。`);
			} else if (fbAttr.status === 'pure_ui') {
				fbLines.push('  - 初态回读约束：纯界面场景无协议信号，请通过独立上级页面/容器状态确认初态，不得仅用待测最终结果自身做循环前置。');
			}
		}
		const figures = (hint.figures || []).map((item) => `${item.role} · ${item.name}${item.node_id ? `（节点 ${item.node_id}）` : ''}`).join('、');
		const source = point.source || {};
		// 逐条回执优先：按错误码做键会把同码多项压成一条，退回意见就漏了。
		const returned = (hint.review?.findings || []).map((entry) => `  - ${entry.code}${entry.field ? `（${entry.field}）` : ''}：${entry.message}`
			+ (entry.evidence_ref && entry.quote ? `｜依据 ${entry.evidence_ref}：${entry.quote}` : '')
			+ (entry.suggestion ? `｜修订建议：${entry.suggestion}` : ''));
		const returnedLegacy = Object.entries(hint.review?.fields || {}).map(([code, message]) => `  - ${code}：${message}`);
		const returnedLines = returned.length ? returned : returnedLegacy;
		const checklist = (point.expected_items || []).map((entry) => {
			const timing = !entry.delay_s ? '' : entry.since ? `，自${entry.since}起${entry.delay_s}s` : `，${entry.delay_s}s，计时起点待确认`;
			return `  - [${entry.id}] ${entry.kind} · 对象「${entry.object}」应为「${entry.target}」${entry.frames ? `，连续${entry.frames}帧` : ''}${timing}${entry.blocking ? `　【阻断缺口】本项无法判定，写进 deferred_items，不要为它写观察步骤：${entry.unresolved}` : entry.unresolved ? `　已知缺口（必须写进 unresolved）：${entry.unresolved}` : ''}　原文：${entry.quote || ''}`;
		}).join('\n');
		return [
			`[${point.point_id}] ${point.requirement}`,
			source.quote ? `冻结原文（${source.location || ''}）：${source.quote}` : '',
			`初态（条件，不是步骤）：${point.condition}`,
			point.branch_status === 'needs_decision' || point.open_question ? `未决字段：${point.open_question || point.rule_reason}——该项保留缺口，不得写成确定判据` : '',
			`触发：${hint.variant?.action || point.action}`,
			checklist ? `必须逐项覆盖的判据清单：\n${checklist}` : `预期：${point.expected}`,
			`优先级：${point.priority}`,
			hint.retryRoles?.length ? `只重做以下用例角色，逐条原样填写 case_role：${hint.retryRoles.join('、')}` : '',
			hint.retryPaths?.length ? '各角色对应的原始触发保持一致：' + JSON.stringify(hint.retryPaths) : '',
			hint.variant ? `只展开已选触发路径，case_role 原样填写 ${hint.variant.case_role}。其余原文路径留给独立用例。` : '',
			controls ? `可用 UI 控件（正文使用 PRD 业务名，节点 ID 与组件前缀仅用于系统关联图证，不要写进步骤文案）：${controls}` : '',
			ambiguousControls ? `同名候选待核 UI 控件（存在歧义，保留待核，不得自动消解）：${ambiguousControls}` : '',
			signals ? `已核对信号（含方向与枚举，不得把反馈当请求）：${signals}` : '',
			fbLines.length ? `准备项（prepare_items）独立反馈回读指引：\n${fbLines.join('\n')}` : '',
			figures ? `配图：${figures}` : '',
			hint.missingFigures ? `缺图判据：${hint.missingFigures}` : '',
			hint.review ? `【上一版内容评审退回，必须逐条改掉】原用例 ${hint.review.case_id}：\n${returnedLines.join('\n') || hint.review.basis}\n只改被点名的字段与其连带项，未被点名的合格写法保持不变。` : ''
		].filter(Boolean).join('\n');
	}).join('\n\n');
	return compose('cts-case-authoring',
		`当前项目：${projectName}；默认界面入口：${surface}。请按上方 Skill 规范，每条测试点生成一条用例（输出完整结构化字段）。`,
		'输出 JSON：{"cases":[{"point_id":"T-0001","case_role":"按指定角色填写，常规用 primary","title":"…","type":"…","priority":"P0","precondition":"…",'
		+ '"prepare_items":[{"key":"p1","text":"…","object":"…","target":"…","establish":"如何建立","read_back":"从哪里读回哪个独立反馈信号及取值，并与哪个 UI 状态核对","on_failure":"…"}],'
		+ '"steps":[{"key":"click","role":"action","text":"…"},{"key":"read","role":"observe","text":"…"}],'
		+ '"expected_items":[{"key":"e1","assertion_ref":"判据清单里方括号内的 ID，原样照抄","trigger":"click","observe":"read","object":"…","target":"…","kind":"沿用清单 kind，如 ui_immediate、can_request、can_feedback、ui_feedback、ui_feedback_30s 或 state_observation","evidence_ref":"本版原文引用","frames":0,"since":"","delay_s":0,"unresolved":""}],'
		+ '"restore_items":[{"key":"r1","text":"…","baseline":"…","read_back":"…","on_failure":"…"}],'
		+ '"deferred_items":[{"assertion_ref":"清单判据 ID","object":"…","target":"…","kind":"…","evidence_ref":"本版原文引用","frames":0,"since":"","delay_s":0,"unresolved":"为什么现在判不了"}],'
		+ '"failure_policy":"…","basis":"依据测试点 T-0001、事实 F-0001"}]}',
		`本轮硬契约：触发前基线读回写入 prepare_items（有唯一对端反馈信号时必须在 prepare_items[].read_back 写明从哪里读哪个反馈信号及支持本例目标初态的取值，并与对应 UI 状态核对；严禁读回被测方外发请求信号充当初态证据，严禁把触发前基线推到 steps 第一步 S01）；正文控件名统一使用可追溯到 PRD 的业务名（不得将设计节点几何尺寸或内部组件分类标记写进步骤或预期）；steps 每步以地点开头（如「在${surface}…／在原始采集记录中…／在采集工具中…／在本版原文文档中…」），每条界面观察步最多一对【】且与对应 object 逐字一致；expected_items 的 trigger/observe 必须引用 steps.key，每条 expected_items 与 deferred_items 必填 evidence_ref，判据清单每项均须按原 assertion_ref 落入 expected_items 或 deferred_items（标【阻断缺口】者落入 deferred_items）。`,
		block
	);
}

/** Strip fences, find the first JSON object. */
export function parseJson(textValue) {
	let value = String(textValue || '').trim();
	value = value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	const start = value.indexOf('{');
	const end = value.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(value.slice(start, end + 1));
	} catch {
		return null;
	}
}

export function mergeFacts(existing, raw, evidenceIds, options = {}) {
	const key = (value) => String(value || '')
		.normalize('NFKC')
		.replace(/[\s，。；：、,.!?！？;:"'“”()（）【】\[\]]/g, '')
		.toLowerCase();
	const seen = new Set(existing.map((fact) => key(fact.statement)));
	const designEvidenceIds = options?.designEvidenceIds instanceof Set ? options.designEvidenceIds : null;
	const added = [];
	for (const item of list(raw?.facts)) {
		let statement = text(item.statement)
			.replace(/对应的?\s*state_variant\s*外观/gi, '对应状态外观')
			.replace(/\bstate_variant\b/gi, '状态变体');
		const refs = strings(item.evidence_refs).map(text).filter((ref) => evidenceIds.has(ref));
		if (designEvidenceIds && refs.length > 0 && refs.every((ref) => designEvidenceIds.has(ref))) {
			statement = statement
				.replace(/[（(，、；\s]*(?:尺寸(?:为)?|宽高(?:为)?|大小(?:为)?)?\s*\d+(?:\.\d+)?\s*[×xX*]\s*\d+(?:\.\d+)?(?:\s*(?:px|像素))?[)）]?/gi, '')
				.replace(/\s+/g, ' ')
				.trim();
		}
		if (statement === '' || refs.length === 0 || seen.has(key(statement))) continue;
		seen.add(key(statement));
		added.push({
			type: FACT_TYPES.includes(item.type) ? item.type : 'feature',
			statement,
			evidence_refs: [...new Set(refs)],
			status: 'candidate'
		});
	}
	return added;
}

const pointText = (value) => text(value).normalize('NFKC').replace(/\s+/g, ' ').replace(/[。;；]+$/, '').trim();

const pointKey = (point) => JSON.stringify([
	pointText(point.condition), pointText(point.action), pointText(point.expected), text(point.transition_ref)
]);

export function checkPointQuality(points, factIds, transitionIds) {
	const findings = {};
	const scenarios = new Map();
	for (const point of points) {
		const messages = [];
		const refs = strings(point.fact_refs);
		if (!refs.length) messages.push('缺少来源事实，补上能支持条件和预期的 F 编号。');
		else if (refs.some((ref) => !factIds.has(ref))) messages.push('来源事实已失效，请核对 F 编号。');
		if (!text(point.condition) || !text(point.action) || !text(point.expected)) messages.push('补全前置条件、动作和预期。');
		if (point.transition_ref && transitionIds.size && !transitionIds.has(point.transition_ref)) messages.push('状态转移编号无效，请核对模型。');
		if (/^(?:验证|检查|确认|观察|测试)(?:该|此|相关)?(?:功能|状态|结果)(?:是否)?(?:正常|正确|符合预期)?[。！!]*$/.test(text(point.action))) {
			messages.push('动作只描述验证目标，请写清怎么触发。');
		}
		if (/(?:显示|恢复|保持)(?:为)?对应状态|符合预期|符合(?:需求|设计)|^(?:正常|无异常|通过)[。！!]*$/.test(text(point.expected))) {
			messages.push('预期含模糊判据，请写明实际要观察的状态、取值或时限。');
		}
		const feature = point.feature_id || point.requirement;
		if (feature && text(point.condition) && text(point.action)) {
			const key = JSON.stringify([pointText(feature), pointText(point.condition), pointText(point.action), text(point.transition_ref)]);
			const previous = scenarios.get(key);
			if (previous) {
				messages.push(pointKey(previous) === pointKey(point)
					? `与 ${previous.point_id} 的条件、动作和预期相同，可复核后合并。`
					: `与 ${previous.point_id} 的条件和动作相同，请确认预期能否合并或是否缺了分支条件。`);
			} else scenarios.set(key, point);
		}
		if (messages.length) findings[point.point_id] = messages;
	}
	return findings;
}

export function mergePoints(existing, raw, factIds, { requireEvidence = false, transitionIds } = {}) {
	const seen = new Set(existing.map(pointKey));
	const added = [];
	const sanitizePointField = (v) => text(v)
		.replace(/对应的?\s*state_variant\s*外观/gi, '对应状态外观')
		.replace(/\bstate_variant\b/gi, '状态变体');
	for (const item of list(raw?.points)) {
		const condition = sanitizePointField(item.condition);
		const action = sanitizePointField(item.action);
		const expected = sanitizePointField(item.expected);
		const refs = [...new Set(strings(item.fact_refs).map(text).filter((ref) => factIds.has(ref)))];
		const transition = text(item.transition_ref);
		const transition_ref = transitionIds && !transitionIds.has(transition) ? '' : transition;
		if (!condition || !action || !expected || (requireEvidence && !refs.length)) continue;
		const key = pointKey({ condition, action, expected, transition_ref });
		if (seen.has(key)) continue;
		seen.add(key);
		const entry = {
			requirement: sanitizePointField(item.requirement) || '未命名功能',
			condition,
			action,
			expected,
			type: text(item.type) || '请求发送',
			priority: ['P0', 'P1', 'P2', 'P3'].includes(item.priority) ? item.priority : 'P1',
			transition_ref,
			fact_refs: refs,
			status: 'candidate'
		};
		if (item.closed_loop_cell && typeof item.closed_loop_cell === 'object') {
			entry.closed_loop_cell = item.closed_loop_cell;
		}
		added.push(entry);
	}
	return added;
}

function matchesAssertionObject(source, entry) {
	if (!source) return false;
	if (source.kind?.startsWith('can_')) return text(source.object) === text(entry.object);
	const normalize = (value) => text(value).replace(/[【】\s/]/g, '').replace(/(?:显示|状态)+$/, '');
	const sourceObject = normalize(source.object);
	const entryObject = normalize(entry.object);
	if (sourceObject === entryObject) return true;
	// 上游测试点的判据对象常只写到泛称或整句条件（「显示」「图标」「丢失报文恢复正常之后」），
	// 用例把它细化成可观察对象并登记了出处/缺口，这不是错引用。只在来源对象确实不可直接观察、
	// 用例对象确实更具体且带出处或缺口说明时放行；其余仍保持严格比对，避免掩盖挂错判据。
	const rawSource = text(source.object);
	const rawEntry = text(entry.object);
	const GENERIC_SOURCE = /^(?:显示|状态|界面|页面|弹窗|图标|按键|相关显示|目标显示|显示内容|反馈)$/;
	const vague = GENERIC_SOURCE.test(rawSource)
		|| /[，。；、]/.test(rawSource)
		|| (rawSource.length >= 10 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawSource) && !/[【】]/.test(rawSource));
	if (!vague) return false;
	const concrete = /[【】]/.test(rawEntry)
		|| /^[A-Za-z][A-Za-z0-9_]*$/.test(entryObject)
		|| /(?:图标|显示|开关|按键|调节条|弹窗|状态|模式|界面|信号)$/.test(rawEntry)
		|| entryObject.length > sourceObject.length + 1;
	if (!concrete) return false;
	return Boolean(entry.unresolved || entry.evidence_ref);
}

function protocolKindMismatch(source, entry) {
	return (source?.kind === 'can_request' || source?.kind === 'can_feedback') && entry.kind !== source.kind;
}

/** Reports why a candidate case never made it in — silent drops hide real gaps. */
export function mergeCasesDetailed(existing, raw, pointIds, pointMap = new Map()) {
	const seen = new Set(existing.map((item) => JSON.stringify([item.point_id, item.case_role || 'primary'])));
	const added = [];
	const dropped = [];
	for (const item of list(raw?.cases)) {
		const pointId = text(item.point_id);
		const point = pointMap.get(pointId);
		const title = text(item.title);
		const role = text(item.case_role) || 'primary';
		const identity = JSON.stringify([pointId, role]);
		const structured = Array.isArray(item.expected_items) || Array.isArray(item.deferred_items)
			|| (Array.isArray(item.steps) && item.steps.some((step) => step && typeof step === 'object'));
		const stepTexts = (Array.isArray(item.steps) ? item.steps : []).map((step) => typeof step === 'string' ? text(step) : text(step?.text)).filter(Boolean);
		const expected = structured
			? list(item.expected_items).map((entry) => text(entry.text) || `${text(entry.object)}：${text(entry.target)}`).filter(Boolean).join('\n')
			: text(item.expected).trim();
		const steps = stepTexts;
		const hasPointAssertions = Array.isArray(point?.expected_items) && point.expected_items.length > 0;
		const deferredOnly = expected ? [] : list(item.deferred_items).filter((entry) => text(entry.unresolved)
			&& (!hasPointAssertions || point.expected_items.some((source) => source.id === entry.assertion_ref)));
		const reason = !pointIds.has(pointId) ? 'POINT_MISSING'
			: title === '' ? 'TITLE_MISSING'
			: expected === '' ? (deferredOnly.length ? 'NO_EXECUTABLE_ASSERTIONS' : 'EXPECTED_EMPTY')
			: steps.length === 0 ? 'STEPS_EMPTY'
			: seen.has(identity) ? 'DUPLICATE' : '';
		if (reason !== '') {
			dropped.push({ point_id: pointId, reason, ...(reason === 'NO_EXECUTABLE_ASSERTIONS' ? {
				assertion_refs: [...new Set(deferredOnly.map((entry) => text(entry.assertion_ref)))],
				issues: deferredOnly.map((entry) => ({ message: text(entry.unresolved) }))
			} : {}) });
			continue;
		}
		const derivedRefs = point && Array.isArray(point.fact_refs) ? point.fact_refs.join(';') : '';
		const evidenceId = text(point?.source?.evidence_id);
		const frozenBasis = evidenceId ? [`依据测试点 ${pointId}`, evidenceId, text(point.source.location)].filter(Boolean).join(' · ') : '';
		const base = {
			point_id: pointId,
			case_role: role,
			prepare_detail: text(item.prepare_detail),
			restore_steps: strings(item.restore_steps).map(text).filter(Boolean),
			failure_policy: text(item.failure_policy),
			verification: text(point?.verification) || text(item.verification),
			title,
			type: text(item.type) || '请求发送',
			priority: ['P0', 'P1', 'P2', 'P3'].includes(item.priority) ? item.priority : 'P1',
			precondition: text(item.precondition),
			steps: steps.map((step, index) => /^\d+[.、]/.test(step) ? step : `${index + 1}. ${step}`),
			expected,
			signals: strings(item.signals).map(text).filter(Boolean),
			feature_id: point?.feature_id || '',
			module: text(item.module) || '',
			basis: frozenBasis || text(item.basis) || (point ? `依据测试点 ${pointId}：${point.condition || ''}` : ''),
			source_reference: [evidenceId, evidenceId ? derivedRefs : text(item.source_reference) || derivedRefs, ...(point?.contract_refs || [])].filter(Boolean).join(';'),
			review_status: '草稿'
		};
		if (structured) {
			let candidate = item;
			if (point?.expected_items?.some((entry) => entry.binding_blocked)) {
				const blocked = point.expected_items.filter((entry) => entry.binding_blocked);
				const executableRefs = new Set(list(item.expected_items).map((entry) => entry.assertion_ref));
				const competing = blocked.filter((entry) => executableRefs.has(entry.id) ||
					list(item.expected_items).some((output) => !output.assertion_ref && output.kind === entry.kind && output.object === entry.object));
				if (competing.length) {
					dropped.push({ point_id: pointId, reason: 'SIGNAL_BINDING_UNRESOLVED', assertion_refs: competing.map((entry) => entry.id),
						issues: competing.map((entry) => ({ message: entry.unresolved })) });
					continue;
				}
				const ids = new Set(blocked.map((entry) => entry.id));
				candidate = { ...item, deferred_items: [...list(item.deferred_items).filter((entry) => !ids.has(entry.assertion_ref)
					&& !blocked.some((source) => !entry.assertion_ref && source.kind === entry.kind && source.object === entry.object)),
				...blocked.map((entry) => ({ ...entry, assertion_ref: entry.id }))] };
			}
			const built = buildStructuredCase(candidate, point, null);
			const executable = new Set(built.expected_items.map((entry) => entry.assertion_ref));
			const deferred = new Set(built.deferred_items.map((entry) => entry.assertion_ref));
			const missing = (point?.expected_items || []).filter((entry) => entry.id
				&& !deferred.has(entry.id) && (entry.blocking || !executable.has(entry.id)));
			if (missing.length) {
				dropped.push({ point_id: pointId, reason: 'ASSERTION_COVERAGE_MISSING', assertion_refs: missing.map((entry) => entry.id) });
				continue;
			}
			const anchorErrors = validateAnchors(built).filter((issue) => issue.severity === 'error' &&
				(point?.expected_items?.length || ['CAPTURE_NOT_RECORDING', 'TRIGGER_MISSING', 'OBSERVATION_MISSING',
					'OBSERVATION_OBJECT_MISMATCH', 'OBSERVATION_WRONG_SURFACE', 'PREPARE_UNAVAILABLE_INPUT'].includes(issue.code)));
			if (anchorErrors.length) {
				dropped.push({ point_id: pointId, reason: anchorErrors[0].code, issues: anchorErrors });
				continue;
			}
			const checklist = new Map((point?.expected_items || []).map((entry) => [entry.id, entry]));
			const assertions = [...built.expected_items, ...built.deferred_items];
			const wrongKinds = assertions.filter((entry) => protocolKindMismatch(checklist.get(entry.assertion_ref), entry));
			if (wrongKinds.length) {
				dropped.push({ point_id: pointId, reason: 'ASSERTION_PROTOCOL_KIND_MISMATCH', assertion_refs: wrongKinds.map((entry) => entry.assertion_ref),
					issues: wrongKinds.map((entry) => ({ message: `判据 ${entry.assertion_ref} 必须保留 ${checklist.get(entry.assertion_ref).kind}，收到 ${entry.kind}` })) });
				continue;
			}
			const wrongReferences = checklist.size ? assertions.filter((entry) => !matchesAssertionObject(checklist.get(entry.assertion_ref), entry)) : [];
			if (wrongReferences.length) {
				dropped.push({ point_id: pointId, reason: 'ASSERTION_REF_MISMATCH',
					assertion_refs: wrongReferences.map((entry) => entry.assertion_ref),
					issues: wrongReferences.map((entry) => ({ message: checklist.has(entry.assertion_ref)
						? `判据 ${entry.assertion_ref} 的 object 必须保留「${checklist.get(entry.assertion_ref).object}」，收到「${entry.object}」`
						: `对象「${entry.object}」使用了当前清单未提供的引用「${entry.assertion_ref}」` })) });
				continue;
			}
			const wrongFrameCounts = assertions.filter((entry) => {
				const source = checklist.get(entry.assertion_ref);
				return source?.kind === 'can_request' && (Number(source.frames) || 0) !== entry.frames;
			});
			if (wrongFrameCounts.length) {
				dropped.push({ point_id: pointId, reason: 'ASSERTION_FRAME_COUNT_MISMATCH', assertion_refs: wrongFrameCounts.map((entry) => entry.assertion_ref) });
				continue;
			}
			const wrongWindows = assertions.filter((entry) => {
				const source = checklist.get(entry.assertion_ref);
				return source && (Number(source.delay_s) || 0) !== entry.delay_s;
			});
			if (wrongWindows.length) {
				dropped.push({ point_id: pointId, reason: 'ASSERTION_WINDOW_MISMATCH',
					assertion_refs: wrongWindows.map((entry) => entry.assertion_ref),
					issues: wrongWindows.map((entry) => ({ message: `判据 ${entry.assertion_ref} 的时限应保持来源规定的 ${checklist.get(entry.assertion_ref).delay_s || '未规定'}，观察步骤引用原文计时事件。` })) });
				continue;
			}
			Object.assign(base, {
				step_items: built.step_items, expected_items: built.expected_items,
				prepare_items: built.prepare_items, restore_items: built.restore_items,
				deferred_items: built.deferred_items,
				steps: built.steps, expected: built.expected,
				prepare_detail: built.prepare_detail, restore_steps: built.restore_steps,
				precondition: built.precondition, structured: true
			});
		}
		seen.add(identity);
		added.push(base);
	}
	return { added, dropped };
}

export function mergeCases(existing, raw, pointIds, pointMap = new Map()) {
	return mergeCasesDetailed(existing, raw, pointIds, pointMap).added;
}

/** Deterministic checks; the agent sees these as a linter, not a generator. */
const signalName = () => new RegExp(`(?:${signalPrefixes().map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)'})[A-Za-z0-9_]+`);
const MESSAGE_REF = /\(0x[0-9A-Fa-f]+(?:\/\d+)?\)|0x[0-9A-Fa-f]+/;

const stripAnchor = (value) => String(value ?? '').replace(/^S\d+(?:[-.]\d+)*\.?\s*/, '').replace(/^\d+[.、)]\s*/, '').trim();

/** A single step copied from the point's action is not an expanded case. */
export function isPointCopy(item, point) {
	if (!point) return false;
	const steps = item.steps || [];
	return steps.length === 1
		&& stripAnchor(steps[0]) === stripAnchor(point.action)
		&& stripAnchor(item.expected) === stripAnchor(point.expected);
}

export function lint(cases, pointIds, factIds, pointById = null) {
	const errors = [];
	const idCount = new Map();
	for (const item of cases) idCount.set(item.case_id, (idCount.get(item.case_id) || 0) + 1);
	cases.forEach((item, index) => {
		const at = `cases[${index}]`;
		if (idCount.get(item.case_id) > 1) errors.push({ at, code: 'DUPLICATE_CASE_ID', message: `用例编号重复：${item.case_id}`, severity: 'error' });
		if (!pointIds.has(item.point_id)) errors.push({ at, code: 'POINT_MISSING', message: `来源测试点不存在：${item.point_id}`, severity: 'error' });
		if (!item.expected || item.expected.trim() === '') {
			// 全部延期时不能说「缺少预期结果」就算完：要列出延期了哪些义务，否则看不出测试义务去哪了。
			const deferred = (item.deferred_items || []).map((entry) => `${entry.object}：${entry.unresolved || entry.target}`).filter(Boolean);
			errors.push({
				at, code: deferred.length ? 'ALL_ASSERTIONS_DEFERRED' : 'EXPECTED_EMPTY',
				message: deferred.length ? `本例已无可执行判据，全部义务延期：${deferred.join('；')}` : '缺少预期结果',
				severity: 'error'
			});
		}
		if (strings(item.steps).length === 0) errors.push({ at, code: 'STEPS_EMPTY', message: '缺少测试步骤', severity: 'error' });
		const point = pointById?.get?.(item.point_id);
		if (isPointCopy(item, point)) errors.push({ at, code: 'POINT_COPY', message: '用例把测试点动作复制成唯一步骤、预期原样照抄，未展开为可执行操作与逐项判据', severity: 'error' });
		if (item.structured || (item.expected_items || []).some((entry) => entry.trigger_step_id !== undefined)) {
			for (const issue of validateAnchors(item)) errors.push({ ...issue, at: `${at}.${issue.at}` });
		}
		const checklist = new Map((point?.expected_items || []).filter((entry) => entry.id).map((entry) => [entry.id, entry]));
		if (checklist.size) {
			for (const entry of [...(item.expected_items || []), ...(item.deferred_items || [])]) {
				if (!entry.assertion_ref) continue;
				const source = checklist.get(entry.assertion_ref);
				if (protocolKindMismatch(source, entry)) errors.push({ at, code: 'ASSERTION_PROTOCOL_KIND_MISMATCH', message: `判据 ${entry.id} 必须保留来源通信方向 ${source.kind}，收到 ${entry.kind}`, severity: 'error' });
				if (matchesAssertionObject(source, entry)) continue;
				errors.push({ at, code: 'ASSERTION_REF_MISMATCH', message: `判据 ${entry.id} 的引用 ${entry.assertion_ref} 不对应本测试点的对象 ${entry.object}`, severity: 'error' });
			}
		}
		// 原文标为阻断缺口的判据必须落在待裁决项里，不能被悄悄丢掉。
		for (const entry of point?.expected_items || []) {
			if (!entry.blocking) continue;
			const kept = (item.deferred_items || []).some((deferred) => deferred.assertion_ref
				? deferred.assertion_ref === entry.id
				: deferred.object === entry.object && (!deferred.kind || deferred.kind === entry.kind));
			if (!kept) errors.push({ at, code: 'DEFERRED_ITEM_MISSING', message: `原文阻断缺口项未登记为待裁决：${entry.object}（${entry.unresolved || ''}）`, severity: 'error' });
		}
		// 判据里的业务数值必须能在本版原文找到；报文 ID 与信号名里的数字不算业务数值。
		if (point) {
			const bare = (value) => String(value || '').replace(/0x[0-9A-Fa-f]+/g, ' ').replace(/[A-Za-z][A-Za-z0-9_]*\d[A-Za-z0-9_]*/g, ' ');
			const sourceNumbers = new Set([...bare(`${point.source?.quote || ''} ${point.condition || ''} ${(point.expected_items || []).map((entry) => entry.quote).join(' ')}`)
				.matchAll(/\d+(?:\.\d+)?/g)].map((hit) => hit[0]));
			for (const entry of item.expected_items || []) {
				sourceNumbers.add(String(entry.frames || ''));
				sourceNumbers.add(String(entry.delay_s || ''));
				const invented = [...bare(entry.target).matchAll(/\d+(?:\.\d+)?/g)].map((hit) => hit[0]).filter((value) => !sourceNumbers.has(value));
				if (invented.length) errors.push({ at: `${at}.expected_items[${entry.id}]`, code: 'NUMBER_UNSUPPORTED', message: `原文无此数值：${invented.join('、')}（目标：${entry.target}）`, severity: 'error' });
			}
		}
		const refs = `${item.basis || ''} ${item.source_reference || ''}`.match(/[FE]-\d{4}/g) || [];
		if (refs.length === 0) errors.push({ at, code: 'NO_REF', message: '依据里没有任何证据或事实编号', severity: 'error' });
		for (const ref of refs) {
			if (ref.startsWith('F-') && factIds.size > 0 && !factIds.has(ref)) errors.push({ at, code: 'FACT_MISSING', message: `引用了不存在的事实：${ref}`, severity: 'error' });
		}
		const text = `${(item.steps || []).join(' ')} ${item.expected || ''}`;
		if (signalName().test(text) && !MESSAGE_REF.test(text)) {
			errors.push({ at, code: 'SIGNAL_NOT_SPECIFIC', message: '提到了信号，但没有报文 ID(0x..) 或具体取值，无法照做', severity: 'warning' });
		}
		for (const match of text.matchAll(/[【\[]([^】\]]{2,16})[】\]]/g)) {
			const name = match[1];
			const bound = (item.controls || []).some((entry) => entry.name === name || entry.name.includes(name) || name.includes(entry.name));
			if (!bound) errors.push({ at, code: 'UNBOUND_CONTROL', message: `控件未绑定：${name}`, severity: 'warning' });
		}
		if (Array.isArray(item.signals) && item.signals.length === 0 && /[A-Z][A-Za-z0-9_]{4,}/.test(text)) {
			errors.push({ at, code: 'UNBOUND_SIGNAL', message: '步骤或预期提到了信号，但没有已绑定的信号', severity: 'warning' });
		}
		if (item.steps && item.steps.length === 1 && /验证|检查/.test(item.steps[0]) && !/点击|操作|发送|注入|切换|进入/.test(item.steps[0])) {
			errors.push({ at, code: 'STEP_NOT_OPERABLE', message: '步骤只有"验证/检查"，不可执行', severity: 'error' });
		}
	});
	return errors;
}

const CASE_COLUMN_SPECS = [
	{ key: 'case_id', header: '用例ID', width: 18, get: (item, index) => item.case_id || index + 1 },
	{ key: 'module', header: '模块', width: 14, get: (item) => item.module || '' },
	{ key: 'feature_id', header: '功能点ID', width: 12, get: (item) => item.feature_id || '' },
	{ key: 'point_id', header: '来源测试点ID', width: 16, get: (item) => item.point_id || '' },
	{ key: 'title', header: '用例标题', width: 34, get: (item) => item.title || '' },
	{ key: 'type', header: '用例类型', width: 12, get: (item) => item.type || '' },
	{ key: 'priority', header: '优先级', width: 8, get: (item) => item.priority || '' },
	{ key: 'precondition', header: '前置条件', width: 40, get: (item) => item.precondition || '' },
	{ key: 'steps', header: '操作步骤', width: 44, get: (item) => (item.steps || []).join('\n') },
	{ key: 'expected', header: '预期结果', width: 40, get: (item) => item.expected || '' },
	{ key: 'restore_steps', header: '恢复步骤', width: 40, get: (item) => (item.restore_steps || []).join('\n') },
	{ key: 'prepare_detail', header: '准备明细', width: 28, get: (item) => item.prepare_detail || '' },
	{ key: 'signals', header: '待验证信号', width: 26, get: (item) => (item.signals || []).join('、') },
	{ key: 'images', header: '图片证据', width: 28, get: (item) => figureSummary(item) },
	{ key: 'source_feature_id', header: '来源功能点ID', width: 14, get: (item) => item.feature_id || '' },
	{ key: 'source_reference', header: '来源引用', width: 30, get: (item) => item.source_reference || '' },
	{ key: 'review_conclusion', header: '评审结论', width: 12, get: (item) => item.review_conclusion || '待评审' },
	{ key: 'review_comment', header: '修改意见', width: 24, get: (item) => item.review_comment || '' },
	{ key: 'reviewer', header: '评审人', width: 12, get: (item) => item.reviewer || '' },
	{ key: 'gaps', header: '待完善项', width: 40, get: (item) => (item.gaps || []).join('；') },
	{ key: 'basis', header: '依据说明', width: 40, get: (item) => item.basis || '' }
];

const CASE_COLUMN_BY_KEY = new Map(CASE_COLUMN_SPECS.map((col) => [col.key, col]));

export const EXPORT_TEMPLATES = {
	standard: {
		label: '标准完整模板（21 列）',
		columns: CASE_COLUMN_SPECS.map(({ key, header }) => ({ key, label: header }))
	},
	zentao: {
		label: '禅道导入模板',
		columns: [
			{ key: 'case_id', label: '用例编号' },
			{ key: 'module', label: '所属模块' },
			{ key: 'title', label: '用例标题' },
			{ key: 'precondition', label: '前置条件' },
			{ key: 'steps', label: '步骤' },
			{ key: 'expected', label: '预期' },
			{ key: 'priority', label: '优先级' },
			{ key: 'type', label: '用例类型' },
			{ key: 'signals', label: '关键词/信号' },
			{ key: 'basis', label: '相关需求/依据' }
		]
	},
	jira: {
		label: 'Jira / TestRail 精简模板',
		columns: [
			{ key: 'case_id', label: 'Case ID' },
			{ key: 'module', label: 'Module' },
			{ key: 'title', label: 'Summary' },
			{ key: 'priority', label: 'Priority' },
			{ key: 'type', label: 'Type' },
			{ key: 'precondition', label: 'Preconditions' },
			{ key: 'steps', label: 'Steps' },
			{ key: 'expected', label: 'Expected Result' },
			{ key: 'restore_steps', label: 'Cleanup / Restore' },
			{ key: 'signals', label: 'Signals' },
			{ key: 'source_reference', label: 'Reference' }
		]
	}
};

export const CASE_COLUMN_KEYS = CASE_COLUMN_SPECS.map(({ key, header }) => ({ key, label: header }));

const CASE_COLUMNS = CASE_COLUMN_SPECS.map(({ header, get }) => [header, get]);

function resolveExportColumns(options = {}) {
	if (Array.isArray(options?.columns) && options.columns.length) {
		const resolved = options.columns
			.map((entry) => {
				const key = typeof entry === 'string' ? entry.trim() : String(entry?.key || '').trim();
				const spec = CASE_COLUMN_BY_KEY.get(key);
				if (!spec) return null;
				const label = typeof entry === 'object' && String(entry?.label || '').trim() ? String(entry.label).trim() : spec.header;
				return { ...spec, header: label };
			})
			.filter(Boolean);
		if (resolved.length) return resolved;
	}
	const tplKey = String(options?.template || 'standard');
	const tpl = EXPORT_TEMPLATES[tplKey] || EXPORT_TEMPLATES.standard;
	return tpl.columns
		.map(({ key, label }) => {
			const spec = CASE_COLUMN_BY_KEY.get(key);
			return spec ? { ...spec, header: label || spec.header } : null;
		})
		.filter(Boolean);
}

/** 图对位：稳定 ID 优先，旧数据才用显式步骤号；对不上返回 mapped:false，不猜第一步。 */
export function figurePlacement(item, figure) {
	const steps = item.steps || [];
	const stepItems = (item.step_items || []).length === steps.length ? item.step_items : [];
	const expectedItems = item.expected_items || [];
	if (figure.step_id && stepItems.length) {
		const at = stepItems.findIndex((entry) => entry.id === figure.step_id);
		return at >= 0 ? { step: at + 1, mapped: true } : { step: 0, mapped: false, reason: '步骤已变化' };
	}
	if (figure.expected_id && expectedItems.length) {
		const entry = expectedItems.find((expected) => expected.id === figure.expected_id);
		const at = Number(entry?.step_index || 0);
		if (entry && !at) return { step: 0, mapped: true };
		if (entry && at <= steps.length) return { step: at, mapped: true };
		return { step: 0, mapped: false, reason: '预期已变化' };
	}
	const legacy = Number(figure.step || 0);
	if (!legacy) return { step: 0, mapped: true };
	return legacy <= steps.length ? { step: legacy, mapped: true } : { step: 0, mapped: false, reason: '步骤已变化' };
}

function figureSummary(item) {
	if (!Array.isArray(item.image_refs)) return item.image_ref && item.image_ref !== '未绑定' ? item.image_ref : '待补图';
	return item.image_refs.map((figure) => {
		const placement = figurePlacement(item, figure);
		const where = placement.mapped ? (placement.step ? `步骤 ${placement.step}` : '全局') : '待核对';
		return `${where} · ${figure.role} · ${figure.name}`;
	}).join('\n') || '待补图';
}

export function caseRows(cases) {
	return cases.map((item, index) => CASE_COLUMNS.map(([, get]) => get(item, index)));
}

export async function exportCases(dataRoot, projectId, cases, moduleName = '', moduleLabel = '', imagesDir = '', version = null, basis = digestOf(cases), accounting = [], options = {}) {
	const dir = path.join(dataRoot, 'exports');
	await fs.mkdir(dir, { recursive: true });
	const cols = resolveExportColumns(options);
	const headers = cols.map((col) => col.header);
	const widths = cols.map((col) => col.width || 22);
	const rows = cases.map((item, index) => cols.map((col) => {
		const val = col.get(item, index);
		return col.key === 'module' && !val ? moduleName : val;
	}));

	const prepareRows = cases.map((item) => [
		item.case_id,
		item.title,
		item.precondition || '',
		item.prepare_detail || '',
		(item.controls || []).map((entry) => `${entry.name} → ${entry.page || '页面未知'} / ${entry.node_id}`).join('\n'),
		(item.signals || []).join('、'),
		(item.steps || []).slice(0, 2).join('\n')
	]);

	const traceRows = cases.map((item) => [
		item.case_id,
		item.point_id,
		item.feature_id || '',
		item.basis || '',
		(item.controls || []).map((entry) => entry.node_id).join('、'),
		(item.controls || []).map((entry) => entry.page || '').filter(Boolean).join('、'),
		figureSummary(item)
	]);

	const buffer = buildWorkbook([
		{ name: '测试用例', headers, rows, widths },
		{ name: '准备步骤', headers: ['用例ID', '用例标题', '前置条件', '准备明细', '控件定位', '初始信号', '前两步'], rows: prepareRows, widths: [18, 34, 40, 40, 36, 26, 40] },
		{ name: '评审基线', headers: ['用例版本', '内容摘要'], rows: [[version ?? '', basis]], widths: [18, 26] },
		{ name: '追溯与图片', headers: ['用例ID', '来源测试点ID', '功能点ID', '依据', '设计节点', '页面', '图片证据'], rows: traceRows, widths: [18, 16, 12, 40, 20, 20, 26] },
		...(accounting.length ? [{
			name: '覆盖与延期', headers: ['场景ID', '测试点ID', '场景', '覆盖状态', '延期原因', '影响范围', '责任人', '评审人'],
			rows: accounting.map((row) => [row.scenario_id, row.point_id || '', row.requirement, row.state, row.deferral?.reason || '',
				row.deferral?.impact || '', row.deferral?.owner || '', row.deferral?.reviewer || '']),
			widths: [25, 16, 38, 14, 45, 34, 24, 24]
		}] : [])
	]);
	const stamp = new Date().toISOString().replace(/[:T.Z]/g, '');
	const label = moduleLabel ? `-${moduleLabel.replace(/[\\/:*?"<>|]/g, '')}` : '';
	const file = path.join(dir, `${projectId}${label}-cases-${stamp}.xlsx`);
	const figures = await Promise.all(cases.map(async (item) => {
		const files = (item.image_refs || []).map((figure) => caseFigurePath(dataRoot, projectId, figure)).filter(Boolean)
			.map((image) => imagesDir ? path.join(imagesDir, path.basename(image)) : image);
		return (await Promise.all(files.map(async (image) => await fs.stat(image).catch(() => null) ? image : ''))).filter(Boolean);
	}));
	const staging = path.join(dir, `.${crypto.randomUUID()}.xlsx`);
	try {
		await fs.writeFile(staging, buffer);
		if (figures.some((row) => row.length)) await renderVisual('workbook', staging, { workbook: staging, rows: figures });
		await fs.rename(staging, file);
		return file;
	} finally {
		await fs.rm(staging, { force: true });
	}
}


export const ID_FIELD = { facts: 'fact_id', points: 'point_id', cases: 'case_id' };

export function applyPatch(document, id, patch, kind) {
	const items = document.items;
	const idField = ID_FIELD[kind] || 'case_id';
	const index = items.findIndex((item) => item[idField] === id);
	if (index < 0) throw new Error(`条目不存在：${id}`);
	const allowed = ['statement', 'type', 'priority', 'title', 'condition', 'action', 'expected', 'precondition', 'steps', 'signals', 'prepare_detail', 'verification', 'failure_policy', 'restore_steps', 'basis', 'source_reference', 'requirement', 'review_status'];
	if (kind === 'points') allowed.push('fact_refs', 'transition_ref');
	// 有来源依据的定向修订要能直接改结构化字段：只改旧字符串会与 expected_items 脱钩，下次渲染即被覆盖。
	const structuredFields = ['step_items', 'expected_items', 'prepare_items', 'restore_items', 'deferred_items'];
	if (kind === 'cases') allowed.push(...structuredFields);
	const next = { ...items[index] };
	const contractFields = ['requirement', 'condition', 'action', 'expected', 'fact_refs', 'transition_ref'];
	for (const key of Object.keys(patch)) {
		if (!allowed.includes(key)) continue;
		const value = key === 'fact_refs' ? [...new Set(strings(patch[key]).map(text).filter(Boolean))]
			: key === 'transition_ref' ? text(patch[key]) : patch[key];
		if (kind === 'points' && next.contract_refs?.length && contractFields.includes(key) && digestOf(value) !== digestOf(next[key] ?? '')) {
			throw new Error('请在 ECSM 的需求合同中修正场景或来源，再冻结并生成测试点');
		}
		next[key] = value;
	}
	if (patch.review_status === undefined) next.review_status = 'candidate';
	if (kind === 'cases' && structuredFields.some((key) => patch[key] !== undefined)) {
		next.structured = true;
		renderLegacyFields(next, next, null);
	}
	items[index] = next;
	return next;
}

export function removeItem(document, id, kind) {
	const idField = ID_FIELD[kind] || 'case_id';
	const before = document.items.length;
	document.items = document.items.filter((item) => item[idField] !== id);
	if (document.items.length === before) throw new Error(`条目不存在：${id}`);
	return document;
}

export function markReview(document, id, status, kind) {
	const idField = ID_FIELD[kind] || 'case_id';
	const item = document.items.find((entry) => entry[idField] === id);
	if (!item) throw new Error(`条目不存在：${id}`);
	item.review_status = status;
	item.reviewed_at = new Date().toISOString();
	return item;
}

const POINT_REVIEW_FIELDS = ['review_status', 'reviewed_at'];

/** 重建不得抹掉人工评审：内容逐字未变的点沿用原评审状态，内容变了才回到候选。 */
export function keepPointReviews(items, previous) {
	const byId = new Map(previous.map((item) => [item.point_id, item]));
	const contentOf = (item) => {
		const content = { ...item };
		for (const key of POINT_REVIEW_FIELDS) delete content[key];
		return JSON.stringify(content);
	};
	let kept = 0;
	for (const item of items) {
		const prior = byId.get(item.point_id);
		if (!prior || prior.review_status === 'candidate' || contentOf(prior) !== contentOf(item)) continue;
		for (const key of POINT_REVIEW_FIELDS) if (prior[key] !== undefined) item[key] = prior[key];
		kept += 1;
	}
	return kept;
}

/** Coverage: what exists but is not yet used by the next stage. */
export function coverage(facts, points, cases) {
	const factIds = new Set(facts.items.map((item) => item.fact_id));
	const usedFacts = new Set(points.items.flatMap((item) => item.fact_refs || []));
	const pointIds = new Set(points.items.map((item) => item.point_id));
	const usedPoints = new Set(cases.items.map((item) => item.point_id));
	return {
		facts: { total: facts.items.length, orphan: [...factIds].filter((id) => !usedFacts.has(id)).length },
		points: { total: points.items.length, orphan: [...pointIds].filter((id) => !usedPoints.has(id)).length },
		cases: { total: cases.items.length },
		dangling: {
			facts: points.items.filter((item) => (item.fact_refs || []).some((ref) => !factIds.has(ref))).length,
			points: cases.items.filter((item) => !pointIds.has(item.point_id)).length
		}
	};
}

export function reviewPrompt(cases, limit = 30) {
	// 判据锚点必须与步骤行用同一套标号，否则评审会把空触发读成不存在的 S0 并报假缺陷。
	const anchorOf = (index) => (index ? `S${String(index).padStart(2, '0')}` : '');
	const block = cases.slice(0, limit).map((item) => {
		const steps = (item.step_items || []).length
			? item.step_items.map((step) => `  ${step.anchor} [${step.role}] ${step.text}`).join('\n')
			: (item.steps || []).map((line) => `  ${line}`).join('\n');
		const assertions = (item.expected_items || []).length
			? item.expected_items.map((entry) => `  - ${entry.id} ${entry.kind}｜对象「${entry.object}」应为「${entry.target}」`
				+ `｜触发 ${anchorOf(entry.trigger_step_index) || '无独立触发（只读观察）'} → 观察 ${anchorOf(entry.step_index) || '未解析'}`
				+ `${entry.frames ? `｜连续${entry.frames}帧` : ''}${entry.delay_s ? `｜自${entry.since || '未写起点'}起${entry.delay_s}s` : ''}`
				+ `｜来源 ${entry.evidence_ref || '未写'}${entry.unresolved ? `｜已登记缺口：${entry.unresolved}` : ''}`).join('\n')
			: `  ${item.expected}`;
		const prepares = (item.prepare_items || []).map((entry) => `  - ${entry.object}→${entry.target}｜建立 ${entry.establish}｜读回 ${entry.read_back}｜失败 ${entry.on_failure}`).join('\n');
		const restores = (item.restore_items || []).map((entry) => `  - ${entry.text}｜基线 ${entry.baseline}｜读回 ${entry.read_back}｜失败 ${entry.on_failure}`).join('\n');
		return [
			`[${item.case_id}] ${item.title}（${item.priority}｜${item.type}）`,
			`前置：${item.precondition}`,
			prepares ? `准备：\n${prepares}` : '准备：未记录',
			`步骤：\n${steps}`,
			`逐项判据：\n${assertions}`,
			restores ? `恢复：\n${restores}` : `恢复：${(item.restore_steps || []).join('；') || '未记录'}`,
			`失败处理：${item.failure_policy || '未记录'}`,
			`依据：${item.basis}`
		].join('\n');
	}).join('\n\n');
	return compose('cts-review',
		`请按上方 Skill 规范，逐条逐项审查下面 ${Math.min(limit, cases.length)} 条测试用例。`,
		`输出 JSON：{"receipts":[{"case_id":"C-0001","conclusion":"通过|待修改","findings":[{"code":"EXPECTED_VAGUE|EXPECTED_WEAKENED|STEP_NOT_OPERABLE|PRECONDITION_MISSING|NO_REF|ANCHOR_WRONG|ASSERTION_MERGED|NUMBER_UNSUPPORTED|NAME_UNCONFIRMED|DIRECTION_WRONG|PREPARE_NO_READBACK|RESTORE_MISSING|OBSERVATION_OBJECT_MISMATCH","field":"哪一项判据或哪一步","message":"具体问题"}]}]}`,
		`receipts 必须为下面每一个用例编号各返回恰好一条，编号原样照抄，不得增加、遗漏或重复。无问题则 conclusion 写「通过」、findings 写空数组；有问题则写「待修改」并逐处单列 finding，不得合并同类项。`,
		block
	);
}

export function featurePrompt(facts, projectName) {
	const block = facts.map((fact) => `[${fact.fact_id}]（${fact.type}）${fact.statement}`).join('\n');
	return [
		`你在为「${projectName}」建立 ECSM 的功能点层级。下面是产品事实，请归并成功能点。`,
		'一个功能点 = 用户能感知的一个能力（例如「开关控制」「档位调节」「模式切换」），不是一条规则。',
		'输出 JSON，不要解释：',
		'{"features":[{"name":"功能点名称","summary":"一句话说明","fact_refs":["F-0001","F-0002"]}]}',
		'规则：',
		'- 每个事实最多归属一个功能点；无法归属的不要硬塞。',
		'- 表格中具有独立信号名、独立监控实体或独立触发规则的不同行，保持各自可独立验收的功能点粒度，严禁把数十个不同实体笼统塞进同一个大口袋。',
		'- 功能点每批 3~15 个，粒度以「测试时能单独验收」为准。',
		'- fact_refs 必须来自下面编号，不得遗漏本批核心规则事实。',
		'',
		block
	].join('\n');
}

export function mergeFeatures(existing, raw, factIds) {
	const byName = new Map(existing.map((item) => [item.name, item]));
	const added = [];
	for (const item of list(raw?.features)) {
		const name = text(item.name);
		const refs = [...new Set(strings(item.fact_refs).map(text).filter((ref) => factIds.has(ref)))];
		if (name === '' || refs.length === 0) continue;
		const prior = byName.get(name);
		if (prior) {
			prior.fact_refs = [...new Set([...(prior.fact_refs || []), ...refs])];
			continue;
		}
		const entry = { name, summary: text(item.summary), fact_refs: refs, status: 'candidate' };
		byName.set(name, entry);
		added.push(entry);
	}
	return added;
}

/** Points inherit a feature through their facts — deterministic, not model-reported. */
export function attachFeatures(points, facts, features) {
	const factToFeature = new Map();
	for (const feature of features) {
		for (const ref of feature.fact_refs || []) if (!factToFeature.has(ref)) factToFeature.set(ref, feature.feature_id);
	}
	let assigned = 0;
	for (const point of points) {
		const refs = point.fact_refs || [];
		const featureId = refs.map((ref) => factToFeature.get(ref)).find(Boolean) || '';
		point.feature_id = featureId;
		if (featureId) assigned += 1;
	}
	return assigned;
}


const hashId = (seed) => `TC-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase()}`;

const stepLabel = (index) => `S${String(index + 1).padStart(2, '0')}`;

/** Number the steps and pair each expected line with the step it observes. */
export function normalizeCaseStructure(item) {
	// Structured cases already carry explicit trigger/observation anchors; the
	// heuristic pairing below must not overwrite them.
	const structuredContent = (item.expected_items || []).some((entry) => entry && (entry.object !== undefined || entry.trigger_step_id !== undefined));
	if ((item.structured || structuredContent) && (item.expected_items || []).length) {
		const steps = (item.step_items || []).map((step, index) => ({ ...step, index: index + 1, anchor: `S${String(index + 1).padStart(2, '0')}` }));
		item.step_items = steps;
		item.steps = steps.map((step) => `${step.anchor}. ${step.text}`);
		const indexOf = (id) => steps.findIndex((step) => step.id === id);
		item.expected_items = item.expected_items.map((entry) => {
			const observe = indexOf(entry.step_id);
			const trigger = indexOf(entry.trigger_step_id);
			return withSourceGaps({ ...entry, step_index: observe >= 0 ? observe + 1 : 0, trigger_step_index: trigger >= 0 ? trigger + 1 : 0 });
		});
		item.expected = item.expected_items.map((entry) => `${entry.step_index ? 'S' + String(entry.step_index).padStart(2, '0') : 'S00'}-1. ${entry.text}`).join('\n');
		return item;
	}
	const steps = (item.steps || []).map((step) => String(step));
	const numbered = steps.map((step, index) => (/^S\d+/.test(step) ? step : `${stepLabel(index)}. ${step.replace(/^\d+[.、)]\s*/, '')}`));
	const expectedLines = String(item.expected || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
	const bigrams = (text) => {
		const set = new Set();
		for (const run of String(text).match(/[\u4e00-\u9fff]+/g) || []) {
			for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2));
		}
		for (const word of String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) || []) set.add(word);
		return set;
	};
	const stepTokens = numbered.map((step) => bigrams(step));
	const OBSERVE = /观察|查看|确认|检查|记录|监听|读取|核对/;
	const observationAt = numbered.reduce((last, step, index) => (OBSERVE.test(step) ? index : last), -1);
	const paired = expectedLines.map((line, index) => {
		const cleaned = line.replace(/^\d+[.、)]\s*/, '').replace(/^S\d+[-\d]*\.\s*/, '');
		if (numbered.length === 0) return cleaned;
		let at = observationAt;
		if (at < 0) {
			const lineTokens = bigrams(cleaned);
			let best = { score: 0, at: numbered.length - 1 };
			stepTokens.forEach((tokens, position) => {
				let hit = 0;
				for (const token of lineTokens) if (tokens.has(token)) hit += 1;
				const score = hit / Math.max(1, lineTokens.size);
				if (score > best.score) best = { score, at: position };
			});
			at = best.at;
		}
		const anchor = numbered[at].match(/^S\d+/)?.[0];
		const ordinal = expectedLines.length === 1 ? 1 : index + 1;
		return anchor ? `${anchor}-${ordinal}. ${cleaned}` : cleaned;
	});
	item.steps = numbered;
	item.expected = paired.join('\n');
	structureCase(item);
	return item;
}

/**
 * Stable ids for steps and expected items. Ids follow the step content, so
 * inserting or reordering steps keeps existing figure references attached to
 * the same sentence. Repeated identical sentences keep distinct ids in order of
 * appearance; a sentence that changed gets a new id, so its old figures must be
 * re-checked instead of silently inheriting the old binding.
 */
export function structureCase(item) {
	// A structured case already owns stable ids and explicit anchors; rebuilding
	// them from the rendered strings would drop trigger/object/evidence fields.
	// 只读状态观察的 trigger 合法为空，不能用它判断是否结构化。
	// 标记可能缺失（旧数据或只改了部分字段的写入），所以也认结构化内容本身，避免静默降级。
	const structuredContent = (item.expected_items || []).some((entry) => entry && (entry.object !== undefined || entry.trigger_step_id !== undefined));
	if ((item.structured || structuredContent) && (item.step_items || []).length && (item.expected_items || []).length) {
		const steps = item.step_items.map((step, index) => ({ ...step, index: index + 1, anchor: `S${String(index + 1).padStart(2, '0')}` }));
		item.step_items = steps;
		const indexOf = (id) => steps.findIndex((step) => step.id === id);
		item.expected_items = item.expected_items.map((entry) => {
			const observe = indexOf(entry.step_id);
			const trigger = indexOf(entry.trigger_step_id);
			return withSourceGaps({ ...entry, step_index: observe >= 0 ? observe + 1 : entry.step_index || 0, trigger_step_index: trigger >= 0 ? trigger + 1 : entry.trigger_step_index || 0 });
		});
		return item;
	}
	const lines = (item.steps || []).map((line) => String(line));
	const prior = (item.step_items || []).filter((entry) => entry && entry.text !== undefined);
	const priorByKey = new Map();
	for (const entry of prior) {
		const key = stepKey(entry.text);
		if (!priorByKey.has(key)) priorByKey.set(key, []);
		priorByKey.get(key).push(entry);
	}
	const seen = new Map();
	const used = new Set();
	const allocate = (base) => {
		let id = base;
		let n = 2;
		while (used.has(id) || prior.some((entry) => entry.id === id && !used.has(id))) {
			id = `${base}-${n}`;
			n += 1;
		}
		used.add(id);
		return id;
	};
	item.step_items = lines.map((text, index) => {
		const key = stepKey(text);
		const indexInKey = seen.get(key) || 0;
		seen.set(key, indexInKey + 1);
		const match = priorByKey.get(key)?.[indexInKey];
		const id = match?.id && !used.has(match.id) ? (used.add(match.id), match.id) : allocate(`s-${stepDigest(text)}`);
		// Keep the structured role/key: they are authored, not derivable from text.
		return { id, text, index: index + 1, anchor: (text.match(/^S\d+/) || [])[0] || '', ...(match?.role ? { role: match.role } : {}), ...(match?.key ? { key: match.key } : {}) };
	});

	const expectedPrior = (item.expected_items || []).filter((entry) => entry && entry.text !== undefined);
	const expectedByKey = new Map();
	for (const entry of expectedPrior) {
		const key = stepKey(entry.text);
		if (!expectedByKey.has(key)) expectedByKey.set(key, []);
		expectedByKey.get(key).push(entry);
	}
	const expectedSeen = new Map();
	const STRUCTURED_FIELDS = ['object', 'target', 'kind', 'trigger_step_id', 'trigger_step_index', 'evidence_ref', 'frames', 'since', 'delay_s', 'signal', 'unresolved'];
	item.expected_items = String(item.expected || '').split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
		const key = stepKey(line);
		const indexInKey = expectedSeen.get(key) || 0;
		expectedSeen.set(key, indexInKey + 1);
		const match = expectedByKey.get(key)?.[indexInKey];
		const id = match?.id && !used.has(match.id) ? (used.add(match.id), match.id) : allocate(`e-${stepDigest(line)}`);
		const step = (line.match(/^S\d+/) || [])[0] || '';
		const owner = (item.step_items || []).find((entry) => entry.anchor && entry.anchor === step);
		const kept = {};
		for (const field of STRUCTURED_FIELDS) if (match?.[field] !== undefined && match[field] !== '') kept[field] = match[field];
		return {
			id,
			text: line,
			step_id: match?.step_id || owner?.id || '',
			step_index: match?.step_index || owner?.index || 0,
			...kept
		};
	});
	return item;
}


/** Restore the bench to the recorded baseline, parsed from the precondition. */
export function buildRestore(item) {
	if ((item.restore_steps || []).length > 0 && item.restore_grounded) return item.restore_steps;
	const lines = [
		...String(item.precondition || '').split(/\n+/),
		...(item.steps || []).map((step) => String(step))
	].map((line) => line.trim()).filter(Boolean);
	const signals = [];
	for (const line of lines) {
		for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9_]*\(0x[0-9A-Fa-f]+\)\.[A-Za-z0-9_]+|[A-Z][A-Za-z0-9_]{4,})\s*=\s*(0x[0-9A-Fa-f]+|\d+)/g)) {
			if (signals.some((entry) => entry.signal === match[1])) continue;
			signals.push({ signal: match[1], value: match[2] });
		}
	}
	const uiStates = [];
	for (const line of lines) {
		for (const match of line.matchAll(/【([^】]{2,16})】\s*(?:为|处于)?\s*(选中态|默认态|开启|关闭)/g)) {
			uiStates.push({ control: match[1], state: match[2] });
		}
	}
	const start = (item.steps || []).length + 1;
	const steps = [];
	let cursor = start;
	if (signals.length > 0) {
		steps.push(`S${String(cursor).padStart(2, '0')}. 将信号恢复到测试前基线：${signals.map((entry) => `${entry.signal}=${entry.value}`).join('；')}`);
		cursor += 1;
		steps.push(`S${String(cursor).padStart(2, '0')}. 用报文工具确认上述信号已回到基线取值`);
		cursor += 1;
	}
	for (const entry of uiStates) {
		steps.push(`S${String(cursor).padStart(2, '0')}. 将【${entry.control}】恢复为${entry.state}`);
		cursor += 1;
	}
	if (steps.length === 0) {
		steps.push(`S${String(cursor).padStart(2, '0')}. 按测试前记录恢复整车电源与界面到初始状态（无具体基线，需人工确认）`);
		cursor += 1;
	}
	steps.push(`S${String(cursor).padStart(2, '0')}. 无论步骤成功或失败都执行本节，并记录恢复结果`);
	item.restore_steps = steps;
	item.restore_grounded = signals.length > 0 || uiStates.length > 0;
	item.restore_signals = signals.length;
	return item.restore_steps;
}

/** Everything this case still cannot guarantee, in plain words. */
export function buildGaps(item) {
	const gaps = [];
	if (!(item.controls || []).length) gaps.push('控件未绑定设计节点');
	if (signalName().test(item.expected || '') && !MESSAGE_REF.test(item.expected || '')) gaps.push('信号缺报文ID或取值');
	if (!item.prepare_detail) gaps.push('未写准备明细');
	if (String(item.basis || '').includes('未绑定')) gaps.push('存在未绑定信号');
	if ((item.restore_steps || []).length > 0 && !item.restore_grounded) gaps.push('RESTORE_SEQUENCE_NOT_MATERIALIZED（恢复序列无明确基线）');
	return gaps;
}

/** Collect bound controls separately from executable instructions. */
const normalizeControl = (name) => String(name || '')
	.replace(/[【】\[\]「」\s]/g, '')
	.replace(/(按键|按钮|开关|图标|入口|栏|显示|状态|控件)+$/g, '')
	.trim();

function matchBinding(control, bindings) {
	const key = normalizeControl(control);
	if (key === '') return null;
	for (const binding of bindings.items || []) {
		if (binding.status !== 'bound') continue;
		const name = normalizeControl(binding.subject?.name);
		if (name === key) return binding;
		if (key.length >= 2 && name.length >= 2 && (key.includes(name) || name.includes(key))) return binding;
	}
	return null;
}

export function decorateCases(cases, bindings) {
	const controlAlias = new Map();
	const signalByName = new Map();
	for (const item of bindings?.items || []) {
		if (item.status !== 'bound' || !item.target) continue;
		if (item.kind === 'control') {
			const entry = { name: item.subject.name, target: item.target };
			const subjKey = normalizeControl(item.subject.name);
			if (subjKey) controlAlias.set(subjKey, entry);
			if (subjKey && /[/／]/.test(subjKey)) controlAlias.set(subjKey.replace(/[/／]/g, ''), entry);
			if (item.target?.name) {
				const targetCore = normalizeControl(stripDesignComponentPrefix(item.target.name));
				if (targetCore && !controlAlias.has(targetCore)) controlAlias.set(targetCore, entry);
			}
		} else {
			signalByName.set(item.subject.name, item.target);
		}
	}
	const resolveControl = (rawName) => {
		const k = normalizeControl(rawName);
		if (!k || k.length < 2) return null;
		if (controlAlias.has(k)) return controlAlias.get(k);
		if (/[/／]/.test(k) && controlAlias.has(k.replace(/[/／]/g, ''))) return controlAlias.get(k.replace(/[/／]/g, ''));
		const maxPref = /^最大([\u4e00-\u9fa5]{2,6})$/.exec(k);
		if (maxPref && controlAlias.has(`${maxPref[1]}MAX`)) return controlAlias.get(`${maxPref[1]}MAX`);
		const maxSuf = /^([\u4e00-\u9fa5]{2,6})MAX$/i.exec(k);
		if (maxSuf && controlAlias.has(`最大${maxSuf[1]}`)) return controlAlias.get(`最大${maxSuf[1]}`);
		return null;
	};
	for (const item of cases) {
		item.controls = item.controls || [];
		const addFound = (found) => {
			if (!found) return;
			if (!item.controls.some((entry) => entry.name === found.name)) {
				item.controls.push({ name: found.name, node_id: found.target.node_id, page: found.target.page || '' });
			}
		};
		for (const step of item.steps || []) {
			for (const match of String(step).matchAll(/[【「]([^】」]{2,20})[】」]/g)) {
				addFound(resolveControl(match[1]));
			}
		}
		for (const entry of item.expected_items || []) {
			if (entry?.object && !/^can_/.test(entry.kind || '')) addFound(resolveControl(entry.object));
		}
		for (const entry of item.prepare_items || []) {
			if (entry?.object) addFound(resolveControl(entry.object));
		}
		item.signals = item.signals || [];
		for (const [name] of signalByName) {
			const mentioned = `${item.expected || ''} ${(item.steps || []).join(' ')} ${(item.basis || '')}`.includes(name);
			if (mentioned && !item.signals.includes(name)) item.signals.push(name);
		}
	}
	return cases;
}




/** Facts the model left outside every feature: attach them to the closest one. */
export function assignUnassigned(features, facts) {
	const tokens = (text) => {
		const set = new Set();
		const value = String(text || '').toLowerCase();
		for (const word of value.match(/[a-z0-9_]{2,}/g) || []) set.add(word);
		for (const run of value.match(/[\u4e00-\u9fff]+/g) || []) {
			if (run.length === 1) set.add(run);
			for (let index = 0; index < run.length - 1; index += 1) set.add(run.slice(index, index + 2));
		}
		return set;
	};
	const overlap = (a, b) => {
		if (a.size === 0 || b.size === 0) return 0;
		let hit = 0;
		for (const token of a) if (b.has(token)) hit += 1;
		return hit / Math.min(a.size, b.size);
	};
	const factById = new Map(facts.map((fact) => [fact.fact_id, fact]));
	const assigned = new Set(features.flatMap((feature) => feature.fact_refs || []));
	const unassigned = facts.filter((fact) => !assigned.has(fact.fact_id));
	const featureTokens = features.map((feature) => ({
		feature,
		tokens: tokens((feature.fact_refs || []).map((ref) => factById.get(ref)?.statement || '').join(' '))
	}));
	let moved = 0;
	for (const fact of unassigned) {
		const factTokens = tokens(fact.statement);
		let best = { score: 0, feature: null };
		for (const entry of featureTokens) {
			const score = overlap(factTokens, entry.tokens);
			if (score > best.score) best = { score, feature: entry.feature };
		}
		if (best.score < 0.25 || !best.feature) continue;
		best.feature.fact_refs = [...(best.feature.fact_refs || []), fact.fact_id];
		moved += 1;
	}
	return { moved, left: unassigned.length - moved };
}

const FAMILIES = [
	{ key: '丢包/丢失', pattern: /丢失|丢帧|超时未收到|无报文|未收到反馈/ },
	{ key: '恢复', pattern: /恢复|重新上电|重连|重新连接/ },
	{ key: '记忆', pattern: /记忆|上次关机|默认值恢复|断电保持/ },
	{ key: '边界', pattern: /最小|最大|越界|下限|上限|0 档|0档/ },
	{ key: '连续帧', pattern: /连续\s*\d+\s*帧|连续\s*[一二三四五]\s*帧|3\s*帧|三帧/ },
	{ key: '语音入口', pattern: /语音/ }
];

/** Which scenario families the point set actually covers. */
export function familyCoverage(points) {
	const declared = configTerms('families').map((family) => ({ key: family.key, pattern: termsPattern(family.terms) }));
	return [...FAMILIES, ...declared].map((family) => {
		const hits = points.filter((point) => family.pattern.test(`${point.condition || ''} ${point.action || ''} ${point.expected || ''}`)).length;
		return { family: family.key, hits, ok: hits > 0 };
	});
}

/** Entry channels are project facts; without a declaration only the default surface exists. */
const entryRules = () => {
	const declared = configTerms('entries').map((entry) => ({ key: entry.key, pattern: entry.catch_all ? /./ : termsPattern(entry.terms) }));
	return declared.length ? declared : [{ key: defaultSurface(), pattern: /./ }];
};

const STATE_RULES = [
	{ key: '关闭态', pattern: /关闭|未开启|默认状态/ },
	{ key: '开启态', pattern: /开启|打开|选中状态|已开启/ },
	{ key: '记忆态', pattern: /记忆|上次|断电|上电/ },
	{ key: '异常态', pattern: /丢失|超时|未收到|异常|故障|离线/ }
];

const VERIFY_RULES = [
	{ key: '界面反馈', pattern: /图标|显示|界面|选中状态|置灰|点亮/ },
	{ key: '信号发送', pattern: /发送|请求|上报|报文|信号/ },
	{ key: '接收刷新', pattern: /反馈|接收|刷新|更新|同步/ },
	{ key: '联动', pattern: /联动|同时|一并|联动开启/ }
];

// Object nouns are project-neutral: take names the PRD already bracketed (【…】),
// otherwise a short prefix in front of a control noun. No domain list.
const OBJECT_SUFFIX = /(按键|按钮|开关|调节条|入口|图标|指示灯|模式|功能|弹层|弹窗|页面|列表)$/;
const OBJECT_NOISE = /(发送|接收|丢失|恢复|刷新|切换|显示|置灰|按下|上报|请求|等待|如果|当|则|状态|时间|报文|信号|反馈|时|后|前)/;

/** Pull the objects a feature talks about out of its fact text. */
export function extractObjects(text, limit = 6) {
	const source = String(text || '');
	const counts = new Map();
	const add = (raw, weight) => {
		const name = raw.replace(/^[的和与及或在当若则后前]/, '').replace(/[时后前的]$/, '').trim();
		if (name.length < 2 || name.length > 14) return;
		if (OBJECT_NOISE.test(name)) return;
		counts.set(name, (counts.get(name) || 0) + weight);
	};
	for (const match of source.matchAll(/【([^】]{2,16})】/g)) add(match[1], 3);
	for (const match of source.matchAll(/“([^”]{2,16})”/g)) add(match[1], 2);
	for (const match of source.matchAll(/[\u4e00-\u9fffA-Za-z0-9_]{2,14}/g)) {
		const token = match[0];
		if (!OBJECT_SUFFIX.test(token)) continue;
		add(token.replace(OBJECT_SUFFIX, ''), 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([name]) => name);
}

/** Deterministic cell skeleton: entry × state × verify × object. */
export function buildCells(feature, facts, limit = 12) {
	const text = (feature.fact_refs || [])
		.map((ref) => facts.find((fact) => fact.fact_id === ref)?.statement || '')
		.join('\n');
	const rules = entryRules();
	const entries = rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.key);
	const states = STATE_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.key);
	const verifies = VERIFY_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.key);
	const objects = extractObjects(text);
	if (states.length === 0) states.push('常态');
	if (verifies.length === 0) verifies.push('界面反馈');
	if (objects.length === 0) objects.push('');

	const exception = states.includes('异常态');
	const cells = [];
	// Anomaly cells are enumerated per object, mirroring how delivered workbooks
	// write one point per control ("…报文丢失后 X 置灰").
	if (exception && objects.length > 0) {
		for (const object of objects) {
			for (const verify of verifies) cells.push({ entry: rules.at(-1).key, state: '异常态', verify, object });
		}
	}
	for (const entry of entries) {
		for (const state of states) {
			for (const verify of verifies) {
				for (const object of objects.slice(0, 2)) cells.push({ entry, state, verify, object });
			}
		}
	}
	const seen = new Set();
	const picked = [];
	for (let round = 0; picked.length < limit && round < 12; round += 1) {
		for (let index = round; index < cells.length && picked.length < limit; index += 7) {
			const cell = cells[index];
			const key = `${cell.entry}|${cell.state}|${cell.verify}|${cell.object}`;
			if (seen.has(key)) continue;
			seen.add(key);
			picked.push(cell);
		}
	}
	return picked;
}

export function matrixPrompt(feature, facts, cells) {
	const lines = cells.map((cell, index) => `${index + 1}. 入口=${cell.entry}；状态=${cell.state}；验证=${cell.verify}${cell.object ? `；对象=${cell.object}` : ''}`);
	return [
		`功能点：${feature.feature_id} ${feature.name}`,
		'下面是按「入口 × 状态 × 验证 × 对象」枚举出来的格子。请为每个格子产出一条测试点。',
		'如果某个格子在本功能下不成立（例如该入口不存在、该状态下无此行为），不要编造，输出 {"cell":序号,"na":"为什么不适用"}。',
		'',
		'格子：',
		lines.join('\n'),
		'',
		'输出 JSON：{"points":[{"cell":1,"requirement":"…","condition":"…","action":"…","expected":"…","type":"…","priority":"P0|P1|P2","fact_refs":["F-0001"]}],"na":[{"cell":3,"reason":"…"}]}',
		'每个成立的格子必须给一条点，condition 里体现该格的状态，expected 里体现验证对象。',
		'',
		'可用事实：',
		(feature.fact_refs || []).map((ref) => {
			const fact = facts.find((item) => item.fact_id === ref);
			return fact ? `[${fact.fact_id}]（${fact.type}）${fact.statement}` : '';
		}).filter(Boolean).join('\n')
	].join('\n');
}

const BOUNDARY_HINT = /(\d+\s*[-~至—]\s*\d+\s*(档|挡|℃)|\d+\s*(档|挡|℃|秒|s|帧)|最大|最小|上限|下限|范围)/;

/** Features whose facts state numeric ranges or extremes deserve boundary points. */
export function boundaryTargets(feature, facts, limit = 6) {
	const refs = (feature.fact_refs || []).map((ref) => facts.find((fact) => fact.fact_id === ref)).filter(Boolean);
	const ranges = refs.filter((fact) => BOUNDARY_HINT.test(fact.statement));
	if (ranges.length === 0) return null;
	const objects = extractObjects(ranges.map((fact) => fact.statement).join('\n'), 4);
	return { feature, facts: ranges.slice(0, limit), objects };
}

export function boundaryPrompt(target) {
	const { feature, facts, objects } = target;
	const objectList = objects.length > 0 ? objects.join(' / ') : '该功能的主要控件';
	return [
		`功能点：${feature.feature_id} ${feature.name}`,
		`围绕对象：${objectList}`,
		'为这个功能补齐边界测试点：最小值、最大值、越界、以及档位/数值跳变。',
		'要求：',
		'- 最小与最大各至少一条，写成具体档位或数值（如 18℃、8 挡、0 挡）',
		'- 越界一条（例如再从最大值继续调节，界面不变化且不发请求）',
		'- 如果事实里没有给出具体数值，写数量级但要标注 TBD，不要编造',
		'',
		'输出 JSON：{"points":[{"requirement":"…","condition":"…","action":"…","expected":"…","type":"边界","priority":"P1","fact_refs":["F-0001"]}]}',
		'',
		'可用事实：',
		facts.map((fact) => `[${fact.fact_id}] ${fact.statement}`).join('\n')
	].join('\n');
}

/** Gold notation is `MSG(0xID).SIGNAL=value`; we often only write the signal name.
 *  The DBC binding already knows the message, so enrich deterministically. */
export function enrichSignals(items, bindings) {
	const byName = new Map();
	const byNormKey = new Map();
	for (const binding of bindings?.items || []) {
		if (binding.kind !== 'signal' || binding.status !== 'bound' || !binding.target) continue;
		const name = binding.subject?.name;
		const message = binding.target.message;
		const id = binding.target.message_id;
		if (!name || !message || !id) continue;
		const full = `${message}(${id}).${name}`;
		byName.set(name, full);
		byNormKey.set(normKey(name), full);
	}
	const resolveSignalToken = (signal) => {
		if (byName.has(signal)) return byName.get(signal);
		if (!signal.includes('_')) return null;
		const nk = normKey(signal);
		if (nk.length < 8) return null;
		if (byNormKey.has(nk)) return byNormKey.get(nk);
		const prefixHits = [];
		const suffixHits = [];
		const multisetHits = [];
		const charsetHits = [];
		const nkMs = nk.length >= 9 ? nk.split('').sort().join('') : '';
		for (const [k, full] of byNormKey.entries()) {
			if (k.length >= 8 && nk.startsWith(k) && nk.length - k.length <= 6) prefixHits.push(full);
			if (nk.length >= 8 && k.endsWith(nk) && k.length - nk.length <= 6) suffixHits.push(full);
			if (nkMs && k.length === nk.length && k.split('').sort().join('') === nkMs) multisetHits.push(full);
			if (k.length >= 10 && nk.length >= 10 && Math.abs(k.length - nk.length) <= 2
				&& [...nk].every((ch) => k.includes(ch)) && [...k].every((ch) => nk.includes(ch))) {
				charsetHits.push(full);
			}
		}
		if (prefixHits.length === 1) return prefixHits[0];
		if (suffixHits.length === 1) return suffixHits[0];
		if (multisetHits.length === 1) return multisetHits[0];
		if (charsetHits.length === 1) return charsetHits[0];
		return null;
	};
	let changed = 0;
	const collapse = (text) => String(text || '').replace(/([A-Za-z0-9_]+\(0x[0-9A-Fa-f]+\)\.)+([A-Za-z][A-Za-z0-9_]{4,})/g, (whole, _prefix, signal) => {
		const full = resolveSignalToken(signal);
		return full || whole;
	});
	const rewrite = (text) => {
		const cleaned = collapse(text);
		return cleaned.replace(/(?<![.\w])([A-Za-z][A-Za-z0-9_]{4,})/g, (token, signal) => resolveSignalToken(signal) || token);
	};
	for (const item of items) {
		for (const key of ['expected', 'title', 'requirement', 'condition', 'action']) {
			if (typeof item[key] !== 'string' || item[key] === '') continue;
			const next = rewrite(item[key]);
			if (next !== item[key]) {
				item[key] = next;
				changed += 1;
			}
		}
		if (Array.isArray(item.steps)) {
			item.steps = item.steps.map((step) => {
				const next = rewrite(step);
				if (next !== step) changed += 1;
				return next;
			});
		}
		if (Array.isArray(item.step_items)) {
			for (const s of item.step_items) {
				if (typeof s?.text === 'string' && s.text) s.text = rewrite(s.text);
			}
		}
		if (Array.isArray(item.prepare_items)) {
			for (const p of item.prepare_items) {
				for (const k of ['read_back', 'establish', 'text']) {
					if (typeof p?.[k] === 'string' && p[k]) p[k] = rewrite(p[k]);
				}
			}
		}
		if (Array.isArray(item.restore_items)) {
			for (const r of item.restore_items) {
				for (const k of ['read_back', 'text']) {
					if (typeof r?.[k] === 'string' && r[k]) r[k] = rewrite(r[k]);
				}
			}
		}
	}
	return changed;
}

/** Stable hash ids: regeneration no longer reuses C-0001 for different content. */
export function applyCaseIds(cases) {
	for (const item of cases) {
		if (item.case_id && item.case_id.startsWith('TC-')) continue;
		item.legacy_id = item.legacy_id || item.case_id || '';
		item.case_id = hashId(`${item.point_id}|${item.title || ''}|${item.legacy_id}`);
	}
	return cases;
}

const FAILURE_BY_TYPE = [
	[/请求发送|信号/, '信号未按预期发出（漏发/多帧/取值错）'],
	[/状态迁移|状态/, '状态迁移条件判断错误或反馈未刷新'],
	[/界面|显示/, '界面反馈与信号状态不一致'],
	[/边界/, '边界值处理错误（越界仍响应/极限档位错）'],
	[/异常|丢失/, '异常分支未处理（报文丢失未置灰/恢复未重算）']
];

/** The three-part card a reviewer actually reads, plus one line on what can fail. */
export function attachReviewCard(points) {
	for (const point of points) {
		if (!point.review_card) {
			point.review_card = {
				condition_state: point.condition || '',
				operation_event: point.action || '',
				key_expected_result: String(point.expected || '').split(/\n+/)[0] || '',
				test_object: point.cell ? String(point.cell).split('|').pop() : ''
			};
		}
		if (!point.primary_failure_mechanism) {
			const text = `${point.type || ''} ${point.expected || ''}`;
			const hit = FAILURE_BY_TYPE.find(([pattern]) => pattern.test(text));
			point.primary_failure_mechanism = hit ? hit[1] : '功能行为与 PRD 不一致';
		}
	}
	return points;
}

const AUTHORITY_BY_KIND = { prd: 'PRD', dbc: 'DBC', design: '设计稿', history: '历史用例', bench: '台架' };

/** Which document each fact is answerable to, and whether it is still a candidate. */
export function applyAuthority(facts, evidenceById) {
	for (const fact of facts) {
		if (!fact.authority_scope || fact.authority_scope === '未标注') {
			const kinds = (fact.evidence_refs || []).map((ref) => evidenceById?.get(ref)?.kind).filter(Boolean);
			const kind = kinds[0] || '';
			fact.authority_scope = AUTHORITY_BY_KIND[kind] || '未标注';
		}
		fact.status = fact.status || 'candidate';
	}
	return facts;
}

// ============================================================================
// Transformation 2: Evidence-Backed Global Closed-Loop Rule × Entry × Branch
// ============================================================================

const CN_NUM_MAP = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const parseCnInt = (raw) => {
	const s = String(raw || '').trim();
	if (/^\d+$/.test(s)) return Number(s);
	return CN_NUM_MAP[s] || null;
};
const normKey = (v) => String(v || '').replace(/[\s_\-·、，,。.:：;；()（）【】\[\]"'“”‘’/]/g, '').toLowerCase();

const NON_CONTROL_ENTRY_RE = /(?:不控制|不发送(?:控制|请求|信号)?|不触发(?:控制|开关|信号)|仅打开|只打开|不适用(?:该|统一|全局)?策略|只读|仅显示)/;
const GLOBAL_RULE_CUE_RE = /(?:统一.*?(?:外发|发送|通信|控制)?(?:策略|规则|约定)|全局.*?(?:通信|控制|闭环|外发)?(?:策略|规则|约定)|所有控制请求|状态改变时.*?(?:发|发送|下发)\s*[一二三四五六七八九十\d]+\s*帧|(?:未收到.*?反馈|反馈值?无效).*?(?:回弹|回退|恢复|还原))/;

/**
 * Build the evidence-backed closed-loop coverage plan from frozen facts, features, bindings, and signalIndex.
 * Strictly determines outcome branches and applicable entries from material evidence (never Cartesian-combining all controls × signals).
 */
export function buildClosedLoopCoveragePlan(facts = [], features = [], bindings = [], signalIndex = new Map(), options = {}) {
	const dut = String(options.dut || dutNode() || '').trim();
	const activeFacts = (facts || []).filter((f) => f && f.statement && !/^【待裁决】/.test(String(f.statement).trim()));
	const factById = new Map((facts || []).map((f) => [f.fact_id, f]));

	// 1. Discover global closed-loop communication rule facts
	const seedRuleFacts = activeFacts.filter((f) => GLOBAL_RULE_CUE_RE.test(f.statement));
	const seedEvRefs = new Set(seedRuleFacts.flatMap((f) => f.evidence_refs || []));
	const ruleFacts = activeFacts.filter((f) =>
		seedRuleFacts.includes(f)
		|| ((f.evidence_refs || []).some((r) => seedEvRefs.has(r))
			&& /(?:外发|发送|帧|反馈|回弹|回退|恢复|还原|不适用)/.test(f.statement))
	);

	const gaps = [];
	const excluded_entries = [];
	if (ruleFacts.length === 0) {
		return { hasGlobalRule: false, rule_fact_ids: [], branches: [], entries: [], cells: [], excluded_entries, gaps };
	}

	const ruleJoined = ruleFacts.map((f) => f.statement).join('\n');
	const frameMatch = /(?:发|发送|下发|连续发送)\s*([一二三四五六七八九十\d]+)\s*帧(?:有效)?/.exec(ruleJoined);
	const frames = frameMatch ? parseCnInt(frameMatch[1]) : null;
	const windowMatch = /(\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒))\s*内?(?:未收到|收到|无|超时)?.*?反馈/.exec(ruleJoined)
		|| /反馈(?:窗口|时限|超时)(?:为)?\s*(\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒))/.exec(ruleJoined);
	const windowText = windowMatch ? windowMatch[1].replace(/\s+/g, '') : null;
	const sinceMatch = /(状态改变|发送请求|发[一二三四五六七八九十\d]+帧(?:有效)?后|触发操作|请求发出)/.exec(ruleJoined);
	const sinceText = sinceMatch ? sinceMatch[1] : '状态改变发送请求';
	const rollbackMatch = /(?:显示|状态|界面)[^\n，。；]*?(回弹|回退|恢复(?:原状态|初态)?|还原)/.exec(ruleJoined)
		|| /(回弹|回退|恢复(?:原状态|初态)?|还原)/.exec(ruleJoined);
	const rollbackAction = rollbackMatch ? rollbackMatch[1] : null;

	// Determine evidence-backed branches strictly from ruleFacts
	const branches = [];
	const validHoldFacts = ruleFacts.filter((f) =>
		/(?:根据输入信号显示|收到(?:有效)?反馈.*?(?:保持|显示|维持|更新)|发[一二三四五六七八九十\d]+帧(?:有效)?|界面设置为)/.test(f.statement)
	);
	if (validHoldFacts.length > 0) {
		branches.push({
			branch_id: 'valid_hold',
			branch_label: '有效反馈保持',
			fact_ids: validHoldFacts.map((f) => f.fact_id),
			evidence_refs: [...new Set(validHoldFacts.flatMap((f) => f.evidence_refs || []))],
			frames,
			window: windowText,
			since: sinceText
		});
	}

	const timeoutFacts = ruleFacts.filter((f) =>
		/(?:(\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒))|超时)\s*内?(?:未收到|无).*?反馈.*?(?:回弹|回退|恢复|还原)|(?:回弹|回退|恢复|还原).*?(?:(\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒))|超时)\s*内?(?:未收到|无).*?反馈/.test(f.statement)
	);
	if (timeoutFacts.length > 0) {
		if (!windowText || !rollbackAction) {
			gaps.push({
				kind: 'incomplete_timeout_rule',
				fact_ids: timeoutFacts.map((f) => f.fact_id),
				evidence_refs: [...new Set(timeoutFacts.flatMap((f) => f.evidence_refs || []))],
				message: '全局超时回退规则未明确具体时间窗或回退动作'
			});
		} else {
			branches.push({
				branch_id: 'timeout_rollback',
				branch_label: `${windowText}超时未收到反馈回退`,
				fact_ids: timeoutFacts.map((f) => f.fact_id),
				evidence_refs: [...new Set(timeoutFacts.flatMap((f) => f.evidence_refs || []))],
				frames,
				window: windowText,
				since: sinceText,
				rollback_action: rollbackAction
			});
		}
	} else {
		const partialTimeout = ruleFacts.filter((f) => /(?:未收到|无).*?反馈/.test(f.statement));
		if (partialTimeout.length > 0) {
			gaps.push({
				kind: 'missing_timeout_window_or_action',
				fact_ids: partialTimeout.map((f) => f.fact_id),
				evidence_refs: [...new Set(partialTimeout.flatMap((f) => f.evidence_refs || []))],
				message: '提及未收到反馈但缺少明确时间窗或回退动作证据'
			});
		}
	}

	const invalidFacts = ruleFacts.filter((f) =>
		/(?:反馈值?无效|无效反馈|反馈(?:为)?(?:无效值|非法值|异常)).*?(?:回弹|回退|恢复|还原)|(?:回弹|回退|恢复|还原).*?(?:反馈值?无效|无效反馈)/.test(f.statement)
	);
	if (invalidFacts.length > 0) {
		if (!rollbackAction) {
			gaps.push({
				kind: 'incomplete_invalid_feedback_rule',
				fact_ids: invalidFacts.map((f) => f.fact_id),
				evidence_refs: [...new Set(invalidFacts.flatMap((f) => f.evidence_refs || []))],
				message: '全局无效反馈规则未明确具体回退动作'
			});
		} else {
			branches.push({
				branch_id: 'invalid_rollback',
				branch_label: '反馈值无效回退',
				fact_ids: invalidFacts.map((f) => f.fact_id),
				evidence_refs: [...new Set(invalidFacts.flatMap((f) => f.evidence_refs || []))],
				frames,
				window: windowText,
				since: sinceText,
				rollback_action: rollbackAction
			});
		}
	}

	// 2. Build signal lookup and identify request/feedback signal facts per functional subject
	const sigLookup = new Map();
	if (signalIndex instanceof Map) {
		for (const [k, v] of signalIndex.entries()) sigLookup.set(normKey(k), v);
	}
	for (const b of bindings || []) {
		if (b.kind === 'signal' && b.status === 'bound' && b.target) {
			const k = normKey(b.subject?.name);
			if (!sigLookup.has(k)) sigLookup.set(k, { name: b.subject.name, ...b.target });
		}
	}
	const findInSigLookup = (tok) => {
		const nk = normKey(tok);
		if (!nk) return null;
		if (sigLookup.has(nk)) return sigLookup.get(nk);
		const prefixHits = [];
		const suffixHits = [];
		const multisetHits = [];
		const charsetHits = [];
		const nkMs = nk.length >= 9 ? nk.split('').sort().join('') : '';
		for (const [k, v] of sigLookup.entries()) {
			if (k.length >= 8 && nk.startsWith(k) && nk.length - k.length <= 6) prefixHits.push(v);
			if (nk.length >= 8 && k.endsWith(nk) && k.length - nk.length <= 6) suffixHits.push(v);
			if (nkMs && k.length === nk.length && k.split('').sort().join('') === nkMs) multisetHits.push(v);
			if (k.length >= 10 && nk.length >= 10 && Math.abs(k.length - nk.length) <= 2
				&& [...nk].every((ch) => k.includes(ch)) && [...k].every((ch) => nk.includes(ch))) {
				charsetHits.push(v);
			}
		}
		if (prefixHits.length === 1) return prefixHits[0];
		if (suffixHits.length === 1) return suffixHits[0];
		if (multisetHits.length === 1) return multisetHits[0];
		if (charsetHits.length === 1) return charsetHits[0];
		return null;
	};

	const factToFeature = new Map();
	for (const feat of features || []) {
		for (const fid of feat.fact_refs || []) factToFeature.set(fid, feat);
	}

	const classifySignalDirection = (sigMeta, statement) => {
		const tx = String(sigMeta?.transmitter || '').trim();
		const dirText = String(sigMeta?.direction || '');
		if (dut && tx) {
			if (tx.toLowerCase() === dut.toLowerCase()) return 'request';
			return 'feedback';
		}
		const dutAlt = dut ? `${dut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|` : '';
		if (new RegExp(`被测方.*?发送|发送方为\\s*(?:${dutAlt}被测方|本端|客户端|主控)`, 'i').test(dirText + ' ' + statement)) return 'request';
		if (new RegExp(`接收方为\\s*(?:${dutAlt}被测方|本端|客户端|主控)|外部.*?→.*?被测方|对端.*?反馈|状态反馈`, 'i').test(dirText + ' ' + statement)) return 'feedback';
		if (/(?:发送给|下发给|外发|控制请求|请求信号|开关命令)/.test(statement) && !/(?:状态反馈|接收方为被测方)/.test(statement)) return 'request';
		if (/(?:状态反馈|反馈信号|上报给被测方)/.test(statement)) return 'feedback';
		return 'unknown';
	};

	const extractInvalidEnumFromText = (valueDesc, statement) => {
		const combined = `${valueDesc || ''} ${statement || ''}`;
		const m = /(0x[0-9a-fA-F]+|\b\d+\b)\s*[:：]\s*(预留|无效|Invalid|Reserved|异常|非法)/i.exec(combined);
		if (m) return `${m[1]}（${m[2]}）`;
		return '';
	};

	const extractValidEnumsFromText = (valueDesc, statement) => {
		const src = String(valueDesc || '').trim() || String(statement || '');
		const out = [];
		for (const m of src.matchAll(/(0x[0-9a-fA-F]+|\b\d+)\s*[:：]\s*([^\n；;，,/／]+?)(?=\s+(?:0x[0-9a-fA-F]+|\d+(?:~0x[0-9a-fA-F]+|~\d+)?)\s*[:：]|[/／；;，,。)]|$)/g)) {
			if (!/^(?:预留|无效|无输入|Invalid|Reserved)$/i.test(m[2].trim())) {
				out.push(`${m[1].trim()}:${m[2].trim()}`);
			}
		}
		return [...new Set(out)];
	};

	const signalMentions = [];
	for (const fact of activeFacts) {
		const tokens = [...fact.statement.matchAll(/\b([A-Za-z][A-Za-z0-9_]{3,40})\b/g)].map((m) => m[1]);
		for (const tok of tokens) {
			const meta = findInSigLookup(tok);
			const looksLikeSignal = Boolean(meta) || (fact.type === 'signal' && /_/.test(tok) && !/^(?:E|F|T|C|FTR)_\d+$/i.test(tok));
			if (!looksLikeSignal) continue;
			const role = classifySignalDirection(meta, fact.statement);
			const canonicalName = meta?.name || tok;
			const valueDesc = meta?.valueDesc || '';
			signalMentions.push({
				fact_id: fact.fact_id,
				evidence_refs: fact.evidence_refs || [],
				statement: fact.statement,
				feature_id: factToFeature.get(fact.fact_id)?.feature_id || '',
				token: tok,
				name: canonicalName,
				resolvedInMatrix: Boolean(meta) || sigLookup.size === 0,
				message: meta?.message || '',
				message_id: meta?.message_id || '',
				role,
				valueDesc,
				validEnums: extractValidEnumsFromText(valueDesc, fact.statement),
				invalidEnum: meta?.invalid || extractInvalidEnumFromText(valueDesc, fact.statement)
			});
		}
	}

	// 3. Identify candidate interactive UI entry facts and match them to closed-loop signal pairs
	const rawEntryCandidates = [];
	for (const fact of activeFacts) {
		if (ruleFacts.includes(fact)) continue;
		const stmt = fact.statement;
		if (NON_CONTROL_ENTRY_RE.test(stmt)) {
			excluded_entries.push({
				fact_id: fact.fact_id,
				evidence_refs: fact.evidence_refs || [],
				statement: stmt,
				reason: 'explicit_non_control_or_exempt'
			});
			continue;
		}
		// Match explicit entry patterns:
		// Pattern A: "在<surface>提供/点击/单击/操作<subject>开关/按键/按钮/选项"
		// Pattern B: "单击/点击/操作 <surface> 【?<subject>】?(开关|按键|按钮|图标)?"
		let surface = '';
		let subject = '';
		const pA = /(?:在|于|通过)([\u4e00-\u9fa5A-Za-z0-9_\s]{2,14}?(?:界面|页面|栏|屏|面板|区))(?:上|中|内)?(?:提供|设有|点击|单击|短按|操作)\s*[【\[]?([\u4e00-\u9fa5A-Za-z0-9/]{2,12}?)[】\]]?\s*(?:软按键|开关选项|开关|按键|按钮|图标|选项)/.exec(stmt);
		const pB = /(?:单击|点击|短按|按下|操作)\s*([\u4e00-\u9fa5A-Za-z0-9_\s]{2,12}?(?:界面|页面|栏|屏|面板))\s*[【\[]?([\u4e00-\u9fa5A-Za-z0-9/]{2,12}?)[】\]]?\s*(?:软按键|开关|按键|按钮|图标)?(?:打开|开启|关闭|切换|触发)/.exec(stmt);
		const pC = /^([\u4e00-\u9fa5A-Za-z0-9_\s]{2,12}?(?:界面|页面|栏|屏|面板))(?:提供|包含)\s*[【\[]?([\u4e00-\u9fa5A-Za-z0-9/]{2,12}?)[】\]]?\s*(?:软按键|开关选项|开关|按键|按钮)/.exec(stmt);
		const hit = pA || pB || pC;
		if (!hit) continue;
		surface = hit[1].replace(/\s+/g, '').replace(/^(?:在|于|通过)/, '');
		subject = hit[2].replace(/\s+/g, '').replace(/(?:软按键|开关选项|开关|按键|按钮|选项)$/, '');
		if (!surface || !subject || subject.length < 2) continue;
		const genericStop = new Set(['系统', '功能', '当前', '对应', '所有', ...configTerms('generic_names')].map((w) => String(w).toLowerCase()));
		if (genericStop.has(subject.toLowerCase())) continue;
		rawEntryCandidates.push({
			fact_id: fact.fact_id,
			evidence_refs: fact.evidence_refs || [],
			feature_id: factToFeature.get(fact.fact_id)?.feature_id || '',
			surface,
			subject,
			statement: stmt
		});
	}

	// Group raw entry candidates by (normKey(surface), normKey(subject)), merging prefix-overlapping surface names for the same subject
	const groupedEntries = new Map();
	for (const cand of rawEntryCandidates) {
		const surfNorm = normKey(cand.surface);
		const subjNorm = normKey(cand.subject);
		let mergedKey = `${surfNorm}::${subjNorm}`;
		for (const [existKey, existVal] of groupedEntries.entries()) {
			if (normKey(existVal.subject) !== subjNorm) continue;
			const existSurf = normKey(existVal.surface);
			if (existSurf === surfNorm || existSurf.startsWith(surfNorm) || surfNorm.startsWith(existSurf)) {
				mergedKey = existKey;
				if (cand.surface.length > existVal.surface.length) {
					existVal.surface = cand.surface;
					existVal.entry_id = `ENTRY_${surfNorm}_${subjNorm}`;
					existVal.entry_label = `${cand.surface}【${existVal.subject}】`;
				}
				break;
			}
		}
		const existing = groupedEntries.get(mergedKey);
		if (existing) {
			if (!existing.entry_fact_ids.includes(cand.fact_id)) existing.entry_fact_ids.push(cand.fact_id);
			for (const r of cand.evidence_refs) if (!existing.evidence_refs.includes(r)) existing.evidence_refs.push(r);
		} else {
			groupedEntries.set(mergedKey, {
				entry_id: `ENTRY_${surfNorm}_${subjNorm}`,
				surface: cand.surface,
				subject: cand.subject,
				entry_label: `${cand.surface}【${cand.subject}】`,
				feature_id: cand.feature_id,
				entry_fact_ids: [cand.fact_id],
				evidence_refs: [...cand.evidence_refs]
			});
		}
	}

	// Match each grouped entry to request + feedback signals for its subject
	const matchedEntries = [];
	for (const entry of groupedEntries.values()) {
		const subjNorm = normKey(entry.subject);
		const scoreSignalForEntry = (s) => {
			// Strip raw ASCII signal identifier tokens when matching short ASCII subjects so substrings inside signal IDs do not false-match
			const proseOnly = s.statement.replace(/\b[A-Za-z][A-Za-z0-9_]{4,40}\b/g, ' ');
			const descAndHead = `${s.description || ''} ${proseOnly.split(/取值|0x0/)[0] || proseOnly}`;
			const headNorm = normKey(descAndHead);
			const fullProseNorm = normKey(proseOnly);
			const isShortAscii = /^[a-z0-9]{1,3}$/i.test(subjNorm);
			if (isShortAscii) {
				const wordRe = new RegExp(`(?<!MAX\\s*|最大)(?:^|[^A-Za-z0-9])${entry.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9])`, 'i');
				if (wordRe.test(descAndHead)) return 10;
				if (wordRe.test(proseOnly)) return 3;
				return 0;
			}
			if (headNorm.includes(subjNorm)) return 10;
			if (fullProseNorm.includes(subjNorm)) return 3;
			return 0;
		};
		const relatedSignals = signalMentions
			.map((s) => ({ s, score: scoreSignalForEntry(s) }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || Number(b.s.resolvedInMatrix) - Number(a.s.resolvedInMatrix))
			.map((x) => x.s);
		const reqSigs = relatedSignals.filter((s) => s.role === 'request');
		if (reqSigs.length === 0) {
			excluded_entries.push({
				entry_id: entry.entry_id,
				entry_label: entry.entry_label,
				fact_ids: entry.entry_fact_ids,
				reason: 'no_closed_loop_signal_pair'
			});
			continue;
		}
		const reqSig = reqSigs.find((s) => s.resolvedInMatrix) || reqSigs[0];
		const reqEvRefs = new Set(reqSig.evidence_refs || []);
		// Also include feedback signals from the exact same interface table (evidence_refs) as reqSig
		const fbCandidates = signalMentions
			.filter((s) => s.role === 'feedback')
			.map((s) => {
				const baseScore = scoreSignalForEntry(s);
				const sameTableBonus = (s.evidence_refs || []).some((r) => reqEvRefs.has(r)) ? 12 : 0;
				return { s, score: baseScore + sameTableBonus };
			})
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || Number(b.s.resolvedInMatrix) - Number(a.s.resolvedInMatrix))
			.map((x) => x.s);
		if (fbCandidates.length === 0) {
			excluded_entries.push({
				entry_id: entry.entry_id,
				entry_label: entry.entry_label,
				fact_ids: entry.entry_fact_ids,
				reason: 'no_closed_loop_signal_pair'
			});
			continue;
		}
		const fbSig = fbCandidates.find((s) => s.resolvedInMatrix) || fbCandidates[0];
		if (!reqSig.resolvedInMatrix || !fbSig.resolvedInMatrix) {
			gaps.push({
				kind: 'unresolved_entry_signal',
				entry_id: entry.entry_id,
				entry_label: entry.entry_label,
				request_signal: reqSig.name,
				feedback_signal: fbSig.name,
				fact_ids: [...new Set([...entry.entry_fact_ids, reqSig.fact_id, fbSig.fact_id])],
				message: `入口「${entry.entry_label}」关联信号 ${!reqSig.resolvedInMatrix ? reqSig.name : fbSig.name} 未在协议矩阵中命中`
			});
			continue;
		}
		const signalFactIds = [...new Set([reqSig.fact_id, fbSig.fact_id])];
		const signalEvRefs = [...new Set([...(reqSig.evidence_refs || []), ...(fbSig.evidence_refs || [])])];
		matchedEntries.push({
			...entry,
			request_signal: reqSig,
			feedback_signal: fbSig,
			signal_fact_ids: signalFactIds,
			evidence_refs: [...new Set([...entry.evidence_refs, ...signalEvRefs])]
		});
	}

	// Count entries per subject: if a project has multi-entry closed-loop subjects (e.g. main page + shortcut bar),
	// prioritize multi-entry subjects so we don't explode across single-entry sub-controls in large projects.
	const countBySubject = new Map();
	for (const e of matchedEntries) {
		const k = normKey(e.subject);
		countBySubject.set(k, (countBySubject.get(k) || 0) + 1);
	}
	const hasMultiEntrySubjects = [...countBySubject.values()].some((c) => c >= 2);
	const entries = (hasMultiEntrySubjects && matchedEntries.length > 2 && options.includeSingleEntries !== true)
		? matchedEntries.filter((e) => (countBySubject.get(normKey(e.subject)) || 0) >= 2)
		: matchedEntries;

	// 4. Build (entry × branch) coverage cells
	const cells = [];
	for (const entry of entries) {
		const reqName = entry.request_signal.message
			? `${entry.request_signal.message}(${entry.request_signal.message_id}).${entry.request_signal.name}`
			: entry.request_signal.name;
		const fbName = entry.feedback_signal.message
			? `${entry.feedback_signal.message}(${entry.feedback_signal.message_id}).${entry.feedback_signal.name}`
			: entry.feedback_signal.name;
		const reqValid = entry.request_signal.validEnums.find((v) => /开启|打开|使能|ON/i.test(v)) || entry.request_signal.validEnums[0] || '有效目标值';
		const fbValid = entry.feedback_signal.validEnums.find((v) => /开启|打开|使能|ON/i.test(v)) || entry.feedback_signal.validEnums[0] || '与请求一致的有效反馈值';
		const fbInvalid = entry.feedback_signal.invalidEnum || entry.request_signal.invalidEnum || '无效反馈取值';

		for (const branch of branches) {
			const requiredFactRefs = [...new Set([...branch.fact_ids, ...entry.entry_fact_ids, ...entry.signal_fact_ids])];
			const cellEvRefs = [...new Set([...branch.evidence_refs, ...entry.evidence_refs])];
			let instruction = '';
			if (branch.branch_id === 'valid_hold') {
				instruction = `单击/操作「${entry.entry_label}」开关触发状态改变（控件请求—反馈流程进入等待反馈）：连续发送${branch.frames ? `三帧（${branch.frames}帧）` : ''}目标状态有效值 ${reqName}=${reqValid}，把界面设置为用户选择状态；在需求规定的${branch.window ? ` ${branch.window}（1秒）反馈窗口内` : '反馈窗口内'}收到与请求一致的有效反馈 ${fbName}=${fbValid}，根据输入反馈信号显示对应状态并保持`;
			} else if (branch.branch_id === 'timeout_rollback') {
				instruction = `从「${entry.entry_label}」触发状态改变并发出请求 ${reqName}=${reqValid}${branch.frames ? `（连续 ${branch.frames} 帧目标状态有效值）` : ''}（控件请求—反馈流程为等待反馈）后，自${branch.since || '状态改变'}起在需求规定的 ${branch.window}（1秒）反馈窗口内不提供/未收到对端反馈 ${fbName}，界面显示状态必须「${branch.rollback_action}」回退至触发前状态`;
			} else if (branch.branch_id === 'invalid_rollback') {
				instruction = `从「${entry.entry_label}」触发状态改变并发出请求 ${reqName}=${reqValid}${branch.frames ? `（连续 ${branch.frames} 帧目标状态有效值）` : ''}（控件请求—反馈流程为等待反馈）后，在${branch.window ? ` ${branch.window}（1秒）` : ''}反馈窗口内提供/收到对端无效反馈 ${fbName}=${fbInvalid}，检查回弹：界面显示状态必须「${branch.rollback_action}」回退至触发前状态`;
			}
			cells.push({
				cell_id: `${entry.entry_id}::${branch.branch_id}`,
				entry_id: entry.entry_id,
				entry_label: entry.entry_label,
				surface: entry.surface,
				subject: entry.subject,
				branch_id: branch.branch_id,
				branch_label: branch.branch_label,
				request_signal: entry.request_signal.name,
				feedback_signal: entry.feedback_signal.name,
				frames: branch.frames,
				window: branch.window,
				since: branch.since,
				rollback_action: branch.rollback_action || '',
				invalid_enum: fbInvalid,
				required_fact_refs: requiredFactRefs,
				rule_fact_ids: branch.fact_ids,
				entry_fact_ids: entry.entry_fact_ids,
				signal_fact_ids: entry.signal_fact_ids,
				evidence_refs: cellEvRefs,
				instruction
			});
		}
	}

	return {
		hasGlobalRule: branches.length > 0,
		rule_fact_ids: ruleFacts.map((f) => f.fact_id),
		frames,
		window: windowText,
		since: sinceText,
		rollback_action: rollbackAction,
		branches,
		entries,
		cells,
		excluded_entries,
		gaps
	};
}

/**
 * Given a fact batch in generate('points'), return the injected global rule + signal facts,
 * the applicable closed-loop cells for entries in this batch, and the expanded fact_id whitelist.
 */
export function closedLoopForBatch(batch = [], plan = null, allFacts = []) {
	const batchIds = new Set((batch || []).map((f) => f.fact_id));
	if (!plan || !plan.hasGlobalRule || !Array.isArray(plan.cells) || plan.cells.length === 0) {
		return { batchFacts: batch, injectedFactIds: [], cells: [], allowedFactIds: batchIds };
	}
	const matchingCells = plan.cells.filter((cell) => cell.entry_fact_ids.some((id) => batchIds.has(id)));
	if (matchingCells.length === 0) {
		return { batchFacts: batch, injectedFactIds: [], cells: [], allowedFactIds: batchIds };
	}
	const factById = new Map((allFacts || []).map((f) => [f.fact_id, f]));
	const neededIds = [...new Set(matchingCells.flatMap((cell) => cell.required_fact_refs))];
	const injectedFactIds = neededIds.filter((id) => !batchIds.has(id) && factById.has(id));
	const injectedFacts = injectedFactIds.map((id) => factById.get(id));
	const allowedFactIds = new Set([...batchIds, ...injectedFactIds]);
	return {
		batchFacts: [...batch, ...injectedFacts],
		injectedFactIds,
		cells: matchingCells,
		allowedFactIds
	};
}

/**
 * Check landed test points cell-by-cell against the closed-loop coverage plan.
 * - Generic protocol points (not naming the specific entry surface + subject) cannot satisfy an entry cell.
 * - Points merging multiple mutually-exclusive branches (e.g. valid_hold + timeout_rollback, or timeout + invalid) cannot satisfy multiple cells.
 */
export function evaluateClosedLoopCoverage(points = [], plan = null) {
	if (!plan || !plan.hasGlobalRule) {
		return { cells: [], covered_cells: [], missing_cells: [], merged_points: [], excluded_entries: plan?.excluded_entries || [], gaps: plan?.gaps || [] };
	}
	const mergedPoints = [];
	const pointBranchKind = (p) => {
		const txt = `${p.requirement || ''} ${p.condition || ''} ${p.action || ''} ${p.expected || ''}`;
		const hasTimeout = /(?:未收到|超时未收到|不提供|不注入)[^\n，。；]*?反馈[^\n。]*?(?:回弹|回退|恢复|还原)|(?:无反馈|未反馈|超时未反馈)[^\n。]*?(?:回弹|回退|恢复|还原)|(?:\d+\s*(?:s|ms|秒|毫秒))[^\n，。；]*?(?:未收到|不提供|不注入)[^\n，。；]*?反馈/i.test(txt);
		const hasInvalid = /(?:反馈值?无效|无效反馈|预留值|非法反馈)[^\n。]*?(?:回弹|回退|恢复|还原)|(?:收到|提供|注入)[^\n，。；]*?无效反馈/i.test(txt);
		const hasExplicitValidHold = /(?<!未|不)(?:收到|接收|提供)(?:与请求一致的?|对端)?有效反馈[^\n。]*?(?:保持|显示|维持|更新)|根据输入[^\n，。；]*?反馈[^\n。]*?显示/i.test(txt);
		const hasConditionalMerge = /若[^\n。]*?收到[^\n。]*?反馈[^\n。]*?则[^\n。]*?(?:保持|显示)[^\n。]*?(?:否则|未收到|无效)[^\n。]*?(?:回弹|回退)/i.test(txt);
		if (hasConditionalMerge || (hasTimeout && hasInvalid) || (hasExplicitValidHold && (hasTimeout || hasInvalid))) {
			return {
				merged: true,
				branches: [
					hasExplicitValidHold ? 'valid_hold' : null,
					hasTimeout ? 'timeout_rollback' : null,
					hasInvalid ? 'invalid_rollback' : null
				].filter(Boolean)
			};
		}
		if (hasTimeout) return { merged: false, branches: ['timeout_rollback'] };
		if (hasInvalid) return { merged: false, branches: ['invalid_rollback'] };
		const hasValidHold = hasExplicitValidHold
			|| /有效反馈保持|收到[^\n。；]*?反馈[^\n。；]*?(?:保持|不回弹|显示对应状态)/.test(txt)
			|| /(?:发|发送|连续发送|连续)\s*[一二三四五六七八九十\d]+\s*帧/.test(txt);
		return { merged: false, branches: hasValidHold ? ['valid_hold'] : [] };
	};

	const matchesEntrySurfaceAndSubject = (p, cell) => {
		if (p.closed_loop_cell?.cell_id === cell.cell_id) return true;
		if (p.closed_loop_cell?.cell_id && p.closed_loop_cell.cell_id !== cell.cell_id) return false;
		const rawTxt = `${p.requirement || ''} ${p.condition || ''} ${p.action || ''} ${p.expected || ''}`;
		const proseTxt = rawTxt.replace(/\b[A-Za-z][A-Za-z0-9_]{2,40}\s*\(0x[0-9a-fA-F]+\)/g, ' ').replace(/\b[A-Za-z][A-Za-z0-9_]{4,40}\b/g, ' ');
		const txt = normKey(proseTxt);
		const actAndReq = normKey(`${p.requirement || ''} ${p.action || ''}`);
		const subj = normKey(cell.subject);
		if (/^[a-z0-9]{1,3}$/i.test(subj)) {
			const wordRe = new RegExp(`(?<!MAX\\s*|最大)(?:^|[^A-Za-z0-9])${cell.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9])`, 'i');
			if (!wordRe.test(proseTxt)) return false;
		} else if (!txt.includes(subj)) {
			return false;
		}
		const surf = normKey(cell.surface);
		const surfCore = surf.replace(/(?:界面|页面|栏|屏|面板)$/g, '');
		const otherSurfaces = (plan.entries || [])
			.filter((e) => normKey(e.subject) === subj && normKey(e.surface) !== surf)
			.map((e) => normKey(e.surface));
		// If the point's action/requirement explicitly names another entry surface for the same subject and not this cell's surface, reject
		const matchesThisSurf = actAndReq.includes(surf) || (surfCore.length >= 2 && actAndReq.includes(surfCore))
			|| txt.includes(surf) || (surfCore.length >= 2 && txt.includes(surfCore));
		const matchesOtherSurf = otherSurfaces.some((os) => {
			const osCore = os.replace(/(?:界面|页面|栏|屏|面板)$/g, '');
			return actAndReq.includes(os) || (osCore.length >= 2 && actAndReq.includes(osCore));
		});
		if (matchesOtherSurf && !actAndReq.includes(surf)) return false;
		return matchesThisSurf;
	};

	for (const p of points || []) {
		const info = pointBranchKind(p);
		if (info.merged) mergedPoints.push({ point_id: p.point_id, action: p.action, expected: p.expected });
	}

	const covered_cells = [];
	const missing_cells = [];
	const cellResults = [];
	const claimedPointIds = new Set();

	for (const cell of plan.cells || []) {
		let matchedPoint = null;
		for (const p of points || []) {
			if (p.point_id && claimedPointIds.has(p.point_id)) continue;
			const info = pointBranchKind(p);
			if (info.merged) continue;
			if (!info.branches.includes(cell.branch_id)) continue;
			if (!matchesEntrySurfaceAndSubject(p, cell)) continue;
			matchedPoint = p;
			if (p.point_id) claimedPointIds.add(p.point_id);
			break;
		}
		if (matchedPoint) {
			// Ensure fact_refs on the matched point include the cell's required_fact_refs for full traceability
			const mergedRefs = [...new Set([...(matchedPoint.fact_refs || []), ...cell.required_fact_refs])];
			matchedPoint.fact_refs = mergedRefs;
			matchedPoint.closed_loop_cell = {
				cell_id: cell.cell_id,
				entry_id: cell.entry_id,
				entry_label: cell.entry_label,
				branch_id: cell.branch_id,
				branch_label: cell.branch_label,
				required_fact_refs: cell.required_fact_refs
			};
			const rec = {
				...cell,
				covered: true,
				point_id: matchedPoint.point_id,
				point_title: matchedPoint.title || matchedPoint.requirement || '',
				fact_refs: matchedPoint.fact_refs
			};
			covered_cells.push(rec);
			cellResults.push(rec);
		} else {
			const rec = { ...cell, covered: false, point_id: null, fact_refs: [] };
			missing_cells.push(rec);
			cellResults.push(rec);
		}
	}

	return {
		cells: cellResults,
		covered_cells,
		missing_cells,
		merged_points: mergedPoints,
		excluded_entries: plan.excluded_entries || [],
		gaps: plan.gaps || []
	};
}

/** Build a 1-pass targeted supplement prompt for any missing (entry × branch) cells. */
export function closedLoopSupplementPrompt(missingCells = [], projectName = '', plan = null, allFacts = []) {
	const factById = new Map((allFacts || []).map((f) => [f.fact_id, f]));
	const neededFactIds = [...new Set(missingCells.flatMap((c) => c.required_fact_refs || []))];
	const factsBlock = neededFactIds
		.map((id) => factById.get(id))
		.filter(Boolean)
		.map((f) => `[${f.fact_id}]（${f.type}）${f.statement}  ← ${(f.evidence_refs || []).join(',')}`)
		.join('\n');
	const cellLines = missingCells.map((cell, idx) =>
		`${idx + 1}. 格子 [${cell.cell_id}]（入口：${cell.entry_label}，分支：${cell.branch_label}）：\n   - 要求：${cell.instruction}\n   - 必填 fact_refs：${JSON.stringify(cell.required_fact_refs)}`
	).join('\n');

	return compose('cts-test-design',
		`当前项目：${projectName}。以下是全局通信闭环规则在具体适用入口上尚未覆盖的「规则×入口×结果分支」遗漏项。`,
		'请为下面每一个遗漏格子单独生成 1 条测试点（严禁把多个分支合并到同一条测试点，每条测试点必须明确写出所属入口表面、触发控件、请求信号与帧数、反馈窗口/取值及界面结果，并原样填入该格要求的 fact_refs）。',
		'输出 JSON：{"points":[{"requirement":"功能名","condition":"…","action":"…","expected":"…","type":"请求发送|状态显示|异常恢复","priority":"P0|P1","fact_refs":["F-0001"],"transition_ref":""}]}',
		'',
		'待补齐的规则×入口×结果分支清单：',
		cellLines,
		'',
		'依据的产品事实：',
		factsBlock
	);
}

// ============================================================================
// Round 4: Generic Exhaustive Expansion Directives (Zero Domain Hardcoding)
// ============================================================================

/**
 * Derive evidence-backed exhaustive expansion directives for a batch of facts when coverage_mode === 'exhaustive':
 * 1. Discrete signal enums or numeric level ranges (e.g. 0x1~0x8 or >=3 valid enum values) -> expand per-value request/display points.
 * 2. Restricted/inoperable preconditions (disabled/greyed/no-response) -> expand per-control negative points.
 * 3. Mutual exclusion / multi-mode transitions -> expand per-mode switch & exit points.
 */
export function buildExhaustiveExpansionHints(batch = [], signalIndex = new Map(), bindings = []) {
	const hints = [];
	const batchIds = new Set((batch || []).map((f) => f.fact_id));
	const sigLookup = new Map();
	if (signalIndex instanceof Map) {
		for (const [k, v] of signalIndex.entries()) sigLookup.set(normKey(k), v);
	}
	for (const b of bindings || []) {
		if (b.kind === 'signal' && b.status === 'bound' && b.target) {
			const k = normKey(b.subject?.name);
			if (!sigLookup.has(k)) sigLookup.set(k, { name: b.subject.name, ...b.target });
		}
	}

	// 1. Discrete enum / range expansion from batch signals
	const seenSignals = new Set();
	for (const f of batch || []) {
		const stmt = String(f?.statement || '');
		for (const m of stmt.matchAll(/\b([A-Za-z][A-Za-z0-9_]{3,40})\b/g)) {
			const meta = sigLookup.get(normKey(m[1]));
			if (!meta || seenSignals.has(meta.name)) continue;
			seenSignals.add(meta.name);
			const descSrc = String(meta.valueDesc || '').trim() || stmt;
			const rangeMatch = /(0x[0-9a-fA-F]+|\b\d+)\s*[~～-]\s*(0x[0-9a-fA-F]+|\b\d+)\s*[:：]\s*([^\n；;，,。]{2,20})/.exec(descSrc);
			if (rangeMatch) {
				const lo = Number(rangeMatch[1]);
				const hi = Number(rangeMatch[2]);
				if (Number.isInteger(lo) && Number.isInteger(hi) && hi > lo && hi - lo <= 16 && !/(?:预留|保留|无效|无输入|Invalid|Reserved)/i.test(rangeMatch[3])) {
					hints.push(`离散档位逐项展开：信号 ${meta.name}（${meta.description || '协议信号'}，来自 ${f.fact_id}）定义连续档位 ${rangeMatch[1]}~${rangeMatch[2]}（${rangeMatch[3].trim()}），请为每一有效档位分别生成独立的请求发送/状态显示测试点，勿仅做单点等价类抽样`);
					continue;
				}
			}
			const validEnums = [];
			for (const em of descSrc.matchAll(/(0x[0-9a-fA-F]+|\b\d+)\s*[:：]\s*([^\n；;，,/／]+?)(?=\s+(?:0x[0-9a-fA-F]+|\d+(?:~0x[0-9a-fA-F]+|~\d+)?)\s*[:：]|[/／；;，,。)]|$)/g)) {
				const lbl = em[2].trim();
				if (lbl && !/(?:预留|保留|无效|无输入|Invalid|Reserved|No\s*Input|No\s*Action)/i.test(lbl) && !/^(?:默认|Default)$/i.test(lbl)) {
					validEnums.push(`${em[1].trim()}:${lbl}`);
				}
			}
			const uniqEnums = [...new Set(validEnums)];
			if (uniqEnums.length >= 3 && uniqEnums.length <= 14) {
				hints.push(`离散枚举逐项展开：信号 ${meta.name}（${meta.description || '协议信号'}，来自 ${f.fact_id}）含 ${uniqEnums.length} 个有效取值（${uniqEnums.join('、')}），请逐枚举展开独立的触发请求与反馈显示测试点`);
			}
		}
	}

	// 2. Restricted / inoperable precondition × controls expansion
	const restrictedFacts = (batch || []).filter((f) => /(?:不可操作|置灰|无响应|不响应|禁止操作|不支持操作|不可调节)/.test(f?.statement || ''));
	if (restrictedFacts.length > 0) {
		const ctrlNames = [...new Set((bindings || [])
			.filter((b) => b.kind === 'control' && b.status === 'bound' && (b.subject?.fact_ids || []).some((id) => batchIds.has(id)))
			.map((b) => stripDesignComponentPrefix(b.subject.name))
			.filter(Boolean))].slice(0, 12);
		const refIds = restrictedFacts.map((f) => f.fact_id).slice(0, 6).join('、');
		hints.push(`受限/不可操作矩阵逐控件展开：事实 ${refIds} 明确约定了不可操作/置灰/无响应前提${ctrlNames.length ? `（本批涉及控件：${ctrlNames.join('、')}）` : ''}，请针对每个受限前提 × 涉及控件逐个生成独立负向验证测试点`);
	}

	// 3. Multi-mode switch / mutual-exclusion exit expansion
	const modeFacts = (batch || []).filter((f) => /(?:互斥|退出|切换为|共\s*[3-9]\s*种|关闭前|回到.*?之前|恢复至)/.test(f?.statement || ''));
	if (modeFacts.length > 0) {
		const refIds = modeFacts.map((f) => f.fact_id).slice(0, 6).join('、');
		hints.push(`模式切换与互斥退出逐项展开：事实 ${refIds} 描述了多模式切换、互斥退出或状态恢复关系，请逐条展开各模式间切换与每种退出触发条件对应的独立测试点`);
	}

	return hints.slice(0, 12);
}

// ============================================================================
// Transformation 4: Independent Feedback Attribution for Prepare Readback
// ============================================================================

/**
 * Trace "point -> feature / confirmed relations -> related facts -> signal bindings"
 * and determine independent feedback signal attribution for initial-state readback in prepare_items.
 * Never relies on signal naming suffixes or hardcoded node names; uses matrix tx/rx direction, signal meaning, object, and enum table.
 */
export function resolvePointFeedbackAttribution(point, { facts = [], features = [], bindings = [], signalIndex = new Map(), dut = '', surface = '' } = {}) {
	if (!point) return { status: 'pure_ui', attributions: [], forbidden_request_signals: [] };
	const effectiveDut = String(dut || dutNode() || '').trim();
	const factById = new Map((facts || []).map((f) => [f.fact_id, f]));
	const directFactIds = new Set(point.fact_refs || []);

	// 1. Find related features and facts along "point -> feature -> related facts"
	const relatedFeatures = (features || []).filter((feat) =>
		(point.feature_id && feat.feature_id === point.feature_id)
		|| (feat.fact_refs || []).some((fid) => directFactIds.has(fid))
	);
	const relatedFactIds = new Set([...directFactIds]);
	for (const feat of relatedFeatures) {
		for (const fid of feat.fact_refs || []) relatedFactIds.add(fid);
	}
	// Also include facts that share the core requirement/subject name with point.requirement
	const reqClean = String(point.requirement || '').replace(/(?:开关|控制|调节|模式|功能|显示|设置|信号|交互)+$/g, '').trim();
	if (reqClean.length >= 2) {
		for (const f of facts || []) {
			if (f.statement && f.statement.includes(reqClean)) relatedFactIds.add(f.fact_id);
		}
	}

	// 2. Collect candidate signals from bindings and signalIndex across relatedFactIds
	const sigLookup = new Map();
	if (signalIndex instanceof Map) {
		for (const [k, v] of signalIndex.entries()) sigLookup.set(normKey(k), v);
	}
	const findInSigLookup = (tok) => {
		const nk = normKey(tok);
		if (!nk) return null;
		if (sigLookup.has(nk)) return sigLookup.get(nk);
		const prefixHits = [];
		const suffixHits = [];
		const multisetHits = [];
		const charsetHits = [];
		const nkMs = nk.length >= 9 ? nk.split('').sort().join('') : '';
		for (const [k, v] of sigLookup.entries()) {
			if (k.length >= 8 && nk.startsWith(k) && nk.length - k.length <= 6) prefixHits.push(v);
			if (nk.length >= 8 && k.endsWith(nk) && k.length - nk.length <= 6) suffixHits.push(v);
			if (nkMs && k.length === nk.length && k.split('').sort().join('') === nkMs) multisetHits.push(v);
			if (k.length >= 10 && nk.length >= 10 && Math.abs(k.length - nk.length) <= 2
				&& [...nk].every((ch) => k.includes(ch)) && [...k].every((ch) => nk.includes(ch))) {
				charsetHits.push(v);
			}
		}
		if (prefixHits.length === 1) return prefixHits[0];
		if (suffixHits.length === 1) return suffixHits[0];
		if (multisetHits.length === 1) return multisetHits[0];
		if (charsetHits.length === 1) return charsetHits[0];
		return null;
	};
	const candidatesByName = new Map();
	const addCandidate = (sigName, meta = {}, sourceFact = null) => {
		const matrixMeta = findInSigLookup(sigName) || {};
		const norm = normKey(matrixMeta.name || meta.name || sigName);
		if (!norm) return;
		const merged = {
			name: matrixMeta.name || meta.name || sigName,
			description: matrixMeta.description || meta.description || '',
			message: matrixMeta.message || meta.message || '',
			message_id: matrixMeta.message_id || meta.message_id || '',
			transmitter: matrixMeta.transmitter || meta.transmitter || '',
			receivers: matrixMeta.receivers || meta.receivers || [],
			direction: meta.direction || matrixMeta.direction || '',
			valueDesc: matrixMeta.valueDesc || meta.valueDesc || '',
			initial: matrixMeta.initial || meta.initial || '',
			invalid: matrixMeta.invalid || meta.invalid || '',
			factStatements: sourceFact?.statement ? [sourceFact.statement] : []
		};
		const existing = candidatesByName.get(normKey(merged.name));
		if (existing) {
			if (sourceFact?.statement && !existing.factStatements.includes(sourceFact.statement)) {
				existing.factStatements.push(sourceFact.statement);
			}
			if (!existing.description && merged.description) existing.description = merged.description;
			if (!existing.valueDesc && merged.valueDesc) existing.valueDesc = merged.valueDesc;
			if (!existing.transmitter && merged.transmitter) existing.transmitter = merged.transmitter;
			if (!existing.message && merged.message) existing.message = merged.message;
			if (!existing.message_id && merged.message_id) existing.message_id = merged.message_id;
		} else {
			candidatesByName.set(normKey(merged.name), merged);
		}
	};

	for (const b of bindings || []) {
		if (b.kind !== 'signal' || b.status !== 'bound' || !b.target) continue;
		if ((b.subject?.fact_ids || []).some((fid) => relatedFactIds.has(fid))) {
			const f = (b.subject?.fact_ids || []).map((fid) => factById.get(fid)).find(Boolean);
			addCandidate(b.subject.name, b.target, f);
		}
	}
	for (const fid of relatedFactIds) {
		const f = factById.get(fid);
		if (!f?.statement) continue;
		for (const m of f.statement.matchAll(/\b([A-Za-z][A-Za-z0-9_]{3,40})\b/g)) {
			const hit = findInSigLookup(m[1]);
			if (hit) addCandidate(hit.name, hit, f);
		}
	}

	const allCandidates = [...candidatesByName.values()];

	// 3. Classify each candidate signal strictly by matrix/fact transmit-receive direction (never by naming suffix!)
	const classifyRole = (cand) => {
		const tx = String(cand.transmitter || '').trim();
		const rxList = Array.isArray(cand.receivers) ? cand.receivers.map((r) => String(r).trim().toLowerCase()) : [];
		const dir = String(cand.direction || '');
		const factsTxt = cand.factStatements.join(' ');
		if (effectiveDut && tx) {
			if (tx.toLowerCase() === effectiveDut.toLowerCase()) return 'dut_tx';
			if (rxList.length === 0 || rxList.includes(effectiveDut.toLowerCase())) return 'peer_feedback';
		}
		if (/被测方.*?发送|^发送/i.test(dir)) return 'dut_tx';
		if (/被测方.*?接收|外部.*?→.*?被测方|^接收/i.test(dir)) return 'peer_feedback';
		if (effectiveDut) {
			const dutEsc = effectiveDut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			if (new RegExp(`发送方(?:为|:|：)?\\s*${dutEsc}`, 'i').test(factsTxt)) return 'dut_tx';
			if (new RegExp(`接收方(?:为|:|：)?\\s*${dutEsc}`, 'i').test(factsTxt)) return 'peer_feedback';
		}
		if (/发送方(?:为|:|：)?\s*(?:被测方|本端|客户端|主控)|由(?:被测方|本端)发送/.test(factsTxt)) return 'dut_tx';
		if (/接收方(?:为|:|：)?\s*(?:被测方|本端|客户端|主控)|对端(?:周期)?反馈|状态反馈/.test(factsTxt)) return 'peer_feedback';
		return 'unknown';
	};

	const dutTxSignals = [];
	const peerFeedbackSignals = [];
	const unknownSignals = [];

	// 4. Parse ALL non-environment initial-state condition clauses from point.condition
	const condText = String(point.condition || '');
	const genericStop = new Set(['系统', '功能', '当前', '对应', '所有', ...configTerms('generic_names')].map((w) => String(w).toLowerCase()));
	const extractConditionClauses = (cond, req, act) => {
		const clauses = String(cond || '').split(/[；;，,。]/).map((c) => c.trim()).filter(Boolean);
		const ENV_RE = /^(?:整车电源|电源模式|车辆上电|系统处于运行|被动采集|采集工具|用户无操作|用户无任何|尚未进行|已记录|进入.*?界面|在.*?界面|[\u4e00-\u9fa5A-Za-z0-9]{2,10}(?:页面|界面)处于(?:已激活|可见|打开)|[\u4e00-\u9fa5A-Za-z0-9]{2,10}(?:页面|界面)已显示)/;
		const reqActText = `${req || ''} ${act || ''}`;
		const parsed = [];
		for (const cl of clauses) {
			if (ENV_RE.test(cl)) continue;
			const cleanCl = cl.replace(/[【】\[\]「」]/g, '').replace(/^(?:并且|而且|同时|以及|此时|当前|且|并)\s*/, '').trim();
			const m = /^(?:在[\u4e00-\u9fa5A-Za-z0-9]{2,10}(?:界面|页面|栏))?([\u4e00-\u9fa5A-Za-z0-9/_-]{2,14}?)(?:软按键|开关选项|开关|按键|按钮|状态|模式|功能|档位)?\s*(?:当前)?(?:处于|为|已达|未达|已|保持|>|<|≥|≤)\s*(.+)$/.exec(cleanCl);
			if (m) {
				let rawSubj = stripDesignComponentPrefix(m[1].trim());
				let statePart = m[2].trim();
				const negTarget = /^非\s*([A-Za-z]{2,10}|[\u4e00-\u9fa5]{2,8})(?:\s*模式|\s*状态)?$/.exec(statePart);
				if (negTarget && !/^(?:开启|关闭|打开|使能|有效|无效|激活|运行|静音)$/.test(negTarget[1]) && genericStop.has(rawSubj.toLowerCase())) {
					rawSubj = stripDesignComponentPrefix(negTarget[1].trim());
					statePart = `非${rawSubj}（关闭）`;
				}
				const maxPerm = /^([\u4e00-\u9fa5]{2,6})MAX$/i.exec(rawSubj);
				if (maxPerm) {
					rawSubj = reqActText.includes(maxPerm[1]) && !reqActText.includes(`最大${maxPerm[1]}`)
						? maxPerm[1]
						: `最大${maxPerm[1]}`;
				}
				const isGeneric = genericStop.has(rawSubj.toLowerCase());
				const inReqAct = rawSubj.length >= 2 && reqActText.toLowerCase().includes(rawSubj.toLowerCase());
				parsed.push({
					subject: rawSubj,
					clause: cl,
					statePart,
					priority: (inReqAct ? 10 : 0) + (!isGeneric ? 6 : 0)
				});
				continue;
			}
			// Also match negated mode clauses without copula like "系统状态非 AUTO" / "非 AUTO 模式"
			const negMode = /^(?:[\u4e00-\u9fa5]{2,6}?(?:状态)?)?非\s*([A-Za-z]{2,10}|[\u4e00-\u9fa5]{2,8})(?:\s*模式|\s*状态)?$/.exec(cleanCl);
			if (negMode) {
				const rawSubj = stripDesignComponentPrefix(negMode[1].trim());
				const isGeneric = genericStop.has(rawSubj.toLowerCase());
				const inReqAct = rawSubj.length >= 2 && reqActText.toLowerCase().includes(rawSubj.toLowerCase());
				parsed.push({
					subject: rawSubj,
					clause: cl,
					statePart: `非${rawSubj}（关闭）`,
					priority: (inReqAct ? 10 : 0) + (!isGeneric ? 6 : 0)
				});
			}
		}
		if (parsed.length > 0) {
			parsed.sort((a, b) => b.priority - a.priority);
			return parsed;
		}
		const cleanReq = stripDesignComponentPrefix(String(req || '').replace(/[【】\[\]「」]/g, '').trim())
			.replace(/(?:开启|关闭|打开|退出|进入|切换|调节|设置|请求|状态|反馈|控制|显示|联动).*$/, '')
			.trim();
		const maxPerm = /^([\u4e00-\u9fa5]{2,6})MAX$/i.exec(cleanReq);
		return [{
			subject: (maxPerm ? `最大${maxPerm[1]}` : cleanReq) || String(req || '').slice(0, 10),
			clause: cond,
			statePart: cond,
			priority: 0
		}];
	};

	const parsedClauses = extractConditionClauses(condText, point.requirement, point.action).slice(0, 4);
	const primaryCond = parsedClauses[0];
	const targetSubject = primaryCond.subject;
	const stateFocus = primaryCond.statePart || condText;

	// Expand relatedFactIds across all parsed clause subjects (plus facts sharing their interface evidence_refs)
	const subjectEvRefsByClause = new Map();
	for (const cl of parsedClauses) {
		const subj = cl.subject;
		const evSet = new Set();
		subjectEvRefsByClause.set(subj, evSet);
		if (subj && subj.length >= 2) {
			const altSubj = /^最大([\u4e00-\u9fa5]{2,6})$/.exec(subj)?.[1];
			for (const f of facts || []) {
				if (!f?.statement) continue;
				if (f.statement.includes(subj) || (altSubj && f.statement.includes(`${altSubj}MAX`))) {
					relatedFactIds.add(f.fact_id);
					if (f.type === 'signal') {
						for (const r of f.evidence_refs || []) evSet.add(r);
					}
				}
			}
			for (const f of facts || []) {
				if (f?.type === 'signal' && (f.evidence_refs || []).some((r) => evSet.has(r))) {
					relatedFactIds.add(f.fact_id);
				}
			}
		}
	}
	for (const fid of relatedFactIds) {
		const f = factById.get(fid);
		if (!f?.statement) continue;
		for (const m of f.statement.matchAll(/\b([A-Za-z][A-Za-z0-9_]{3,40})\b/g)) {
			const hit = findInSigLookup(m[1]);
			if (hit) addCandidate(hit.name, hit, f);
		}
	}

	if (candidatesByName.size === 0) {
		return { status: 'pure_ui', attributions: [], forbidden_request_signals: [] };
	}

	// Collect and classify all candidates
	for (const cand of candidatesByName.values()) {
		cand.tx_role = classifyRole(cand);
		if (cand.tx_role === 'dut_tx') dutTxSignals.push(cand);
		else if (cand.tx_role === 'peer_feedback') peerFeedbackSignals.push(cand);
		else unknownSignals.push(cand);
	}
	const updatedForbiddenNames = dutTxSignals.map((s) => s.name);
	if (peerFeedbackSignals.length === 0) {
		if (unknownSignals.length > 0) {
			return {
				status: 'insufficient_feedback',
				reason: `候选信号 ${unknownSignals.map((s) => s.name).join('、')} 收发方向未知，无法确认为独立对端反馈`,
				attributions: [],
				forbidden_request_signals: updatedForbiddenNames
			};
		}
		return {
			status: 'only_request',
			reason: `仅存在被测方外发请求信号（${updatedForbiddenNames.join('、')}），无独立对端状态反馈信号`,
			attributions: [],
			forbidden_request_signals: updatedForbiddenNames
		};
	}

	const parseEnumEntries = (cand) => {
		// Prefer matrix/binding valueDesc over multi-signal fact text so request enums never pollute feedback enums
		const primarySrc = String(cand.valueDesc || '').trim();
		const fallbackSrc = cand.factStatements.join(' ');
		const extractFrom = (raw) => {
			const entries = [];
			for (const m of String(raw || '').matchAll(/(0x[0-9a-fA-F]+|\b\d+)\s*[:：]\s*([^\n；;，,/／]+?)(?=\s+(?:0x[0-9a-fA-F]+|\d+(?:~0x[0-9a-fA-F]+|~\d+)?)\s*[:：]|[/／；;，,。)]|$)/g)) {
				entries.push({ code: m[1].trim(), label: m[2].trim() });
			}
			return entries;
		};
		const fromPrimary = extractFrom(primarySrc);
		return fromPrimary.length > 0 ? fromPrimary : extractFrom(fallbackSrc);
	};

	const cjkBigrams = (str) => {
		const s = String(str || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').toLowerCase();
		const out = new Set();
		for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
		if (s.length === 1) out.add(s);
		return out;
	};
	const pointText = `${point.requirement || ''} ${point.condition || ''} ${point.action || ''} ${point.expected || ''}`;
	const uiSurface = surface || defaultSurface() || '目标界面';

	const resolveClause = (clObj) => {
		const subj = clObj.subject || '';
		const focus = clObj.statePart || condText;
		const clEvRefs = subjectEvRefsByClause.get(subj) || new Set();
		const wantsClosed = /(?:关闭|未开启|未激活|处于\s*(?:关闭|OFF|未开启)\s*(?:状态|态)?|为\s*(?:关闭|OFF|未开启)\s*(?:状态|态)?|\bOFF\s*状态|关机|^非)/i.test(focus);
		const wantsOpen = !wantsClosed && /(?<!未|不|非)(?:已开启|处于\s*(?:开启|ON)\s*(?:状态|态)?|为\s*(?:开启|ON)\s*(?:状态|态)?|开启状态|开启态|\bON\s*状态|使能|开机)/i.test(focus);

		const matchEnumForTarget = (entries, targetHint, candDesc = '') => {
			if (!entries.length) {
				const gearHit = /(?:LVL|档位为?)\s*([1-8])\s*档?/i.exec(targetHint);
				if (gearHit && /0x1~0x8|1~8/.test(candDesc)) return `0x${gearHit[1]}（${gearHit[1]}档）`;
				return null;
			}
			if (wantsClosed || (!wantsOpen && /关闭|未开启|\bOFF\b|关机|^非/i.test(targetHint))) {
				const hit = entries.find((e) => /(?:关闭|\bOff\b|未开启|未激活|禁用|灭)/i.test(e.label) && !/无输入|无效|预留/.test(e.label));
				if (hit) return `${hit.code}（${hit.label}）`;
			}
			if (wantsOpen || /开启|打开|\bON\b|使能|开机/i.test(targetHint)) {
				const hit = entries.find((e) => /(?:开启|打开|\bOn\b|使能|激活|亮)/i.test(e.label) && !/无输入|无效|预留/.test(e.label));
				if (hit) return `${hit.code}（${hit.label}）`;
			}
			const gearHit = /(?:LVL|档位为?)\s*([1-8])\s*档?/i.exec(targetHint);
			if (gearHit && /0x1~0x8|1~8/.test(candDesc)) {
				return `0x${gearHit[1]}（${gearHit[1]}档）`;
			}
			if (/(?:>\s*3\s*档|未达\s*LVL8)/i.test(targetHint) && /0x1~0x8|1~8/.test(candDesc)) {
				return '0x4（4档）';
			}
			const sortedEntries = [...entries].sort((a, b) =>
				b.label.replace(/模式|状态/g, '').trim().length - a.label.replace(/模式|状态/g, '').trim().length
			);
			for (const e of sortedEntries) {
				const cleanLbl = e.label.replace(/模式|状态/g, '').trim();
				if (cleanLbl.length >= 2 && focus.includes(cleanLbl)) {
					return `${e.code}（${e.label}）`;
				}
			}
			return null;
		};

		const subjToks = cjkBigrams(subj.includes('最大') ? `${subj} max` : subj);
		const scoredFeedback = peerFeedbackSignals.map((cand) => {
			const enumEntries = parseEnumEntries(cand);
			const descText = `${cand.description || ''}`;
			const semText = `${descText} ${cand.factStatements.join(' ')}`;
			const targetEnum = matchEnumForTarget(enumEntries, focus, `${cand.valueDesc || ''} ${semText}`);
			const candToks = cjkBigrams(semText);
			let overlap = 0;
			for (const t of subjToks) if (candToks.has(t)) overlap += 1;
			const subjClean = subj.replace(/[/／]/g, '').toLowerCase();
			const descClean = descText.replace(/[/／]/g, '').toLowerCase();
			const descExactHit = subjClean.length >= 2 && descClean.includes(subjClean) ? 15 : 0;
			const factExactHit = subjClean.length >= 2 && semText.replace(/[/／]/g, '').toLowerCase().includes(subjClean) ? 8 : 0;
			const sameInterfaceTableBonus = clEvRefs.size > 0 && (facts || []).some((f) =>
				f.type === 'signal'
				&& (f.evidence_refs || []).some((r) => clEvRefs.has(r))
				&& (f.statement.includes(cand.name) || findInSigLookup(cand.name)?.name === cand.name)
			) ? 10 : 0;
			const leftoverDesc = descClean
				.replace(subjClean, '')
				.replace(/(?:系统|开关|关闭|开启|状态|反馈|信号|实际|指示灯|等级|设定)/g, '')
				.trim();
			const extraSubfunctionPenalty = (leftoverDesc.length >= 2 && !focus.toLowerCase().includes(leftoverDesc)) ? -6 : 0;
			const switchStateBonus = ((wantsClosed || wantsOpen) && /(?:系统)?(?:开关|关闭)/.test(descText) && leftoverDesc.length === 0) ? 8 : 0;
			const citedInPointBonus = pointText.includes(cand.name) ? 12 : 0;
			return {
				cand,
				enumEntries,
				targetEnum,
				wantsClosed,
				wantsOpen,
				score: overlap + descExactHit + factExactHit + sameInterfaceTableBonus + extraSubfunctionPenalty + switchStateBonus + citedInPointBonus
			};
		}).sort((a, b) => Number(Boolean(b.targetEnum)) - Number(Boolean(a.targetEnum)) || b.score - a.score);

		const best = scoredFeedback[0];
		const tied = scoredFeedback.filter((x) => x.score === best.score && Boolean(x.targetEnum) === Boolean(best.targetEnum));
		if (tied.length > 1) {
			return {
				status: 'ambiguous_feedback',
				reason: `同一功能下存在多个得分相同的候选反馈信号（${tied.map((t) => t.cand.name).join(' vs ')}），无法唯一归属初态反馈`
			};
		}
		if (!best.targetEnum) {
			return {
				status: 'insufficient_feedback',
				reason: `候选反馈信号 ${best.cand.name} 缺少支持目标初态「${focus || subj}」的枚举取值定义`
			};
		}
		const fb = best.cand;
		const msgPrefix = fb.message && fb.message_id ? `${fb.message}(${fb.message_id}).` : (fb.message ? `${fb.message}.` : '');
		const targetStateLabel = best.wantsClosed ? '关闭状态' : (best.wantsOpen ? '开启状态' : (focus.slice(0, 24) || '目标初态'));
		const readBackTemplate = `在原始采集记录中读回对端反馈 ${msgPrefix}${fb.name}=${best.targetEnum}（确认${subj || '被测对象'}处于${targetStateLabel}），并在${uiSurface}核对【${subj || '对应控件'}】显示状态与反馈一致`;
		return {
			status: 'unique_feedback',
			score: best.score,
			attribution: {
				object: subj || point.requirement || '待测对象',
				target_state: targetStateLabel,
				feedback_signal: fb.name,
				message: fb.message || '',
				message_id: fb.message_id || '',
				direction: fb.direction || (fb.transmitter ? `外部 ${fb.transmitter} → 被测方接收` : '对端反馈 → 被测方接收'),
				target_enum: best.targetEnum,
				matrix_initial: fb.initial || '',
				read_back_template: readBackTemplate,
				forbidden_request_signals: updatedForbiddenNames
			}
		};
	};

	const primaryRes = resolveClause(primaryCond);
	if (primaryRes.status !== 'unique_feedback') {
		return {
			status: primaryRes.status,
			reason: primaryRes.reason,
			attributions: [],
			forbidden_request_signals: updatedForbiddenNames
		};
	}

	const attributions = [primaryRes.attribution];
	const seenFbSignals = new Set([primaryRes.attribution.feedback_signal]);
	// Resolve remaining compound precondition clauses (require strong semantic match score >= 10)
	for (const secClause of parsedClauses.slice(1)) {
		const secRes = resolveClause(secClause);
		if (secRes.status === 'unique_feedback' && secRes.score >= 10 && !seenFbSignals.has(secRes.attribution.feedback_signal)) {
			seenFbSignals.add(secRes.attribution.feedback_signal);
			attributions.push(secRes.attribution);
		}
	}

	return {
		status: 'unique_feedback',
		attributions,
		forbidden_request_signals: updatedForbiddenNames
	};
}

/**
 * Deterministic post-processor for prepare_items on cases with unique independent feedback attribution:
 * - Ensures passive capture session startup is placed first before signal baseline readback (auto-injecting if missing)
 *   and explicitly lists the case's subscribed signals/messages in the capture preparation read_back;
 * - Ensures every uniquely-attributed condition clause (including compound preconditions) has explicit independent feedback read_back;
 * - Replaces any erroneous citation of forbidden outgoing request signals in prepare_items[].read_back.
 */
export function enrichPrepareFeedbackReadback(caseItem, point, attribution, surface = '', bindings = null) {
	if (!caseItem || !attribution) return caseItem;
	const prep = Array.isArray(caseItem.prepare_items) ? caseItem.prepare_items.map((p) => ({ ...p })) : [];
	if (prep.length === 0) return caseItem;

	const forbidden = new Set(attribution.forbidden_request_signals || []);

	// Build signal metadata lookup for formatting subscribed capture checklist
	const sigMetaByName = new Map();
	for (const b of bindings?.items || []) {
		if (b.kind === 'signal' && b.status === 'bound' && b.target && b.subject?.name) {
			sigMetaByName.set(b.subject.name, b.target);
		}
	}
	for (const attr of attribution.attributions || []) {
		if (attr.feedback_signal && !sigMetaByName.has(attr.feedback_signal)) {
			sigMetaByName.set(attr.feedback_signal, { message: attr.message, message_id: attr.message_id });
		}
	}
	const formatSigRef = (sigName) => {
		const m = sigMetaByName.get(sigName);
		if (m?.message && m?.message_id) return `${m.message}(${m.message_id}).${sigName}`;
		if (m?.message) return `${m.message}.${sigName}`;
		return sigName;
	};

	const annotateCaptureSubscriptions = (prepList) => {
		const capItem = prepList.find((p) => p.key === 'capture' || p.key === 'capture-session' || /被动采集|启动.*?采集/.test(`${p.text || ''} ${p.object || ''} ${p.establish || ''}`));
		if (!capItem) return;
		const subscribed = new Set();
		for (const attr of attribution.attributions || []) {
			if (attr.feedback_signal) subscribed.add(formatSigRef(attr.feedback_signal));
		}
		for (const reqSig of forbidden) {
			if (JSON.stringify(caseItem).includes(reqSig)) subscribed.add(formatSigRef(reqSig));
		}
		for (const s of caseItem.signals || []) subscribed.add(formatSigRef(s));
		const sigList = [...subscribed].slice(0, 8);
		if (sigList.length === 0) return;
		const subNote = `已确认采集配置已订阅本例信号（${sigList.join('、')}）且实时记录中可读到有效帧`;
		if (!String(capItem.read_back || '').includes('已订阅')) {
			capItem.read_back = capItem.read_back ? `${capItem.read_back}；${subNote}` : subNote;
		}
	};

	// 1. If status is only_request / ambiguous_feedback / insufficient_feedback, strip any forbidden outgoing request signal from prepare_items.read_back
	if (attribution.status !== 'unique_feedback' || !attribution.attributions?.length) {
		for (const item of prep) {
			if (!item.read_back) continue;
			for (const reqSig of forbidden) {
				if (item.read_back.includes(reqSig)) {
					item.read_back = `在${surface || defaultSurface() || '目标界面'}通过独立上级状态确认「${item.object || '初态'}」已处于「${item.target || '目标初态'}」（被测方外发请求信号 ${reqSig} 不作初态反馈读回）`;
				}
			}
		}
		annotateCaptureSubscriptions(prep);
		caseItem.prepare_items = prep;
		return renderLegacyFields(caseItem, caseItem, point);
	}

	const primaryAttr = attribution.attributions[0];
	const isCaptureItem = (p) => p.key === 'capture' || p.key === 'capture-session' || /被动采集会话|启动.*?采集/.test(`${p.object || ''} ${p.text || ''} ${p.establish || ''}`);

	// 2. Ensure capture startup item exists and is placed first in prepare_items before any signal readback
	let capIdx = prep.findIndex(isCaptureItem);
	if (capIdx > 0) {
		const [capItem] = prep.splice(capIdx, 1);
		prep.unshift(capItem);
	} else if (capIdx === -1) {
		prep.unshift({
			id: `p-cap-${stepDigest('在采集工具中启动被动采集')}`,
			key: 'capture-session',
			object: '被动采集会话',
			text: '在采集工具中启动被动采集',
			target: '正在记录',
			establish: '在采集工具中启动被动采集并加载本例监控信号列表',
			read_back: '在采集工具状态栏确认会话正在记录并记录会话标识',
			on_failure: '无法确认采集已开始则停止本例'
		});
		const restore = Array.isArray(caseItem.restore_items) ? caseItem.restore_items : [];
		if (!restore.some((r) => /(?:停止|关闭|结束).{0,10}(?:采集|录制)/.test(r?.text || ''))) {
			restore.push({
				id: `r-cap-${stepDigest('在采集工具中停止本例采集并保存记录')}`,
				key: 'capture-session',
				text: '在采集工具中停止本例采集并保存记录',
				baseline: '恢复到启动采集前',
				read_back: '确认本例会话已停止并核对保存的记录可打开',
				on_failure: '记录失败，保留可用记录供复核'
			});
			caseItem.restore_items = restore;
		}
	}

	// 3. Replace any forbidden outgoing request signal in prepare_items[].read_back
	for (const item of prep) {
		if (isCaptureItem(item)) continue;
		const rb = String(item.read_back || '');
		const citesForbidden = [...forbidden].some((reqSig) => rb.includes(reqSig) || String(item.object || '').includes(reqSig));
		if (citesForbidden) {
			item.object = primaryAttr.object;
			item.target = primaryAttr.target_state;
			item.read_back = primaryAttr.read_back_template;
		}
	}

	// 4. Ensure every uniquely-attributed condition clause (primary + compound secondary clauses) has its feedback readback
	for (let idx = 0; idx < attribution.attributions.length; idx += 1) {
		const attr = attribution.attributions[idx];
		const code = attr.target_enum.split('（')[0];
		const alreadyCovered = prep.some((item) =>
			!isCaptureItem(item)
			&& String(item.read_back || '').includes(attr.feedback_signal)
			&& String(item.read_back || '').includes(code)
		);
		if (alreadyCovered) continue;

		if (idx === 0) {
			const targetPrep = prep.find((p) => !isCaptureItem(p) && !/电源模式/.test(String(p.object || '')))
				|| prep.find((p) => !isCaptureItem(p));
			if (targetPrep) {
				const prevRb = String(targetPrep.read_back || '').trim();
				targetPrep.read_back = prevRb && !prevRb.includes('state_variant')
					? `${attr.read_back_template}；${prevRb}`
					: attr.read_back_template;
			} else {
				prep.push({
					id: `p-fb-${stepDigest(`${attr.object}:${attr.feedback_signal}`)}`,
					key: `p_fb_${idx + 1}`,
					object: attr.object,
					text: `确认${attr.object}处于${attr.target_state}`,
					target: attr.target_state,
					establish: `按前置要求建立${attr.object}=${attr.target_state}并记录初始基线`,
					read_back: attr.read_back_template,
					on_failure: '无法建立或读回独立反馈基线则停止本例'
				});
			}
		} else {
			// Secondary clause of a compound precondition: enrich matching prepare_item or append dedicated baseline item
			const matchingPrep = prep.find((p) => !isCaptureItem(p) && String(p.object || '').includes(attr.object));
			if (matchingPrep) {
				const prevRb = String(matchingPrep.read_back || '').trim();
				matchingPrep.read_back = prevRb ? `${attr.read_back_template}；${prevRb}` : attr.read_back_template;
			} else {
				prep.push({
					id: `p-fb-${stepDigest(`${attr.object}:${attr.feedback_signal}`)}`,
					key: `p_fb_${idx + 1}`,
					object: attr.object,
					text: `确认复合前置条件「${attr.object}」处于${attr.target_state}`,
					target: attr.target_state,
					establish: `建立前置条件使${attr.object}处于${attr.target_state}并记录基线`,
					read_back: attr.read_back_template,
					on_failure: '无法建立或读回复合前置独立反馈则停止本例'
				});
			}
		}
	}

	annotateCaptureSubscriptions(prep);
	caseItem.prepare_items = prep;
	return renderLegacyFields(caseItem, caseItem, point);
}

