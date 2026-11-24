/**
 * 把视觉核验结果写回现有 ui-links.json。
 * 只写通过严格校验、自动闸门和写入前有效性检查的结果；不写 confirmed，
 * 不覆盖人工决定、拒绝记忆或仍然有效的旧关联。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadArtifact } from './artifacts.js';
import {
	buildVisionTasks, retrieveCandidates, SCHEMA_VERSION, PROMPT_VERSION, VISION_MODEL
} from './ui-vision.js';
import { autoEligible, validateVisionResult } from './ui-vision-client.js';
import {
	derive, linkKey, linkValidity, loadIndex, loadLinks, saveLinks, stateTokens, visionLinkFresh
} from './ui.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const linkId = (key) => 'L:' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);

function candidateEvidence(candidate, projectDir) {
	const target = candidate.target || {};
	let shotSha = '';
	if (target.shot) {
		try {
			shotSha = sha256(fs.readFileSync(path.join(projectDir, target.shot)));
		} catch {
			shotSha = '';
		}
	}
	return {
		ui_id: candidate.ui_id, name: candidate.name, role: candidate.role,
		revision: candidate.revision || '', state: candidate.state || '',
		page: candidate.page || '', theme: candidate.theme || '', source: candidate.source || '',
		shot: target.shot || candidate.shot || '', shot_sha256: shotSha
	};
}

function existingUsable(link, index, projectDir, task) {
	return linkValidity(link, {
		index, projectDir, text: task.text,
		states: task.purpose === 'expected' ? stateTokens(task.text) : [],
		needShot: true
	}).usable;
}

function sameCandidate(group) {
	const ids = new Set(group.map((entry) => entry.candidate?.ui_id).filter(Boolean));
	return ids.size === 1 ? [...ids][0] : '';
}

/**
 * @param {{dataRoot:string, projectId:string, moduleId:string, results:object[], options?:object}} input
 */
