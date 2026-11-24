/**
 * 从 DSH 冻结产物派生能力画像。规则包只说「该测哪些维度」，
 * 每个维度的预期引用与判据依据必须来自本项目的分支原文，缺就留缺口。
 *
 * 四态：known(true/false) / unknown / conflict。缺证据是 unknown，不是 known:false；
 * 只有项目未声明该观察通道时才算 known:false。
 */
import { digest } from './registry.js';
import featureVocabulary from './vocab/feature_vocabulary.json' with { type: 'json' };

const DERIVATION = 'dsh-ecsm-feature-derivation/v1';

/** 断言类型 → 覆盖维度。只映射语义明确对应的，边界方向等需原文给出的不猜。 */
const KIND_DIMENSION = {
	can_request: 'request_feedback_normal',
	can_feedback: 'request_feedback_normal',
	ui_feedback: 'cross_channel_consistency',
	ui_feedback_30s: 'feedback_timeout',
	ui_immediate: 'functional_expected',
	state_observation: 'functional_expected',
	outcome: 'functional_expected',
	static: 'expected_source_gate'
};

const uniq = (values) => [...new Set(values.filter(Boolean))];

const feature = (status, value, refs) => ({
	status, value: status === 'known' ? value : null,
	derivation_rule_id: DERIVATION, source_refs: uniq(refs), decision_ref: null
});

/** 判据依据标识就用断言 ID：它自带观察对象、目标、原文与位置，比截断的名字可靠。 */
const oracleOf = (assertion) => assertion.assertion_id;

export function matchBranches(capability, branches, config = {}) {
	const terms = capability.quote_terms || [];
	if (!terms.length) return [];
	// 原文同一功能可能有多种写法（项目已声明的别名），选择器按别名展开，避免造出假缺口。
	const expanded = new Set(terms);
	for (const term of terms) {
		for (const [from, to] of config.aliases || []) {
			if (from && to && term.includes(from)) expanded.add(term.split(from).join(to));
			if (from && to && term.includes(to)) expanded.add(term.split(to).join(from));
		}
	}
	return branches.filter((branch) => [...expanded].some((term) => String(branch.quote || '').includes(term)));
}

/**
 * @param {object} input capability / branches / points / states / bindings / uiLinks / frozen / outline / config
 */
