import { contractPoints } from './contracts.js';
import { digestOf } from './artifacts.js';
import { defaultSurface } from './scope.js';

export const methods = {
	baseline: '需求行为', boundary: '边界值', transition: '状态迁移', combination: '组合条件',
	exception: '异常处理', timeout: '时序与超时', recovery: '恢复', permission: '权限', interaction: '联动'
};

const signals = {
	boundary: /边界|上限|下限|最大值|最小值|boundary/i,
	exception: /失败|无效|异常|拒绝|错误|invalid|failure/i,
	timeout: /超时|时限|timeout|deadline/i,
	recovery: /恢复|回退|重试|recover|retry/i,
	permission: /权限|授权|角色|permission|unauthorized/i,
	interaction: /联动|仲裁|互斥|抢占|priority|interlock/i
};

export function outlineFeatures(model) {
	const approved = new Set((model.inputs.contracts?.items || [])
		.filter((item) => item.status === 'approved').map((item) => item.feature_id));
	return model.features.filter((item) => approved.has(item.feature_id));
}

export function buildOutline(model, featureIds, previous, budget) {
	const scope = [...new Set(Array.isArray(featureIds) ? featureIds : [])];
	const eligible = new Set(outlineFeatures(model).map((item) => item.feature_id));
	if (!scope.length || scope.some((id) => !eligible.has(id))) {
		throw new Error('请选择至少一项已有已确认需求合同的功能');
	}
	if (!Number.isInteger(budget) || budget < 0 || budget > 10000) throw new Error('组合预算应为 0 到 10000 的整数');
	const contracts = (model.inputs.contracts?.items || []).filter((item) => item.status === 'approved' && scope.includes(item.feature_id));
	const items = contractPoints(contracts).map((point) => {
		const related = contracts.filter((item) => point.contract_refs.includes(item.contract_id));
		const rule_ids = [...new Set(related.flatMap((item) => {
			if (item.rule_ids?.length) return item.rule_ids;
			const evidence = [item.title, item.condition, item.trigger, item.expected].join(' ');
			return ['baseline', ...(item.transition_ref ? ['transition'] : []),
				...Object.entries(signals).filter(([, pattern]) => pattern.test(evidence)).map(([id]) => id)];
		}))];
		return {
			...point, scenario_id: 'SC-' + digestOf([...point.contract_refs].sort()), rule_ids, required: true, classification: 'required',
			rule_reason: '基于已确认需求：' + related.map((item) => item.title).join('、'),
			verification: related.map((item) => item.verification).filter(Boolean).join('；'),
			recovery: related.map((item) => item.recovery).filter(Boolean).join('；')
		};
	});
	const combinations = items.filter((item) => item.rule_ids.includes('combination'));
	for (const item of combinations.slice(budget)) item.budget_exceeded = true;
	return {
		version: previous.version + 1, source_ecsm_digest: model.digest, status: 'draft', scope, budget,
		rule_version: 1, feature_names: Object.fromEntries(model.features.map((item) => [item.feature_id, item.name])), pending: [], empty: [], items,
		outside: model.features.filter((item) => !scope.includes(item.feature_id)).map((item) => ({ id: item.feature_id, name: item.name }))
	};
}

export function outlineCoverage(outline, points, cases, deferrals = []) {
	const pointsDigest = digestOf(points.items);
	const inVersion = points.source_outline_digest === outline.digest;
	const byScenario = new Map((inVersion ? points.items : []).flatMap((point) => (point.scenario_refs || []).map((id) => [id, point])));
	const casesByPoint = Map.groupBy(cases.source_points_digest === pointsDigest ? cases.items : [], (item) => item.point_id);
	const scoped = deferrals.filter((item) => item.outline_digest === outline.digest && item.points_digest === pointsDigest && item.reviewed_at && item.reviewer && item.owner && item.reason);
	const delayed = new Map(scoped.map((item) => [item.scenario_id || item.point_id, item]));
	return outline.items.map((scenario) => {
		const point = byScenario.get(scenario.scenario_id);
		const deferral = delayed.get(scenario.scenario_id) || delayed.get(point?.point_id);
		const variants = casesByPoint.get(point?.point_id) || [];
		// 覆盖按实际断言对账：优先用显式判据引用，旧记录退回观察对象相等。
		const needed = (point?.expected_items || []).filter((entry) => entry.blocking !== true);
		const counts = variants.map((item) => {
			if (item.review_status !== 'approved') return 0;
			const assertions = item.expected_items || [];
			const refs = new Set(assertions.map((entry) => entry.assertion_ref).filter(Boolean));
			const objects = new Set(assertions.map((entry) => entry.object));
			return needed.filter((entry) => refs.has(entry.id) || objects.has(entry.object)).length;
		});
		const hit = counts.length ? Math.min(...counts) : 0;
		const complete = variants.length > 0 && variants.every((item) => item.review_status === 'approved') && hit === needed.length;
		const state = !scenario.required && !scenario.included && !point ? (scenario.classification || 'optional') : !point ? deferral ? 'deferred' : 'missing' : point.review_status !== 'approved' ? 'review' : complete ? 'covered'
			: deferral ? 'deferred' : variants.length ? 'case_incomplete' : 'case_missing';
		return {
			...scenario, point_id: point?.point_id,
			assertions_required: needed.length, assertions_covered: state === 'deferred' ? 0 : hit,
			assertions_deferred: (state === 'deferred' ? needed.length : 0) + (point?.expected_items || []).filter((entry) => entry.blocking === true).length,
			state,
			deferral
		};
	});
}

