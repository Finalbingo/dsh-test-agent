#!/usr/bin/env node
/**
 * P6 固定样本 A/B/C 对照：A 旧规则、B 修复上下文后的规则、C 同 B 候选 + 视觉模型。
 * 只读项目数据，不写 ui-links。样本与参考判断先落盘再运行。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildVisionTasks, prepareVisionTask } from '../ui-vision.js';
import { runVisionTask, readApiKey } from '../ui-vision-client.js';
import { enterModule } from '../scope.js';
import { load as loadArtifact } from '../artifacts.js';
import { match, pageHintsIn, namedObjectsIn, loadIndex, loadLinks } from '../ui.js';

const DATA_ROOT = process.env.CTS_DATA_ROOT || '/Users/Admin/Documents/CTS';
const RUN_ROOT = process.env.CTS_RUN_DIR || '/Users/Admin/Documents/CTS/reports/ui-vision-ling-20261117-151738';
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
	const index = args.indexOf('--' + name);
	return index >= 0 ? args[index + 1] : fallback;
};
const sampleFile = arg('sample', path.join(RUN_ROOT, 'p6', 'sample-30.json'));
const resume = !args.includes('--no-resume');
const rulesOnly = args.includes('--rules-only');
const limit = Number(arg('limit', 0));

const sample = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
if (!readApiKey()) throw new Error('缺少 OPENROUTER_API_KEY');

const groups = new Map();
for (const item of sample.items) {
	const key = `${item.project}/${item.module}`;
	const list = groups.get(key) || [];
	list.push(item);
	groups.set(key, list);
}

const builtByScope = new Map();
const taskById = new Map();
for (const [key, items] of groups) {
	const { project, module } = items[0];
	enterModule(module);
	const index = loadIndex(DATA_ROOT, project);
	const built = await buildVisionTasks({ dataRoot: DATA_ROOT, projectId: project, moduleId: module, options: { includeMatched: true } });
	builtByScope.set(key, { ...built, index });
	for (const task of built.tasks) taskById.set(task.task_id, { task, project, module, built: { ...built, index }, index });
}
const missing = sample.items.filter((item) => !taskById.has(item.task_id));
if (missing.length) throw new Error('样本任务已不存在：' + missing.map((item) => item.task_id).join(','));

function candidateIds(outcome) {
	return [...(outcome.candidates || []).map((entry) => entry.ui_id), outcome.target?.ui_id].filter(Boolean);
}

function ruleComparison(item, task, built) {
	const { index } = built;
	const oldQuery = {
		text: task.text, name: '', roleHint: 'button', pageHints: [], contextText: '', useContextTokens: false
	};
	const repairedQuery = {
		text: task.text,
		name: task.target?.object_text || '',
		roleHint: task.target?.role || '',
		pageHints: pageHintsIn(index, [task.context?.page || '', `${task.text} ${task.context?.text || ''}`]),
		contextText: task.context?.text || '',
		useContextTokens: !namedObjectsIn(task.text).length
	};
	const a = match(index, oldQuery, { purpose: task.purpose, projectDir: path.join(DATA_ROOT, 'projects', item.project) });
	const b = match(index, repairedQuery, { purpose: task.purpose, projectDir: path.join(DATA_ROOT, 'projects', item.project) });
	return {
		a: {
			status: a.status, target_ui_id: a.target?.ui_id || '', reason: a.reason,
			candidate_ui_ids: candidateIds(a)
		},
		b: {
			status: b.status, target_ui_id: b.target?.ui_id || '', reason: b.reason,
			candidate_ui_ids: candidateIds(b)
		}
	};
}

function judge(item, row) {
	const reference = item.reference || {};
	const ref = reference.target_ui_id || '';
	const cRow = row.c && !row.c.skipped ? {
		...row.c,
		status: row.c.auto_eligible ? 'auto' : '',
		target_ui_id: row.c.candidate_ui_id || '',
		candidate_ui_ids: row.c.candidate_ui_id ? [row.c.candidate_ui_id] : []
	} : null;
	if (reference.type === 'positive') {
		return {
			label: 'positive',
			a: rowOutcome(row.a, ref),
			b: rowOutcome(row.b, ref),
			c: rowOutcome(cRow, ref),
			recall: {
				a: rowRecall(row.a, ref), b: rowRecall(row.b, ref), c: rowRecall(cRow, ref)
			}
		};
	}
	if (reference.type === 'no_match' || reference.type === 'no_material') {
		return {
			label: reference.type,
			a: autoUnsafe(row.a), b: autoUnsafe(row.b), c: cRow ? autoUnsafe(cRow) : null
		};
	}
	return {
		label: reference.type,
		a: autoUnsafe(row.a), b: autoUnsafe(row.b), c: cRow ? autoUnsafe(cRow) : null,
		uncertain_kept: {
			a: !autoUnsafe(row.a), b: !autoUnsafe(row.b), c: cRow ? !autoUnsafe(cRow) : null
		}
	};
}

function rowOutcome(row, ref) {
	if (!row) return 'failed';
	if (!row.auto_eligible && row.status !== 'auto') return row.target_ui_id && row.target_ui_id !== ref ? 'unverified_target' : 'not_auto';
	if (row.target_ui_id === ref) return 'correct';
	return 'wrong';
}
function rowRecall(row, ref) {
	if (!ref || !row) return false;
	return (row.candidate_ui_ids || []).includes(ref);
}
function autoUnsafe(row) {
	if (!row) return false;
	return Boolean(row.auto_eligible || (row.status === 'auto' && row.target_ui_id));
}

async function main() {
	const items = limit > 0 ? sample.items.slice(0, limit) : sample.items;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outDir = path.join(RUN_ROOT, 'p6', `run-${stamp}`);
	await fsp.mkdir(outDir, { recursive: true });
	const results = [];
	for (const item of items) {
		const { task, project, module, built } = taskById.get(item.task_id);
		enterModule(module);
		const rules = ruleComparison(item, task, built);
		const prepared = await prepareVisionTask({ dataRoot: DATA_ROOT, projectId: project, index: built.index, task });
		const base = {
			task_id: task.task_id, sample_category: item.category, project, module,
			text: task.text, subject: task.subject, target: task.target,
			reference: item.reference,
			a: rules.a, b: rules.b,
			candidates: prepared.candidates.map((candidate) => ({
				candidate_id: candidate.candidate_id, ui_id: candidate.ui_id, name: candidate.name,
				role: candidate.role, page: candidate.page, state: candidate.state || '',
				texts: (candidate.target?.texts || []).slice(0, 6), asset_status: candidate.asset_status
			})),
			images: prepared.images.map((image) => ({ image_id: image.image_id, role: image.role, sha256: image.sha256, width: image.width, height: image.height })),
			retrieval: prepared.retrieval,
			c: null
		};
		if (rulesOnly) {
			base.c = { ok: false, skipped: true, error: 'rules-only', decision: 'skipped' };
		} else if (rules.b.status === 'auto') {
			// 按试验方案，视觉只处理 B 仍未自动匹配的任务，避免把 B 的收益算到 C 上。
			base.c = { ok: false, skipped: true, error: 'B 已自动匹配，按计划不进入 C', decision: 'skipped_b_auto' };
		} else if (!prepared.candidates.some((candidate) => candidate.asset_status === 'shot')) {
			base.c = { ok: false, skipped: true, error: '没有可看图候选：' + prepared.retrieval.status, decision: 'no_material' };
		} else {
			try {
				const result = await runVisionTask({ task: prepared, projectDir: path.join(DATA_ROOT, 'projects', project), resume });
				base.c = {
					ok: result.ok, cached: Boolean(result.cached), decision: result.result?.decision || '',
					candidate_id: result.result?.candidate_id ?? null,
					candidate_ui_id: prepared.candidates.find((candidate) => candidate.candidate_id === result.result?.candidate_id)?.ui_id || '',
					validation: result.validation || null, auto_eligible: Boolean(result.auto_eligible),
					result: result.result || null, error: result.error || '', response: result.response || null,
					request: result.request || null, attempts: result.attempts || [], cache_key: result.cache_key || ''
				};
			} catch (error) {
				base.c = { ok: false, error: String(error?.message || error), kind: error?.kind || '', attempts: error?.attempts || [] };
			}
		}
		base.verdict = judge(item, base);
		results.push(base);
		await fsp.appendFile(path.join(outDir, 'results.jsonl'), JSON.stringify(base) + '\n');
		console.log(item.task_id, 'A=' + rules.a.status, 'B=' + rules.b.status, 'C=' + (base.c.decision || base.c.error || '-'), 'auto=' + Boolean(base.c.auto_eligible), 'ref=' + (item.reference.type));
	}
	const summary = summarize(results, sample);
	await fsp.writeFile(path.join(outDir, 'summary.json'), JSON.stringify({ sample_file: sampleFile, ...summary, results }, null, 1));
	console.log(JSON.stringify({ outDir, metrics: summary.metrics, usage: summary.usage }, null, 1));
}

function summarize(results, sample) {
	const byCategory = {};
	for (const row of results) {
		const category = row.sample_category;
		byCategory[category] ||= {
			total: 0, a_auto: 0, b_auto: 0, c_evaluated: 0, c_auto: 0,
			c_skipped_b_auto: 0, c_skipped_no_material: 0, c_failed: 0,
			c_decisions: {}, b_auto_unsafe: 0, c_auto_unsafe: 0, c_uncertain_kept: 0
		};
		const entry = byCategory[category];
		entry.total += 1;
		entry.a_auto += row.a?.status === 'auto' ? 1 : 0;
		entry.b_auto += row.b?.status === 'auto' ? 1 : 0;
		if (row.c?.skipped && row.c.decision === 'skipped_b_auto') entry.c_skipped_b_auto += 1;
		else if (row.c?.skipped) entry.c_skipped_no_material += 1;
		else if (row.c) {
			entry.c_evaluated += 1;
			if (row.c.ok === false) entry.c_failed += 1;
			const decision = row.c.decision || row.c.error || 'failed';
			entry.c_decisions[decision] = (entry.c_decisions[decision] || 0) + 1;
			if (row.c.auto_eligible) entry.c_auto += 1;
			if (row.c.auto_eligible && ['no_match', 'no_material'].includes(row.reference?.type)) entry.c_auto_unsafe += 1;
			if (!row.c.auto_eligible) entry.c_uncertain_kept += 1;
		}
		if (row.b?.status === 'auto' && ['no_match', 'no_material'].includes(row.reference?.type)) entry.b_auto_unsafe += 1;
	const refType = row.reference?.type || '';
		if (!['positive', 'manual_anchor_unverified', 'no_match', 'no_material', 'unknown', 'unlabelled'].includes(refType)) {
			byCategory[category].unexpected_reference = (byCategory[category].unexpected_reference || 0) + 1;
		}
	}
	const refRows = (type) => results.filter((row) => row.reference?.type === type);
	const cEvaluated = (row) => row.c && !row.c.skipped;
	const manualRows = refRows('manual_anchor_unverified');
	const negativeRows = results.filter((row) => ['no_match', 'no_material'].includes(row.reference?.type));
	const unlabelledRows = refRows('unlabelled');
	const usage = { requests: 0, cached: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, latency_ms: 0, reasoning_tokens: 0 };
	for (const row of results) {
		const response = row.c?.response;
		if (!response) continue;
		usage.requests += row.c.cached ? 0 : 1;
		usage.cached += row.c.cached ? 1 : 0;
		const u = response.usage || {};
		usage.prompt_tokens += u.prompt_tokens || 0;
		usage.completion_tokens += u.completion_tokens || 0;
		usage.total_tokens += u.total_tokens || 0;
		usage.cost += u.cost || 0;
		usage.latency_ms += response.latency_ms || 0;
		usage.reasoning_tokens += u.completion_tokens_details?.reasoning_tokens || 0;
	}
	return {
		generated_at: new Date().toISOString(),
		sample_size: results.length,
		sample_file_size: sample.items.length,
		reference_note: sample.reference_audit || null,
		by_category: byCategory,
		metrics: {
			positive_total: refRows('positive').length,
			manual_anchor_total: manualRows.length,
			manual_anchor_b_auto: manualRows.filter((row) => row.b?.status === 'auto').length,
			manual_anchor_c_evaluated: manualRows.filter(cEvaluated).length,
			negative_total: negativeRows.length,
			negative_b_auto_unsafe: negativeRows.filter((row) => row.b?.status === 'auto').length,
			negative_c_evaluated: negativeRows.filter(cEvaluated).length,
			negative_c_auto_unsafe: negativeRows.filter((row) => cEvaluated(row) && row.c.auto_eligible).length,
			unlabelled_total: unlabelledRows.length,
			unlabelled_b_auto: unlabelledRows.filter((row) => row.b?.status === 'auto').length,
			unlabelled_c_evaluated: unlabelledRows.filter(cEvaluated).length,
			unlabelled_c_auto: unlabelledRows.filter((row) => cEvaluated(row) && row.c.auto_eligible).length,
			c_evaluated_total: results.filter(cEvaluated).length,
			c_auto_total: results.filter((row) => row.c?.auto_eligible).length,
			c_skipped_b_auto: results.filter((row) => row.c?.decision === 'skipped_b_auto').length,
			c_failed: results.filter((row) => cEvaluated(row) && row.c.ok === false).length,
			a_auto_total: results.filter((row) => row.a?.status === 'auto').length,
			b_auto_total: results.filter((row) => row.b?.status === 'auto').length
		},
		usage
	};
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });