/**
 * UI 视觉匹配的任务结构、候选检索与无标注图片准备。
 * 这里只产出“待判断任务”，不写 ui-links；最终写入仍由 ui.js / ui-figures.js 完成。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { load as loadArtifact, structureCase } from './artifacts.js';
import { renderVisual } from './case-visuals.js';
import {
	compact, linkValidity, loadIndex, loadLinks, match, namedObjectsIn, pageHintsIn,
	roleHintFor, stateTokens, uiApplicability
} from './ui.js';

export const VISION_MODEL = 'inclusionai/ling-3.2-flash:free';
export const PROMPT_VERSION = 'ui-match-v4';
export const SCHEMA_VERSION = 1;
const CANDIDATE_LIMIT = 6;
const VISUAL_STATE = new Set(['未选中', '未激活', '未开启', '不可用', '加载中', '选中', '默认', '禁用', '置灰', '变灰', '开启', '关闭', '打开', '高亮', '激活', '灰']);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const shortId = (value) => sha256(value).slice(0, 16);
const norm = (value) => String(value || '')
	.replace(/[\s_\-·、，,。.:：;；()（）【】\[\]"'“”‘’]/g, '').toLowerCase();

function stripQuotes(text) {
	return String(text || '').replace(/[“”"「」『』‘’]/g, '');
}

function splitOutsideQuotes(text, pattern) {
	const parts = [];
	let buffer = '';
	let quote = '';
	const closing = { '“': '”', '「': '」', '『': '』', '‘': '’', '"': '"' };
	for (const char of String(text || '')) {
		if (quote) {
			buffer += char;
			if (char === quote) quote = '';
			continue;
		}
		if (closing[char]) { quote = closing[char]; buffer += char; continue; }
		if (pattern.test(char)) {
			if (buffer.trim()) parts.push(buffer.trim());
			buffer = '';
			continue;
		}
		buffer += char;
	}
	if (buffer.trim()) parts.push(buffer.trim());
	return parts;
}

const ACTION_ONLY = /^(?:点击|单击|双击|按下|长按|轻触|滑动|拖动|选择|进入|打开|关闭|返回|切到|切换到|操作)[^。；;]{0,40}(?:后|之后|以后|时|前)$/;
const RESULT_WORDS = /(显示|出现|提示|变为|呈现|展示|弹出|文案|文字|置灰|变灰|禁用|选中|激活|关闭|开启|高亮|默认)/;

/**
 * 把一个预期文本拆成可独立核验的 UI 断言；原文、expected_id 不变。
 * assertion_id 只用于任务/证据，不参与现有 linkKey，因此旧关联键保持兼容。
 */
