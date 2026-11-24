/**
 * ECSM as a first-class artefact: one document with features, their facts, states
 * and transitions, plus versioning and change impact.
 */
import crypto from 'node:crypto';
import { validate } from './states.js';
import { currentModule } from './scope.js';
import fs from 'node:fs';
import path from 'node:path';

const readJson = (file, fallback) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
};

export function ecsmDir(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule());
}

export function build(dataRoot, projectId, { facts, features, states, bindings, points, cases, contracts }) {
	const machineByFeature = new Map((states?.items || []).map((machine) => [machine.feature_id, machine]));
	const factById = new Map((facts?.items || []).map((fact) => [fact.fact_id, fact]));
	const pointIdsByFact = new Map();
	for (const point of points?.items || []) {
		for (const ref of point.fact_refs || []) {
			if (!pointIdsByFact.has(ref)) pointIdsByFact.set(ref, []);
			pointIdsByFact.get(ref).push(point.point_id);
		}
	}
	const casesByPoint = new Map();
	for (const item of cases?.items || []) {
		if (!casesByPoint.has(item.point_id)) casesByPoint.set(item.point_id, []);
		casesByPoint.get(item.point_id).push(item.case_id);
	}
	const impactOfFact = (factId) => {
		const pointIds = pointIdsByFact.get(factId) || [];
		const caseIds = new Set(pointIds.flatMap((pointId) => casesByPoint.get(pointId) || []));
		return { points: pointIds.length, cases: caseIds.size };
	};

	const usedFacts = new Set();
	const modelFeatures = (features?.items || []).map((feature) => {
		const machine = machineByFeature.get(feature.feature_id) || { states: [], transitions: [] };
		const featureFacts = (feature.fact_refs || []).map((ref) => factById.get(ref)).filter(Boolean).map((fact) => {
			usedFacts.add(fact.fact_id);
			return {
				fact_id: fact.fact_id,
				type: fact.type,
				statement: fact.statement,
				evidence_refs: fact.evidence_refs || [],
				impact: impactOfFact(fact.fact_id)
			};
		});
		// Impact goes through the facts, so it still works when points lack feature_id.
		const pointIds = [...new Set(featureFacts.flatMap((fact) => pointIdsByFact.get(fact.fact_id) || []))];
		const caseIds = new Set(pointIds.flatMap((pointId) => casesByPoint.get(pointId) || []));
		return {
			feature_id: feature.feature_id,
			name: feature.name,
			summary: feature.summary || '',
			facts: featureFacts,
			states: machine.states || [],
			transitions: machine.transitions || [],
			issues: machine.issues || [],
			impact: { points: pointIds.length, cases: caseIds.size }
		};
	});

	const unassigned = (facts?.items || []).filter((fact) => !usedFacts.has(fact.fact_id)).map((fact) => ({
		fact_id: fact.fact_id,
		type: fact.type,
		statement: fact.statement,
		evidence_refs: fact.evidence_refs || [],
		impact: impactOfFact(fact.fact_id)
	}));

	const stats = {
		features: modelFeatures.length,
		facts: usedFacts.size + unassigned.length,
		states: modelFeatures.reduce((sum, feature) => sum + feature.states.length, 0),
		transitions: modelFeatures.reduce((sum, feature) => sum + feature.transitions.length, 0),
		unassigned: unassigned.length
	};
	const inputs = {
		facts: { items: facts?.items || [] },
		features: { items: features?.items || [] },
		states: { items: states?.items || [] },
		bindings: { items: bindings?.items || [] },
		...(contracts?.length ? { contracts: { items: contracts } } : {})
	};
	const document = {
		schema: 'ecsm/v2',
		module: currentModule(),
		inputs,
		project: projectId,
		generated_at: new Date().toISOString(),
		stats,
		features: modelFeatures,
		unassigned_facts: unassigned
	};
	const digest = crypto.createHash('sha256').update(JSON.stringify({ module: document.module, inputs })).digest('hex').slice(0, 32);
	return { ...document, digest };
}

export function currentVersion(dataRoot, projectId) {
	return readJson(path.join(ecsmDir(dataRoot, projectId), 'ecsm-current.json'), null);
}

export function frozenModel(dataRoot, projectId, version) {
	if (version !== undefined) {
		if (!Number.isSafeInteger(version) || version < 1) return null;
		const dir = path.join(ecsmDir(dataRoot, projectId), 'ecsm-versions');
		if (!fs.existsSync(dir)) return null;
		const prefix = `ecsm-v${version}-`;
		const file = fs.readdirSync(dir).find((name) => name.startsWith(prefix) && /^[a-f0-9]{8}\.json$/.test(name.slice(prefix.length)));
		return file ? readJson(path.join(dir, file), null) : null;
	}
	const current = currentVersion(dataRoot, projectId);
	if (!current || !/^ecsm-v\d+-[a-f0-9]{8}\.json$/.test(current.file || '')) return null;
	return readJson(path.join(ecsmDir(dataRoot, projectId), 'ecsm-versions', current.file), null);
}

export function versions(dataRoot, projectId) {
	const dir = path.join(ecsmDir(dataRoot, projectId), 'ecsm-versions');
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.map((name) => readJson(path.join(dir, name), null))
		.filter(Boolean)
		.sort((a, b) => String(b.frozen_at).localeCompare(String(a.frozen_at)));
}