export function deriveProfile(input) {
	const { capability, branches, points = [], states = [], uiLinks = [], frozen, outline, config = {} } = input;
	const scope = matchBranches(capability, branches, config);
	if (!scope.length) throw new Error(`能力 ${capability.capability_id} 没有匹配到任何冻结分支`);
	const scopeIds = new Set(scope.map((branch) => branch.branch_id));
	const scopedPoints = points.filter((point) => scopeIds.has(point.branch_id));
	const assertions = scope.flatMap((branch) => (branch.expected || []).map((entry, index) => ({ ...entry,
		assertion_id: `${branch.branch_id}-E${index + 1}`, branch_id: branch.branch_id,
		quote: entry.quote || branch.quote, location: branch.location })));
	const capabilities = config.capabilities || [];
	const has = (name) => capabilities.includes(name);
	const kinds = new Set(assertions.map((entry) => entry.kind));
	const signals = uniq(assertions.map((entry) => entry.signal));
	const machines = states.filter((machine) => scopedPoints.some((point) => point.feature_id === machine.feature_id));
	const usableLinks = uiLinks.filter((link) => link.purpose === 'case_expected' && link.status === 'resolved');
	const conditions = uniq(scope.map((branch) => [branch.precondition, branch.initial].filter(Boolean).join('；')));
	const timed = assertions.filter((entry) => entry.delay_s || entry.frames);
	const conflicts = scope.filter((branch) => branch.open_question && /矛盾|不一致|冲突/.test(branch.open_question));

	const features = {
		...Object.fromEntries(featureVocabulary.items.map((name) => [name, feature('unknown', null, [])])),
		has_state_machine: machines.length ? feature('known', true, machines.map((m) => m.state_machine_id || m.feature_id))
			: states.length ? feature('known', false, scopedPoints.map((p) => p.feature_id))
				: feature('unknown', null, []),
		has_request_feedback: kinds.has('can_request') && kinds.has('can_feedback') ? feature('known', true, signals)
			: !has('protocol') ? feature('known', false, [])
				: feature('unknown', null, signals),
		has_numeric_domain: scope.some((branch) => branch.mode === 'boundary') ? feature('known', true, scope.filter((b) => b.mode === 'boundary').map((b) => b.branch_id))
			: feature('unknown', null, scope.map((b) => b.branch_id).slice(0, 5)),
		has_guard_set: conditions.length ? feature('known', true, scope.filter((b) => b.precondition || b.initial).map((b) => b.branch_id))
			: feature('unknown', null, []),
		has_temporal_requirement: timed.length ? feature('known', true, timed.map((entry) => entry.branch_id))
			: feature('unknown', null, []),
		has_persistence: scope.some((branch) => /记忆|上次|断电|重新上电/.test(branch.quote || '')) ? feature('known', true, scope.filter((b) => /记忆|上次|断电|重新上电/.test(b.quote || '')).map((b) => b.branch_id))
			: feature('unknown', null, []),
		has_visual_oracle: usableLinks.length ? feature('known', true, usableLinks.map((link) => link.link_id))
			: !has('design') ? feature('known', false, [])
				: feature('unknown', null, []),
		has_multi_channel_oracle: [...kinds].some((k) => /^ui_/.test(k)) && [...kinds].some((k) => /^can_/.test(k)) ? feature('known', true, uniq(assertions.map(oracleOf)))
			: feature('unknown', null, []),
		has_external_peer: config.external_session_source ? feature('known', true, [config.external_session_source]) : feature('unknown', null, []),
		has_control_surface_relation: config.behavior_relations?.length ? feature('known', true, config.behavior_relations) : feature('unknown', null, []),
		has_context_lifecycle_relation: config.context_lifecycle_relations?.length ? feature('known', true, config.context_lifecycle_relations) : feature('unknown', null, [])
	};
	if (conflicts.length) {
		// 原文自相矛盾时相关特征记 conflict，让选规器登记问题而不是静默选规。
		features.has_guard_set = feature('conflict', null, conflicts.map((b) => b.branch_id));
	}

	const fields = [];
	if (machines.length) fields.push('state_machine_ref');
	if (conditions.length) fields.push('guard_set_ref', 'activation_condition_ref');
	if (signals.length) fields.push('request_signal_ref', 'feedback_signal_ref');
	if (timed.length) fields.push('temporal_requirement_ref');
	if (assertions.length) fields.push('oracle_ref', 'current_normative_expected_ref');
	if (usableLinks.length) fields.push('visual_oracle_ref');
	if (features.has_numeric_domain.value === true) fields.push('numeric_domain_ref');
	if (config.behavior_relations?.length || config.context_lifecycle_relations?.length) fields.push('behavior_relation_refs');
	if (config.external_session_source) fields.push('external_session_ref');
	if (scope.some((branch) => /清除|消失|退出/.test(branch.quote || ''))) fields.push('clear_condition_ref');
	if (features.has_persistence.value === true) fields.push('persistence_rule_ref');

	const archetypes = [];
	if (kinds.has('can_request') || kinds.has('can_feedback')) archetypes.push('request_feedback_control');
	if (machines.length) archetypes.push('boolean_state_control');
	if (conditions.length) archetypes.push('guarded_setting');
	if (features.has_numeric_domain.value === true) archetypes.push('bounded_value_control');
	if (features.has_persistence.value === true) archetypes.push('persistent_profile');
	if (scope.filter((branch) => branch.mode === 'state_observation').length > 1) archetypes.push('mode_arbitration');
	if (features.has_external_peer.value === true) archetypes.push('external_session');
	if (!archetypes.length) archetypes.push('boolean_state_control');

	// 逐维度支撑：只收本项目分支里真有该维度判据的项，缺维度就留空 → 选规器登记需求问题。
	const byDimension = new Map();
	for (const entry of assertions) {
		const dimension = KIND_DIMENSION[entry.kind];
		if (!dimension) continue;
		const list = byDimension.get(dimension) || [];
		list.push(entry);
		byDimension.set(dimension, list);
	}
	if (machines.length && scope.some((branch) => branch.event)) {
		byDimension.set('state_transition', scope.filter((branch) => branch.event).map((branch) => ({
			kind: 'state_transition', branch_id: branch.branch_id, assertion_id: `${branch.branch_id}-SM`,
			object: branch.event, quote: branch.quote, location: branch.location,
			state_machine_ref: machines[0].state_machine_id || machines[0].feature_id
		})));
	}
	const dimensionSupport = {};
	for (const [dimension, entries] of byDimension) {
		// 一个分支一个支撑项：覆盖目标才能逐分支回答「为什么测这条」。
		const byBranch = new Map();
		for (const entry of entries) {
			const list = byBranch.get(entry.branch_id) || [];
			list.push(entry);
			byBranch.set(entry.branch_id, list);
		}
		const supportItems = [...byBranch].map(([branchId, own]) => {
			const judgeable = own.filter((entry) => !entry.blocking);
			const item = {
				support_id: `${capability.capability_id}#${dimension}#${branchId}`,
				requirement_ids: judgeable.length ? [branchId] : [],
				oracle_refs: uniq(judgeable.map(oracleOf)),
				contract_statuses: ['candidate'],
				// 本项目没有「合同已批准 + 语义证明」这两道人工签署，一律 false，让门禁如实阻断。
				contract_formal: false, semantic_proof_present: false,
				blocking_finding_refs: uniq(own.filter((entry) => entry.blocking).map((entry) => entry.assertion_id))
			};
			if (dimension === 'state_transition') item.state_machine_ref = own[0].state_machine_ref;
			return item;
		});
		dimensionSupport[dimension] = {
			support_items: supportItems,
			requirement_ids: uniq(supportItems.flatMap((item) => item.requirement_ids)),
			oracle_refs: uniq(supportItems.flatMap((item) => item.oracle_refs))
		};
	}

	const requirementSupport = uniq(assertions.map((entry) => entry.branch_id)).map((branchId) => {
		const own = assertions.filter((entry) => entry.branch_id === branchId);
		const branch = scope.find((item) => item.branch_id === branchId);
		return {
			requirement_id: branchId, inherited: false, coupled_via_state_machine: machines.length > 0,
			contract_status: 'candidate', has_expected: own.some((entry) => !entry.blocking),
			observable_kind: uniq(own.map((entry) => entry.kind)),
			oracle_refs: uniq(own.map(oracleOf)),
			oracle_resolves: own.some((entry) => !entry.blocking && !entry.unresolved),
			condition_present: Boolean(branch.precondition || branch.initial),
			source_location: branch.location, source_quote: branch.quote
		};
	});

	const profile = {
		schema_id: 'capability-feature-profile/v1',
		profile_id: `CFP-${capability.capability_id.replace(/^CAP-/, '')}`,
		revision: 1,
		capability_ref: capability.capability_id,
		scope: 'pilot_scoped',
		archetypes: uniq(archetypes),
		features,
		available_contract_fields: uniq(fields).sort(),
		ecsm_ref: frozen?.digest || null, ecsm_digest: frozen?.inputs ? digest(frozen.inputs) : null,
		// 本地尚未对该规则包版本与画像签署批准，一律候选。
		status: 'candidate', decision_refs: [],
		findings: conflicts.map((branch) => `FND-${branch.branch_id}-CONFLICT`),
		derivation: { rule_id: DERIVATION, tool: 'dsh', branch_count: scope.length, assertion_count: assertions.length, capability_name: capability.name || '' },
		formal_readiness: {
			ecsm_status: frozen ? 'frozen' : 'absent',
			ecsm_release_stage: frozen ? 'frozen' : 'absent',
			ecsm_scope_approved: Boolean(frozen && outline?.status === 'approved' && outline.source_ecsm_digest === frozen.digest),
			contract_status_counts: { candidate: requirementSupport.length },
			unresolved_finding_refs: conflicts.map((branch) => `FND-${branch.branch_id}-CONFLICT`)
		},
		requirement_support: requirementSupport,
		dimension_support: dimensionSupport
	};
	profile.object_digest_sha256 = digest(profile);
	return { profile, matched_branches: scope.map((branch) => branch.branch_id) };
}

