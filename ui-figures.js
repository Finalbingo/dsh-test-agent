/**
 * Figures per purpose: page locator, control locator, zoom, expected state,
 * recovery entry. Each figure carries the stable step / expected ids it was
 * built for, so inserting a step never re-points an old picture.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderVisual } from './case-visuals.js';
import { linkValidity, stateTokens } from './ui.js';

const PURPOSE_ROLE = {
	page: '页面定位',
	control: '操作定位',
	zoom: '控件局部',
	expected: '预期界面参考',
	recovery: '恢复入口',
	reference: '需求参考'
};

export function figureKey(spec) {
	return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

async function digestOf(file) {
	try {
		return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
	} catch {
		return '';
	}
}

async function make(projectDir, spec, produce = true) {
	const id = figureKey(spec);
	const file = path.join('design', 'case-images', id + '.png');
	const target = path.join(projectDir, file);
	if (produce && !existsSync(target)) {
		await fs.mkdir(path.dirname(target), { recursive: true });
		await renderVisual('figure', target, spec);
	}
	return file;
}

/** 目标在截图范围内的归一化框；超出部分记录 partial，不靠 clamp 假装完整。 */
function boundsOf(node, scope) {
	const rawValues = [node?.x, node?.y, node?.w, node?.h, scope?.x, scope?.y, scope?.w, scope?.h];
	if (rawValues.some((value) => value === null || value === undefined || value === '')) return null;
	const [nx, ny, nw, nh, sx, sy, sw, sh] = rawValues.map(Number);
	if (![nx, ny, nw, nh, sx, sy, sw, sh].every(Number.isFinite) || nw <= 0 || nh <= 0 || sw <= 0 || sh <= 0) return null;
	const raw = [(nx - sx) / sw, (ny - sy) / sh, nw / sw, nh / sh];
	const left = Math.max(0, raw[0]);
	const top = Math.max(0, raw[1]);
	const right = Math.min(1, raw[0] + raw[2]);
	const bottom = Math.min(1, raw[1] + raw[3]);
	if (!(right > left && bottom > top)) return null;
	const full = raw[0] >= 0 && raw[1] >= 0 && raw[0] + raw[2] <= 1 && raw[1] + raw[3] <= 1;
	return { bounds: [left, top, right - left, bottom - top], visibility: full ? 'full' : 'partial' };
}

/** 截图依据：自身截图优先；祖先/画板图必须在索引构建时已证明包含关系。 */
function basisOf(index, object) {
	if (!object?.shot) return null;
	const shotNode = object.shot_node || object.n;
	if (shotNode === object.n) return { file: object.shot, node: shotNode, bounds: null, visibility: 'full', scope: null };
	if (!object.shot_scope) return null;
	const [x, y, w, h] = object.shot_scope;
	if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
	return { file: object.shot, node: shotNode, bounds: object.shot_scope, visibility: object.shot_visibility || 'partial', scope: object.shot_scope };
}

export async function figuresForLink(projectDir, index, link, ui = null, options = {}) {
	const produce = options.produce !== false;
	// 显式节点可能不在索引对象里（回设计库查到的），用关联自带的 target 渲染；
	// compact 结构与索引对象字段不同，先归一化。
	const fallback = link.target ? {
		...link.target, id: link.target.ui_id, s: link.target.source, n: link.target.node_id,
		revision: link.target.revision || ''
	} : null;
	const indexed = (index.objects || []).find((entry) => entry.id === link.ui_id);
	const object = ui || (indexed && !indexed.shot && fallback?.shot ? fallback : indexed) || fallback;
	if (!object || !object.id) return [];
	const purpose = link.purpose;
	const role = PURPOSE_ROLE[purpose] || '需求参考';
	const subject = { step_id: link.subject.step_id || '', expected_id: link.subject.expected_id || '' };
	const meta = (basis) => ({
		step_id: subject.step_id, expected_id: subject.expected_id,
		ui_id: object.id, node_id: object.n, revision: object.revision || object.rev || '',
		page: object.page_name, source_id: object.s, state: object.state || '',
		shot_node: basis.shot_node || basis.node, shot_scope: basis.scope || null,
		coords: basis.scope ? 'normalized' : 'full-image',
		visibility: basis.visibility
	});

	let basis = basisOf(index, object);
	// 自身没有可用截图时，只有完整包含目标的画板截图可以降级使用。
	if (!basis) {
		const board = (index.boards || []).find((entry) => entry.id === object.board && entry.source === object.s);
		const ownBoardShot = board?.shot && (!board.shot_node || board.shot_node === board.id);
		if (ownBoardShot) {
			const inside = boundsOf(object, { x: board.x, y: board.y, w: board.width, h: board.height });
			if (inside?.visibility === 'full') {
				basis = { file: board.shot, node: board.id, bounds: inside.bounds, visibility: 'full', scope: inside.bounds, board: true };
			}
		}
	}
	if (!basis) return [];
	const input = path.join(projectDir, basis.file);
	if (!existsSync(input)) return [];
	const spec = { input, stamp: statSync(input).mtimeMs, sha256: await digestOf(input) };
	const inputMeta = meta(basis);

	if (purpose === 'page' || object.role === 'board') {
		if (!basis.bounds) {
			const file = await make(projectDir, spec, produce);
			return [{ ...inputMeta, file, sha256: await digestOf(path.join(projectDir, file)), name: object.name || object.board_name || '页面', role: PURPOSE_ROLE.page, purpose: 'page' }];
		}
		if (basis.visibility !== 'full') return [];
		const file = await make(projectDir, { ...spec, bounds: basis.bounds, crop: true }, produce);
		return [{ ...inputMeta, file, sha256: await digestOf(path.join(projectDir, file)), name: object.name || object.board_name || '页面', role: PURPOSE_ROLE.page, purpose: 'page', bounds: basis.bounds }];
	}

	const figures = [];
	if (!basis.bounds) {
		const file = await make(projectDir, spec, produce);
		figures.push({ ...inputMeta, file, sha256: await digestOf(path.join(projectDir, file)), name: object.name || '控件', role, purpose });
		return figures;
	}
	if (basis.visibility !== 'full' && purpose !== 'reference') return [];
	const [overview, crop] = await Promise.all([
		make(projectDir, { ...spec, bounds: basis.bounds, crop: false }, produce),
		make(projectDir, { ...spec, bounds: basis.bounds, crop: true }, produce)
	]);
	figures.push({ ...inputMeta, file: overview, sha256: await digestOf(path.join(projectDir, overview)), name: object.name || '页面', role, purpose, bounds: basis.bounds });
	figures.push({ ...inputMeta, file: crop, sha256: await digestOf(path.join(projectDir, crop)), name: (object.name || '控件') + '（局部）', role: PURPOSE_ROLE.zoom, purpose: 'zoom', bounds: basis.bounds });
	return figures;
}

