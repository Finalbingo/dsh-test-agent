/**
 * 运行视觉匹配任务（不写 ui-links）：准备候选、调用固定模型、严格校验并记录结果。
 * 正式写关联在后续阶段完成。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildVisionTasks, prepareVisionTask } from '../ui-vision.js';
import { runVisionTask, readApiKey } from '../ui-vision-client.js';
import { enterModule } from '../scope.js';

const DATA_ROOT = process.env.CTS_DATA_ROOT || '/Users/Admin/Documents/CTS';
const RUN_DIR = process.env.CTS_RUN_DIR || '/Users/Admin/Documents/CTS/reports/ui-vision-ling-20261117-151738';
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
	const index = args.indexOf('--' + name);
	return index >= 0 ? args[index + 1] : fallback;
};
const projectId = arg('project', 'P-edb245e1ef');
const requestedModule = arg('module', '');
const limit = Number(arg('limit', 1));
const taskId = arg('task', '');
const includeMatched = args.includes('--include-matched');
const resume = !args.includes('--no-resume');

function resolveModuleId() {
	if (requestedModule) return requestedModule;
	try {
		const info = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'projects', projectId, 'project.json'), 'utf8'));
		return info.modules?.[0]?.id || 'default';
	} catch {
		return 'default';
	}
}

async function main() {
	if (!readApiKey()) throw new Error('缺少 OPENROUTER_API_KEY');
	const moduleId = resolveModuleId();
	enterModule(moduleId);
	const built = await buildVisionTasks({ dataRoot: DATA_ROOT, projectId, moduleId, options: { includeMatched } });
	let pending = built.tasks;
	if (taskId) pending = pending.filter((task) => task.task_id === taskId);
	if (!pending.length) throw new Error('没有匹配的任务');
	pending = pending.slice(0, limit);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outDir = path.join(RUN_DIR, 'vision-runs', stamp);
	await fsp.mkdir(outDir, { recursive: true });
	const results = [];
	let stopped = '';
	for (const task of pending) {
		if (stopped) break;
		const prepared = await prepareVisionTask({ dataRoot: DATA_ROOT, projectId, index: built.index, task });
		const base = {
			task_id: task.task_id, purpose: task.purpose, text: task.text, subject: task.subject,
			target: task.target, retrieval: prepared.retrieval,
			candidates: prepared.candidates.map((candidate) => ({
				candidate_id: candidate.candidate_id, ui_id: candidate.ui_id, name: candidate.name,
				role: candidate.role, page: candidate.page, state: candidate.state || '', asset_status: candidate.asset_status
			})),
			images: prepared.images.map((image) => ({ image_id: image.image_id, role: image.role, sha256: image.sha256, width: image.width, height: image.height }))
		};
		if (!prepared.candidates.some((candidate) => candidate.asset_status === 'shot')) {
			const row = { ...base, ok: false, skipped: true, error: '没有可看图候选：' + prepared.retrieval.status };
			results.push(row);
			await fsp.appendFile(path.join(outDir, 'results.jsonl'), JSON.stringify(row) + '\n');
			console.log(task.task_id, 'skipped', prepared.retrieval.status);
			continue;
		}
		try {
			const result = await runVisionTask({ task: prepared, projectDir: path.join(DATA_ROOT, 'projects', projectId), resume });
			const row = {
				...base, ok: result.ok, cached: Boolean(result.cached),
				decision: result.result?.decision || '', candidate_id: result.result?.candidate_id ?? null,
				validation: result.validation || null, auto_eligible: Boolean(result.auto_eligible),
				error: result.error || '', response: result.response || null, result: result.result || null,
				cache_key: result.cache_key || '', created_at: result.created_at || '',
				request: result.request || null, attempts: result.attempts || []
			};
			results.push(row);
			await fsp.appendFile(path.join(outDir, 'results.jsonl'), JSON.stringify(row) + '\n');
			console.log(task.task_id, 'decision=' + (row.decision || '-'), 'ok=' + row.ok, 'auto=' + row.auto_eligible, 'cached=' + row.cached, 'candidates=' + prepared.candidates.length);
		} catch (error) {
			const row = { ...base, ok: false, error: String(error?.message || error), kind: error?.kind || '', attempts: error?.attempts || [] };
			results.push(row);
			await fsp.appendFile(path.join(outDir, 'results.jsonl'), JSON.stringify(row) + '\n');
			console.log(task.task_id, 'failed', row.kind, row.error);
			if (row.kind === 'auth') stopped = 'auth';
		}
	}
	const summary = {
		project_id: projectId, module_id: moduleId, requested: pending.length, completed: results.length,
		ok: results.filter((row) => row.ok).length, auto_eligible: results.filter((row) => row.auto_eligible).length,
		cached: results.filter((row) => row.cached).length,
		decisions: results.reduce((acc, row) => { const key = row.decision || 'none'; acc[key] = (acc[key] || 0) + 1; return acc; }, {}),
		stopped
	};
	await fsp.writeFile(path.join(outDir, 'summary.json'), JSON.stringify({ ...summary, results }, null, 1));
	console.log(JSON.stringify({ outDir, summary }, null, 1));
	if (stopped || summary.ok < summary.requested) process.exitCode = 1;
}

main().catch((error) => {
	console.error(JSON.stringify({ error: String(error?.message || error), kind: error?.kind || '', attempts: error?.attempts || [] }, null, 1));
	process.exitCode = 1;
});