/**
 * 把选规记录摊到分支上：可交付覆盖目标按 expected_refs 归到分支；
 * 缺依据的维度没有 expected_refs，属能力级缺口，不能硬塞给某个分支。
 */
export function annotateSelection(entries) {
	const byBranch = new Map();
	const capabilities = [];
	for (const { capability, profile, selection } of entries) {
		const ruleRevision = new Map(selection.applied_rules.map((rule) => [rule.knowledge_id, rule.revision]));
		const gaps = [];
		for (const output of selection.outputs) {
			const ruleId = output.source_refs[1];
			const ref = { output_id: output.output_id, dimension: output.dimension, rule_id: ruleId, rule_revision: ruleRevision.get(ruleId) ?? null,
				expected_refs: output.expected_refs, oracle_refs: output.oracle_refs, formal_eligibility: output.formal_eligibility };
			if (output.output_class === 'formal_coverage_target') {
				for (const branchId of output.expected_refs) {
					const list = byBranch.get(branchId) || [];
					list.push(ref);
					byBranch.set(branchId, list);
				}
			} else {
				gaps.push({ ...ref, output_class: output.output_class, reason: output.reason, formal_blockers: output.formal_blockers });
			}
		}
		capabilities.push({ capability_id: capability.capability_id, name: capability.name || '', profile_id: profile.profile_id,
			profile_digest: profile.object_digest_sha256, selection_id: selection.selection_id, selection_digest: selection.selection_digest_sha256,
			status: selection.status, formal_eligible: selection.formal_gate.eligible, blockers: selection.formal_gate.blockers,
			applied_rules: selection.applied_rules, not_applied_rules: selection.not_applied_rules,
			matched_branches: profile.derivation.branch_count, findings: selection.findings, gaps });
	}
	return { byBranch, capabilities };
}

/** 项目策略：DSH 侧没有已批准的历史回归清单，也没有跨上下文授权。 */
export function derivePolicy(project, module, config = {}) {
	const policy = {
		schema_id: 'project-test-policy/v1',
		policy_id: `PTP-${project}-${module}`.toUpperCase().replace(/[^A-Z0-9-]/g, '-'),
		revision: 1, project_id: project,
		product_variant: null, market_region: [], test_level: 'E2E', risk_tier: 'normal',
		applicable_regulatory_scopes: [], customer_mandatory_rules: [], enterprise_mandatory_rules: [],
		status: 'candidate', decision_refs: [],
		approved_historical_regressions: uniq(config.approved_historical_regressions || []),
		combination_policy: { mode: 'risk_and_constraint_based', default_strength: null },
		optional_budget: { max_candidates: null },
		waiver_policy: { allowed_roles: [], non_waivable_scopes: [] }
	};
	policy.object_digest_sha256 = digest(policy);
	return policy;
}
