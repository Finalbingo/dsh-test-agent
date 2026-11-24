import fs from 'node:fs/promises';
import path from 'node:path';
import { caseFigurePath } from './case-visuals.js';
import { figurePlacement } from './artifacts.js';

const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function exportDelivery(root, projectId, snapshot, workbook) {
	const dir = await fs.mkdtemp(workbook.slice(0, -5) + '-');
	const images = path.join(dir, 'images');
	await fs.mkdir(images);
	const xlsx = path.join(dir, '用例.xlsx');
	const html = path.join(dir, '图文用例.html');
	const json = path.join(dir, '用例.json');
	const md = path.join(dir, '用例.md');
	const items = snapshot.cases.items.map((item) => ({
		...item,
		image_refs: (item.image_refs || []).map((figure) => {
			const placement = figurePlacement(item, figure);
			return { ...figure, original_file: figure.file, file: 'images/' + path.basename(figure.file), step_index: placement.step, step_mapped: placement.mapped };
		})
	}));
	try {
		// 候选包允许带缺口导出：引用的图片文件缺失时跳过该图并记录警告，而不是整个导出失败。
		const missingImages = [];
		for (const item of items) {
			for (const figure of [...item.image_refs]) {
				const source = caseFigurePath(root, projectId, { file: figure.original_file });
				if (!source) {
					missingImages.push({ case_id: item.case_id, file: figure.original_file, reason: '引用图片不存在' });
					item.image_refs = item.image_refs.filter((entry) => entry !== figure);
					continue;
				}
				try {
					await fs.copyFile(path.join(snapshot.imagesDir, path.basename(source)), path.join(images, path.basename(source)));
				} catch (error) {
					missingImages.push({ case_id: item.case_id, file: figure.original_file, reason: error.code || error.message });
					item.image_refs = item.image_refs.filter((entry) => entry !== figure);
				}
			}
		}
		const content = items.map((item) => renderCase(item, snapshot.design_evidence_applicable !== false)).join('');
		const delays = (snapshot.accounting || []).filter((item) => item.state === 'deferred')
			.map((item) => `<li>${escape(item.requirement)} · ${escape(item.deferral?.reason)} · 影响 ${escape(item.deferral?.impact || '未记录')} · 责任人 ${escape(item.deferral?.owner || '未指派')}</li>`).join('');
		const { imagesDir, ...data } = snapshot;
		await Promise.all([
			fs.copyFile(workbook, xlsx),
			fs.writeFile(json, JSON.stringify({ ...data, cases: { ...snapshot.cases, items } }, null, 2)),
			fs.writeFile(md, renderMarkdown(snapshot, items, delays)),
			fs.writeFile(html, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>图文用例</title><style>'
				+ 'body{font:16px/1.6 system-ui;max-width:1000px;margin:2rem auto;padding:1rem;color:#18202a}'
				+ 'article{border-top:2px solid #bac2cc;margin-top:28px;padding-top:8px}img{max-width:100%}pre{white-space:pre-wrap}'
				+ '.note{background:#f2f4f7;padding:12px;border-left:4px solid #8a94a6}.banner{background:#fff4e5;border:1px solid #e0a96d;padding:14px;border-radius:8px}'
				+ 'table{border-collapse:collapse;width:100%}td,th{border:1px solid #c8d0da;padding:6px 8px;text-align:left;font-size:14px}'
				+ 'figure{margin:8px 0;max-width:260px;display:inline-block;vertical-align:top}figcaption{font-size:12px;color:#4a5568}'
				+ '.missing{color:#a33;background:#fdecec;padding:6px 10px;border-radius:6px;font-size:14px}'
				+ 'details{margin:8px 0}summary{cursor:pointer;color:#2457a1}</style>'
				+ header(snapshot, items) + content
				+ (delays ? '<h2>延期项（保留在覆盖分母中）</h2><ul>' + delays + '</ul>' : '')
				+ '</html>')
		]);
		return { dir, xlsx, html, json, md, missingImages };
	} catch (error) {
		await fs.rm(dir, { recursive: true, force: true });
		throw error;
	}
}