export async function applyVisionResults({ dataRoot, projectId, moduleId, results, options = {} }) {
	const projectDir = path.join(dataRoot, 'projects', projectId);
	const index = loadIndex(dataRoot, projectId);
	if (!index.digest) throw new Error('还没有 UI 索引');
	const links = loadLinks(dataRoot, projectId);
	const [built, pointsDoc, contractsDoc] = await Promise.all([
		buildVisionTasks({ dataRoot, projectId, moduleId, options: { includeMatched: true, links } }),
		loadArtifact(dataRoot, projectId, 'points'),
		loadArtifact(dataRoot, projectId, 'contracts')
	]);
	const taskById = new Map(built.tasks.map((task) => [task.task_id, task]));

	// 每个 expected_id 的原子断言全集；只应用全部断言都已核验的预期项。
	const requiredByExpected = new Map();
	const requiredByPoint = new Map();
	for (const task of built.tasks) {
		if (task.purpose !== 'expected' || task.subject.kind !== 'case_expected') continue;
		const expectedKey = task.subject.expected_id;
		const assertionKey = `${task.subject.id}|${expectedKey}|${task.subject.assertion_id}`;
		const expectedSet = requiredByExpected.get(expectedKey) || new Set();
		expectedSet.add(task.subject.assertion_id);
		requiredByExpected.set(expectedKey, expectedSet);
		const pointId = task.context?.point_refs?.[0] || '';
		if (pointId) {
			const pointSet = requiredByPoint.get(pointId) || new Set();
			pointSet.add(assertionKey);
			requiredByPoint.set(pointId, pointSet);
		}
	}

	// 同一任务多次运行时保留最新一条通过闸门的结果。
	const chosen = new Map();
	for (const row of results) {
		if (!row || row.ok !== true || row.auto_eligible !== true || row.decision !== 'match' || !row.candidate_id) continue;
		const baseTask = taskById.get(row.task_id);
		if (!baseTask || !row.result) continue;
		const task = { ...baseTask, candidates: row.candidates || baseTask.candidates || [], images: row.images || baseTask.images || [] };
		if (!validateVisionResult(task, row.result).valid) continue;
		const prior = chosen.get(row.task_id);
		const stamp = row.created_at || row.attempts?.at?.(-1)?.at || '';
		if (!prior || stamp >= prior.stamp) chosen.set(row.task_id, { row, task, stamp });
	}

	const groups = new Map();
	for (const entry of chosen.values()) {
		const key = linkKey(entry.task.subject, entry.task.purpose);
		const list = groups.get(key) || [];
		list.push(entry);
		groups.set(key, list);
	}

	let items = [...(links.items || [])];
	const byKey = new Map(items.map((item) => [linkKey(item.subject, item.purpose), item]));
	const applied = [];
	const skipped = [];
	const pending = [];

	for (const [key, group] of groups) {
		const task = group[0].task;
		// derive 的展示名来自原始业务文本；对齐名称，避免下一轮 derive 误判为不同对象。
		const subject = {
			...task.subject,
			name: task.subject.name || task.subject_name || String(task.original_text || task.text || '').slice(0, 40)
		};
		const existing = byKey.get(key);
		if (existing?.status === 'confirmed' || existing?.method === 'manual') {
			skipped.push({ key, task_id: task.task_id, reason: '保留人工决定' });
			continue;
		}
		if (existing?.status === 'rejected') {
			skipped.push({ key, task_id: task.task_id, reason: '保留人工拒绝' });
			continue;
		}
		if (existing && existingUsable(existing, index, projectDir, task)) {
			skipped.push({ key, task_id: task.task_id, reason: '已有有效关联，保持成功结果' });
			continue;
		}
		const required = requiredByExpected.get(subject.expected_id) || new Set([subject.assertion_id]);
		const covered = new Set(group.map((entry) => entry.task.subject.assertion_id));
		if ([...required].some((id) => !covered.has(id))) {
			skipped.push({ key, task_id: task.task_id, reason: '预期项的原子断言未全部核验' });
			continue;
		}

		const retrieved = retrieveCandidates({ index, links, task, projectDir });
		const candidates = retrieved.candidates || [];
		const rejected = existing?.status === 'rejected' && existing.rejected_ui_id
			? new Set([existing.rejected_ui_id]) : new Set();
		let candidate = null;
		let conflict = '';
		for (const entry of group) {
			const candidateHit = candidates.find((item) => item.candidate_id === entry.row.candidate_id);
			if (!candidateHit || candidateHit.asset_status !== 'shot' || rejected.has(candidateHit.ui_id)) {
				conflict = '候选已变化或没有可解码截图';
				break;
			}
			const gated = autoEligible({ ...task, candidates }, entry.row.result);
			if (!gated) {
				conflict = '自动闸门复核未通过';
				break;
			}
			if (candidate && candidate.ui_id !== candidateHit.ui_id) {
				conflict = '多个原子断言指向不同 UI 对象，现有 linkKey 不能表达';
				break;
			}
			candidate = candidateHit;
		}
		if (conflict || !candidate) {
			pending.push({ key, task_id: task.task_id, reason: conflict || '没有可写入候选' });
			continue;
		}

		const evidence = {
			task_ids: group.map((entry) => entry.task.task_id),
			basis_digests: [...new Set(group.map((entry) => entry.row.request?.basis_digest || task.basis_digest))],
			model: group[0].row.request?.model || VISION_MODEL,
			prompt_version: group[0].row.request?.prompt_version || PROMPT_VERSION,
			schema_version: group[0].row.request?.schema_version || SCHEMA_VERSION,
			decision: 'match',
			candidate_id: candidate.candidate_id,
			candidate: candidateEvidence(candidate, projectDir),
			verified_assertion_ids: group.map((entry) => entry.task.subject.assertion_id),
			assertions: group.flatMap((entry) => entry.row.result.assertions || []),
			missing_evidence: group.flatMap((entry) => entry.row.result.missing_evidence || []),
			images: group[0].row.images || [],
			retrieval: group[0].row.retrieval || null,
			result_digest: sha256(JSON.stringify(group.map((entry) => entry.row.result))),
			checked_at: group.map((entry) => entry.row.created_at).filter(Boolean).sort().at(-1) || new Date().toISOString()
		};
		const link = {
			link_id: existing?.link_id || linkId(key),
			subject, purpose: task.purpose,
			ui_id: candidate.ui_id, target: candidate.target,
			status: 'auto', method: 'vision',
			confidence: Math.min(...group.map((entry) => Number(entry.row.result.confidence) || 0)),
			reason: `视觉核验通过：${group.map((entry) => entry.task.subject.assertion_id).join('、')}，候选 ${candidate.name}`,
			vision_evidence: evidence,
			updated_at: new Date().toISOString()
		};
		const validity = linkValidity(link, {
			index, projectDir, text: task.text,
			states: task.purpose === 'expected' ? stateTokens(task.text) : [], needShot: true
		});
		if (!validity.usable) {
			skipped.push({ key, task_id: task.task_id, reason: '写入前有效性检查未通过：' + validity.reasons.join('；') });
			continue;
		}
		if (existing) {
			items = items.map((item) => linkKey(item.subject, item.purpose) === key ? link : item);
		} else {
			items.push(link);
		}
		byKey.set(key, link);
		applied.push({ key, link_id: link.link_id, task_ids: evidence.task_ids, ui_id: link.ui_id, assertions: evidence.verified_assertion_ids });
	}

	const propagation = options.propagate === false ? { applied: [], skipped: [] } : propagateConsensus({
		index, projectDir, items, byKey, applied, requiredByPoint, taskById, moduleId,
		points: pointsDoc.items || [], contracts: contractsDoc.items || []
	});
	items = propagation.items;
	if (options.save === false) {
		return { applied, skipped, pending, propagation: propagation.report, document: { ...links, items } };
	}
	const saved = saveLinks(dataRoot, projectId, items, {
		digest: index.digest, sources: index.sources, stale: links.stale, review: links.review
	});
	const [facts, contracts, points, cases] = await Promise.all(['facts', 'contracts', 'points', 'cases']
		.map((kind) => loadArtifact(dataRoot, projectId, kind)));
	const derived = derive(dataRoot, projectId, { facts, contracts, points, cases, links: saved }, { links: saved, save: true });
	return {
		applied, skipped, pending, propagation: propagation.report,
		document: derived.document,
		stats: {
			applied: applied.length, skipped: skipped.length, pending: pending.length,
			propagated: propagation.report.applied.length,
			links: derived.document.items.length, derive: derived.stats
		}
	};
}