export function deliveryCases(cases, accounting) {
	const deferred = new Set(accounting.filter((row) => row.state === 'deferred').map((row) => row.point_id).filter(Boolean));
	if (accounting.length && accounting.every((row) => row.state === 'deferred')) return { ...cases, items: [] };
	return deferred.size ? { ...cases, items: cases.items.filter((item) => !deferred.has(item.point_id)) } : cases;
}

export function generatableScenario(item) {
	return !item.budget_exceeded && !item.omitted && item.classification !== 'needs_evidence' && (item.required || item.included);
}

/**
 * Scenarios straight from the source branches. A clause that only states a
 * display becomes a state observation with an explicit read-back action, never
 * an invented click; a trigger clause keeps the initial state it inherits.
 * Branches whose threshold or result is still TBD stay needs_evidence so they
 * cannot be counted as coverage.
 */
export function branchScenarios(branches, { featureFor = () => '', factRefsFor = () => [] } = {}) {
	return branches.map((branch) => {
		const assertions = branch.expected || [];
		const observation = branch.mode === 'state_observation';
		const condition = [branch.precondition, branch.initial].filter(Boolean).join('；');
		const action = observation
			? `只读观察：在${defaultSurface()}读取${assertions.map((a) => a.object).filter(Boolean).join('、') || '目标控件'}的当前显示，不做任何操作`
			: branch.event || '';
		const expected = assertions.map((assertion, index) => `${index + 1}. ${assertion.object}：${assertion.target}`).join('\n');
		const blocked = branch.status === 'needs_decision' || branch.status === 'needs_design' || !action || !assertions.length;
		// 静态定义核对与资料引用不是运行用例；版本/文档说明行整体排除。
		const staticCheck = branch.mode === 'static_signal' || branch.mode === 'reference';
		const excluded = branch.mode === 'meta' || branch.status === 'excluded';
		const classification = excluded ? 'excluded' : staticCheck ? 'static_check' : blocked ? 'needs_evidence' : 'required';
		return {
			scenario_id: branch.branch_id,
			branch_id: branch.branch_id,
			requirement: `${branch.section} · ${branch.initial || branch.event || branch.quote.slice(0, 30)}`.slice(0, 120),
			feature_id: featureFor(branch),
			condition,
			action,
			expected,
			expected_items: assertions.map((assertion, index) => ({
				id: `${branch.branch_id}-E${index + 1}`,
				kind: assertion.kind, object: assertion.object, target: assertion.target,
				quote: assertion.quote || '', frames: assertion.frames || 0,
				signal: assertion.signal || '', since: assertion.since || '', delay_s: assertion.delay_s || 0,
				...(assertion.signals?.length ? { signals: assertion.signals } : {}),
				unresolved: assertion.unresolved || '', blocking: Boolean(assertion.blocking)
			})),
			fact_refs: factRefsFor(branch),
			contract_refs: [],
			transition_ref: '',
			priority: branch.mode === 'boundary' || branch.tbd ? 'P0' : 'P1',
			review_status: 'candidate',
			rule_ids: [branch.mode === 'boundary' ? 'boundary' : branch.tbd ? 'exception' : observation ? 'baseline' : 'transition'],
			required: !blocked && !staticCheck && !excluded,
			classification,
			rule_reason: branch.open_question || (branch.tbd ? '原文含 TBD，待裁决'
				: excluded ? '版本/文档说明，不构成测试分支'
				: staticCheck ? '静态定义核对，不计运行覆盖'
				: branch.status === 'needs_design' ? '原文未给出可逐项判定的预期表述，需人工设计判据后才能运行'
				: !action ? '原文未点名可执行的操作'
				: `来源：${branch.location}`),
			verification: branch.mode === 'static_signal' ? '静态信号定义核对，不计运行覆盖'
				: observation ? '界面状态只读观察，无需恢复'
				: '运行验证：按判据逐项观察界面与报文',
			recovery: observation ? '只读，无需恢复' : '',
			source: { quote: branch.quote, location: branch.location, evidence_id: branch.evidence_id, version: branch.version, source_id: branch.source_id, prd_sha256: branch.prd_sha256 },
			mode: branch.mode,
			branch_status: branch.status,
			open_question: branch.open_question || ''
		};
	});
}

