import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { exactDesignNodes, layerSources, previewFile, previewNode } from './design.js';
import { stepIds } from './steps.js';
import { currentConfig } from './scope.js';

const bundledPython = path.join(process.env.HOME || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3');

/** 与 ui.js 保持同一状态词表；最长优先，避免“未激活”被识别成“激活”。 */
const STATE_WORDS = /(未选中|未激活|未开启|不可用|加载中|选中|默认|禁用|置灰|变灰|开启|关闭|打开|成功|失败|错误|正常|异常|高亮|激活|灰)/g;

export function designEvidenceApplicable() {
	const capabilities = currentConfig().capabilities;
	return !Array.isArray(capabilities) || capabilities.includes('design');
}

export function renderVisual(mode, target, spec) {
	const python = existsSync(bundledPython) ? bundledPython : 'python3';
	return new Promise((resolve, reject) => {
		const child = spawn(python, [path.join(import.meta.dirname, 'case-visuals.py'), mode, target], {
			stdio: ['pipe', 'ignore', 'pipe'], timeout: 120000
		});
		let stderr = '';
		child.stderr.on('data', (data) => { stderr += data; });
		child.on('error', reject);
		child.stdin.on('error', reject);
		child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || '图片处理失败')));
		child.stdin.end(JSON.stringify(spec));
	});
}