/**
 * 上游共识传播：只有某测试点下所有 UI 适用的用例断言都指向同一对象，
 * 才把视觉依据上提到测试点；合同再要求其下所有有视觉证据的测试点一致。
 */
function propagateConsensus({ index, projectDir, items, byKey, applied, requiredByPoint, taskById, points, contracts }) {
	const report = { applied: [], skipped: [] };
	const assertionKey = (task) => `${task.subject.id}|${task.subject.expected_id}|${task.subject.assertion_id}`;
	const appliedByAssertion = new Map();
	for (const entry of applied) {
		for (const taskId of entry.task_ids) {
			const task = taskById.get(taskId);
			if (task) appliedByAssertion.set(assertionKey(task), entry);
		}
	}
	const pointConsensus = new Map();
	for (const [pointId, required] of requiredByPoint) {
		const entries = [...required].map((key) => appliedByAssertion.get(key)).filter(Boolean);
		if (entries.length !== required.size) {
			report.skipped.push({ point_id: pointId, reason: '仍有断言未通过视觉核验' });
			continue;
		}
		const uiIds = new Set(entries.map((entry) => entry.ui_id));
		if (uiIds.size !== 1) {
			report.skipped.push({ point_id: pointId, reason: '断言指向不同 UI 对象' });
			continue;
		}
		pointConsensus.set(pointId, { ui_id: [...uiIds][0], entries });
	}
	const pointById = new Map();
	for (const task of taskById.values()) {
		const pointId = task.context?.point_refs?.[0] || '';
		if (pointId) pointById.set(pointId, { point_id: pointId, ...(task.context.point || {}) });
	}
	for (const [pointId, consensus] of pointConsensus) {
		const point = pointById.get(pointId) || {};
		const expectedText = point.expected || '';
		if (!expectedText) continue;
		const subject = { kind: 'point', id: pointId, name: point.requirement || pointId };
		const key = linkKey(subject, 'expected');
		const existing = byKey.get(key);
		if (existing?.status === 'confirmed' || existing?.method === 'manual' || existing?.status === 'rejected') continue;
		if (existing && existingUsable(existing, index, projectDir, { text: expectedText, purpose: 'expected' })) continue;
		const sourceLink = items.find((item) => item.link_id === consensus.entries[0].link_id);
		if (!sourceLink) continue;
		const link = {
			link_id: existing?.link_id || linkId(key), subject, purpose: 'expected',
			ui_id: consensus.ui_id, target: sourceLink.target,
			status: 'auto', method: 'vision', confidence: sourceLink.confidence,
			reason: '用例断言视觉核验一致，按同一对象/状态上提到测试点预期',
			inherited_from: sourceLink.link_id,
			vision_evidence: { ...sourceLink.vision_evidence, inherited_from: sourceLink.link_id, consensus_point_id: pointId },
			updated_at: new Date().toISOString()
		};
		const validity = linkValidity(link, {
			index, projectDir, text: `${point.condition || ''} ${expectedText}`,
			states: stateTokens(expectedText), needShot: true
		});
		if (!validity.usable) {
			report.skipped.push({ point_id: pointId, reason: validity.reasons.join('；') });
			continue;
		}
		items = existing ? items.map((item) => linkKey(item.subject, item.purpose) === key ? link : item) : [...items, link];
		byKey.set(key, link);
		report.applied.push({ kind: 'point', point_id: pointId, ui_id: link.ui_id, from: sourceLink.link_id });
	}
	// 合同层只在所有有视觉任务的下属测试点都形成同一对象共识后上提。
	const contractById = new Map(contracts.map((contract) => [contract.contract_id, contract]));
	const pointsByContract = new Map();
	for (const point of points) {
		if (!requiredByPoint.has(point.point_id)) continue;
		for (const contractId of point.contract_refs || []) {
			const list = pointsByContract.get(contractId) || [];
			list.push(point.point_id);
			pointsByContract.set(contractId, list);
		}
	}
	for (const [contractId, pointIds] of pointsByContract) {
		const contract = contractById.get(contractId);
		if (!contract) continue;
		const consensus = pointIds.map((pointId) => pointConsensus.get(pointId));
		if (consensus.some((entry) => !entry)) {
			report.skipped.push({ contract_id: contractId, reason: '下属测试点未全部形成视觉共识' });
			continue;
		}
		const uiIds = new Set(consensus.map((entry) => entry.ui_id));
		if (uiIds.size !== 1) {
			report.skipped.push({ contract_id: contractId, reason: '下属测试点指向不同 UI 对象' });
			continue;
		}
		const pointLinks = [];
		for (const pointId of pointIds) {
			const pointLink = byKey.get(linkKey({ kind: 'point', id: pointId }, 'expected'));
			if (!pointLink?.ui_id) break;
			pointLinks.push(pointLink);
		}
		if (pointLinks.length !== pointIds.length) {
			report.skipped.push({ contract_id: contractId, reason: '测试点视觉关联尚未写回' });
			continue;
		}
		const subject = { kind: 'contract', id: contractId, name: contract.title || contractId };
		const key = linkKey(subject, 'expected');
		const existing = byKey.get(key);
		if (existing?.status === 'confirmed' || existing?.method === 'manual' || existing?.status === 'rejected') continue;
		if (existing && existingUsable(existing, index, projectDir, {
			text: `${contract.condition || ''} ${contract.expected || ''}`,
			purpose: 'expected'
		})) continue;
		const sourceLink = pointLinks[0];
		const link = {
			link_id: existing?.link_id || linkId(key), subject, purpose: 'expected',
			ui_id: sourceLink.ui_id, target: sourceLink.target,
			status: 'auto', method: 'vision', confidence: sourceLink.confidence,
			reason: '下属测试点视觉共识一致，按同一对象/状态上提到需求合同',
			inherited_from: sourceLink.link_id,
			vision_evidence: { ...sourceLink.vision_evidence, inherited_from: sourceLink.link_id, consensus_contract_id: contractId },
			updated_at: new Date().toISOString()
		};
		const validity = linkValidity(link, {
			index, projectDir, text: `${contract.condition || ''} ${contract.expected || ''}`,
			states: stateTokens(contract.expected), needShot: true
		});
		if (!validity.usable) {
			report.skipped.push({ contract_id: contractId, reason: validity.reasons.join('；') });
			continue;
		}
		items = existing ? items.map((item) => linkKey(item.subject, item.purpose) === key ? link : item) : [...items, link];
		byKey.set(key, link);
		report.applied.push({ kind: 'contract', contract_id: contractId, ui_id: link.ui_id, from: sourceLink.link_id });
	}
	return { items, report };
}