/** Branch → feature/fact resolution, shared by the outline entry and the point entry. */
export function branchResolvers(facts, factToFeature) {
	const tokens = (value) => new Set(String(value || '').match(/[一-龥]{2,}|[A-Za-z][A-Za-z0-9_]{3,}/g) || []);
	return {
		featureFor: (branch) => {
			const refs = facts.filter((fact) => (fact.evidence_refs || []).includes(branch.evidence_id)).flatMap((fact) => factToFeature.get(fact.fact_id)).filter(Boolean);
			return refs[0] || '';
		},
		factRefsFor: (branch) => {
			const quoteTokens = tokens(branch.quote);
			const candidates = facts.filter((fact) => (fact.evidence_refs || []).includes(branch.evidence_id));
			const scored = candidates.map((fact) => {
				const factTokens = tokens(fact.statement);
				let hit = 0;
				for (const token of factTokens) if (quoteTokens.has(token)) hit += 1;
				return { fact, score: hit / Math.max(1, factTokens.size) };
			}).filter((entry) => entry.score > 0.2).sort((a, b) => b.score - a.score);
			return (scored.length ? scored.slice(0, 3) : candidates.slice(0, 1).map((fact) => ({ fact }))).map((entry) => entry.fact.fact_id);
		}
	};
}

/**
 * The frozen branch list is the scope. Both generation entries read this one
 * outline, so the coverage denominator cannot differ between them.
 */
export function buildOutlineFromBranches(model, branches, previous, opts = {}) {
	if (!branches.length) throw new Error('还没有冻结的需求分支，请先生成分支清单');
	const items = branchScenarios(branches, opts);
	const previousByBranch = new Map((previous.items?.[0]?.items || []).map((item) => [item.branch_id, item]));
	for (const item of items) {
		const prior = previousByBranch.get(item.branch_id)?.expected_items || [];
		if (!prior.length) continue;
		const key = (entry) => `${entry.kind}:${String(entry.object).replace(/[【】/\s]/g, '')}`;
		const used = new Set(prior.map((entry) => entry.id));
		const remaining = [...prior];
		let next = prior.length + 1;
		for (const entry of item.expected_items) {
			const index = remaining.findIndex((candidate) => key(candidate) === key(entry));
			if (index >= 0) {
				entry.id = remaining.splice(index, 1)[0].id;
				continue;
			}
			do { entry.id = `${item.branch_id}-E${next++}`; } while (used.has(entry.id));
			used.add(entry.id);
		}
	}
	const scope = [...new Set(items.map((item) => item.feature_id).filter(Boolean))];
	const tkr = opts.tkr || null;
	if (tkr) {
		for (const item of items) {
			const targets = tkr.byBranch.get(item.branch_id) || [];
			item.coverage_targets = targets;
			item.tkr_rule_refs = [...new Map(targets.map((t) => [t.rule_id, { rule_id: t.rule_id, revision: t.rule_revision }])).values()];
		}
	}
	return {
		version: previous.version + 1, source_ecsm_digest: model.digest, status: 'draft',
		source_kind: 'branches', source_branches_digest: digestOf(branches),
		scope, budget: 0, rule_version: 1,
		feature_names: Object.fromEntries(model.features.map((item) => [item.feature_id, item.name])),
		pending: [], empty: [], items, outside: [],
		...(tkr ? { tkr: { selection_digest: tkr.selection_digest, bundle_ref: tkr.bundle_ref, bundle_digest: tkr.bundle_digest, pack_status: tkr.pack_status, capabilities: tkr.capabilities } } : {})
	};
}

export function reviewChanges(document, rows) {
	const byId = new Map(document.items.map((item) => [item.case_id, item]));
	const seen = new Set();
	return rows.flatMap((row) => {
		const item = byId.get(row.case_id);
		if (!item || seen.has(row.case_id)) throw new Error('评审文件含未知或重复的用例编号');
		seen.add(row.case_id);
		const patch = {};
		for (const key of ['review_conclusion', 'review_comment', 'reviewer']) {
			const value = String(row[key] || '').trim();
			if (value && value !== (item[key] || (key === 'review_conclusion' ? '待评审' : ''))) patch[key] = value;
		}
		return Object.keys(patch).length ? [{ case_id: item.case_id, patch }] : [];
	});
}
