#!/usr/bin/env node
/**
 * 端到端配图验证：按新关联给真实用例增量挂图；人工图保留，
 * 失效的旧自动图撤下，渲染走现有 case-visuals.py。
 * 用法：node scripts/ui-attach.mjs [--data <dataDir>] [--project <pid>] [--module <mid>] [--out <json>] [--dry]
 * --dry 全程只读：不备份、不写 cases.json、不生成 case-images。
 */
import fs from 'node:fs';
import path from 'node:path';
import { enterModule } from '../scope.js';
import { load as loadArtifact, save as saveArtifact, structureCase } from '../artifacts.js';
import { loadIndex, loadLinks } from '../ui.js';
import { attachCaseFigures } from '../ui-figures.js';
import { missingInterfaceFigures } from '../case-visuals.js';
import { isFrozen } from '../package.js';
import { parseArgs, dataRootOf, resolveTargets } from './targets.mjs';

const { values, flags } = parseArgs();
const dataRoot = dataRootOf(values);
const dry = flags.has('dry');
const jsonOut = values.out || '';
const targets = resolveTargets(dataRoot, { project: values.project || '', module: values.module || '' });
const UI_ROLES = new Set(['页面定位', '操作定位', '控件局部', '预期界面参考', '恢复入口', '界面参考']);
const report = { dataRoot, generatedAt: new Date().toISOString(), dry, modules: [] };

for (const { project, module } of targets) {
	enterModule(module);
	if (!dry && isFrozen(dataRoot, project)) {
		console.log(`${project}/${module}: 已冻结，跳过写入`);
		report.modules.push({ project, module, skipped: 'frozen' });
		continue;
	}
	const index = loadIndex(dataRoot, project);
	if (!index.digest) continue;
	const links = loadLinks(dataRoot, project);
	const cases = await loadArtifact(dataRoot, project, 'cases');
	if (!cases.items.length) continue;
	const projectDir = path.join(dataRoot, 'projects', project);
	const before = { figures: 0, ui: 0, gaps: 0, casesWithUi: 0, auto: 0 };
	const after = { figures: 0, ui: 0, gaps: 0, casesWithUi: 0, auto: 0, added: 0, withdrawn: 0, failed: 0 };
	const measure = (item, acc) => {
		const figures = item.image_refs || [];
		acc.figures += figures.length;
		acc.ui += figures.filter((f) => UI_ROLES.has(f.role)).length;
		acc.auto += figures.filter((f) => !f.manual).length;
		acc.gaps += missingInterfaceFigures(item).length;
		if (figures.some((f) => UI_ROLES.has(f.role))) acc.casesWithUi += 1;
	};
	for (const item of cases.items) measure(item, before);
	if (!dry && jsonOut) {
		const backup = path.join(path.dirname(jsonOut), 'backup');
		fs.mkdirSync(backup, { recursive: true });
		fs.copyFileSync(path.join(dataRoot, 'artifacts', project, module, 'cases.json'), path.join(backup, `cases-${project}-${module}.json`));
	}
	for (const item of cases.items) {
		const existing = item.image_refs || [];
		try {
			// 人工图保留；自动图必须重新通过当前关联有效性检查，旧的错误自动图撤回。
			const probe = { ...item, image_refs: existing.filter((f) => f.manual) };
			structureCase(probe);
			const generated = await attachCaseFigures({ projectDir, index, links, caseItem: probe, produce: !dry });
			const manual = existing.filter((f) => f.manual);
			// 同一图片可分别用于步骤和预期（R15）；去重必须看完整引用语义，不能只按文件名。
			const refKey = (figure) => [figure.step_id || '', figure.expected_id || '', figure.purpose || figure.role || '',
				figure.ui_id || '', figure.file].join('|');
			const finalKeys = new Set([...manual, ...generated].map(refKey));
			const known = new Set(existing.map(refKey));
			const additions = generated.filter((f) => !known.has(refKey(f)));
			const withdrawn = existing.filter((f) => !f.manual && !finalKeys.has(refKey(f)));
			item.image_refs = [...manual, ...generated];
			after.added += additions.length;
			after.withdrawn += withdrawn.length;
		} catch {
			after.failed += 1;
		}
		measure(item, after);
	}
	if (!dry) {
		const { items, version, updatedAt, digest, ...meta } = cases;
		await saveArtifact(dataRoot, project, 'cases', { version, items, meta });
	}
	report.modules.push({ project, module, before, after });
	console.log(`## ${project}/${module}${dry ? '（dry-run 只读）' : ''}`);
	console.log(`挂图新增 ${after.added} · 撤回旧自动图 ${after.withdrawn} · 失败用例 ${after.failed}`);
	console.log(`图总数 ${before.figures} → ${after.figures} · UI图 ${before.ui} → ${after.ui} · 有UI图用例 ${before.casesWithUi} → ${after.casesWithUi}`);
	console.log(`旧规则缺口 ${before.gaps} → ${after.gaps}`);
}
if (jsonOut) {
	fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
	fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
	console.log(`\nJSON 已写入 ${jsonOut}`);
}
