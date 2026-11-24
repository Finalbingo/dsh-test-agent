#!/usr/bin/env node
/**
 * 重建 UI 索引（只读设计库，写 ui-index.json）。已冻结版本跳过。
 * 用法：node scripts/ui-rebuild.mjs [--data <dir>] [--project <pid>] [--module <mid>] [--out <json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { enterModule } from '../scope.js';
import { buildIndex } from '../ui.js';
import { isFrozen } from '../package.js';
import { parseArgs, dataRootOf, resolveTargets } from './targets.mjs';

const { values } = parseArgs();
const dataRoot = dataRootOf(values);
const out = values.out || '';
const targets = resolveTargets(dataRoot, { project: values.project || '', module: values.module || '' });
const report = { dataRoot, generatedAt: new Date().toISOString(), modules: [] };
for (const target of targets) {
	enterModule(target.module);
	if (isFrozen(dataRoot, target.project)) {
		report.modules.push({ ...target, skipped: 'frozen' });
		console.log(`${target.project}/${target.module}: 已冻结，跳过`);
		continue;
	}
	const projectDir = path.join(dataRoot, 'projects', target.project);
	try {
		const index = buildIndex(projectDir, target.project, dataRoot);
		report.modules.push({ ...target, objects: index.objects.length, boards: index.boards.length, shots: index.stats.withScreenshot, digest: index.digest.slice(0, 8), failures: (index.stats.failures || []).length });
		console.log(`${target.project}/${target.module}: 对象 ${index.objects.length} · 画板 ${index.boards.length} · 有截图 ${index.stats.withScreenshot} · 失败 ${(index.stats.failures || []).length}`);
	} catch (error) {
		report.modules.push({ ...target, error: String(error?.message || error) });
		console.log(`${target.project}/${target.module}: ${error?.message || error}`);
	}
}
if (out) {
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, JSON.stringify(report, null, 1));
	console.log(`JSON 已写入 ${out}`);
}