/** 文本版交付件：便于评审/归档在 Git、IM、文档系统里直接阅读。 */
function renderMarkdown(snapshot, items, delays) {
	const lines = [];
	const frozen = snapshot.status === 'frozen' || Boolean(snapshot.model && snapshot.imagesDir);
	const baseline = snapshot.cases?.source_points_digest || snapshot.run?.baseline_digest || '';
	const approved = items.filter((item) => item.review_status === 'approved').length;
	lines.push(`# 图文用例 · ${frozen ? '冻结交付' : '候选评审'}`, '');
	lines.push(`- 项目：${snapshot.project || ''}`);
	lines.push(`- 模块：${snapshot.moduleName || ''}`);
	lines.push(`- 用例基线：${String(baseline).slice(0, 16)}…`);
	lines.push(`- 用例：${items.length} 条（approved ${approved}）`);
	if (snapshot.design_evidence_applicable === false) lines.push('- 设计图证：不适用');
	if (snapshot.accounting?.length) lines.push(`- 大纲场景：${snapshot.accounting.length} 个`);
	lines.push('');
	for (const item of items) {
		lines.push(`## ${item.case_id} · ${item.title}`, '');
		if (item.precondition) lines.push(`- 前置条件：${item.precondition}`);
		if (item.verification) lines.push(`- 判定方式：${item.verification}`);
		if (item.failure_policy) lines.push(`- 失败处理：${item.failure_policy}`);
		lines.push('');
		if (item.prepare_items?.length) {
			lines.push('### 准备');
			item.prepare_items.forEach((entry, index) => lines.push(`${index + 1}. ${entry.text}${entry.read_back ? `（读回：${entry.read_back}）` : ''}`));
			lines.push('');
		}
		const steps = item.step_items?.length ? item.step_items : (item.steps || []).map((text, index) => ({ text, index: index + 1 }));
		const expectations = item.expected_items || [];
		if (steps.length) {
			lines.push('### 步骤与预期');
			steps.forEach((step, index) => {
				lines.push(`${index + 1}. ${step.text}`);
				const own = expectations.filter((entry) => entry.step_id
					? entry.step_id === step.id : entry.step_index === step.index || entry.step_index === index + 1);
				for (const entry of own) lines.push(`   - 预期：${entry.text || `${entry.object}：${entry.target}`}`);
			});
			lines.push('');
		}
		if (item.deferred_items?.length) {
			lines.push(`### 待裁决判据（${item.deferred_items.length}）`);
			for (const entry of item.deferred_items) {
				lines.push(`- ${entry.object || ''}：${entry.target || ''}`);
				if (entry.unresolved) lines.push(`  - 缺口：${entry.unresolved}`);
				if (entry.evidence_ref) lines.push(`  - 原文：${entry.evidence_ref}`);
			}
			lines.push('');
		}
		if (item.restore_items?.length) {
			lines.push('### 恢复');
			item.restore_items.forEach((entry, index) => lines.push(`${index + 1}. ${entry.text}${entry.read_back ? `（读回：${entry.read_back}）` : ''}`));
			lines.push('');
		}
		if (item.image_refs?.length) {
			lines.push('### 配图');
			for (const figure of item.image_refs) {
				const file = String(figure.file || '');
				lines.push(`- ${figure.role || '配图'}${figure.step ? ` · 步骤 ${figure.step}` : ''}：![${figure.role || '配图'}](images/${file.split('/').pop()})`);
			}
			lines.push('');
		}
	}
	if (delays) {
		lines.push('## 延期项（保留在覆盖分母中）', '');
		for (const item of snapshot.accounting || []) {
			if (item.state !== 'deferred') continue;
			lines.push(`- ${item.requirement || ''} · ${item.deferral?.reason || ''} · 影响 ${item.deferral?.impact || '未记录'} · 责任人 ${item.deferral?.owner || '未指派'}`);
		}
	}
	return lines.join('\n') + '\n';
}

function header(snapshot, items) {
	const run = snapshot.run || {};
	const points = snapshot.points?.items || [];
	const cases = snapshot.cases?.items || [];
	const covered = new Set(cases.map((item) => item.point_id));
	const pending = points.filter((point) => !covered.has(point.point_id));
	const failed = run.failed_ids || [];
	const approved = cases.filter((item) => item.review_status === 'approved').length;
	const stale = snapshot.approvals?.stale || [];
	const baseline = snapshot.cases?.source_points_digest || run.baseline_digest || '';
	const reasonFor = (pointId) => {
		const reasons = (run.batches || []).flatMap((batch) => [
			...(batch.status !== 'ok' && (batch.point_ids || []).includes(pointId) ? [batch.error || ''] : []),
			...(batch.failed_points || []).filter((failure) => failure.point_id === pointId).map((failure) => failure.error || '')
		]).filter(Boolean);
		return reasons.join('；') || '本轮未产出用例，保留缺口';
	};
	const gaps = pending.length || failed.length
		? `<h2>缺口表</h2><table><tr><th>测试点</th><th>状态</th><th>原因</th></tr>`
			+ pending.map((point) => `<tr><td>${escape(point.point_id)}</td><td>${failed.includes(point.point_id) ? '生成失败待重试' : '未生成'}</td><td>${escape(reasonFor(point.point_id))}</td></tr>`).join('')
			+ '</table>'
		: '';
	const frozen = snapshot.status === 'frozen' || Boolean(snapshot.model && snapshot.imagesDir);
	const label = frozen ? '冻结交付' : '候选评审';
	return `<h1>图文用例 · ${label}</h1>
	<div class="banner"><b>${frozen ? '冻结交付 · 台架未验证' : '候选／未跑台架'}</b>
	<br>项目 ${escape(snapshot.project || '')} · 模块 ${escape(snapshot.moduleName || '')} · 用例基线 ${escape(baseline.slice(0, 16))}…
	${snapshot.design_evidence_applicable === false ? '<br>设计图证 · 不适用' : ''}
	<br>已完成 <b>${covered.size}</b> / 范围测试点 <b>${points.length}</b> · 生成失败待重试 <b>${failed.length}</b> · 未生成 <b>${pending.length}</b>
	<br>用例 ${cases.length} 条：approved ${approved} · candidate ${cases.length - approved}${stale.length ? ` · <span class="missing">批准已失效 ${stale.length}</span>` : ''}
	${run.run_id ? `<br>运行 ${escape(run.run_id)}${run.stopped ? ` · 中止原因：${escape(run.stopped)}` : ''}` : ''}</div>${gaps}`;
}