export function caseVisuals(dataRoot, projectId, projectDir, bindings, allowedMcpSources) {
	const sources = layerSources(dataRoot, projectId, false, allowedMcpSources).filter((source) =>
		!source.store || !allowedMcpSources || allowedMcpSources.get(source.id) === source.revision);
	const jobs = new Map();
	const namedNodes = new Map();
	const previewNodes = new Map();
	const preview = (source, id) => {
		const key = JSON.stringify([source.id, id]);
		if (!previewNodes.has(key)) previewNodes.set(key, previewNode(source, id));
		return previewNodes.get(key);
	};
	async function make(spec) {
		const id = crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
		const file = path.join('design', 'case-images', id + '.png');
		const target = path.join(projectDir, file);
		if (!jobs.has(id)) {
			jobs.set(id, (async () => {
				if (!existsSync(target)) {
					await fs.mkdir(path.dirname(target), { recursive: true });
					await renderVisual('figure', target, spec);
				}
				return file;
			})().catch((error) => {
				jobs.delete(id);
				throw error;
			}));
		}
		return jobs.get(id);
	}

	function resolveNode(target) {
		const parts = String(target.node_id || '').split('::');
		const nodeId = parts.at(-1);
		const sourceId = target.source_id || (parts.length > 1 ? parts[0] : '');
		const hits = sources.filter((source) => !sourceId || source.id === sourceId || source.name === sourceId)
			.map((source) => ({ source, found: preview(source, nodeId) }))
			.filter((entry) => entry.found);
		if (hits.length !== 1) return null;
		const [{ source, found: { node, layer } }] = hits;
		const legacy = !sources.some((other) => other.id !== source.id && preview(other, layer.id));
		const { cached, file } = previewFile(projectDir, source, layer.id, legacy);
		return { source, node, layer, file, cached: cached && layer.width > 0 && layer.height > 0 };
	}

	async function forNode(target, role, step = 0) {
		const resolved = resolveNode(target);
		if (!resolved?.cached) return [];
		const { source, node, layer, file } = resolved;
		const name = target.name || node.name || node.id;
		const meta = { name, role, step, node_id: node.id, layer_id: layer.id, source_id: source.id, revision: source.revision };
		const left = Math.max(0, (node.x - layer.x) / layer.width);
		const top = Math.max(0, (node.y - layer.y) / layer.height);
		const right = Math.min(1, (node.x + node.width - layer.x) / layer.width);
		const bottom = Math.min(1, (node.y + node.height - layer.y) / layer.height);
		const spec = { input: file, stamp: statSync(file).mtimeMs };
		if (node.id === layer.id || !(right > left && bottom > top)) return [{ ...meta, file: await make(spec) }];
		spec.bounds = [left, top, right - left, bottom - top];
		const [overview, crop] = await Promise.all([make({ ...spec, crop: false }), make({ ...spec, crop: true })]);
		return [{ ...meta, file: overview }, { ...meta, name: name + '（局部）', file: crop }];
	}

	function candidates(point, item, gap) {
		const text = gap.role === '预期界面参考' ? figureExpected(item, gap.step) : item.steps?.[gap.step - 1];
		const names = [...new Set(Array.from(String(text || '').matchAll(/[【「“]([^】」”]{2,80})[】」”]/g), (m) => m[1].trim()))].slice(0, 8);
		// 预期提到状态时，把「名称+状态」的变体名也纳入检索，而不是只找整板。
		const states = gap.role === '预期界面参考' ? [...new Set(Array.from(String(text || '').matchAll(STATE_WORDS), (m) => m[1]))].slice(0, 2) : [];
		const searchNames = states.length ? [...names, ...names.flatMap((name) => states.flatMap((state) => [`${name}-${state}`, `${name}${state}`, `${name}_${state}`]))].slice(0, 24) : names;
		const related = (bindings?.items || []).filter((b) => b.kind === 'control' && b.target && b.status === 'bound' &&
			b.subject.fact_ids?.some((id) => point?.fact_refs?.includes(id)) && names.includes(b.subject.name));
		const hits = searchNames.flatMap((name) => {
			if (!namedNodes.has(name)) namedNodes.set(name, sources.flatMap((source) => exactDesignNodes(source, [name])
				.map((node) => ({ ...node, source_id: source.id, reason: '图层名称与步骤一致' }))));
			return namedNodes.get(name);
		});
		if (gap.role === '操作定位') for (const binding of related) {
			hits.unshift({ ...binding.target, name: binding.subject.name, reason: '已确认的需求控件绑定' });
		}
		const seen = new Set();
		return hits.flatMap((hit) => {
			const key = hit.source_id + '/' + hit.node_id;
			if (seen.has(key)) return [];
			seen.add(key);
			const resolved = resolveNode(hit);
			if (!resolved) return [];
			return [{ ...hit, document: resolved.source.name, revision: resolved.source.revision,
				layer: resolved.layer.name, layer_id: resolved.layer.id, cached: resolved.cached,
				width: resolved.node.width, height: resolved.node.height }];
		});
	}

	async function forPoint(point, steps = [], expected = point?.expected || '', precondition = point?.condition || '', confirmed = new Map()) {
		if (!designEvidenceApplicable()) return [];
		const related = (bindings?.items || []).filter((binding) => binding.status === 'bound' && binding.target &&
			binding.subject.fact_ids?.some((id) => point?.fact_refs?.includes(id)));
		const figures = [];
		const mentions = (text, name) => String(text || '').toLowerCase().includes(String(name).toLowerCase());
		const controls = related.filter((item) => item.kind === 'control');
		for (const binding of controls) {
			const name = binding.subject.name;
			const step = steps.findIndex((line) => {
				const targets = [...String(line).matchAll(/【([^】]+)】/g)].map((match) => match[1]);
				return /点击|单击|按下|拖动|滑动|长按|双击|勾选/.test(line) &&
					!/观察|检查|确认|验证/.test(line) && (targets.length ? targets.includes(name) : mentions(line, name));
			}) + 1;
			const operation = steps.length ? Boolean(step) : mentions(point.action, name);
			if (steps.length && !operation) continue;
			const result = mentions(expected, name);
			if (!operation && !result && controls.length > 1) continue;
			const target = { ...binding.target, name };
			if (operation || !result) figures.push(...await forNode(target, operation ? '操作定位' : '界面参考', operation ? step : 0));
			if (figures.length >= 4) break;
		}
		const item = { steps, expected, precondition };
		for (const gap of missingInterfaceFigures(item, figures)) {
			const saved = confirmed.get(figureBasis(item, gap.role, gap.step));
			if (saved && sources.some((s) => s.id === saved.source_id && s.revision === saved.revision)) {
				figures.push(...(await forNode(saved, gap.role, gap.step)).map((f) => ({ ...f, manual: true, reuse: true })));
			} else {
				const designCheck = /设计稿/.test([precondition, ...steps].join(' ')) &&
					/标注|尺寸|存在/.test([expected, ...steps].join(' '));
				let options = candidates(point, item, gap);
				const context = [precondition, gap.role === '操作定位' ? steps[gap.step - 1] : expected, point?.requirement].join(' ');
				if (gap.role === '预期界面参考' && !designCheck) {
					// 预期图支持画板、组件实例、状态变体和局部区域；
					// 但预期点名了状态却没有对应状态素材时，保留缺口，不用静态整板冒充。
					const wanted = [...new Set(Array.from(String(figureExpected(item, gap.step) || expected).matchAll(STATE_WORDS), (m) => m[1]))];
					if (wanted.length) options = options.filter((hit) => wanted.some((state) => String(hit.name).includes(state) || String(hit.layer || '').includes(state)));
				}
				const size = designCheck && context.match(/(\d+)\s*[×xX]\s*(\d+)/);
				if (size) options = options.filter((hit) => Math.abs(hit.width - Number(size[1])) < 1 && Math.abs(hit.height - Number(size[2])) < 1);
				if (options.length > 1) {
					const cachedOnly = options.filter((hit) => hit.cached);
					if (cachedOnly.length) options = cachedOnly;
				}
				if (options.length > 1) {
					const namedContext = options.filter((hit) => [hit.layer, hit.page, hit.document].some((name) =>
						name?.length >= 3 && name !== hit.name && context.includes(name)));
					if (namedContext.length) options = namedContext;
				}
				const hit = options.length === 1 || (gap.role === '操作定位' && options[0]?.reason === '已确认的需求控件绑定' &&
					options[1]?.reason !== '已确认的需求控件绑定') ? options[0] : null;
				if (hit?.cached) figures.push(...await forNode(hit, gap.role, gap.step));
			}
		}
		if (figures.length) return stampIds(figures, steps, expected);
		const signals = related.filter((item) => item.kind === 'signal').map((item) => item.target).slice(0, 6);
		if (signals.length) {
			const lines = ['信号定义（来源 DBC）', ...signals.flatMap((signal) => [
				`${signal.name}   ${signal.message} ${signal.message_id}`,
				`范围 ${signal.min ?? '—'} ~ ${signal.max ?? '—'} ${signal.unit || ''}   ${signal.source || ''}`
			])];
			return [{ name: '信号定义', role: '信号参考', step: 0, file: await make({ lines }) }];
		}
		if (steps.length && point?.fact_refs?.length && !missingInterfaceFigures(item).length) {
			const lines = ['测试点参考 · ' + (point.requirement || point.point_id),
				'条件 · ' + (point.condition || ''), '动作 · ' + (point.action || ''),
				'预期 · ' + (point.expected || ''), '来源事实 · ' + point.fact_refs.join('、')];
			return [{ name: '测试点与来源事实', role: '需求参考', step: 0, file: await make({ lines }) }];
		}
		return [];
	}
	return { forNode, forPoint, candidates, resolveNode };
}