export function freeze(dataRoot, projectId, document) {
	const dir = path.join(ecsmDir(dataRoot, projectId), 'ecsm-versions');
	fs.mkdirSync(dir, { recursive: true });
	const previous = currentVersion(dataRoot, projectId);
	if (previous?.digest === document.digest && frozenModel(dataRoot, projectId)) return previous;
	const version = (previous?.version || 0) + 1;
	const file = path.join(dir, `ecsm-v${version}-${document.digest.slice(0, 8)}.json`);
	const record = {
		version,
		digest: document.digest,
		frozen_at: new Date().toISOString(),
		stats: document.stats,
		supersedes: previous?.digest || null
	};
	const pointer = path.join(ecsmDir(dataRoot, projectId), 'ecsm-current.json');
	for (const [target, payload] of [[file, { ...document, ...record }], [pointer, { ...record, file: path.basename(file) }]]) {
		fs.writeFileSync(target + '.tmp', JSON.stringify(payload, null, 1), 'utf8');
		fs.renameSync(target + '.tmp', target);
	}
	return record;
}

/** Which points and cases would break if this fact changed. */
export function impact(dataRoot, projectId, factId, { points, cases, transitionId }) {
	const pointIds = (points?.items || []).filter((point) => transitionId ? point.transition_ref === transitionId : (point.fact_refs || []).includes(factId)).map((point) => ({
		point_id: point.point_id,
		requirement: point.requirement,
		condition: point.condition
	}));
	const pointSet = new Set(pointIds.map((point) => point.point_id));
	const affectedCases = (cases?.items || []).filter((item) => pointSet.has(item.point_id)).map((item) => ({
		case_id: item.case_id,
		title: item.title,
		point_id: item.point_id
	}));
	return { fact_id: factId, points: pointIds, cases: affectedCases };
}

export function modelIssues(model, evidenceIds, coveredTransitions) {
	const issues = [];
	const add = (category, kind, ref, message, feature, item) => {
		issues.push({ id: JSON.stringify([category, kind, feature?.feature_id, ref, message]), category, kind, ref, message,
			featureId: feature?.feature_id, featureName: feature?.name, item,
			impact: kind === 'fact' ? item.impact : feature?.impact });
	};
	const factOwners = new Map();
	const machines = new Map((model.inputs?.states?.items || []).map((item) => [item.feature_id, item]));
	const signalNames = (model.inputs?.bindings?.items || []).filter((item) => item.kind === 'signal' && item.status === 'bound')
		.flatMap((item) => [item.subject?.name, item.target?.name]).filter(Boolean);
	for (const feature of model.features || []) {
		for (const fact of feature.facts || []) factOwners.set(fact.fact_id, feature);
		const sourceMachine = machines.get(feature.feature_id);
		const checks = sourceMachine ? validate({
			...sourceMachine,
			transitions: sourceMachine.transitions.map((transition) => ({
				...transition,
				unbound_signals: (transition.unbound_signals || []).filter((action) => !signalNames.some((name) => action.includes(name)))
			}))
		}) : feature.issues || [];
		if (!sourceMachine && !checks.length && !(feature.states || []).length) {
			add('structure', 'state', feature.feature_id, '功能点还没有状态机', feature);
		}
		for (const item of checks) {
			const transition = (feature.transitions || []).find((entry) => entry.transition_id === item.ref || item.message?.includes(entry.transition_id));
			const category = item.code === 'UNBOUND_SIGNAL' ? 'binding' : 'structure';
			add(category, 'state', transition?.transition_id || item.ref || feature.feature_id, item.message || item.code, feature, transition || item);
		}
		for (const transition of feature.transitions || []) {
			if (coveredTransitions && !coveredTransitions.has(transition.transition_id)) {
				add('coverage', 'state', transition.transition_id, '此状态转移尚未关联测试点', feature, transition);
			}
		}
	}
	const allFacts = [...(model.features || []).flatMap((feature) => feature.facts || []), ...(model.unassigned_facts || [])];
	for (const fact of new Map(allFacts.map((item) => [item.fact_id, item])).values()) {
		const owner = factOwners.get(fact.fact_id);
		if (!owner) add('unassigned', 'fact', fact.fact_id, '事实未归入功能点', null, fact);
		const refs = fact.evidence_refs || [];
		if (!refs.length) add('evidence', 'fact', fact.fact_id, '事实没有来源证据', owner, fact);
		else if (evidenceIds) {
			const missing = refs.filter((id) => !evidenceIds.has(id));
			if (missing.length) add('evidence', 'fact', fact.fact_id, '当前证据库找不到 · ' + missing.join('、'), owner, fact);
		}
		if (/待确认|待定|冲突|\bTBD\b/.test(fact.statement)) add('evidence', 'fact', fact.fact_id, '事实口径待确认', owner, fact);
	}
	const factIds = new Set(allFacts.map((item) => item.fact_id));
	for (const feature of model.inputs?.features?.items || []) {
		const missing = (feature.fact_refs || []).filter((ref) => !factIds.has(ref));
		if (missing.length) add('structure', 'feature', feature.feature_id, '功能点引用了不存在的事实 · ' + missing.join('、'), feature, feature);
	}
	for (const item of model.inputs?.bindings?.items || []) {
		if (item.status !== 'ambiguous' && item.status !== 'unmatched') continue;
		const owner = (item.subject?.fact_ids || []).map((id) => factOwners.get(id)).find(Boolean);
		add('binding', 'binding', item.binding_id, item.status === 'ambiguous' ? '有多个候选，待确认' : '未找到匹配的控件或信号', owner, item);
	}
	const rank = { structure: 0, evidence: 1, binding: 2, coverage: 3, unassigned: 4 };
	return issues.sort((a, b) => rank[a.category] - rank[b.category] || (b.impact?.cases || 0) - (a.impact?.cases || 0) || (b.impact?.points || 0) - (a.impact?.points || 0));
}
