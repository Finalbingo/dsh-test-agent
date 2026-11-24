import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { apply } from '../index.js';
import { save, digestOf } from '../artifacts.js';
import { saveStates } from '../states.js';
import { withModule } from '../scope.js';
import { recordReview, caseContentDigest } from '../quality-gate.js';
import { startRun, finishRun, loadRun } from '../case-runs.js';

// M2：合同批量确认必须逐条走与单条确认相同的字段/证据门禁，不能一次性盖章。
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-batch-'));
const project = 'P-test';
const module = 'M-main';
const routes = new Map();
const cleanup = [];
let host;
try {
	await fs.mkdir(path.join(root, 'projects', project), { recursive: true });
	await fs.mkdir(path.join(root, 'evidence', project), { recursive: true });
	await fs.writeFile(path.join(root, 'evidence', project, 'items.json'), JSON.stringify({ items: [
		{ id: 'E-1', source: 'prd/x.md', location: '需求', text: '条件：页面就绪。动作：点击确认。预期：页面显示已确认。', chars: 30 }
	] }));
	await fs.writeFile(path.join(root, 'projects', project, 'project.json'), JSON.stringify({
		id: project, name: '批处理测试', modules: [{ id: module, name: '默认模块' }],
		quality: { capabilities: ['text'], surfaces: ['页面'], default_surface: '页面', sources: {} }
	}));
	await withModule(module, async () => {
		await save(root, project, 'facts', { items: [{ fact_id: 'F-0001', type: 'rule', statement: '条件：页面就绪。动作：点击确认。预期：页面显示已确认。', evidence_refs: ['E-1'] }] });
		await save(root, project, 'features', { items: [{ feature_id: 'FT-1', name: '确认', fact_refs: ['F-0001'] }] });
		saveStates(root, project, [{ feature_id: 'FT-1', states: [{ state_id: 'S1', name: '就绪' }], transitions: [] }], { source_facts_digest: 'x', source_features_digest: 'y' });
		await save(root, project, 'contracts', { items: [
			{ contract_id: 'RC-1', feature_id: 'FT-1', title: '点击确认', trigger: '点击确认', condition: '页面就绪', expected: '显示已确认', fact_refs: ['F-0001'], status: 'draft' },
			{ contract_id: 'RC-2', feature_id: 'FT-1', title: '缺字段', trigger: '', condition: '', expected: '', fact_refs: ['F-0001'], status: 'draft' }
		] });
	});
	apply({
		get: () => undefined,
		effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); },
		webServer: { register: (route) => routes.set(route.path, route.handler) },
		tools: { register() {} }
	}, { dataDir: root, legacyRoot: false });
	host = http.createServer((req, res) => {
		const handler = routes.get(new URL(req.url, 'http://local').pathname);
		Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(error.message));
	});
	await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
	const base = 'http://127.0.0.1:' + host.address().port;
	const result = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'contracts.approveAll', project, module
	}) })).json();
	assert.equal(result.ok, true);
	assert.deepEqual(result.state.approved, ['RC-1']);
	assert.equal(result.state.blocked[0].id, 'RC-2');
	const loaded = JSON.parse(await fs.readFile(path.join(root, 'artifacts', project, module, 'contracts.json'), 'utf8'));
	assert.equal(loaded.items.find((item) => item.contract_id === 'RC-1').status, 'approved');
	assert.equal(loaded.items.find((item) => item.contract_id === 'RC-2').status, 'draft');

	// 验证 artifact.approveBatch / rejectBatch（测试点与用例原子批处理 + 门禁逐条生效）
	await withModule(module, async () => {
		const pts = [
			{ point_id: 'T-0001', requirement: '点击确认', condition: '页面就绪', action: '在页面点击确认', expected: '页面显示已确认', fact_refs: ['F-0001'], classification: 'required', review_status: 'candidate' },
			{ point_id: 'T-0002', requirement: '静态条目', condition: '页面就绪', action: '查看文档', expected: '一致', fact_refs: ['F-0001'], classification: 'static_check', rule_reason: '静态核对条目', review_status: 'candidate' }
		];
		await save(root, project, 'points', { items: pts });
	});

	const ptBatch = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'artifact.approveBatch', project, module, kind: 'points', scope: 'all_pending'
	}) })).json();
	assert.equal(ptBatch.ok, true);
	assert.deepEqual(ptBatch.state.approved, ['T-0001']);
	assert.equal(ptBatch.state.blocked.length, 1);
	assert.equal(ptBatch.state.blocked[0].id, 'T-0002');

	await withModule(module, async () => {
		const latestPts = JSON.parse(await fs.readFile(path.join(root, 'artifacts', project, module, 'points.json'), 'utf8'));
		const c1 = {
			case_id: 'C-0001', point_id: 'T-0001', title: '点击确认成功', precondition: '页面就绪', structured: true,
			steps: ['S01. 在页面点击确认', 'S02. 在页面观察【确认结果】'],
			step_items: [
				{ id: 's1', key: 'click', role: 'action', text: '在页面点击确认', index: 1, anchor: 'S01' },
				{ id: 's2', key: 'obs', role: 'observe', text: '在页面观察【确认结果】', index: 2, anchor: 'S02' }
			],
			expected: 'S02-1. 页面显示已确认',
			expected_items: [{ id: 'e1', object: '确认结果', target: '页面显示已确认', kind: 'ui_immediate', trigger: 'click', observe: 'obs', step_id: 's2', trigger_step_id: 's1', step_index: 2, evidence_ref: 'F-0001' }],
			restore_items: [{ id: 'r1', text: '恢复页面至初始状态', baseline: '测试前初始状态', read_back: '在页面核对已恢复' }],
			basis: '依据 F-0001', fact_refs: ['F-0001'], review_status: 'candidate'
		};
		const c2 = { ...c1, case_id: 'C-0002', title: '未审用例' };
		await save(root, project, 'cases', { items: [c1, c2], meta: { source_points_digest: digestOf(latestPts.items) } });
		recordReview(root, project, { case_id: 'C-0001', case_digest: caseContentDigest(c1), review_kind: 'content', conclusion: '通过', reviewer: '测试审校' });
		const run = startRun(root, project, { points_digest: digestOf(latestPts.items) });
		finishRun(root, project, run, {
			pendingIds: ['T-0002'],
			stopped: null,
			droppedDetails: [{ point_id: 'T-0002', reason: 'OBSERVATION_OBJECT_MISMATCH', assertion_refs: [], messages: ['示例退回'] }]
		});
		const reloadedRun = loadRun(root, project, run.run_id);
		assert.equal(reloadedRun.dropped_details.length, 1);
		assert.equal(reloadedRun.dropped_details[0].point_id, 'T-0002');
	});

	const caseBatch = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'artifact.approveBatch', project, module, kind: 'cases', scope: 'all_pending'
	}) })).json();
	assert.equal(caseBatch.ok, true);
	assert.deepEqual(caseBatch.state.approved, ['C-0001'], JSON.stringify(caseBatch.state.blocked));
	assert.equal(caseBatch.state.blocked.length, 1);
	assert.equal(caseBatch.state.blocked[0].id, 'C-0002');

	const ptReject = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'artifact.rejectBatch', project, module, kind: 'points', ids: ['T-0001']
	}) })).json();
	assert.equal(ptReject.ok, true);
	assert.deepEqual(ptReject.state.approved, ['T-0001']);
	const ptsAfter = JSON.parse(await fs.readFile(path.join(root, 'artifacts', project, module, 'points.json'), 'utf8'));
	assert.equal(ptsAfter.items.find((item) => item.point_id === 'T-0001').review_status, 'rejected');

	// 验证 export.templates + 可配置导出模板 + 浏览器安全下载（含路径越界拦截）
	const tplRes = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'export.templates', project, module
	}) })).json();
	assert.equal(tplRes.ok, true);
	assert.ok(tplRes.state.templates.zentao && tplRes.state.templates.jira);

	const expRes = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'artifacts.export', project, module, export_template: 'zentao'
	}) })).json();
	assert.equal(expRes.ok, true);
	assert.ok(expRes.state.download_url?.startsWith('/cts/api/download?path='), '导出应返回可下载 URL');
	const dlRes = await fetch(base + expRes.state.download_url);
	assert.equal(dlRes.status, 200);
	assert.match(dlRes.headers.get('content-disposition') || '', /attachment/);
	assert.ok((await dlRes.arrayBuffer()).byteLength > 200, '下载的 xlsx 文件应为非空字节流');
	const badDl = await fetch(base + '/cts/api/download?path=../../etc/passwd');
	assert.equal(badDl.status, 400, '路径越界下载必须被拒绝');

	// 验证自定义列映射导出
	const customExp = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'artifacts.export', project, module, export_columns: [{ key: 'case_id', label: 'ID' }, { key: 'title', label: '标题' }]
	}) })).json();
	assert.equal(customExp.ok, true);
	assert.ok(customExp.state.download_url);

	// 验证 impact.sourceChanges 增量影响分析
	const impRes = await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({
		action: 'impact.sourceChanges', project, module, path: 'prd/x.md'
	}) })).json();
	assert.equal(impRes.ok, true);
	assert.equal(impRes.state.affected_facts.length, 1);
	assert.equal(impRes.state.affected_points.length, 2);
	assert.equal(impRes.state.affected_cases.length, 2);
	assert.equal(impRes.state.untouched_approved_cases, 0);
	assert.equal(impRes.state.sources_summary[0].source, 'prd/x.md');

	console.log('合同批量确认、原子批处理、退回持久化、模板下载与增量影响验证全部通过');
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	for (const dispose of cleanup.reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
}
