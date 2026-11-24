#!/usr/bin/env node
/**
 * 视觉匹配改造基线（只读）：逐项目/模块记录需求、测试点、用例、UI 操作/预期、
 * 关联状态、人工决定、图片引用与文件健康度。
 *
 * 用法：
 *   node scripts/ui-vision-baseline.mjs [--data <dataDir>] [--project <pid>] [--module <mid>]
 *     [--out <json>] [--images]
 *
 * --images 由 scripts/verify-pngs.py 单独执行；本脚本只把图片清单写入 detail，
 * 不代替真实解码结论。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { enterModule } from '../scope.js';
import { load as loadArtifact, structureCase } from '../artifacts.js';
import { loadIndex, loadLinks, linkValidity, uiApplicability, stateTokens, coverage } from '../ui.js';
import { isFrozen, currentPackage } from '../package.js';
import { parseArgs, dataRootOf, resolveTargets } from './targets.mjs';

const { values, flags } = parseArgs();
const dataRoot = dataRootOf(values);
const out = values.out || values.json || '';
const wantImages = flags.has('images');
const targets = resolveTargets(dataRoot, { project: values.project || '', module: values.module || '' });

const roleLooksUI = (role) => ['页面定位', '操作定位', '控件局部', '预期界面参考', '恢复入口', '界面参考', '需求参考'].includes(role);

function figureStep(figure, step, order) {
	return figure.step_id ? figure.step_id === step.id : !figure.expected_id && Number(figure.step) === order;
}

function sha256File(file) {
	try {
		return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
	} catch {
		return '';
	}
}

const report = {
	dataRoot,
	generatedAt: new Date().toISOString(),
	mode: 'read-only',
	modules: [],
	images: null
};
const imageFiles = new Map();

for (const { project, module } of targets) {
	enterModule(module);
	const index = loadIndex(dataRoot, project);
	const [facts, contracts, points, cases, features] = await Promise.all(
		['facts', 'contracts', 'points', 'cases', 'features'].map((kind) => loadArtifact(dataRoot, project, kind)));
	const links = loadLinks(dataRoot, project);
	const projectDir = path.join(dataRoot, 'projects', project);
	const packageInfo = currentPackage(dataRoot, project);
	const entry = {
		project, module,
		projectName: (() => {
			try { return JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')).name || ''; } catch { return ''; }
		})(),
		frozen: isFrozen(dataRoot, project),
		package: packageInfo ? { package_id: packageInfo.package_id, version: packageInfo.version, status: packageInfo.status } : null,
		versions: {
			facts: facts.version || 0, contracts: contracts.version || 0,
			points: points.version || 0, cases: cases.version || 0, features: features.version || 0
		},
		counts: {
			facts: facts.items.length, contracts: contracts.items.length,
			points: points.items.length, cases: cases.items.length, features: features.items.length
		},
		uiIndex: index.digest ? {
			version: index.version, digest: index.digest.slice(0, 16), builtAt: index.builtAt,
			objects: index.objects?.length || 0, boards: index.boards?.length || 0,
			pages: index.pages?.length || 0,
			withScreenshot: index.stats?.withScreenshot || 0,
			boardsWithScreenshot: index.stats?.boardsWithScreenshot || 0,
			failures: index.stats?.failures || [],
			cacheBySource: index.stats?.cacheBySource || []
		} : null,
		sources: (index.sources || []).map((source) => ({ id: source.id, name: source.name, revision: source.revision, pages: source.pages })),
		applicability: { steps: { required: 0, not_applicable: 0, unknown: 0 }, expected: { required: 0, not_applicable: 0, unknown: 0 } },
		links: {
			total: links.items.length,
			withTarget: 0, withoutTarget: 0,
			byStatus: {}, byPurpose: {}, byKind: {},
			humanConfirmed: 0, humanRejected: 0, manualOther: 0,
			valid: 0, invalid: 0, validByPurpose: {},
			states: {}, reasons: {}
		},
		figures: {
			casesWithFigures: 0, total: 0, uiRoles: 0, manual: 0,
			validSubjectLink: 0, invalidOrStale: 0,
			byPurpose: {}, byRole: {}
		},
		coverage: null,
		imageInventory: { uniqueShots: 0, uniqueFigures: 0, missing: 0, missingSamples: [] }
	};
	const bySubject = new Map();
	for (const link of links.items) {
		const key = [link.subject?.kind, link.subject?.id, link.subject?.step_id || '', link.subject?.expected_id || ''].join('|');
		if (!bySubject.has(key)) bySubject.set(key, []);
		bySubject.get(key).push(link);
	}
	const bump = (object, key) => { object[key || 'unknown'] = (object[key || 'unknown'] || 0) + 1; };
	const reasonCode = (result) => {
		if (result.usable) return 'valid';
		return result.status || (result.reasons?.[0] || 'unknown').slice(0, 40);
	};
	for (const link of links.items) {
		bump(entry.links.byStatus, link.status);
		bump(entry.links.byPurpose, link.purpose);
		bump(entry.links.byKind, link.subject?.kind);
		if (link.ui_id && link.target) entry.links.withTarget += 1;
		else entry.links.withoutTarget += 1;
		if (link.method === 'manual' || link.status === 'confirmed' || link.status === 'rejected') {
			if (link.status === 'confirmed') entry.links.humanConfirmed += 1;
			else if (link.status === 'rejected') entry.links.humanRejected += 1;
			else entry.links.manualOther += 1;
		}
		const text = link.subject?.name || '';
		const validity = linkValidity(link, { index, projectDir, text, states: stateTokens(text) });
		if (validity.usable) {
			entry.links.valid += 1;
			bump(entry.links.validByPurpose, link.purpose);
		} else {
			entry.links.invalid += 1;
			bump(entry.links.states, validity.status);
			bump(entry.links.reasons, reasonCode(validity));
		}
		const shot = link.target?.shot;
		if (shot && !imageFiles.has(path.join(projectDir, shot))) imageFiles.set(path.join(projectDir, shot), { project, module, kind: 'link-shot' });
	}
	const validLinks = new Map();
	for (const link of links.items) {
		const text = link.subject?.name || '';
		const validity = linkValidity(link, { index, projectDir, text, states: stateTokens(text) });
		validLinks.set(link.link_id, validity);
	}

	for (const item of cases.items) {
		if (!item.step_items || !item.expected_items) structureCase(item);
		const prior = [item.title || ''];
		for (const [order, step] of (item.step_items || []).entries()) {
			const applicability = uiApplicability(step.text, prior.join(' '));
			entry.applicability.steps[applicability.level] = (entry.applicability.steps[applicability.level] || 0) + 1;
			prior.push(step.text || '');
			const subjectLinks = bySubject.get(['case_step', item.case_id, step.id, ''].join('|')) || [];
			for (const link of subjectLinks) {
				const shot = link.target?.shot;
				if (shot) imageFiles.set(path.join(projectDir, shot), { project, module, kind: 'object-shot' });
			}
			const figures = (item.image_refs || []).filter((figure) => roleLooksUI(figure.role) &&
				figure.role !== '预期界面参考' && figureStep(figure, step, order + 1));
			for (const figure of figures) {
				if (figure.file) imageFiles.set(path.join(projectDir, figure.file), { project, module, kind: 'case-figure' });
			}
		}
		const stepText = (item.step_items || []).map((step) => step.text || '').join(' ');
		for (const expected of item.expected_items || []) {
			const applicability = uiApplicability(expected.text, `${item.title || ''} ${stepText}`);
			entry.applicability.expected[applicability.level] = (entry.applicability.expected[applicability.level] || 0) + 1;
			const subjectLinks = bySubject.get(['case_expected', item.case_id, '', expected.id].join('|')) || [];
			for (const link of subjectLinks) {
				const shot = link.target?.shot;
				if (shot) imageFiles.set(path.join(projectDir, shot), { project, module, kind: 'expected-shot' });
			}
			const figures = (item.image_refs || []).filter((figure) => figure.expected_id === expected.id &&
				(figure.role === '预期界面参考' || figure.purpose === 'expected'));
			for (const figure of figures) {
				if (figure.file) imageFiles.set(path.join(projectDir, figure.file), { project, module, kind: 'expected-figure' });
			}
		}
		const figures = item.image_refs || [];
		if (figures.length) entry.figures.casesWithFigures += 1;
		for (const figure of figures) {
			entry.figures.total += 1;
			bump(entry.figures.byPurpose, figure.purpose);
			bump(entry.figures.byRole, figure.role);
			if (roleLooksUI(figure.role)) entry.figures.uiRoles += 1;
			if (figure.manual) entry.figures.manual += 1;
			const subjectKind = figure.expected_id ? 'case_expected' : figure.step_id ? 'case_step' : '';
			const subjectId = figure.expected_id
				? ['case_expected', item.case_id, '', figure.expected_id].join('|')
				: ['case_step', item.case_id, figure.step_id || '', ''].join('|');
			const candidates = subjectKind ? (bySubject.get(subjectId) || []).filter((link) => link.purpose === figure.purpose) : [];
			const valid = candidates.some((link) => validLinks.get(link.link_id)?.usable && link.ui_id === figure.ui_id);
			if (valid) entry.figures.validSubjectLink += 1;
			else entry.figures.invalidOrStale += 1;
		}
	}
	try {
		entry.coverage = coverage(dataRoot, project, { cases, points, contracts, features, links }).stats;
	} catch (error) {
		entry.coverage = { error: String(error?.message || error) };
	}
	const uniqueShots = new Set();
	const uniqueFigures = new Set();
	for (const [file, meta] of imageFiles) {
		if (meta.kind === 'case-figure' || meta.kind === 'expected-figure') uniqueFigures.add(file);
		else uniqueShots.add(file);
	}
	entry.imageInventory.uniqueShots = uniqueShots.size;
	entry.imageInventory.uniqueFigures = uniqueFigures.size;
	for (const file of [...uniqueShots, ...uniqueFigures]) {
		if (fs.existsSync(file)) continue;
		entry.imageInventory.missing += 1;
		if (entry.imageInventory.missingSamples.length < 20) entry.imageInventory.missingSamples.push(path.relative(projectDir, file));
	}
	report.modules.push(entry);
	report.images ||= {};
	report.images[`${project}/${module}`] = {
		shots: [...uniqueShots].map((file) => ({ file: path.relative(projectDir, file), sha256: sha256File(file), bytes: (() => { try { return fs.statSync(file).size; } catch { return 0; } })() })),
		figures: [...uniqueFigures].map((file) => ({ file: path.relative(projectDir, file), sha256: sha256File(file), bytes: (() => { try { return fs.statSync(file).size; } catch { return 0; } })() }))
	};
}
if (!wantImages) delete report.images;

const fmt = (object, keys = []) => keys.map((key) => `${key}=${object?.[key] ?? 0}`).join(' ');
console.log(`# 视觉匹配只读基线 ${report.generatedAt}`);
for (const entry of report.modules) {
	console.log(`\n## ${entry.project} / ${entry.module}${entry.projectName ? `（${entry.projectName}）` : ''}${entry.frozen ? ' · 已冻结' : ''}`);
	console.log(`版本 ${JSON.stringify(entry.versions)} · 数量 ${JSON.stringify(entry.counts)}`);
	console.log(`UI索引 ${entry.uiIndex ? `对象 ${entry.uiIndex.objects} / 截图 ${entry.uiIndex.withScreenshot} / 画板截图 ${entry.uiIndex.boardsWithScreenshot} / ${entry.uiIndex.digest}` : '无'}`);
	console.log(`适用性 步骤 ${JSON.stringify(entry.applicability.steps)} · 预期 ${JSON.stringify(entry.applicability.expected)}`);
	console.log(`关联 ${entry.links.total}（有目标 ${entry.links.withTarget} · 有效 ${entry.links.valid} · 无效 ${entry.links.invalid}）`);
	console.log(`  状态 ${JSON.stringify(entry.links.byStatus)}`);
	console.log(`  无效分类 ${JSON.stringify(entry.links.states)}`);
	console.log(`  人工 确认 ${entry.links.humanConfirmed} · 拒绝 ${entry.links.humanRejected}`);
	console.log(`配图 ${entry.figures.total}（UI ${entry.figures.uiRoles} · 人工 ${entry.figures.manual} · 关联有效 ${entry.figures.validSubjectLink} · 无效/过期 ${entry.figures.invalidOrStale}）`);
	console.log(`图片清单 对象/关联图 ${entry.imageInventory.uniqueShots} · 配图 ${entry.imageInventory.uniqueFigures} · 缺失 ${entry.imageInventory.missing}`);
	console.log(`覆盖 ${entry.coverage ? JSON.stringify(entry.coverage) : '无'}`);
}
if (out) {
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, JSON.stringify(report, null, 1));
	console.log(`\nJSON 已写入 ${out}`);
}