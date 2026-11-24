#!/usr/bin/env node
/**
 * 旧 V5 测试点 → 需求合同 继承迁移（默认只预览）。
 * 用法：node scripts/ui-migrate-inherit.mjs --data <dataDir> --project <pid> [--module <mid>] [--out <preview.json>] [--apply]
 *
 * 规则：
 * - 只读点：逐点列出候选合同、依据与风险；不按数组位置、相似标题或相同 fact_refs 单独自动补引用。
 * - 自动补引用需要至少两个语义字段（条件/动作/预期）完全一致，且其中一个为条件或动作。
 * - 多个候选都达到完整依据且语义三元组一致（需求拆分/合并）时多对多补引用；语义不同则保留待判断。
 * - 应用时保留原关联，新增引用；曾经 approved 的点重置为 candidate，不带任何旧批准摘要。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { enterModule } from '../scope.js';
import { archive, load as loadArtifact, save as saveArtifact } from '../artifacts.js';

const norm = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/[，。；：、!?！？.,;:]/g, '');

function scoreContract(point, contract) {
	const fields = {
		condition: norm(contract.condition) && norm(contract.condition) === norm(point.condition),
		action: norm(contract.trigger ?? contract.action) && norm(contract.trigger ?? contract.action) === norm(point.action),
		expected: norm(contract.expected) && norm(contract.expected) === norm(point.expected)
	};
	const exact = Object.values(fields).filter(Boolean).length;
	const evidence = [];
	const risk = [];
	if (fields.condition) evidence.push('前置条件一致');
	if (fields.action) evidence.push('触发动作一致');
	if (fields.expected) evidence.push('预期一致');
	const pointFacts = new Set((point.fact_refs || []).map(String));
	const contractFacts = new Set((contract.fact_refs || []).map(String));
	const shared = [...pointFacts].filter((id) => contractFacts.has(id));
	const factsEqual = pointFacts.size > 0 && shared.length === pointFacts.size && shared.length === contractFacts.size;
	if (factsEqual) evidence.push('事实引用完全相同');
	else if (shared.length) {
		evidence.push(`事实引用部分重叠 ${shared.length} 条`);
		risk.push('事实引用不完全一致，不能单独作为依据');
	}
	if (point.transition_ref && contract.transition_ref && point.transition_ref === contract.transition_ref &&
		(!contract.feature_id || !point.feature_id || contract.feature_id === point.feature_id)) evidence.push('状态转移一致');
	const title = norm(contract.title);
	const requirement = norm(point.requirement ?? point.title);
	if (title && requirement && (title === requirement || (title.length >= 4 && requirement.includes(title)) || (requirement.length >= 4 && title.includes(requirement)))) {
		evidence.push('标题相近');
		risk.push('标题相近不作为独立依据');
	}
	if (pointFacts.size && !factsEqual) risk.push('事实引用与合同不一致');
	return { exact, fields, factsEqual, evidence, risk };
}

export function migrationRows(points, contracts) {
	const rows = [];
	for (const point of points) {
		const current = [...new Set((point.contract_refs || []).map(String))];
		if (current.length) {
			rows.push({ point_id: point.point_id, requirement: point.requirement || point.title || '', decision: 'already_linked', current_refs: current, candidates: [], reason: '已有合同引用，不重复迁移' });
			continue;
		}
		if (!contracts.length) {
			rows.push({ point_id: point.point_id, requirement: point.requirement || point.title || '', decision: 'no_contract', current_refs: [], candidates: [], reason: '项目没有需求合同，无法建立继承' });
			continue;
		}
		const scoped = contracts.filter((contract) => contract.status === 'approved' &&
			(!point.feature_id || !contract.feature_id || contract.feature_id === point.feature_id));
		if (!scoped.length) {
			rows.push({ point_id: point.point_id, requirement: point.requirement || point.title || '', decision: 'pending', current_refs: [], candidates: [], reason: point.feature_id ? `功能点 ${point.feature_id} 没有已批准合同` : '项目没有已批准合同' });
			continue;
		}
		const scored = scoped.map((contract) => {
			const scoredContract = scoreContract(point, contract);
			return { contract_id: contract.contract_id, title: contract.title || '', score: scoredContract.exact * 2 + (scoredContract.factsEqual ? 1 : 0), exact: scoredContract.exact, fields: scoredContract.fields, factsEqual: scoredContract.factsEqual, evidence: scoredContract.evidence, risk: scoredContract.risk };
		}).sort((a, b) => b.score - a.score);
		const complete = scored.filter((candidate) => candidate.exact >= 2 && (candidate.fields.condition || candidate.fields.action));
		if (!complete.length) {
			rows.push({ point_id: point.point_id, requirement: point.requirement || point.title || '', decision: 'pending', current_refs: [], candidates: scored.slice(0, 3), reason: '没有达到完整依据的候选（至少两个语义字段一致）' });
			continue;
		}
		const triples = new Set(complete.map((candidate) => {
			const contract = scoped.find((entry) => entry.contract_id === candidate.contract_id);
			return [norm(contract?.condition), norm(contract?.trigger ?? contract?.action), norm(contract?.expected)].join('|');
		}));
		if (triples.size > 1) {
			rows.push({ point_id: point.point_id, requirement: point.requirement || point.title || '', decision: 'pending', current_refs: [], candidates: complete.slice(0, 4), reason: '多个语义不同的完整候选，需人工判断拆分/合并关系' });
			continue;
		}
		rows.push({ point_id: point.point_id, requirement: point.requirement || point.title || '', decision: 'apply', current_refs: [], candidates: complete, reason: `唯一语义候选${complete.length > 1 ? '（拆分合同，多对多）' : ''}` });
	}
	return rows;
}

async function main() {
	const args = process.argv.slice(2);
	const argOf = (name, fallback) => {
		const index = args.indexOf(name);
		return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
	};
	const dataRoot = argOf('--data', path.join(os.homedir(), 'Documents', 'CTS'));
	const projectId = argOf('--project', '');
	const moduleName = argOf('--module', '');
	const apply = args.includes('--apply');
	let moduleId = '';
	const out = argOf('--out', path.join(dataRoot, 'reports', `ui-inherit-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
	if (!projectId) {
		console.error('必须显式指定 --project');
		process.exit(1);
	}
	if (!moduleName) {
		const candidates = await fs.readdir(path.join(dataRoot, 'artifacts', projectId)).catch(() => []);
		if (candidates.length !== 1) {
			console.error('项目有多个模块，请用 --module 指定：' + candidates.join('、'));
			process.exit(1);
		}
		enterModule(candidates[0]);
		moduleId = candidates[0];
	} else {
		enterModule(moduleName);
		moduleId = moduleName;
	}
	const points = await loadArtifact(dataRoot, projectId, 'points');
	const contracts = await loadArtifact(dataRoot, projectId, 'contracts');
	const rows = migrationRows(points.items || [], contracts.items || []);
	const summary = {
		generated_at: new Date().toISOString(), applied: apply,
		project: projectId, module: moduleId,
		counts: rows.reduce((acc, row) => { acc[row.decision] = (acc[row.decision] || 0) + 1; return acc; }, {}),
		rows
	};
	if (apply) {
		const targets = rows.filter((row) => row.decision === 'apply');
		if (targets.length) {
			await archive(dataRoot, projectId, 'points');
			for (const row of rows) {
				if (row.decision !== 'apply') continue;
				const point = points.items.find((entry) => entry.point_id === row.point_id);
				if (!point) continue;
				const refs = [...new Set([...(point.contract_refs || []), ...row.candidates.map((candidate) => candidate.contract_id)])];
				point.contract_refs = refs;
				// 来源变了，旧批准不能继续有效（旧版用 status 表示审核，新版用 review_status）。
				if (point.review_status === 'approved' || point.status === 'approved') {
					point.review_status = 'candidate';
					if (point.status === 'approved') point.status = 'candidate';
				}
				delete point.approved_at;
				point.migrated_at = new Date().toISOString();
				point.migrated_by = 'ui-migrate-inherit';
			}
			const { items, version, updatedAt, digest, ...meta } = points;
			await saveArtifact(dataRoot, projectId, 'points', { version, items, meta });
		}
		summary.applied_points = targets.length;
	}
	await fs.mkdir(path.dirname(out), { recursive: true });
	await fs.writeFile(out, JSON.stringify(summary, null, 1), 'utf8');
	console.log(JSON.stringify({ ok: true, out, project: projectId, applied: apply, counts: summary.counts, applied_points: summary.applied_points || 0 }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(String(error?.stack || error));
		process.exit(1);
	});
}
