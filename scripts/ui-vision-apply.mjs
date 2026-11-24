/**
 * 将一个运行目录中的视觉结果写入 ui-links.json，并触发 derive 传播。
 * 默认只写通过闸门的结果；--dry-run 只计算不落盘。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { applyVisionResults } from '../ui-vision-apply.js';
import { enterModule } from '../scope.js';

const DATA_ROOT = process.env.CTS_DATA_ROOT || '/Users/Admin/Documents/CTS';
const RUN_ROOT = process.env.CTS_RUN_DIR || '/Users/Admin/Documents/CTS/reports/ui-vision-ling-20261117-151738';
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
	const index = args.indexOf('--' + name);
	return index >= 0 ? args[index + 1] : fallback;
};
const projectId = arg('project', 'P-v5-test');
const moduleId = arg('module', '');
const runArg = arg('run', '');
const dryRun = args.includes('--dry-run');
const noPropagate = args.includes('--no-propagate');

function resolveModuleId() {
	if (moduleId) return moduleId;
	try {
		const info = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'projects', projectId, 'project.json'), 'utf8'));
		return info.modules?.[0]?.id || 'default';
	} catch {
		return 'default';
	}
}

function latestRun() {
	const root = path.join(RUN_ROOT, 'vision-runs');
	const dirs = fs.readdirSync(root)
		.map((name) => path.join(root, name))
		.filter((dir) => fs.existsSync(path.join(dir, 'results.jsonl')))
		.sort();
	return dirs.at(-1) || '';
}

async function main() {
	const runDir = runArg ? path.resolve(runArg) : latestRun();
	const resultsFile = path.join(runDir, 'results.jsonl');
	if (!fs.existsSync(resultsFile)) throw new Error('找不到结果文件：' + resultsFile);
	const results = (await fsp.readFile(resultsFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
	const resolvedModule = resolveModuleId();
	enterModule(resolvedModule);
	const solved = await applyVisionResults({
		dataRoot: DATA_ROOT, projectId, moduleId: resolvedModule, results,
		options: { save: !dryRun, propagate: !noPropagate }
	});
	const outDir = path.join(RUN_ROOT, 'vision-apply');
	await fsp.mkdir(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const report = {
		project_id: projectId, module_id: resolvedModule, source_run: runDir, dry_run: dryRun,
		applied: solved.applied, skipped: solved.skipped, pending: solved.pending,
		propagation: solved.propagation,
		stats: solved.stats || { applied: solved.applied.length, skipped: solved.skipped.length, pending: solved.pending.length }
	};
	const file = path.join(outDir, `apply-${stamp}.json`);
	await fsp.writeFile(file, JSON.stringify(report, null, 1));
	console.log('applied', report.stats.applied, 'skipped', report.stats.skipped, 'pending', report.stats.pending, 'propagated', report.stats.propagated || 0, 'dry', dryRun);
	console.log(report.file || file);
	if (solved.applied.length) for (const row of solved.applied) console.log('  +', row.key, '->', row.ui_id, row.assertions.join(','));
	if (solved.pending.length) for (const row of solved.pending) console.log('  ?', row.key, row.reason);
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });