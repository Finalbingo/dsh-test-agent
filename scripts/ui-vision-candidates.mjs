/**
 * P2 只读盘点：任务结构、候选上限、一次扩展、无标注图片与来源路径。
 * 不调用模型，不写关联。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildVisionTasks, prepareVisionTask, CANDIDATE_LIMIT } from '../ui-vision.js';
import { decodePng } from '../ui.js';
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
const sampleSize = Number(arg('sample', 12));
const includeMatched = args.includes('--include-matched');

function resolveModuleId() {
	if (requestedModule) return requestedModule;
	try {
		const info = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'projects', projectId, 'project.json'), 'utf8'));
		return info.modules?.[0]?.id || 'default';
	} catch {
		return 'default';
	}
}

function digest(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function contained(base, relative) {
	const root = path.resolve(base);
	const file = path.resolve(root, String(relative || ''));
	return file.startsWith(root + path.sep) ? file : '';
}

async function main() {
	const moduleId = resolveModuleId();
	enterModule(moduleId);
	const projectDir = path.join(DATA_ROOT, 'projects', projectId);
	const built = await buildVisionTasks({ dataRoot: DATA_ROOT, projectId, moduleId, options: { includeMatched } });
	const total = built.tasks.length;
	const picks = [];
	if (!total) throw new Error('没有待处理任务');
	const step = Math.max(1, Math.floor(total / sampleSize));
	for (let index = 0; index < total && picks.length < sampleSize; index += step) picks.push(built.tasks[index]);
	const sourceDigests = new Map();
	for (const task of picks) {
		for (const candidate of task.candidates || []) {
			const file = contained(projectDir, candidate.shot);
			if (file && fs.existsSync(file) && !sourceDigests.has(file)) sourceDigests.set(file, digest(file));
		}
	}
	const rows = [];
	for (const task of picks) {
		const prepared = await prepareVisionTask({ dataRoot: DATA_ROOT, projectId, index: built.index, task });
		const problems = [];
		if (prepared.candidates.length > CANDIDATE_LIMIT) problems.push('候选超过上限');
		if (prepared.candidates.some((candidate) => candidate.target?.role === 'board')) problems.push('画板候选占用位置');
		for (const candidate of prepared.candidates) {
			const file = contained(projectDir, candidate.shot);
			if (candidate.asset_status === 'shot' && !file) problems.push('候选截图路径越界');
			else if (candidate.asset_status === 'shot' && !decodePng(file)) problems.push('候选截图不可解码');
		}
		for (const image of prepared.images) {
			const file = contained(projectDir, image.file);
			if (!file) problems.push('图片路径越界');
			else if (!decodePng(file)) problems.push('图片不可解码');
			if (!image.image_id || !image.sha256) problems.push('图片缺少标识或摘要');
			if (image.role === 'control_crop' && image.source_sha256 && sourceDigests.has(contained(projectDir, image.source_file)) &&
				sourceDigests.get(contained(projectDir, image.source_file)) !== image.source_sha256) problems.push('原图在准备期间发生变化');
		}
		rows.push({
			task_id: task.task_id, purpose: task.purpose, text: task.text,
			target: task.target, retrieval: prepared.retrieval,
			candidate_count: prepared.candidates.length,
			candidates: prepared.candidates.map((candidate) => ({
				candidate_id: candidate.candidate_id, ui_id: candidate.ui_id, name: candidate.name,
				role: candidate.role, page: candidate.page, state: candidate.state || '',
				asset_status: candidate.asset_status, origin: candidate.origin,
				shot: candidate.shot, shot_sha256: candidate.shot ? digest(contained(projectDir, candidate.shot) || '') : ''
			})),
			images: prepared.images.map((image) => ({
				image_id: image.image_id, role: image.role, file: image.file, sha256: image.sha256,
				width: image.width, height: image.height, source_sha256: image.source_sha256 || '',
				bounds: image.bounds || null, pad: image.pad ?? null
			})),
			problems
		});
	}
	const unchanged = [...sourceDigests].every(([file, sha]) => fs.existsSync(file) && digest(file) === sha);
	const byStatus = rows.reduce((acc, row) => {
		const key = row.retrieval.status + (row.retrieval.window === 'expanded' ? '/expanded' : '');
		acc[key] = (acc[key] || 0) + 1;
		return acc;
	}, {});
	const report = {
		project_id: projectId, module_id: moduleId || '(auto)',
		generated_at: new Date().toISOString(),
		totals: { tasks: total, skipped: built.skipped.length, sampled: rows.length },
		by_status: byStatus,
		checks: {
			max_candidates: CANDIDATE_LIMIT,
			candidate_limit_ok: rows.every((row) => row.candidate_count <= CANDIDATE_LIMIT),
			board_slots_ok: rows.every((row) => !row.problems.includes('画板候选占用位置')),
			paths_contained: rows.every((row) => !row.problems.some((problem) => problem.includes('路径越界'))),
			images_decodable: rows.every((row) => !row.problems.some((problem) => problem.includes('不可解码'))),
			original_cache_unchanged: unchanged,
			problems: rows.flatMap((row) => row.problems.map((problem) => ({ task_id: row.task_id, problem })))
		},
		tasks: rows
	};
	const dir = path.join(RUN_DIR, 'p2-candidates');
	await fsp.mkdir(dir, { recursive: true });
	const file = path.join(dir, projectId + (moduleId ? '-' + moduleId : '') + '.json');
	await fsp.writeFile(file, JSON.stringify(report, null, 1));
	console.log(JSON.stringify({ file, totals: report.totals, by_status: byStatus, checks: { ...report.checks, problems: report.checks.problems.length } }, null, 1));
	if (!report.checks.candidate_limit_ok || !report.checks.board_slots_ok || !report.checks.paths_contained ||
		!report.checks.images_decodable || !report.checks.original_cache_unchanged) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error?.stack || String(error));
	process.exitCode = 1;
});