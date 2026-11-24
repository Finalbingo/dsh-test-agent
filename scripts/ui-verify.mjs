#!/usr/bin/env node
/**
 * 阶段6 验证：对真实项目重跑 UI 关联 derive，输出方案要求的七类计数、
 * 逐步骤/逐预期覆盖率、幂等性与跨项目串图检查。
 * 用法：node scripts/ui-verify.mjs [--data <dataDir>] [--project <pid>] [--module <mid>] [--out <json>] [--dry]
 * 默认重写 ui-links.json（先备份到输出目录）；--dry 全程只读，不改任何项目文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { enterModule } from '../scope.js';
import { load as loadArtifact } from '../artifacts.js';
import { derive, loadLinks, linksFile, loadIndex, coverage } from '../ui.js';
import { isFrozen } from '../package.js';
import { parseArgs, dataRootOf, resolveTargets } from './targets.mjs';

const { values, flags } = parseArgs();
const dataRoot = dataRootOf(values);
const jsonOut = values.out || values.json || '';
const dry = flags.has('dry');
const targets = resolveTargets(dataRoot, { project: values.project || '', module: values.module || '' });

const report = { dataRoot, generatedAt: new Date().toISOString(), dry, modules: [] };
const backedUp = new Set();
for (const { project, module } of targets) {
	enterModule(module);
	if (!dry && isFrozen(dataRoot, project)) {
		console.log(`${project}/${module}: 已冻结，跳过写入`);
		report.modules.push({ project, module, skipped: 'frozen' });
		continue;
	}
	const index = loadIndex(dataRoot, project);
	if (!index.digest) { console.log(`${project}/${module}: 无 UI 索引，跳过`); continue; }
	const file = linksFile(dataRoot, project);
	// 只备份进场前的原始关联；幂等对比的两次 derive 不能互相污染起点。
	if (!dry && fs.existsSync(file) && !backedUp.has(file)) {
		const dir = jsonOut ? path.dirname(jsonOut) : path.join(dataRoot, 'reports');
		const backup = path.join(dir, 'backup');
		fs.mkdirSync(backup, { recursive: true });
		fs.copyFileSync(file, path.join(backup, `ui-links-${project}-${module}.json`));
		backedUp.add(file);
	}
	const [facts, contracts, points, cases, features] = await Promise.all(
		['facts', 'contracts', 'points', 'cases', 'features'].map((kind) => loadArtifact(dataRoot, project, kind)));
	const documents = { facts, contracts, points, cases, features };
	const first = derive(dataRoot, project, documents, dry ? { save: false } : undefined);
	const second = dry
		? derive(dataRoot, project, documents, { links: first.document, save: false })
		: derive(dataRoot, project, documents);
	const links = second.document.items;
	const objectIds = new Set(index.objects.map((object) => object.id));
	const counts = { needsUi: links.length, correct: 0, partial: 0, ambiguous: 0, missing: 0, missingAsset: 0, stale: 0, review: 0, confirmed: 0, inherited: 0 };
	let crossProject = 0;
	const byKind = {};
	const kindCounts = {};
	for (const item of links) {
		byKind[item.subject.kind] = (byKind[item.subject.kind] || 0) + 1;
		const kc = kindCounts[item.subject.kind] ||= { total: 0, correct: 0, partial: 0, ambiguous: 0, missing: 0, stale: 0 };
		kc.total += 1;
		if (item.ui_id && !objectIds.has(item.ui_id) && !(item.explicit || item.reason?.startsWith('原文明确指定设计节点'))) crossProject += 1;
		if (item.method === 'inherit') counts.inherited += 1;
		if (item.status === 'confirmed') { counts.confirmed += 1; counts.correct += 1; kc.correct += 1; continue; }
		if (item.status === 'stale') { counts.stale += 1; kc.stale += 1; continue; }
		if (item.status === 'review' || item.needs_review) { counts.review += 1; counts.partial += 1; kc.partial += 1; continue; }
		if (item.status === 'ambiguous') { counts.ambiguous += 1; kc.ambiguous += 1; continue; }
		if (item.status === 'missing_asset') { counts.missingAsset += 1; counts.partial += 1; kc.partial += 1; continue; }
		if (item.ui_id && item.target?.shot) { counts.correct += 1; kc.correct += 1; }
		else if (item.ui_id) { counts.missingAsset += 1; counts.partial += 1; kc.partial += 1; }
		else { counts.missing += 1; kc.missing += 1; }
	}
	const cov = coverage(dataRoot, project, { cases, points, contracts, ...(dry ? { links: second.document } : {}) }).stats;
	const idempotent = first.document.items.length === second.document.items.length &&
		JSON.stringify(first.document.items.map((item) => [item.link_id, item.ui_id, item.status])) ===
		JSON.stringify(second.document.items.map((item) => [item.link_id, item.ui_id, item.status]));
	const entry = {
		project, module, dry, indexDigest: index.digest.slice(0, 8),
		indexObjects: index.objects.length, indexShots: index.stats.withScreenshot,
		cacheFailures: (index.stats.failures || []).length,
		cacheBySource: index.stats.cacheBySource || [],
		documents: { facts: facts.items.length, contracts: contracts.items.length, points: points.items.length, cases: cases.items.length },
		linksByKind: byKind, kindCounts, counts, coverage: cov, idempotent, crossProject,
		deriveStats: second.stats
	};
	report.modules.push(entry);
	console.log(`\n## ${project} / ${module}${dry ? '（dry-run 只读）' : ''}`);
	console.log(`索引 ${entry.indexObjects} 对象 / ${entry.indexShots} 截图 · 关联 ${counts.needsUi} 条 ${JSON.stringify(byKind)}`);
	console.log(`七类计数：正确 ${counts.correct}（含人工 ${counts.confirmed}）· 部分 ${counts.partial} · 待判断 ${counts.ambiguous} · 缺素材 ${counts.missing} · 缺截图 ${counts.missingAsset} · 过期 ${counts.stale} · 待复核 ${counts.review}`);
	console.log(`继承 ${counts.inherited} · 幂等 ${idempotent} · 跨项目串图 ${crossProject}`);
	console.log(`覆盖：UI步骤 ${cov.stepsCovered}/${cov.uiSteps} · 预期 ${cov.expectedCovered}/${cov.expectedNeeded} · ambiguous ${cov.ambiguous}`);
	for (const [kind, kc] of Object.entries(kindCounts)) console.log(`  ${kind}: 正确 ${kc.correct} / 部分 ${kc.partial} / 待判断 ${kc.ambiguous} / 缺素材 ${kc.missing} / 过期 ${kc.stale} （共 ${kc.total}）`);
}
if (jsonOut) {
	fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
	fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
	console.log(`\nJSON 已写入 ${jsonOut}`);
}