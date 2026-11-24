import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { save, load } from '../artifacts.js';
import { withModule } from '../scope.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-workbench-b4-'));
const routes = new Map();
const cleanup = [];
let host;
try {
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
	const raw = async (action, fields = {}) => (await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({ action, ...fields }) })).json());
	const api = async (action, fields = {}) => { const result = await raw(action, fields); assert.ok(result.ok, action + ': ' + JSON.stringify(result)); return result.state; };
	const project = (await api('project.create', { name: 'B4 状态矩阵', module: 'M1' })).project;
	const projectId = project.id;
	const moduleId = project.modules[0].id;
	const dir = path.join(root, 'projects', projectId);
	await fs.mkdir(path.join(dir, 'prd'), { recursive: true });
	await fs.writeFile(path.join(dir, 'prd', '需求.md'), '# 需求\n设备就绪时点击确认，界面显示已确认。');
	await api('evidence.build', { project: projectId });
	const evidence = await api('evidence.index', { project: projectId });
	const evidenceId = evidence.index.items[0].id;
	await withModule(moduleId, async () => {
		await save(root, projectId, 'facts', { items: [{ fact_id: 'F-0001', type: 'rule', statement: '设备就绪时点击确认，界面显示已确认', evidence_refs: [evidenceId] }] });
		await save(root, projectId, 'features', { items: [{ feature_id: 'FT', name: '确认', fact_refs: ['F-0001'] }] });
	});
	const patch = { feature_id: 'FT', title: '确认操作', condition: '设备就绪', trigger: '点击确认', expected: '界面显示已确认', fact_refs: ['F-0001'] };
	const draft = await api('contracts.save', { project: projectId, module: moduleId, patch });
	let state = await api('workbench.state', { project: projectId, module: moduleId });
	assert.equal(state.phase, 'contract_review');
	assert.equal(state.next_action.id, 'review_contract');
	assert.ok(state.blockers.some((item) => item.code === 'CONTRACT_UNAPPROVED'));
	console.log('PASS B4 合同待确认');

	await api('contracts.save', { project: projectId, module: moduleId, id: draft.item.contract_id, patch, approve: true });
	const frozen = await api('ecsm.freeze', { project: projectId, module: moduleId });
	assert.ok(frozen.version >= 1);
	state = await api('workbench.state', { project: projectId, module: moduleId });
	assert.equal(state.phase, 'outline');
	assert.equal(state.next_action.id, 'design_outline');
	console.log('PASS B4 已冻结待大纲');

	await withModule(moduleId, async () => {
		await save(root, projectId, 'outline', { items: [{ outline_id: 'O1', status: 'approved', source_ecsm_digest: 'old-digest', items: [{ scenario_id: 'SC-1' }] }] });
	});
	state = await api('workbench.state', { project: projectId, module: moduleId });
	assert.ok(state.blockers.some((item) => item.code === 'OUTLINE_STALE'));
	assert.equal(state.next_action.id, 'review_outline');
	console.log('PASS B4 旧大纲过期阻断');

	const scope = { project: projectId, module: moduleId };
	const branch = { branch_id: 'BR-1', section: '确认', quote: '界面显示已确认', event: '点击确认',
		status: 'ready', mode: 'run', expected: [{ kind: 'ui_immediate', object: '界面', target: '已确认' }] };
	const branches = await api('branches.save', { ...scope, items: [branch] });
	const old = await api('outline.view', scope);
	const design = await api('outline.save', { ...scope, from_branches: true, version: old.version, model_digest: old.model_digest });
	await api('branches.save', { ...scope, version: branches.version, digest: branches.digest, items: [{ ...branch, quote: '已确认，状态来源更新' }] });
	assert.equal((await raw('branches.save', { ...scope, version: branches.version, items: [branch] })).ok, false);
	assert.equal((await api('outline.view', scope)).stale, true);
	assert.equal((await api('workbench.state', scope)).next_action.id, 'review_outline');
	assert.match((await raw('outline.approve', { ...scope, version: design.version, model_digest: design.model_digest, reviewer: 'fixture' })).error, /分支清单已过期/);
	assert.match((await raw('package.freeze', scope)).error, /分支清单已过期/);
	console.log('PASS B4 分支修订使旧大纲过期，工作台、批准及冻结一致');

	await withModule(moduleId, async () => {
		const frozenNow = (await import('../ecsm.js')).currentVersion(root, projectId);
		const outline = await save(root, projectId, 'outline', { items: [{ outline_id: 'O1', status: 'approved', source_ecsm_digest: frozenNow.digest, items: [{ scenario_id: 'SC-1', required: true, rule_ids: [] }] }] });
		await save(root, projectId, 'points', { items: [{ point_id: 'T-0001', review_status: 'approved', scenario_refs: ['SC-1'] }], meta: { source_ecsm_digest: frozenNow.digest, source_outline_digest: outline.digest } });
	});
	state = await api('workbench.state', { project: projectId, module: moduleId });
	assert.equal(state.phase, 'cases');
	assert.equal(state.next_action.id, 'generate_cases');
	console.log('PASS B4 部分生成：有待生成用例');

	await withModule(moduleId, async () => {
		await save(root, projectId, 'deferrals', { items: [{ id: 'D-1', title: '待台架验证', status: 'pending' }] });
	});
	state = await api('workbench.state', { project: projectId, module: moduleId });
	assert.ok(state.blockers.some((item) => item.code === 'DEFERRAL_PENDING'));
	console.log('PASS B4 待延期阻断');

	await withModule(moduleId, async () => {
		await save(root, projectId, 'deferrals', { items: [] });
		const points = await load(root, projectId, 'points');
		await save(root, projectId, 'cases', { items: [{ case_id: 'C-0001', point_id: 'T-0001', review_status: 'candidate' }],
			meta: { source_points_digest: points.digest, source_ecsm_digest: frozen.digest } });
	});
	state = await api('workbench.state', scope);
	assert.equal(state.next_action.id, 'address_delivery_blocker');
	assert.equal(state.next_action.target.tab, 'cases');
	const outline = await api('outline.view', scope);
	await api('deferral.save', { ...scope, outline_digest: outline.digest, point_id: 'T-0001', reason: '缺少测试环境', reviewer: 'fixture', owner: 'fixture' });
	assert.deepEqual((await api('artifacts.load', scope)).delivery.pendingCaseIds, []);
	state = await api('workbench.state', { project: projectId, module: moduleId });
	assert.equal(state.phase, 'delivery');
	assert.equal(state.next_action.id, 'delivery');
	assert.ok(!state.blockers.some((item) => /STATE/.test(item.code)), '不适用状态机不应成为阻断');
	console.log('PASS B4 可交付 + 状态不适用不阻断');

	await withModule(moduleId, () => save(root, projectId, 'points', { items: [{ point_id: 'T-0001', expected: '更新预期' }] }));
	state = await api('workbench.state', scope);
	assert.equal(state.next_action.id, 'generate_cases');
	assert.equal(state.next_action.target.tab, 'cases');
	assert.ok(state.blockers.some((item) => item.code === 'CASES_STALE'));
	await withModule(moduleId, () => save(root, projectId, 'points', { items: [{ point_id: 'T-0001' }], meta: { source_outline_digest: 'old-outline' } }));
	state = await api('workbench.state', scope);
	assert.equal(state.next_action.id, 'generate_points');
	assert.equal(state.next_action.target.tab, 'points');
	assert.ok(state.blockers.some((item) => item.code === 'POINTS_STALE'));
	console.log('PASS B4 测试点或用例过期，主操作返回对应环节');

	// 辅助资料-only：只有参考用途，不能当成需求来源，必须回到选择资料。
	const aux = (await api('project.create', { name: 'B4 辅助资料', module: 'M1' })).project;
	const auxDir = path.join(root, 'projects', aux.id);
	await fs.mkdir(path.join(auxDir, 'prd'), { recursive: true });
	await fs.writeFile(path.join(auxDir, 'prd', '参考.md'), '# 参考\n仅供参考的旧说明');
	await api('evidence.build', { project: aux.id });
	const auxModule = aux.modules[0].id;
	await withModule(auxModule, async () => {
		await save(root, aux.id, 'source-scope', { items: [{ path: 'prd/参考.md', role: 'reference' }], meta: { mode: 'selected' } });
	});
	const auxState = await api('workbench.state', { project: aux.id, module: auxModule });
	assert.equal(auxState.phase, 'materials');
	assert.equal(auxState.next_action.id, 'select_materials');
	assert.ok(auxState.blockers.some((item) => item.code === 'MATERIAL_SOURCE_MISSING'));
	console.log('PASS B4 辅助资料-only 不进入生成');

	// 单文件解析失败：不能算成可用来源，必须给出可点击的失败源。
	const broken = (await api('project.create', { name: 'B4 解析失败', module: 'M1' })).project;
	const brokenDir = path.join(root, 'projects', broken.id);
	await fs.mkdir(path.join(brokenDir, 'prd'), { recursive: true });
	await fs.writeFile(path.join(brokenDir, 'prd', '坏文件.pdf'), 'not a pdf');
	await api('evidence.build', { project: broken.id });
	const brokenState = await api('workbench.state', { project: broken.id, module: broken.modules[0].id });
	assert.equal(brokenState.phase, 'materials');
	assert.ok(brokenState.blockers.some((item) => item.code === 'SOURCE_PARSE_FAILED'));
	console.log('PASS B4 单文件解析失败阻断');

	console.log('PASS B4 状态矩阵：合同待确认 / 已冻结 / 旧大纲 / 部分生成 / 待延期 / 可交付');
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	for (const dispose of cleanup.reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
}
