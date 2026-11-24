/**
 * TKR 规则包加载器与确定性选规器。移植自上游 tkr_lite/build_registry.py。
 *
 * 规则包只声明「该测哪些维度」；每个确定的产品预期必须由本项目的画像给出
 * expected_refs / oracle_refs。上游业务值不进入任何项目预期。
 *
 * 摘要算法必须与上游逐字节一致：canonical JSON（键排序、无空格、保留非 ASCII）
 * 去掉摘要字段后取 SHA-256。原始文件 SHA-256 不匹配。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PACK_DIR = path.join(import.meta.dirname);
const APPROVED_STATUSES = new Set(['approved', 'approved_with_scope']);
const FORMAL_OUTPUT_CLASSES = new Set(['formal_coverage_target', 'formal_or_finding']);
export const PLANNER_REVISION = 'deterministic-planner/0.3.0';

/** Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False) 的等价实现。 */
function canonical(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
	return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

export function digest(value) {
	return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function digestFieldValid(value, field) {
	const expected = value?.[field];
	if (typeof expected !== 'string') return false;
	const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
	return digest(rest) === expected;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function loadBundle(name, dir = PACK_DIR) {
	return readJson(path.join(dir, 'bundles', name));
}

/** 只加载清单点名的成员；objects/ 下的其他文件不算可执行知识。 */
export function loadRules(bundle, dir = PACK_DIR) {
	const rules = [];
	const errors = [];
	const root = path.resolve(dir);
	for (const member of bundle.objects || []) {
		const relative = member.path;
		if (typeof relative !== 'string') { errors.push(`registry_bundle_member_path_missing:${member.knowledge_id}`); continue; }
		const file = path.resolve(root, relative);
		if (!file.startsWith(root + path.sep)) { errors.push(`registry_bundle_member_path_escape:${relative}`); continue; }
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { errors.push(`registry_bundle_member_file_missing:${relative}`); continue; }
		const rule = readJson(file);
		if (rule.knowledge_id !== member.knowledge_id || rule.revision !== member.revision) {
			errors.push(`registry_bundle_member_identity_mismatch:${relative}`); continue;
		}
		rules.push(rule);
	}
	errors.push(...verifyBundle(bundle, rules));
	return { rules, errors: [...new Set(errors)].sort() };
}

export function verifyBundle(bundle, rules) {
	const errors = [];
	if (!digestFieldValid(bundle, 'bundle_digest_sha256')) errors.push('registry_bundle_digest_invalid');
	const keyOf = (item) => `${item.knowledge_id}@${item.revision}`;
	const supplied = new Map(rules.map((rule) => [keyOf(rule), rule]));
	const members = new Map((bundle.objects || []).map((member) => [keyOf(member), member]));
	for (const [key, member] of members) {
		const rule = supplied.get(key);
		if (!rule) { errors.push(`registry_bundle_member_missing:${key}`); continue; }
		if (rule.object_digest_sha256 !== member.digest) errors.push(`registry_bundle_member_digest_mismatch:${key}`);
		if (!digestFieldValid(rule, 'object_digest_sha256')) errors.push(`registry_rule_digest_invalid:${key}`);
	}
	for (const key of [...supplied.keys()].filter((key) => !members.has(key)).sort()) {
		errors.push(`rule_not_in_registry_bundle:${key}`);
	}
	return errors.sort();
}

export function selectionGate(profile, rules, bundle, policy, bundleErrors = []) {
	const checks = {
		profile_digest_valid: digestFieldValid(profile, 'object_digest_sha256'),
		profile_approved: APPROVED_STATUSES.has(profile.status),
		profile_has_approval_decision: Boolean(profile.decision_refs?.length),
		ecsm_scope_approved: Boolean(profile.formal_readiness?.ecsm_scope_approved),
		registry_bundle_digest_valid: digestFieldValid(bundle, 'bundle_digest_sha256'),
		registry_bundle_approved: APPROVED_STATUSES.has(bundle.status),
		registry_rules_approved: rules.length > 0 && rules.every((rule) => APPROVED_STATUSES.has(rule.governance?.status)),
		registry_rules_applicable: rules.length > 0 && rules.every((rule) => rule.evidence?.applicability_status === 'applicable'),
		project_policy_digest_valid: digestFieldValid(policy, 'object_digest_sha256'),
		project_policy_approved: APPROVED_STATUSES.has(policy.status),
		project_policy_has_approval_decision: Boolean(policy.decision_refs?.length)
	};
	const integrity = [...new Set([...bundleErrors, ...verifyBundle(bundle, rules)])].sort();
	checks.registry_bundle_members_valid = integrity.length === 0;
	const blockers = [...Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name), ...integrity].sort();
	return { eligible: blockers.length === 0, checks, blockers };
}

const sortedUnique = (values) => [...new Set(values)].sort();

// Python 把空数组/空对象也当假值；上游门序依赖这一点，不能直接用 JS 真值。
const truthy = (value) => {
	if (Array.isArray(value)) return value.length > 0;
	if (value && typeof value === 'object') return Object.keys(value).length > 0;
	return Boolean(value);
};

/**
 * 门序：能力原型 → 项目策略 → 必要特征 → 合同字段 → 逐维度预期／判据支撑 → 输入放行状态。
 * mode='candidate_dry_run' 保留本应正式的目标并标 blocked_by_input_status，不塌成 finding。
 */
export function makeSelection(profile, rules, bundle, policy, mode = 'formal', { selectionRevision = null, bundleErrors = [] } = {}) {
	const applied = [];
	const notApplied = [];
	const outputs = [];
	const findings = [...(profile.findings || [])];
	const formalGate = selectionGate(profile, rules, bundle, policy, bundleErrors);
	const archetypes = new Set(profile.archetypes);
	const dimensionSupport = profile.dimension_support;

	for (const rule of rules) {
		const scoped = new Set(rule.scope.capability_archetypes);
		const fail = (reason, finding) => {
			notApplied.push({ knowledge_id: rule.knowledge_id, reason });
			if (finding) findings.push(finding);
		};
		if (scoped.size && ![...scoped].some((item) => archetypes.has(item))) { fail('capability_archetype_not_matched'); continue; }
		if (rule.kind === 'risk_modifier' && !truthy(policy.approved_historical_regressions)) { fail('no_approved_historical_regression_in_project_policy'); continue; }
		const states = rule.input_contract.required_features.map((feature) => profile.features[feature] || { status: 'unknown', value: null });
		if (states.some((item) => item.status === 'conflict')) { fail('required_feature_conflict', `AUTO-FINDING:${rule.knowledge_id}:conflict`); continue; }
		if (states.some((item) => item.status === 'unknown')) { fail('required_feature_unknown', `AUTO-FINDING:${rule.knowledge_id}:unknown`); continue; }
		if (states.some((item) => item.value === false)) { fail('required_feature_proven_false'); continue; }
		const available = new Set(profile.available_contract_fields);
		const missing = rule.input_contract.required_ecsm_fields.filter((field) => !available.has(field)).sort();
		if (missing.length) { fail('required_contract_fields_missing:' + missing.join(','), `AUTO-FINDING:${rule.knowledge_id}:missing_contract_fields`); continue; }
		applied.push({ knowledge_id: rule.knowledge_id, revision: rule.revision, reason: 'archetype_and_required_features_matched' });

		for (const contract of rule.output_contract) {
			const outputClass = contract.output_class;
			const dimension = contract.dimension;
			const support = (dimensionSupport || {})[dimension] || { requirement_ids: [], oracle_refs: [] };
			let supportItems = [...(support.support_items || [])];
			if (!supportItems.length && support.requirement_ids?.length) {
				supportItems = [{ support_id: `${profile.profile_id}#${dimension}-legacy-aggregate`, requirement_ids: support.requirement_ids, oracle_refs: support.oracle_refs || [], contract_formal: false, semantic_proof_present: false, blocking_finding_refs: [] }];
			}
			if (!supportItems.length) {
				supportItems = [{ support_id: `${profile.profile_id}#${dimension}-unsupported`, requirement_ids: [], oracle_refs: [], contract_formal: false, semantic_proof_present: false, blocking_finding_refs: [] }];
			}
			for (const item of supportItems) {
				const supportKey = digest({ dimension, support_id: item.support_id, requirement_ids: item.requirement_ids || [] }).slice(0, 12).toUpperCase();
				const output = {
					output_id: `OUT-${profile.profile_id}-${rule.knowledge_id.split('.').at(-1)}-${dimension}-${supportKey}`,
					dimension, support_ref: item.support_id,
					source_refs: [profile.profile_id, rule.knowledge_id, item.support_id],
					expected_refs: item.requirement_ids || [], oracle_refs: item.oracle_refs || []
				};
				for (const key of ['state_machine_ref', 'source_state', 'event', 'target_state', 'condition_signature']) {
					if (key in item) output[key] = item[key];
				}
				const blockersOf = (supportItem) => sortedUnique([
					...formalGate.blockers,
					...(supportItem.contract_formal ? [] : ['supporting_requirement_contract_not_approved']),
					...(supportItem.semantic_proof_present ? [] : ['supporting_requirement_semantic_proof_missing']),
					...(supportItem.blocking_finding_refs || []).map((ref) => `open_finding:${ref}`)
				]);
				const asFinding = (reason, eligibility) => {
					Object.assign(output, { output_class: outputClass === 'formal_or_finding' ? 'requirement_finding' : 'finding', reason, formal_eligibility: eligibility, formal_blockers: blockersOf(item) });
				};
				if (profile.scope === 'evaluation_fixture') {
					Object.assign(output, { output_class: outputClass !== 'finding_only' ? 'exploratory_candidate' : 'finding', reason: 'evaluation_fixture_scope', formal_eligibility: 'not_formal_class', formal_blockers: [] });
				} else if (outputClass === 'risk_candidate') {
					Object.assign(output, { output_class: 'risk_candidate', reason: 'risk_modifier_output', formal_eligibility: 'not_formal_class', formal_blockers: [] });
				} else if (outputClass === 'finding_only') {
					Object.assign(output, { output_class: 'finding', reason: 'finding_only_contract', formal_eligibility: 'not_formal_class', formal_blockers: [] });
				} else if (FORMAL_OUTPUT_CLASSES.has(outputClass)) {
					const eligibility = dimensionSupport == null ? 'profile_lacks_dimension_support'
						: !output.expected_refs.length ? 'no_normative_expected'
							: !output.oracle_refs.length ? 'no_resolving_oracle' : 'eligible';
					const formalBlockers = blockersOf(item);
					if (['no_normative_expected', 'no_resolving_oracle', 'profile_lacks_dimension_support'].includes(eligibility)) {
						asFinding(eligibility, eligibility);
						findings.push(`AUTO-FINDING:${rule.knowledge_id}:${dimension}:${eligibility}`);
					} else if (formalBlockers.length) {
						if (mode === 'candidate_dry_run') {
							Object.assign(output, { output_class: 'formal_coverage_target', reason: 'would_be_formal_after_recorded_blockers_close', formal_eligibility: 'blocked_by_input_status', formal_blockers: formalBlockers });
						} else {
							asFinding('formal_gate_blocked', 'blocked_by_input_status');
							findings.push(`AUTO-FINDING:${rule.knowledge_id}:${dimension}:formal_gate_blocked`);
						}
					} else {
						Object.assign(output, { output_class: 'formal_coverage_target', reason: 'expected_oracle_and_all_release_gates_supported', formal_eligibility: 'eligible', formal_blockers: [] });
					}
				} else {
					Object.assign(output, { output_class: outputClass, reason: 'passthrough', formal_eligibility: 'not_formal_class', formal_blockers: [] });
				}
				outputs.push(output);
			}
		}
	}

	const uniqueFindings = sortedUnique(findings);
	const status = profile.scope === 'evaluation_fixture' ? 'evaluation_only'
		: !formalGate.eligible ? 'blocked_by_input_status'
			: outputs.some((output) => output.formal_eligibility === 'blocked_by_input_status') ? 'blocked_by_input_status'
				: uniqueFindings.some((item) => item.includes(':conflict')) ? 'blocked_by_conflict'
					: uniqueFindings.some((item) => item.includes(':unknown')) ? 'blocked_by_unknown' : 'selected';
	const record = {
		schema_id: 'selection-record/v1', selection_id: `SEL-${profile.profile_id.slice(4)}`,
		revision: selectionRevision || profile.revision || 1, mode,
		capability_profile_ref: profile.profile_id, capability_profile_digest: profile.object_digest_sha256,
		registry_bundle_ref: bundle.bundle_id, registry_bundle_digest: bundle.bundle_digest_sha256,
		project_policy_ref: policy.policy_id, project_policy_digest: policy.object_digest_sha256,
		planner_revision: PLANNER_REVISION, formal_gate: formalGate,
		applied_rules: applied, not_applied_rules: notApplied, outputs, findings: uniqueFindings, status
	};
	record.selection_digest_sha256 = digest(record);
	return record;
}