/** Attach derived figures to a case. Human figures are kept untouched; stale auto
 * figures are withdrawn, failed renders keep their last known-good picture. */
export async function attachCaseFigures({ projectDir, index, links, caseItem, produce = true, allowedDesigns }) {
	const prior = caseItem.image_refs || [];
	const manual = prior.filter((figure) => figure.manual);
	const priorAuto = prior.filter((figure) => !figure.manual);
	const steps = new Map((caseItem.step_items || []).map((step) => [step.id, step]));
	const expects = new Map((caseItem.expected_items || []).map((entry) => [entry.id, entry]));
	const related = links.items.filter((link) => {
		if (link.subject.kind === 'case_step' && link.subject.id === caseItem.case_id) return steps.has(link.subject.step_id);
		if (link.subject.kind === 'case_expected' && link.subject.id === caseItem.case_id) return expects.has(link.subject.expected_id);
		return false;
	});
	const sameSubject = (figure, link) =>
		figure.ui_id === link.ui_id && figure.purpose === link.purpose &&
		(figure.step_id || '') === (link.subject.step_id || '') &&
		(figure.expected_id || '') === (link.subject.expected_id || '') &&
		(!figure.revision || !link.target?.revision || figure.revision === link.target.revision);
	const results = [];
	const produced = [];
	for (const link of related) {
		const subject = link.subject.kind === 'case_step' ? steps.get(link.subject.step_id) : expects.get(link.subject.expected_id);
		const text = subject?.text || '';
		const base = {
			case_id: caseItem.case_id, link_id: link.link_id, purpose: link.purpose,
			step_id: link.subject.step_id || '', expected_id: link.subject.expected_id || '',
			source: link.target?.source || '', ui_id: link.ui_id || ''
		};
		if (allowedDesigns && (!link.target?.revision || allowedDesigns.get(link.target.source) !== link.target.revision)) {
			results.push({ ...base, status: 'skipped', reason: '关联的设计稿版本不在本轮模块范围内' });
			continue;
		}
		if (link.subject.kind === 'case_step' && subject?.role === 'observe' && link.purpose === 'control') {
			results.push({ ...base, status: 'skipped', reason: '观察步骤应使用对应判据的状态图' });
			continue;
		}
		const validity = linkValidity(link, { index, projectDir, text, states: stateTokens(text) });
		if (!validity.usable) {
			// 旧自动图随无效关联撤下，人工图不受影响。
			results.push({ ...base, status: 'skipped', reason: validity.reasons.join('；'), validity: validity.status });
			continue;
		}
		try {
			const figures = await figuresForLink(projectDir, index, link, null, { produce });
			if (!figures.length) {
				results.push({ ...base, status: 'skipped', reason: '关联有效，但截图依据不足（自身/祖先/画板均未包含目标），待补缓存' });
				produced.push(...priorAuto.filter((figure) => sameSubject(figure, link)));
				continue;
			}
			produced.push(...figures);
			results.push({ ...base, status: 'attached', figures: figures.map((figure) => figure.file) });
		} catch (error) {
			results.push({ ...base, status: 'failed', reason: String(error?.message || error) });
			// 保留上次成功的同目标图片，失败可重试，不清空。
			produced.push(...priorAuto.filter((figure) => sameSubject(figure, link)));
		}
	}
	const seen = new Map();
	for (const figure of produced) {
		// 同一图片用于两个步骤时分别保留引用；去重键包含用例、步骤/预期、用途、关联来源与内容。
		const key = [caseItem.case_id, figure.step_id || '', figure.expected_id || '', figure.purpose || figure.role,
			figure.ui_id || '', figure.revision || '', figure.file].join('|');
		if (!seen.has(key)) seen.set(key, figure);
	}
	const attached = [...seen.values()];
	caseItem.image_refs = [...manual, ...attached];
	attached.results = results;
	return attached;
}

export function figureCoverage(caseItem) {
	const figures = caseItem.image_refs || [];
	const uiRoles = new Set(['页面定位', '操作定位', '控件局部', '预期界面参考', '恢复入口']);
	const ui = figures.filter((figure) => uiRoles.has(figure.role));
	return {
		total: figures.length,
		ui: ui.length,
		byPurpose: ui.reduce((acc, figure) => {
			const key = figure.purpose || figure.role;
			acc[key] = (acc[key] || 0) + 1;
			return acc;
		}, {})
	};
}
