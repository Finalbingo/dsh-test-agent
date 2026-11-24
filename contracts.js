import { randomUUID } from 'node:crypto';
import { digestOf } from './artifacts.js';

export function contractBasis(contract, facts, evidence) {
	const factById = new Map(facts.map((item) => [item.fact_id, item]));
	const evidenceById = new Map(evidence.map((item) => [item.id, item]));
	const sources = contract.fact_refs.map((id) => {
		const fact = factById.get(id);
		if (!fact?.evidence_refs?.length) return null;
		const refs = fact.evidence_refs.map((ref) => evidenceById.get(ref));
		if (refs.some((ref) => !ref)) return null;
		return [id, fact.statement, refs.map((ref) => [ref.id, ref.source, ref.location, ref.sha256 || digestOf(ref.text)])];
	});
	return sources.length && sources.every(Boolean) ? digestOf(sources) : null;
}

/** Verbatim source rows: a contract must carry the quote it was approved on. */
export function contractSources(contract, facts, evidence) {
	const factById = new Map(facts.map((item) => [item.fact_id, item]));
	const evidenceById = new Map(evidence.map((item) => [item.id, item]));
	return (contract.fact_refs || []).map((id) => {
		const fact = factById.get(id);
		const refs = (fact?.evidence_refs || []).map((ref) => evidenceById.get(ref)).filter(Boolean);
		return {
			fact_id: id,
			statement: fact?.statement || '',
			evidence: refs.map((ref) => ({
				id: ref.id, source: ref.source, location: ref.location,
				source_id: ref.source_id || '', version: ref.source_version || '',
				sha256: ref.sha256 || digestOf(ref.text), quote: ref.text || ''
			}))
		};
	});
}

export function editContract(existing, patch, features, facts, evidence, approve, states) {
	const field = (key) => typeof patch[key] === 'string' ? patch[key].trim() : '';
	const featureId = field('feature_id');
	if (!features.some((item) => item.feature_id === featureId)) throw new Error('请选择现有功能点');
	const transition = field('transition_ref');
	if (transition && !states.some((machine) => machine.feature_id === featureId && machine.transitions.some((entry) => entry.transition_id === transition))) {
		throw new Error('请选择所属功能点中的状态转移');
	}
	const factIds = new Set(facts.map((item) => item.fact_id));
	const refs = [...new Set(Array.isArray(patch.fact_refs) ? patch.fact_refs : [])];
	if (refs.some((ref) => !factIds.has(ref))) throw new Error('存在无效的事实编号');
	const contract = {
		contract_id: existing?.contract_id || 'RC-' + randomUUID(),
		feature_id: featureId,
		transition_ref: transition,
		fact_refs: refs,
		title: field('title'),
		trigger: field('trigger'),
		condition: field('condition'),
		expected: field('expected'),
		rule_ids: [...new Set(Array.isArray(patch.rule_ids) ? patch.rule_ids.filter((id) =>
			['baseline', 'boundary', 'transition', 'combination', 'exception', 'timeout', 'recovery', 'permission', 'interaction'].includes(id)) : [])],
		// 完整规则引用另存：短名白名单只服务旧合同，不得丢弃带修订的 TKR ID。
		tkr_rule_refs: Array.isArray(patch.tkr_rule_refs) ? patch.tkr_rule_refs.filter((ref) => ref && typeof ref.rule_id === 'string')
			.map((ref) => ({ rule_id: ref.rule_id, revision: Number(ref.revision) || null })) : [],
		verification: field('verification'),
		interactions: field('interactions'),
		recovery: field('recovery'),
		status: 'draft'
	};
	const missingFields = [
		['trigger', '触发动作'],
		['condition', '前置条件'],
		['expected', '可观察预期']
	].filter(([key]) => !contract[key]).map(([, label]) => label);
	// 草稿缺字段不是无声的：列表和确认动作都要点名缺哪一项。
	contract.missing_fields = missingFields;
	if (!contract.title) throw new Error('请输入合同名称');
	if (approve) {
		if (missingFields.length) throw new Error('请补齐' + missingFields.join('、'));
		const basis = contractBasis(contract, facts, evidence);
		if (!basis) throw new Error('确认前，请关联来源有效的事实并核对原文');
		contract.status = 'approved';
		contract.basis = basis;
		contract.sources = contractSources(contract, facts, evidence);
		contract.approved_at = new Date().toISOString();
	}
	return contract;
}

export function contractPoints(contracts) {
	const items = new Map();
	for (const item of contracts) {
		const key = JSON.stringify([item.feature_id, item.transition_ref || '', item.condition, item.trigger, item.expected].map((text) => text.normalize('NFKC').replace(/\s+/g, '')));
		const previous = items.get(key);
		if (previous) {
			previous.fact_refs = [...new Set([...previous.fact_refs, ...item.fact_refs])];
			previous.contract_refs.push(item.contract_id);
			continue;
		}
		items.set(key, {
			point_id: `T-${String(items.size + 1).padStart(4, '0')}`,
			requirement: item.title, feature_id: item.feature_id, condition: item.condition,
			action: item.trigger, expected: item.expected, fact_refs: [...item.fact_refs],
			transition_ref: item.transition_ref || '',
			contract_refs: [item.contract_id], priority: 'P1', review_status: 'candidate'
		});
	}
	return [...items.values()];
}