/** 给旧路径配图补稳定步骤/预期 ID：插入、重排步骤后图仍跟着原内容走。 */
function stampIds(figures, steps, expected) {
	const ids = stepIds(steps);
	const expectedLines = String(expected || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
	const expectedIds = stepIds(expectedLines, 'e-');
	for (const figure of figures) {
		if (figure.step && ids[figure.step - 1]) figure.step_id = ids[figure.step - 1];
		if (figure.role === '预期界面参考') {
			const anchor = figure.step ? String(steps[figure.step - 1] || '').match(/^S\d+/)?.[0] : '';
			const at = expectedLines.findIndex((entry) => (anchor ? entry.startsWith(anchor) : true));
			if (at >= 0) figure.expected_id = expectedIds[at];
		}
	}
	return figures;
}

function figureExpected(item, step) {
	const expected = String(item.expected || '');
	if (!step) return expected;
	return expected.split('\n').filter((line) => Number(line.match(/^\s*S(\d+)[.-]/i)?.[1]) === step).join('\n');
}

export function figureBasis(item, role, step) {
	const operation = String(item.steps?.[step - 1] || '').replace(/^\s*(?:S)?\d+[.、)]\s*/i, '');
	const expected = figureExpected(item, step).replace(/^\s*S\d+(?:-\d+)?\.\s*/gim, '');
	if (role === '预期界面参考' ? !expected : !operation) return '';
	return JSON.stringify([role, String(item.precondition || '').trim(), operation.trim(), role === '预期界面参考' ? expected.trim() : '']);
}

export function confirmedFigures(items) {
	const matches = new Map(), ambiguous = new Set();
	for (const item of items) for (const figure of item.image_refs || []) {
		if (!figure.reuse || !figure.revision || !figure.source_id || !figure.node_id) continue;
		const key = figureBasis(item, figure.role, figure.step);
		if (!key || ambiguous.has(key)) continue;
		const prior = matches.get(key);
		if (prior && (prior.source_id !== figure.source_id || prior.node_id !== figure.node_id || prior.revision !== figure.revision)) {
			matches.delete(key);
			ambiguous.add(key);
		} else if (!prior) matches.set(key, figure);
	}
	return matches;
}

export function missingInterfaceFigures(item, figures = item.image_refs || []) {
	if (!designEvidenceApplicable()) return [];
	const steps = item.steps || [];
	const missing = [];
	const ui = figures.filter((figure) => ['操作定位', '预期界面参考', '界面参考', '页面定位', '控件局部', '恢复入口'].includes(figure.role));
	// 有稳定 ID 的图按 ID 对位；没有 step_items 的旧结构才需要从头计算。
	const ids = item.step_items?.length === steps.length ? item.step_items.map((entry) => entry.id) : stepIds(steps);
	const covers = (figure, index) => figure.step_id
		? figure.step_id === ids[index]
		: Number(figure.step) === index + 1;
	for (const [index, step] of steps.entries()) {
		const operation = /点击|点按|单击|双击|长按|滑动|拖动|轻触|(?:进入|按下|调节).*(?:界面|页面|菜单|控件|图标)|(?:在|通过).*(?:界面|页面|弹层|控件)/.test(step);
		const observation = /(?:观察|检查|确认|验证).*(?:界面|页面|控件|图标|弹窗|显示)/i.test(step);
		if (operation && !ui.some((f) => covers(f, index) && f.role !== '预期界面参考')) missing.push({ step: index + 1, role: '操作定位' });
		if (observation && !ui.some((f) => covers(f, index) && f.role === '预期界面参考')) missing.push({ step: index + 1, role: '预期界面参考' });
	}
	if (/界面|页面|控件|图标|弹窗|显示/i.test(item.expected || '') &&
		!ui.some((f) => f.role === '预期界面参考') &&
		!missing.some((gap) => gap.role === '预期界面参考')) missing.push({ step: 0, role: '预期界面参考' });
	return missing;
}

export function caseFigurePath(dataRoot, projectId, figure) {
	return /^design\/case-images\/[a-f0-9]{64}\.png$/.test(figure?.file || '')
		? path.join(dataRoot, 'projects', projectId, figure.file) : '';
}
