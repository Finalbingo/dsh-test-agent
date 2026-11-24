#!/usr/bin/env node
/**
 * UI 绑定改造前基线（只读）：逐项目/模块盘点配图缺口并归因。
 * 用法：node scripts/ui-baseline.mjs [--data <dataDir>] [--project <pid>] [--module <mid>] [--out <json>]
 * 缺口归因：no_binding（控件没绑定）/ node_not_found（设计里找不到）/
 * screenshot_missing（找到节点但没截图）/ attachable（素材齐全但没挂上）/
 * state_material_missing（预期状态无素材）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { enterModule } from '../scope.js';
import { load as loadArtifact } from '../artifacts.js';
import { loadBindings, stats as bindingStats, extractControls } from '../bindings.js';
import { missingInterfaceFigures } from '../case-visuals.js';
import { layerSources, exactDesignNodes, previewFile, previewNode } from '../design.js';
import { loadIndex as loadUiIndex } from '../ui.js';
import { parseArgs, dataRootOf, resolveTargets } from './targets.mjs';

const { values } = parseArgs();
const dataRoot = dataRootOf(values);
const jsonOut = values.out || values.json || '';
const onlyProject = values.project || '';
const onlyModule = values.module || '';

const UI_ROLES = new Set(['页面定位', '操作定位', '控件局部', '预期界面参考', '恢复入口', '界面参考']);
const projectsDir = path.join(dataRoot, 'projects');
const artifactsDir = path.join(dataRoot, 'artifacts');

function classifyGap(item, gap, bindings, sources, projectDir) {
	const text = gap.role === '预期界面参考'
		? String(item.expected || '').split('\n').filter((line) => !gap.step || Number(line.match(/^\s*S(\d+)[.-]/i)?.[1]) === gap.step).join(' ')
		: String(item.steps?.[gap.step - 1] || '');
	const names = [...new Set(Array.from(text.matchAll(/[【「“]([^】」”]{2,80})[】」”]/g), (m) => m[1].trim()))];
	if (names.length === 0) return 'no_named_object';
	const bound = (bindings?.items || []).some((b) => b.kind === 'control' && b.status === 'bound' && b.target &&
		names.some((name) => b.subject.name === name || name.includes(b.subject.name) || b.subject.name.includes(name)));
	let foundNode = false;
	let cachedShot = false;
	for (const name of names) {
		for (const source of sources) {
			const nodes = exactDesignNodes(source, [name]);
			if (!nodes.length) continue;
			foundNode = true;
			for (const node of nodes) {
				const preview = previewNode(source, node.node_id || node.id);
				if (!preview) continue;
				const { cached } = previewFile(projectDir, source, preview.layer.id);
				if (cached) cachedShot = true;
			}
		}
	}
	if (cachedShot) return 'attachable';
	if (foundNode) return 'screenshot_missing';
	if (bound) return 'binding_target_unresolved';
	if (gap.role === '预期界面参考') return 'state_material_missing';
	return 'node_not_found';
}

const report = { dataRoot, generatedAt: new Date().toISOString(), modules: [] };
const targets = resolveTargets(dataRoot, { project: onlyProject, module: onlyModule });
for (const { project: projectId, module: moduleId } of targets) {
	const projectDir = path.join(projectsDir, projectId);
	if (!fs.existsSync(path.join(artifactsDir, projectId, moduleId, 'cases.json'))) continue;
	enterModule(moduleId);
	const cases = await loadArtifact(dataRoot, projectId, 'cases');
	const facts = await loadArtifact(dataRoot, projectId, 'facts');
	const bindings = loadBindings(dataRoot, projectId);
	let sources = [];
	try { sources = layerSources(dataRoot, projectId); } catch { /* no design */ }
	const entry = {
		project: projectId, module: moduleId,
		cases: cases.items.length,
		figures: { total: 0, ui: 0, cards: 0, casesWithUi: 0, casesWithAny: 0 },
		gaps: { total: 0, byReason: {}, samples: [] },
		bindings: bindingStats(bindings),
		controlsExtracted: extractControls(facts.items).length,
		controlCapHit: extractControls(facts.items).length >= 60,
		uiIndex: null,
		designSources: sources.map((source) => ({ id: source.id, name: source.name, revision: source.revision }))
	};
	const index = loadUiIndex(dataRoot, projectId);
	if (index.digest) entry.uiIndex = { objects: index.objects.length, withScreenshot: index.stats.withScreenshot, boards: index.boards.length, digest: index.digest.slice(0, 8) };
	for (const item of cases.items) {
		const figures = item.image_refs || [];
		const ui = figures.filter((figure) => UI_ROLES.has(figure.role));
		entry.figures.total += figures.length;
		entry.figures.ui += ui.length;
		entry.figures.cards += figures.length - ui.length;
		if (figures.length) entry.figures.casesWithAny += 1;
		if (ui.length) entry.figures.casesWithUi += 1;
		for (const gap of missingInterfaceFigures(item)) {
			entry.gaps.total += 1;
			const reason = classifyGap(item, gap, bindings, sources, projectDir);
			entry.gaps.byReason[reason] = (entry.gaps.byReason[reason] || 0) + 1;
			if (entry.gaps.samples.length < 12) entry.gaps.samples.push({ case_id: item.case_id, step: gap.step, role: gap.role, reason });
		}
	}
	report.modules.push(entry);
}

const totals = report.modules.reduce((acc, entry) => {
	acc.cases += entry.cases;
	acc.gaps += entry.gaps.total;
	acc.uiFigures += entry.figures.ui;
	acc.cardFigures += entry.figures.cards;
	for (const [reason, count] of Object.entries(entry.gaps.byReason)) acc.byReason[reason] = (acc.byReason[reason] || 0) + count;
	return acc;
}, { cases: 0, gaps: 0, uiFigures: 0, cardFigures: 0, byReason: {} });
report.totals = totals;

console.log(`# UI 绑定基线 ${report.generatedAt}`);
for (const entry of report.modules) {
	console.log(`\n## ${entry.project} / ${entry.module}`);
	console.log(`用例 ${entry.cases} · 图 ${entry.figures.total}（UI ${entry.figures.ui} / 卡片 ${entry.figures.cards}）· 有UI图用例 ${entry.figures.casesWithUi}`);
	console.log(`缺口 ${entry.gaps.total}：${JSON.stringify(entry.gaps.byReason)}`);
	console.log(`绑定：控件 ${entry.bindings.controls}（绑定率 ${entry.bindings.controlRate}%）ambiguous ${entry.bindings.ambiguous} unmatched ${entry.bindings.unmatched} · 提取控件 ${entry.controlsExtracted}${entry.controlCapHit ? '（触顶60）' : ''}`);
	console.log(`UI索引：${entry.uiIndex ? JSON.stringify(entry.uiIndex) : '未建立'} · 设计源 ${entry.designSources.length}`);
}
console.log(`\n## 汇总\n${JSON.stringify(totals, null, 1)}`);
if (jsonOut) {
	fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
	fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
	console.log(`\nJSON 已写入 ${jsonOut}`);
}