function renderCase(item, designEvidence) {
	const located = (item.image_refs || []).map((figure) => ({ figure, ...figurePlacement(item, figure) }));
	const globals = located.filter((entry) => entry.mapped && !entry.step);
	const unmapped = located.filter((entry) => !entry.mapped);
	const steps = item.step_items?.length ? item.step_items : (item.steps || []).map((text, index) => ({ id: '', text, index: index + 1 }));
	const expectations = item.expected_items?.length ? item.expected_items : null;
	const figuresFor = (stepId, expectedId) => located.filter((entry) => entry.mapped
		&& (expectedId ? entry.figure.expected_id === expectedId : entry.figure.step_id === stepId));
	const operations = `<ol>${steps.map((step) => {
		const own = expectations ? expectations.filter((entry) => entry.step_id === step.id) : [];
		const pictures = figuresFor(step.id, '');
		return `<li>${escape(step.text)}${own.map((entry) => {
			const shots = figuresFor(step.id, entry.id);
			const needsFigure = designEvidence && /^(?:ui_|state_)/.test(entry.kind || '');
			return `<p><strong>预期：</strong>${escape(entry.text)}</p>`
				+ (shots.length ? shots.map((entry2) => picture(entry2.figure)).join('')
					: needsFigure && entry.object ? `<p class="missing">缺状态图：${escape(entry.object)} 的目标状态图未绑定</p>` : '');
		}).join('')}${pictures.map((entry) => picture(entry.figure)).join('')}</li>`;
	}).join('')}</ol>`;
	const fallbackExpected = expectations ? '' : `<h3>预期</h3><pre>${escape(item.expected)}</pre>${globals.map((entry) => picture(entry.figure)).join('')}`;
	const deferred = (item.deferred_items || []).length
		? `<details open><summary>待裁决判据（${item.deferred_items.length}）· 本轮不可判定</summary>`
			+ item.deferred_items.map((entry) => `<p class="missing">${entry.assertion_ref ? `${escape(entry.assertion_ref)} · ` : ''}${escape(entry.object)}：${escape(entry.target)}<br>原因 · ${escape(entry.unresolved)}<br>原文 · ${escape(entry.evidence_ref)}</p>`).join('')
			+ '</details>'
		: '';
	const detailRows = (items, fields) => `<ol>${items.map((entry) => `<li>${escape(entry.text)}${fields
		.filter(([key]) => entry[key]).map(([key, label]) => `<br>${label} · ${escape(entry[key])}`).join('')}</li>`).join('')}</ol>`;
	const preparation = item.prepare_items?.length
		? detailRows(item.prepare_items, [['object', '对象'], ['target', '目标'], ['establish', '建立'], ['read_back', '读回'], ['on_failure', '失败']])
		: `<pre>${escape(item.prepare_detail || '未记录独立准备步骤')}</pre>`;
	const restoration = item.restore_items?.length
		? detailRows(item.restore_items, [['baseline', '基线'], ['read_back', '读回'], ['on_failure', '失败']])
		: `<pre>${escape((item.restore_steps || []).join('\n') || '未记录恢复步骤')}</pre>`;
	return `<article><h2>${escape(item.case_id)} · ${escape(item.title)}</h2>
	<p class="note">状态：${escape(item.review_status || 'candidate')} · 评审人 ${escape(item.reviewer || '未评审')} · 评审版本 ${escape((item.review_digest || '').slice(0, 12) || '无')} · 测试点 ${escape(item.point_id)}</p>
	<h3>前置条件</h3><pre>${escape(item.precondition)}</pre>
	<details><summary>准备（执行时不可省略）</summary>${preparation}</details>
	<h3>操作与检查</h3>${operations}${fallbackExpected}${deferred}
	${unmapped.length ? `<details open><summary>待核对配图（${unmapped.length}）</summary><p>这些图对不上当前步骤或预期，需人工核对。</p>${unmapped.map((entry) => picture(entry.figure, entry.reason)).join('')}</details>` : ''}
	<details><summary>恢复（执行时不可省略）</summary>${restoration}
	<p>失败处理 · ${escape(item.failure_policy || '未记录')}</p></details>
	<details><summary>追溯与已知限制</summary><p>来源 · ${escape(item.source_reference)}</p><p>依据 · ${escape(item.basis)}</p>
	<p>验证方式 · ${escape(item.verification || '未记录')}</p><p>配图 ${located.length} 张，其中待核对 ${unmapped.length} 张。</p></details></article>`;
}

function picture(figure, note = '') {
	return `<figure><img src="${escape(figure.file)}" alt="${escape(figure.name)}"><figcaption>${escape(figure.role)} · ${escape(figure.name)}${note ? ` · 待核对（${escape(note)}）` : ''}</figcaption></figure>`;
}
