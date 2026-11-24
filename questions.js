/**
 * Batch questions: instead of interrupting a run every time the model hits a
 * gap, collect the gaps and ask them once a stage finishes.
 */
import fs from 'node:fs';
import path from 'node:path';

export function questionsPath(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, 'questions.json');
}

export function load(dataRoot, projectId) {
	try {
		return JSON.parse(fs.readFileSync(questionsPath(dataRoot, projectId), 'utf8'));
	} catch {
		return { updatedAt: null, items: [] };
	}
}

export function save(dataRoot, projectId, items) {
	const file = questionsPath(dataRoot, projectId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const document = { updatedAt: new Date().toISOString(), items };
	fs.writeFileSync(file, JSON.stringify(document, null, 1), 'utf8');
	return document;
}

/** Derive open questions from the artefacts that are already on disk. */
export function derive({ bindings, states, cases, points, facts }) {
	const items = [];
	const seen = new Set();
	const add = (question) => {
		const key = `${question.kind}:${question.subject}:${question.ref || ''}`;
		if (seen.has(key)) return;
		seen.add(key);
		items.push(question);
	};

	for (const binding of bindings?.items || []) {
		if (binding.status !== 'ambiguous' && binding.status !== 'unmatched') continue;
		// 候选带上页面/画板差异，让用户一眼看出同名控件分别在哪。
		const options = (binding.candidates || []).slice(0, 4).map((candidate) => {
			const where = [candidate.page, candidate.board].filter(Boolean).join(' · ');
			return where ? `${candidate.name || candidate.node_id}（${where}）` : (candidate.name || candidate.node_id);
		});
		const pageNote = binding.subject.page ? `（需求上下文：${binding.subject.page}）` : '';
		add({
			id: '',
			scope: 'design',
			kind: 'binding',
			subject: binding.subject.name,
			ref: binding.binding_id,
			question: binding.status === 'ambiguous'
				? `「${binding.subject.name}」${pageNote}对应设计稿里的哪个节点？候选重名，需要你选。`
				: `「${binding.subject.name}」${pageNote}在设计稿里没找到，能给个节点 id 或跳过吗？`,
			options: [...options, '跳过'],
			status: 'open',
			answer: ''
		});
	}

	for (const fact of facts?.items || []) {
		if (!/冲突|待确认|TBD|待定|未知/.test(String(fact.statement || ''))) continue;
		add({
			id: '',
			scope: 'ecsm',
			kind: 'fact',
			subject: fact.fact_id,
			ref: fact.fact_id,
			question: `事实「${String(fact.statement).slice(0, 60)}」标了待确认/冲突，能给定论吗？`,
			options: ['按原文保留', '我补充定论'],
			status: 'open',
			answer: ''
		});
	}

	for (const machine of states?.items || []) {
		const codes = (machine.issues || []).map((issue) => issue.code);
		if (!codes.includes('NO_TRANSITIONS') && !codes.includes('NO_STATES')) continue;
		add({
			id: '',
			scope: 'ecsm',
			kind: 'state',
			subject: machine.feature_id,
			ref: machine.feature_id,
			question: `功能点「${machine.name || machine.feature_id}」没有可用的状态转移：PRD 里没有写触发条件吗？能补一句触发方式吗？`,
			options: ['PRD 没写，先跳过', '我补充触发条件'],
			status: 'open',
			answer: ''
		});
	}

	const unbound = new Map();
	for (const item of cases?.items || []) {
		for (const control of item.controls || []) unbound.set(control.name, true);
	}
	const bound = new Set((bindings?.items || []).filter((binding) => binding.status === 'bound').map((binding) => binding.subject.name));
	const mentioned = new Set();
	for (const item of cases?.items || []) {
		for (const match of String(`${(item.steps || []).join(' ')} ${item.expected || ''}`).matchAll(/[【\[]([^】\]]{2,16})[】\]]/g)) mentioned.add(match[1]);
	}
	for (const name of mentioned) {
		if (bound.has(name)) continue;
		add({
			id: '',
			scope: 'design',
			kind: 'control',
			subject: name,
			ref: '',
			question: `用例里用到了控件「${name}」，但设计稿里没有绑定。要跳过还是指定节点？`,
			options: ['跳过', '我填节点 id'],
			status: 'open',
			answer: ''
		});
	}

	items.forEach((item, index) => {
		item.id = `Q-${String(index + 1).padStart(3, '0')}`;
	});
	return items;
}

/** Keep previous answers so rebuilding does not ask the same thing twice. */
export function merge(previous, fresh) {
	const existing = new Map((previous?.items || []).map((item) => [`${item.kind}:${item.subject}`, item]));
	let nextId = Math.max(0, ...(previous?.items || []).map((item) => Number(item.id?.replace('Q-', '')) || 0));
	const current = fresh.map((item) => {
		const key = `${item.kind}:${item.subject}`;
		const old = existing.get(key);
		existing.delete(key);
		if (!old) return { ...item, id: `Q-${String(++nextId).padStart(3, '0')}` };
		if (old.status === 'open') return { ...item, id: old.id };
		return { ...item, id: old.id, status: old.status, answer: old.answer || '', applied: old.applied, answeredAt: old.answeredAt, dismissedAt: old.dismissedAt };
	});
	return [...current, ...[...existing.values()].filter((item) => item.status !== 'open')];
}