export function atomicAssertions(originalText, options = {}) {
	const expectedId = options.expectedId || '';
	const source = String(originalText || '').replace(/^S\d+(?:-\d+)?[.、．:：]?\s*/, '').trim();
	if (!source) return [];
	const clauses = [];
	for (const block of splitOutsideQuotes(source, /[；;。]/)) {
		const chunks = block.split(/(?:，|,)?\s*(?:并且|同时|且)\s*/).filter(Boolean);
		for (const chunk of chunks) clauses.push(...splitOutsideQuotes(chunk, /[，,]/));
	}
	const kept = [];
	let pendingAction = '';
	for (const clause of clauses) {
		const value = clause.replace(/^S\d+(?:-\d+)?[.、．:：]?\s*/, '').trim();
		if (!value) continue;
		const states = stateTokens(value).filter((state) => VISUAL_STATE.has(state));
		const quoted = [...value.matchAll(/[“"「『]([^”"」』]{1,40})[”"」』]/g)].map((hit) => hit[1]);
		const named = namedObjectsIn(value);
		const actionOnly = ACTION_ONLY.test(value) && !quoted.length && states.length === 0;
		if (actionOnly) { pendingAction = pendingAction ? `${pendingAction} ${value}` : value; continue; }
		const content = states.length || quoted.length || RESULT_WORDS.test(value) ||
			/(页面|界面|弹窗|提示|控件|按钮|图标|开关|列表|页签|菜单)/.test(value) || named.length;
		if (!content) { pendingAction = pendingAction ? `${pendingAction} ${value}` : value; continue; }
		kept.push({ text: pendingAction ? `${pendingAction} ${value}` : value, assertionText: value, pendingAction });
		pendingAction = '';
	}
	if (!kept.length) kept.push({ text: source, assertionText: source, pendingAction });
	return kept.map((entry, index) => {
		const quoted = [...entry.assertionText.matchAll(/[“"「『]([^”"」』]{1,40})[”"」』]/g)].map((hit) => hit[1]);
		const states = stateTokens(entry.assertionText);
		const visualState = states.find((state) => VISUAL_STATE.has(state)) || states[0] || null;
		const afterShow = /(?:显示|出现|提示|文案为|文字为|呈现|展示)[：:，,]?\s*([^，,。；;]{2,30})/.exec(entry.assertionText);
		const clean = stripQuotes(entry.assertionText);
		const named = namedObjectsIn(clean).filter((name) => !/(状态|态)$/.test(name));
		const quotedText = quoted[0] || (afterShow ? stripQuotes(afterShow[1]).trim() : null);
		const statePhrase = quotedText && (/^(?:选中|未选中|默认|禁用|置灰|变灰|激活|未激活|开启|关闭|高亮|不可用)(?:状态|态)?$/.test(quotedText.trim()));
		const requestedText = statePhrase ? null : quotedText;
		return {
			assertion_id: 'a-' + shortId(`${expectedId}|${index}|${entry.assertionText}`),
			index,
			text: entry.text,
			assertion_text: entry.assertionText,
			action_context: entry.pendingAction || '',
			target: {
				object_text: named[0] || options.controlName || null,
				role: roleHintFor(entry.assertionText) || options.roleHint || null,
				requested_state: visualState,
				requested_text: requestedText || null
			}
		};
	});
}

function factsFor(documents, refs) {
	return (refs || []).map((id) => documents.facts?.items?.find((fact) => fact.fact_id === id)).filter(Boolean);
}

function pointFor(documents, pointId) {
	return (documents.points?.items || []).find((point) => point.point_id === pointId) || null;
}

function contractsFor(documents, refs) {
	return (refs || []).map((id) => documents.contracts?.items?.find((contract) => contract.contract_id === id)).filter(Boolean);
}

function caseContext(index, item, point, contracts, facts, steps) {
	const contractText = contracts.map((contract) => [contract.title, contract.condition, contract.trigger, contract.expected].filter(Boolean).join(' ')).join(' ');
	const factText = facts.map((fact) => fact.statement).join(' ');
	const navigation = steps.filter((step) => uiApplicability(step.text).level === 'required').map((step) => step.text);
	const all = [item.title, item.precondition, item.prepare_detail, point?.requirement, point?.condition, point?.action, point?.expected, contractText, factText, ...navigation].filter(Boolean);
	const pageText = [item.title, item.precondition, item.prepare_detail, point?.requirement, point?.condition, ...contracts.map((contract) => contract.condition)].filter(Boolean).join(' ');
	const pages = pageHintsIn(index, [pageText || all.join(' ')]);
	return {
		contract_refs: (point?.contract_refs || []).slice(),
		point_refs: point ? [point.point_id] : [],
		evidence_refs: facts.map((fact) => fact.fact_id),
		page: pages[0] || null,
		theme: /(深色|暗色|夜间|dark)/i.test(all.join(' ')) ? 'dark' : /(浅色|亮色|日间|light)/i.test(all.join(' ')) ? 'light' : null,
		device: null,
		language: null,
		precondition: item.precondition || item.prepare_detail || '',
		expected: String(item.expected || ''),
		navigation_steps: navigation,
		point: point ? { condition: point.condition || '', action: point.action || '', expected: point.expected || '', requirement: point.requirement || '' } : null,
		contracts: contracts.map((contract) => ({
			contract_id: contract.contract_id, title: contract.title || '',
			condition: contract.condition || '', trigger: contract.trigger || '', expected: contract.expected || ''
		})),
		facts: facts.map((fact) => ({ fact_id: fact.fact_id, statement: fact.statement })),
		title: item.title || '',
		text: [contractText, factText].filter(Boolean).join(' ')
	};
}

function taskSubject(item, step, expected, assertion) {
	return {
		kind: expected ? 'case_expected' : 'case_step',
		id: item.case_id,
		step_id: step?.id || '',
		expected_id: expected?.id || '',
		assertion_id: assertion?.assertion_id || ''
	};
}

function subjectKey(subject) {
	return [subject.kind, subject.id, subject.step_id || '', subject.expected_id || '', subject.assertion_id || ''].join('|');
}

function hasUsableLink(links, subject, purpose, index, projectDir, text) {
	return links.items.some((link) => link.subject.kind === subject.kind && link.subject.id === subject.id &&
		(link.subject.step_id || '') === (subject.step_id || '') &&
		(link.subject.expected_id || '') === (subject.expected_id || '') &&
		(link.subject.assertion_id || '') === (subject.assertion_id || '') &&
		link.purpose === purpose && link.ui_id &&
		linkValidity(link, { index, projectDir, text, states: stateTokens(text) }).usable);
}

function figureForSubject(item, subject) {
	return (item.image_refs || []).some((figure) => {
		if (subject.expected_id && figure.expected_id !== subject.expected_id) return false;
		if (subject.step_id && figure.step_id !== subject.step_id) return false;
		if (subject.assertion_id && (figure.assertion_id || '') !== subject.assertion_id) return false;
		return Boolean(figure.file);
	});
}

function baseTask(item, subject, purpose, assertion, context, target, index) {
	const body = {
		project_id: '', module_id: '',
		subject, purpose,
		target,
		context,
		text: assertion?.assertion_text || assertion?.text || '',
		original_text: assertion?.text || '',
		assertions: subject.assertion_id ? [{ assertion_id: subject.assertion_id, assertion_text: assertion?.assertion_text || assertion?.text || '' }] : [],
		basis: {
			subject, purpose, target, assertion_text: assertion?.assertion_text || '',
			context_digest: sha256(JSON.stringify(context)), index_digest: index.digest || ''
		}
	};
	body.task_id = 'v-' + shortId(JSON.stringify(body.basis));
	body.basis_digest = sha256(JSON.stringify(body.basis));
	return body;
}

/**
 * 生成视觉任务。默认只处理缺口；includeMatched=true 时也生成已有有效关联的任务，
 * 用于 A/B/C 对照时固定候选集合。
 */
export async function buildVisionTasks({ dataRoot, projectId, moduleId = '', options = {} }) {
	const index = loadIndex(dataRoot, projectId);
	if (!index.digest) throw new Error('还没有 UI 索引，请先建立');
	const links = options.links || loadLinks(dataRoot, projectId);
	const [facts, contracts, points, cases] = await Promise.all(['facts', 'contracts', 'points', 'cases']
		.map((kind) => loadArtifact(dataRoot, projectId, kind)));
	const documents = { facts, contracts, points, cases, links };
	const projectDir = path.join(dataRoot, 'projects', projectId);
	const tasks = [];
	const skipped = [];
	const seen = new Set();
	const includeMatched = options.includeMatched === true;
	for (const item of documents.cases?.items || []) {
		if (!item.step_items || !item.expected_items) structureCase(item);
		const point = pointFor(documents, item.point_id);
		const contracts = contractsFor(documents, point?.contract_refs || []);
		const facts = factsFor(documents, [...(point?.fact_refs || []), ...contracts.flatMap((contract) => contract.fact_refs || [])]);
		const context = caseContext(index, item, point, contracts, facts, item.step_items);
		const controlName = namedObjectsIn([point?.action, ...contracts.map((contract) => contract.trigger)].filter(Boolean).join(' '))[0] || '';
		const roleHint = roleHintFor(point?.action || '') || roleHintFor(context.text);
		for (const expected of item.expected_items || []) {
			const applicability = uiApplicability(expected.text, `${item.title || ''} ${context.text}`);
			if (applicability.level !== 'required') {
				skipped.push({ scope: 'case_expected', case_id: item.case_id, expected_id: expected.id, reason: applicability.reason, level: applicability.level });
				continue;
			}
			const assertions = atomicAssertions(expected.text, { expectedId: expected.id, controlName, roleHint });
			for (const assertion of assertions) {
				const atomicApplicability = uiApplicability(assertion.assertion_text, `${item.title || ''} ${context.text}`);
				if (atomicApplicability.level !== 'required') {
					skipped.push({ scope: 'case_expected', case_id: item.case_id, expected_id: expected.id, assertion_id: assertion.assertion_id, reason: atomicApplicability.reason, level: atomicApplicability.level });
					continue;
				}
				const subject = taskSubject(item, null, expected, assertion);
				const key = subjectKey(subject) + '|expected';
				if (seen.has(key)) continue;
				seen.add(key);
				if (!includeMatched && hasUsableLink(links, subject, 'expected', index, projectDir, assertion.assertion_text) &&
					figureForSubject(item, subject)) {
					skipped.push({ scope: 'case_expected', case_id: item.case_id, expected_id: expected.id, assertion_id: assertion.assertion_id, reason: '已有有效关联和配图' });
					continue;
				}
				const target = {
					object_text: assertion.target.object_text,
					role: assertion.target.role,
					requested_state: assertion.target.requested_state,
					requested_text: assertion.target.requested_text
				};
				const task = baseTask(item, subject, 'expected', assertion, context, target, index);
				// 与 derive 的展示名保持同源，写入关联后下一轮 derive 才能识别为同一对象。
				task.subject_name = String(expected.text || '').slice(0, 40);
				tasks.push(task);
			}
		}
		for (const step of item.step_items || []) {
			if (uiApplicability(step.text, [item.title, item.precondition, ...context.navigation_steps].filter(Boolean).join(' ')).level !== 'required') continue;
			const subject = taskSubject(item, step, null, null);
			const key = subjectKey(subject) + '|control';
			if (seen.has(key)) continue;
			seen.add(key);
			if (!includeMatched && hasUsableLink(links, subject, 'control', index, projectDir, step.text) && figureForSubject(item, subject)) {
				skipped.push({ scope: 'case_step', case_id: item.case_id, step_id: step.id, reason: '已有有效关联和配图' });
				continue;
			}
			const names = namedObjectsIn(step.text);
			const target = {
				object_text: names[0] || controlName || null,
				role: roleHintFor(step.text) || roleHint || null,
				requested_state: null,
				requested_text: null
			};
			const task = baseTask(item, subject, 'control', { assertion_text: step.text, text: step.text, action_context: '' }, context, target, index);
			task.subject_name = String(step.text || '').slice(0, 40);
			tasks.push(task);
		}
	}
	for (const task of tasks) {
		task.project_id = projectId;
		task.module_id = moduleId;
		task.page_hint = task.context.page || null;
	}
	return { tasks, skipped, stats: { tasks: tasks.length, skipped: skipped.length, cases: documents.cases?.items?.length || 0 } };
}

function linkSubjectMatches(link, subject) {
	return link.subject.kind === subject.kind && link.subject.id === subject.id &&
		(link.subject.step_id || '') === (subject.step_id || '') &&
		(link.subject.expected_id || '') === (subject.expected_id || '') &&
		(link.subject.assertion_id || '') === (subject.assertion_id || '');
}

function candidateMeta(object, extra = {}) {
	const target = compact(object);
	return {
		candidate_id: 'c:' + shortId([object.id, object.state || '', object.page_name || '', object.theme || ''].join('|')),
		ui_id: object.id, target,
		name: object.name || '', role: object.role || '', state: object.state || '',
		page: object.page_name || '', theme: object.theme || '', source: object.s || '',
		node_id: object.n || '', revision: object.rev || object.revision || '',
		shot: object.shot || '', shot_node: object.shot_node || '', shot_scope: object.shot_scope || null,
		origin: extra.origin || 'match', rank: extra.rank || 5, score: Number(extra.score || 0),
		reasons: extra.reasons || [], state_known: Boolean(object.state),
		asset_status: object.shot ? 'shot' : 'missing_shot'
	};
}

function candidateKey(candidate) {
	return [candidate.ui_id, candidate.state, candidate.page, candidate.theme].join('|');
}

function pushCandidate(out, candidate) {
	const key = candidateKey(candidate);
	const existing = out.get(key);
	if (!existing || candidate.rank < existing.rank || (candidate.rank === existing.rank && candidate.score > existing.score)) out.set(key, candidate);
}

function textCandidates(index, task) {
	const tokens = new Set();
	for (const name of [task.target?.object_text, task.target?.requested_text]) {
		const token = norm(name);
		if (token.length >= 2) tokens.add(token);
	}
	for (const name of namedObjectsIn(task.text).map(norm)) if (name.length >= 2) tokens.add(name);
	const wantedState = task.target?.requested_state || '';
	const page = task.context?.page || '';
	const out = [];
	for (const object of index.objects || []) {
		if (!object.shot) continue;
		const objectName = norm(object.name);
		if (objectName.length < 2) continue;
		let score = 0;
		for (const token of tokens) {
			if (objectName === token) score = Math.max(score, 0.9);
			else if (objectName.includes(token) || token.includes(objectName)) score = Math.max(score, 0.62);
		}
		if (!score) continue;
		if (wantedState && object.state && object.state !== wantedState) continue;
		if (page && object.page_name === page) score += 0.1;
		out.push(candidateMeta(object, { origin: 'text_search', rank: 4, score, reasons: ['页面/图层文字候选'] }));
	}
	return out;
}

function stateVariants(index, candidates) {
	const out = [];
	for (const candidate of candidates) {
		const base = norm(String(candidate.name).replace(/^[AB][-－—_]/, ''));
		if (base.length < 2) continue;
		for (const object of index.objects || []) {
			if (object.id === candidate.ui_id) continue;
			if (norm(String(object.name).replace(/^[AB][-－—_]/, '')) !== base) continue;
			if (object.page !== candidate.target.page && object.page_name !== candidate.page) continue;
			if ((object.state || '') === candidate.state) continue;
			out.push(candidateMeta(object, { origin: 'state_variant', rank: 5, score: 0.4 }));
		}
	}
	return out;
}

function expandedCandidates(index, task) {
	const text = `${task.target.object_text || ''} ${task.target.requested_text || ''} ${task.text} ${task.context?.text || ''}`;
	const names = namedObjectsIn(text).map(norm).filter((name) => name.length >= 2);
	const wantedState = task.target.requested_state || '';
	const out = [];
	for (const object of index.objects || []) {
		const objectName = norm(object.name);
		const hit = names.some((name) => objectName.includes(name) || name.includes(objectName));
		if (!hit) continue;
		if (wantedState && object.state && object.state !== wantedState) continue;
		out.push(candidateMeta(object, { origin: 'expanded', rank: 6, score: 0.3, reasons: ['候选扩展：按对象名跨页面检索'] }));
		if (out.length >= CANDIDATE_LIMIT * 2) break;
	}
	return out;
}

export function retrieveCandidates({ index, links, task, projectDir = '', expanded = false, limit = CANDIDATE_LIMIT }) {
	const out = new Map();
	const subject = task.subject;
	const purpose = task.purpose;
	const text = `${task.text} ${task.context?.text || ''}`;
	const states = task.target?.requested_state ? [task.target.requested_state] : stateTokens(task.text);
	const confirmed = [];
	const upstream = [];
	for (const link of links?.items || []) {
		if (!link.ui_id) continue;
		const same = linkSubjectMatches(link, subject) && link.purpose === purpose;
		const upstreamSubject = (subject.kind === 'case_expected' || subject.kind === 'case_step') &&
			((link.subject.kind === 'point' && (task.context?.point_refs || []).includes(link.subject.id)) ||
				(link.subject.kind === 'contract' && (task.context?.contract_refs || []).includes(link.subject.id)));
		if (!same && !upstreamSubject) continue;
		if (link.purpose !== purpose && !(same && link.purpose === 'expected' && purpose === 'expected')) continue;
		const validity = linkValidity(link, { index, projectDir, text, states, requireShot: false });
		if (!['valid', 'missing_asset', 'located'].includes(validity.status)) continue;
		const object = (index.objects || []).find((entry) => entry.id === link.ui_id);
		if (!object) continue;
		const candidate = candidateMeta(object, {
			origin: link.status === 'confirmed' ? 'confirmed' : (same ? 'existing' : 'upstream'),
			rank: link.status === 'confirmed' ? 1 : (same ? 2 : 3),
			score: link.status === 'confirmed' ? 1 : 0.8,
			reasons: [link.status === 'confirmed' ? '人工确认的有效关联' : same ? '同对象已有有效关联' : '上游兼容关联']
		});
		if (link.status === 'confirmed') confirmed.push(candidate);
		else upstream.push(candidate);
	}
	for (const candidate of [...confirmed, ...upstream]) pushCandidate(out, candidate);
	const token = namedObjectsIn(text);
	const query = {
		text: task.text,
		name: task.target?.object_text || '',
		roleHint: task.target?.role || '',
		pageHints: pageHintsIn(index, [task.context?.page || '', text]),
		contextText: task.context?.text || '',
		useContextTokens: !token.length
	};
	let outcome = match(index, query, { purpose, projectDir });
	// 状态未知的实例仍要进入候选，由视觉核验；不能因为缺少设计状态属性就当作无素材。
	if (!outcome.candidates?.length && states.length) {
		const relaxedText = task.text.replace(new RegExp(states.join('|'), 'g'), ' ');
		outcome = match(index, { ...query, text: relaxedText }, { purpose, projectDir });
	}
	for (const entry of outcome.candidates || []) {
		const object = (index.objects || []).find((item) => item.id === entry.ui_id);
		if (!object) continue;
		pushCandidate(out, candidateMeta(object, {
			origin: 'match', rank: 4, score: entry.score,
			reasons: entry.reasons || []
		}));
	}
	if (outcome.target) {
		const object = (index.objects || []).find((item) => item.id === outcome.target.ui_id);
		if (object) pushCandidate(out, candidateMeta(object, { origin: 'match', rank: 4, score: (outcome.candidates?.[0]?.score || 0.9), reasons: [outcome.reason] }));
	}
	for (const candidate of textCandidates(index, task)) pushCandidate(out, candidate);
	const base = [...out.values()];
	for (const candidate of stateVariants(index, base)) pushCandidate(out, candidate);
	if (expanded && out.size < limit) {
		for (const candidate of expandedCandidates(index, task)) pushCandidate(out, candidate);
	}
	let candidates = [...out.values()]
		.sort((a, b) => a.rank - b.rank || (b.asset_status === 'shot') - (a.asset_status === 'shot') || b.score - a.score);
	// 预期/操作用途的候选必须是可指认的对象；画板只能作为页面上下文，不能挤占候选位。
	if (!['page', 'reference'].includes(purpose)) {
		const concrete = candidates.filter((candidate) => candidate.target?.role !== 'board');
		if (concrete.length) candidates = concrete;
		// 没有截图的包装节点不能提交视觉核验，也不能挤掉可看图的具体控件。
		const withShot = candidates.filter((candidate) => candidate.asset_status === 'shot');
		if (withShot.length) candidates = withShot;
	}
	const wantedState = task.target?.requested_state || '';
	if (wantedState) {
		const stateMatch = candidates.filter((candidate) => candidate.state === wantedState);
		if (stateMatch.length) candidates = [...stateMatch, ...candidates.filter((candidate) => candidate.state !== wantedState)];
	}
	candidates = candidates.slice(0, limit);
	const withShot = candidates.filter((candidate) => candidate.asset_status === 'shot');
	const knownState = candidates.filter((candidate) => candidate.state_known);
	const stateMatched = wantedState ? candidates.some((candidate) => candidate.state === wantedState) : true;
	const unknownStateOnly = Boolean(wantedState && withShot.length && knownState.length === 0);
	let status = 'ok';
	let reason = '';
	if (!candidates.length) { status = 'retrieval_miss'; reason = '候选检索没有找到对象'; }
	else if (!withShot.length) { status = 'missing_asset'; reason = '已定位对象，但候选都没有可用截图'; }
	else if (wantedState && !stateMatched && !unknownStateOnly) { status = 'missing_state'; reason = `没有找到状态为「${wantedState}」的候选`; }
	else {
		const distinct = candidates.filter((candidate) => candidate.asset_status === 'shot' && candidate.origin !== 'state_variant');
		const top = distinct[0];
		const second = distinct[1];
		if (top && second && top.rank === second.rank && Math.abs(top.score - second.score) < 0.02 && top.ui_id !== second.ui_id) {
			status = 'ambiguous'; reason = '多个候选得分接近，需要看图确认';
		}
	}
	if (unknownStateOnly) reason = '候选状态属性未知，需要看图核验';
	return { status, reason, candidates, match: outcome, window: expanded ? 'expanded' : 'first', state_unknown: unknownStateOnly };
}

export function imageRoot(projectDir) {
	return path.join(projectDir, 'design', 'vision-images');
}

function pngSize(file) {
	try {
		const fd = fs.openSync(file, 'r');
		const head = Buffer.alloc(24);
		fs.readSync(fd, head, 0, 24, 0);
		fs.closeSync(fd);
		if (!head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
		return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
	} catch {
		return null;
	}
}

async function renderVisionImage(projectDir, spec) {
	const id = sha256(JSON.stringify(spec));
	const relative = path.join('design', 'vision-images', id + '.png');
	const target = path.join(projectDir, relative);
	if (!fs.existsSync(target)) {
		await fsp.mkdir(path.dirname(target), { recursive: true });
		await renderVisual('vision', target, spec);
	}
	const size = pngSize(target);
	const digest = sha256(await fsp.readFile(target));
	return { file: relative, sha256: digest, bytes: fs.statSync(target).size, width: size?.width || 0, height: size?.height || 0 };
}

function boardFor(index, candidate) {
	return (index.boards || []).find((board) => board.id === candidate.target?.board) || null;
}

function controlBounds(candidate, board) {
	const target = candidate.target || {};
	if (target.shot_node === target.node_id) return null;
	if (Array.isArray(target.shot_scope) && target.shot_scope.length === 4) return target.shot_scope;
	if (!board || !board.width || !board.height) return null;
	if (![target.x, target.y, target.w, target.h].every(Number.isFinite) || target.w <= 0 || target.h <= 0) return null;
	const x = (target.x - (board.x || 0)) / board.width;
	const y = (target.y - (board.y || 0)) / board.height;
	const w = target.w / board.width;
	const h = target.h / board.height;
	if (x < -0.05 || y < -0.05 || x + w > 1.05 || y + h > 1.05) return null;
	return [Math.max(0, x), Math.max(0, y), Math.min(1 - Math.max(0, x), w), Math.min(1 - Math.max(0, y), h)];
}

/**
 * 为候选准备无标注页面图与控件局部图。原图只读，输出写入 design/vision-images。
 */
export async function prepareCandidateImages({ projectDir, index, candidate, pageCache = new Map() }) {
	const target = candidate.target || {};
	const board = boardFor(index, candidate);
	const shot = candidate.shot;
	if (!shot) return { ...candidate, images: [], preparation: 'missing_asset' };
	const input = path.join(projectDir, shot);
	if (!fs.existsSync(input)) return { ...candidate, images: [], preparation: 'missing_asset' };
	const imageMeta = {
		image_id: 'source:' + sha256(await fsp.readFile(input)).slice(0, 16),
		role: 'source', file: shot, sha256: sha256(await fsp.readFile(input)), width: pngSize(input)?.width || 0, height: pngSize(input)?.height || 0
	};
	const pageFile = board?.shot && fs.existsSync(path.join(projectDir, board.shot)) ? board.shot : shot;
	const pageKey = pageFile + '|' + (board?.id || '');
	let page = pageCache.get(pageKey);
	if (!page) {
		page = await renderVisionImage(projectDir, {
			input: path.join(projectDir, pageFile), annotate: false, max_width: 1400, max_height: 1000
		});
		page.image_id = 'page:' + page.sha256.slice(0, 16);
		page.role = 'page_context';
		page.source_file = pageFile;
		pageCache.set(pageKey, page);
	}
	const bounds = controlBounds(candidate, board);
	const control = await renderVisionImage(projectDir, {
		input, annotate: false,
		...(bounds ? { bounds, pad: 0.3 } : {}),
		max_width: 960, max_height: 720
	});
	control.image_id = 'control:' + control.sha256.slice(0, 16);
	control.role = 'control_crop';
	control.source_file = shot;
	control.bounds = bounds;
	control.pad = bounds ? 0.3 : 0;
	control.source_sha256 = imageMeta.sha256;
	const images = page.image_id === control.image_id ? [control] : [page, control];
	return {
		...candidate,
		images,
		page_image_id: page.image_id,
		control_image_id: control.image_id,
		preparation: 'ready'
	};
}

export async function prepareVisionTask({ dataRoot, projectId, index = null, task, candidates = null }) {
	const projectDir = path.join(dataRoot, 'projects', projectId);
	const idx = index || loadIndex(dataRoot, projectId);
	let found = candidates || retrieveCandidates({ index: idx, links: loadLinks(dataRoot, projectId), task, projectDir });
	// 第一轮没有可选素材时，只允许在项目索引内扩展一次；仍失败则记录原因。
	if (!candidates && ['retrieval_miss', 'missing_asset'].includes(found.status)) {
		const expanded = retrieveCandidates({ index: idx, links: loadLinks(dataRoot, projectId), task, projectDir, expanded: true });
		if (expanded.candidates.some((candidate) => candidate.asset_status === 'shot') || !found.candidates.length) found = expanded;
	}
	const pageCache = new Map();
	const prepared = [];
	for (const candidate of found.candidates) {
		prepared.push(await prepareCandidateImages({ projectDir, index: idx, candidate, pageCache }));
	}
	const images = [];
	const seen = new Set();
	for (const candidate of prepared) {
		for (const image of candidate.images || []) {
			if (seen.has(image.image_id)) continue;
			seen.add(image.image_id);
			images.push(image);
		}
	}
	return { ...task, retrieval: { status: found.status, reason: found.reason, window: found.window }, candidates: prepared, images };
}

export function taskCacheKey(task) {
	const candidates = (task.candidates || []).map((candidate) => [
		candidate.candidate_id, candidate.ui_id, candidate.revision, candidate.state, candidate.page, candidate.asset_status,
		(candidate.images || []).map((image) => image.sha256).join(',')
	]);
	return sha256(JSON.stringify({
		model: VISION_MODEL, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION,
		task_id: task.task_id, basis_digest: task.basis_digest, target: task.target,
		candidates
	}));
}

export { CANDIDATE_LIMIT };