import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { classifyApprovalBuckets, approvalGate, caseContentDigest as caseDigest, loadReviews, recordReviews } from '../quality-gate.js';
import { load as loadArtifact, save as saveArtifact, structureCase, digestOf } from '../artifacts.js';
import { withModule } from '../scope.js';
import * as pluginModule from '../index.js';

const activate = pluginModule.activate || pluginModule.register || Object.values(pluginModule).find((v) => typeof v === 'function');
assert.equal(typeof activate, 'function', 'index.js 必须导出插件激活入口函数');

// ---------------------------------------------------------------------------
// 1. 单元测试：classifyApprovalBuckets (contracts / points / cases)
// ---------------------------------------------------------------------------
const unitContracts = [
	{ contract_id: 'CT-1', feature_id: 'FT-1', title: '已批准合同', status: 'approved', condition: '上电', trigger: '按键', expected: '亮灯', fact_refs: ['F-1'] },
	{ contract_id: 'CT-2', feature_id: 'FT-1', title: '绿灯草稿合同', status: 'draft', condition: '上电', trigger: '按键', expected: '亮灯', fact_refs: ['F-1'] },
	{ contract_id: 'CT-3', feature_id: 'FT-1', title: '待定黄灯合同', status: 'draft', condition: '上电', trigger: '按键', expected: 'TBD 待定', fact_refs: ['F-1'] },
	{ contract_id: 'CT-4', feature_id: 'FT-2', title: '缺预期红灯合同', status: 'draft', condition: '', trigger: '', expected: '', fact_refs: [] }
];
const ctRes = classifyApprovalBuckets('contracts', unitContracts);
assert.equal(ctRes.byId['CT-1'].bucket, 'approved', 'approved 合同应归为 approved');
assert.equal(ctRes.byId['CT-2'].bucket, 'green', '要素齐全且有事实引用的草稿合同应归为 green');
assert.equal(ctRes.byId['CT-3'].bucket, 'yellow', '含 TBD/待定 的草稿合同应归为 yellow');
assert.equal(ctRes.byId['CT-4'].bucket, 'red', '缺核心要素或无证据引用的合同应归为 red');
assert.deepEqual(ctRes.counts, { red: 1, yellow: 1, green: 1, approved: 1, total: 4 });

const unitPoints = [
	{ point_id: 'T-0001', feature_id: 'FT-1', requirement: '正常开启', condition: '系统运行', action: '单击开关', expected: '开启成功', priority: 'P1', review_status: 'approved', fact_refs: ['F-0001'] },
	{ point_id: 'T-0002', feature_id: 'FT-1', requirement: '常规关闭', condition: '系统运行', action: '单击开关', expected: '关闭成功', priority: 'P1', review_status: 'draft', fact_refs: ['F-0001'] },
	{ point_id: 'T-0003', feature_id: 'FT-1', requirement: '核心P0保护', condition: '系统运行', action: '触发过压', expected: '切断输出', priority: 'P0', review_status: 'draft', fact_refs: ['F-0001'] },
	{ point_id: 'T-0004', feature_id: 'FT-2', requirement: '缺动作红灯点', condition: '', action: '', expected: '', priority: 'P2', review_status: 'draft', fact_refs: [] }
];
const ptRes = classifyApprovalBuckets('points', unitPoints);
assert.equal(ptRes.byId['T-0001'].bucket, 'approved');
assert.equal(ptRes.byId['T-0002'].bucket, 'green');
assert.equal(ptRes.byId['T-0003'].bucket, 'yellow', 'P0 测试点应默认归入黄灯重点审');
assert.equal(ptRes.byId['T-0003'].p0, true);
assert.equal(ptRes.byId['T-0004'].bucket, 'red');

const makeValidCase = (id, overrides = {}) => ({
	case_id: id,
	point_id: 'T-0001',
	feature_id: 'FT-1',
	case_role: 'primary',
	title: `标准用例 ${id}`,
	type: '功能',
	priority: 'P1',
	review_status: 'draft',
	precondition: '系统处于运行模式；主控页面可见',
	prepare_items: [{ key: 'p1', text: '确认初始状态', object: '功能开关', target: '关闭', establish: '在主控页面核对状态', read_back: '在主控页面观察【功能开关】为关闭', on_failure: '停止' }],
	steps: [
		'1. 在主控页面单击一次【功能开关】',
		'2. 在主控页面观察【功能开关】，记录状态'
	],
	step_items: [
		{ key: 's1', role: 'action', text: '在主控页面单击一次【功能开关】' },
		{ key: 's2', role: 'observe', text: '在主控页面观察【功能开关】，记录状态' }
	],
	expected: '1. 【功能开关】切换为开启状态',
	expected_items: [
		{ key: 'e1', assertion_ref: '', trigger: 's1', observe: 's2', object: '功能开关', target: '切换为开启状态', kind: 'ui_immediate', evidence_ref: 'F-0001', frames: 0, since: '', delay_s: 0, unresolved: '' }
	],
	restore_steps: ['1. 在主控页面单击【功能开关】恢复关闭'],
	restore_items: [{ key: 'r1', text: '在主控页面单击【功能开关】恢复关闭', baseline: 'p1', read_back: '在主控页面观察【功能开关】为关闭', on_failure: '停止' }],
	deferred_items: [],
	failure_policy: '截图记录',
	basis: 'F-0001',
	...overrides
});

const cGreen = makeValidCase('C-GREEN', { priority: 'P1' });
const cP0Passed = makeValidCase('C-P0', { priority: 'P0' });
const cDeferred = makeValidCase('C-DEF', { priority: 'P1', deferred_items: [{ field: 'expected_items[0]', reason: '待实车确认' }] });
const cRedLint = makeValidCase('C-RED', { priority: 'P1', steps: [], expected_items: [] });
const cUnreviewed = makeValidCase('C-UNREV', { priority: 'P2' });

const reviews = {
	items: [
		{ case_id: 'C-GREEN', conclusion: '通过', review_kind: 'model', case_digest: caseDigest(cGreen), findings: [] },
		{ case_id: 'C-P0', conclusion: '通过', review_kind: 'model', case_digest: caseDigest(cP0Passed), findings: [] },
		{ case_id: 'C-DEF', conclusion: '通过', review_kind: 'model', case_digest: caseDigest(cDeferred), findings: [] },
		{ case_id: 'C-RED', conclusion: '通过', review_kind: 'model', case_digest: caseDigest(cRedLint), findings: [] }
	]
};
const csRes = classifyApprovalBuckets('cases', [cGreen, cP0Passed, cDeferred, cRedLint, cUnreviewed], {
	points: unitPoints,
	reviews,
	quality: {}
});
assert.equal(csRes.byId['C-GREEN'].bucket, 'green', 'AI 审通过、无门禁错、无待定项的 P1 用例应为绿灯');
assert.equal(csRes.byId['C-P0'].bucket, 'yellow', 'P0 用例即使 AI 审通过也应默认黄灯');
assert.equal(csRes.byId['C-P0'].p0, true);
assert.equal(csRes.byId['C-P0'].modelPassed, true);
assert.equal(csRes.byId['C-DEF'].bucket, 'yellow', '含 deferred_items 的用例应为黄灯');
assert.equal(csRes.byId['C-RED'].bucket, 'red', '门禁校验失败的用例应为红灯');
assert.equal(csRes.byId['C-UNREV'].bucket, 'yellow', '尚未独立审查的用例应为黄灯');

// ---------------------------------------------------------------------------
// 2. 端到端 HTTP 路由仿真验证：review.humanSignoff / artifact.approve / artifacts.load
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-triage-'));
const routes = new Map();
const mockCtx = {
	config: { dataDir: tmpDir, provider: 'mock', model: 'mock-1' },
	get: () => null,
	effect: (fn) => fn(),
	tools: { register: () => {} },
	webServer: { register: ({ path: p, handler }) => routes.set(p, handler) }
};

await activate(mockCtx, { dataDir: tmpDir, provider: 'mock', model: 'mock-1' });

const callRoute = async (method, urlStr, bodyObj = null) => {
	const u = new URL(urlStr, 'http://127.0.0.1');
	const handler = routes.get(u.pathname);
	assert.ok(handler, `Route not found: ${u.pathname}`);
	const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : Buffer.alloc(0);
	const req = Object.assign(Readable.from(payload.length ? [payload] : []), {
		method,
		url: u.pathname + u.search,
		headers: { 'content-type': 'application/json' }
	});
	const chunks = [];
	let statusCode = 200;
	let resolveDone;
	const done = new Promise((r) => { resolveDone = r; });
	const res = {
		get statusCode() { return statusCode; },
		set statusCode(v) { statusCode = v; },
		destroyed: false,
		writableEnded: false,
		setHeader() {},
		writeHead(c) { statusCode = c; },
		write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; },
		end(c) { if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); this.writableEnded = true; resolveDone(); },
		once() {},
		on() {}
	};
	await handler(req, res);
	await done;
	return { status: statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
};

const api = async (body) => callRoute('POST', '/cts/api', body);

try {
	// 创建项目与模块
	const created = await api({ action: 'project.create', name: '异常分流审批验证项目', firstModule: '核心模块' });
	assert.equal(created.status, 200);
	const projectObj = created.data.state.project;
	const projectId = projectObj.id;
	const moduleId = projectObj.modules[0].id;

	// 创建真实证据 E-0001，确保 contractBasis 校验通过
	const prdDir = path.join(tmpDir, 'projects', projectId, 'prd');
	fs.mkdirSync(prdDir, { recursive: true });
	fs.writeFileSync(path.join(prdDir, 'spec.md'), '# 主控页面\n当在主控页面单击【功能开关】时，功能开关切换为开启状态。\n');
	await api({ action: 'assets.tags.update', project: projectId, module: moduleId, path: 'prd/spec.md', add: true });
	const evBuilt = await api({ action: 'evidence.build', project: projectId, module: moduleId });
	assert.equal(evBuilt.status, 200);
	const evId = evBuilt.data.state.items?.[0]?.id || 'E-0001';

	// 在模块作用域内播种事实、合同、大纲、测试点、用例与模型审查回执
	await withModule(moduleId, async () => {
		await saveArtifact(tmpDir, projectId, 'features', {
			items: [
				{ feature_id: 'FT-1', name: '功能开关控制', fact_refs: ['F-0001'] },
				{ feature_id: 'FT-2', name: '辅助控制', fact_refs: ['F-0001'] }
			]
		});
		await saveArtifact(tmpDir, projectId, 'facts', {
			items: [{ fact_id: 'F-0001', statement: '在主控页面单击功能开关可切换开关状态', type: '行为', source: { evidence_id: evId, quote: '功能开关切换为开启状态' }, evidence_refs: [evId] }]
		});
		await saveArtifact(tmpDir, projectId, 'contracts', {
			items: [
				{ contract_id: 'CT-1', feature_id: 'FT-1', title: '绿灯合同A', status: 'draft', condition: '上电', trigger: '单击', expected: '开启', fact_refs: ['F-0001'] },
				{ contract_id: 'CT-2', feature_id: 'FT-2', title: '其他组绿灯合同B', status: 'draft', condition: '上电', trigger: '双击', expected: '关闭', fact_refs: ['F-0001'] },
				{ contract_id: 'CT-3', feature_id: 'FT-1', title: '红灯合同C', status: 'draft', condition: '', trigger: '', expected: '', fact_refs: [] }
			]
		});
		await saveArtifact(tmpDir, projectId, 'outline', {
			items: [{ status: 'approved', items: [] }]
		});
		await saveArtifact(tmpDir, projectId, 'points', {
			items: [
				{ point_id: 'T-0001', feature_id: 'FT-1', scenario_id: 'SC-1', requirement: '已批准基础点', condition: '运行态', action: '单击开关', expected: '开启', priority: 'P1', review_status: 'approved', fact_refs: ['F-0001'] },
				{ point_id: 'T-0002', feature_id: 'FT-1', scenario_id: 'SC-1', requirement: '绿灯待批点', condition: '运行态', action: '再次单击', expected: '关闭', priority: 'P1', review_status: 'draft', fact_refs: ['F-0001'] },
				{ point_id: 'T-0003', feature_id: 'FT-1', scenario_id: 'SC-1', requirement: 'P0黄灯点', condition: '运行态', action: '异常输入', expected: '保护', priority: 'P0', review_status: 'draft', fact_refs: ['F-0001'] },
				{ point_id: 'T-0004', feature_id: 'FT-1', scenario_id: 'SC-1', requirement: '红灯缺要素点', condition: '', action: '', expected: '', priority: 'P2', review_status: 'draft', fact_refs: [] }
			]
		});
	});

	// 2.1 验证大纲向下继承：points scope='inherit_outline' 仅放行绿灯点 T-0002，不动 P0(T-0003) 和红灯(T-0004)
	const inheritRes = await api({
		action: 'review.humanSignoff',
		project: projectId,
		module: moduleId,
		kind: 'points',
		scope: 'inherit_outline',
		reviewer: '大纲审批人'
	});
	assert.equal(inheritRes.status, 200);
	assert.deepEqual(inheritRes.data.state.approved, ['T-0002'], 'inherit_outline 应只放行绿灯测试点 T-0002');

	// 在测试点稳定后，基于当前 points 基线播种用例与模型审查回执
	await withModule(moduleId, async () => {
		const ptsNow = await loadArtifact(tmpDir, projectId, 'points');
		const seededCases = [
			makeValidCase('C-0001', { point_id: 'T-0001', priority: 'P1' }),
			makeValidCase('C-0002', { point_id: 'T-0001', priority: 'P0' }),
			makeValidCase('C-0003', { point_id: 'T-0001', priority: 'P1', deferred_items: [{ field: 'expected_items[0]', reason: '待确认' }] }),
			makeValidCase('C-0004', { point_id: 'T-0001', priority: 'P1', steps: [], expected: '', expected_items: [] }),
			makeValidCase('C-0005', { point_id: 'T-0001', priority: 'P2' })
		];
		for (const c of seededCases) structureCase(c);
		await saveArtifact(tmpDir, projectId, 'cases', {
			items: seededCases,
			meta: { source_points_digest: digestOf(ptsNow.items) }
		});
		await recordReviews(tmpDir, projectId, seededCases.map((c) => ({
			case_id: c.case_id,
			conclusion: '通过',
			review_kind: 'model',
			reviewer: 'ai-review',
			case_digest: caseDigest(c),
			findings: []
		})));
	});

	// 2.2 验证 artifacts.load 返回完整 triage 分流统计
	const loaded = await api({ action: 'artifacts.load', project: projectId, module: moduleId });
	assert.equal(loaded.status, 200);
	const triage = loaded.data.state.triage;
	assert.ok(triage?.contracts && triage?.points && triage?.cases, 'artifacts.load 必须返回三色分流 triage');
	assert.deepEqual(triage.cases.counts, { red: 1, yellow: 2, green: 2, approved: 0, total: 5 }, JSON.stringify(triage.cases.byId));

	// 2.3 验证用例绿灯一键签收：仅签收 C-0001 和 C-0005，不碰 P0(C-0002)、待定(C-0003) 与红灯(C-0004)
	const greenRes = await api({
		action: 'review.humanSignoff',
		project: projectId,
		module: moduleId,
		kind: 'cases',
		scope: 'green_only',
		reviewer: '测试负责人'
	});
	assert.equal(greenRes.status, 200);
	assert.deepEqual(greenRes.data.state.approved.sort(), ['C-0001', 'C-0005'], 'green_only 应只签收绿灯用例 C-0001 和 C-0005');

	// 验证审计链：C-0001 最新回执为 review_kind='content' 且保留历史 model 回执，并可通过 approvalGate
	await withModule(moduleId, async () => {
		const revAfterGreen = await loadReviews(tmpDir, projectId);
		const c1Rev = revAfterGreen.items.find((r) => r.case_id === 'C-0001');
		assert.equal(c1Rev.review_kind, 'content', '人工签收必须写入 review_kind=content');
		assert.equal(c1Rev.reviewer, '测试负责人', '人工签收必须记录签收人');
		assert.ok(Array.isArray(c1Rev.history) && c1Rev.history.some((h) => h.review_kind === 'model'), '原始 AI model 回执必须保留在 history[] 中');
		const casesDoc = await loadArtifact(tmpDir, projectId, 'cases');
		const ptsDoc = await loadArtifact(tmpDir, projectId, 'points');
		const c1Case = casesDoc.items.find((c) => c.case_id === 'C-0001');
		assert.equal(c1Case.review_status, 'approved');
		const gateCheck = approvalGate(c1Case, { reviews: revAfterGreen, point: ptsDoc.items[0], points: ptsDoc, cases: casesDoc });
		assert.equal(gateCheck.ok, true, '签收后的用例必须 100% 通过 approvalGate');
	});

	// 2.4 验证含 AI 已审通过 P0 的批量签收：签收 C-0002，依然拦住 C-0003(待定) 和 C-0004(红灯)
	const p0Res = await api({
		action: 'review.humanSignoff',
		project: projectId,
		module: moduleId,
		kind: 'cases',
		scope: 'green_and_p0_passed',
		reviewer: '测试负责人'
	});
	assert.equal(p0Res.status, 200);
	assert.deepEqual(p0Res.data.state.approved, ['C-0002'], 'green_and_p0_passed 应签收 AI 已审通过的 P0 用例 C-0002');

	// 2.5 验证单条在线人工签收（artifact.approve + human_signoff: true）：对 C-0003 签收并解除旧版网页审批死锁
	const singleRes = await api({
		action: 'artifact.approve',
		project: projectId,
		module: moduleId,
		kind: 'cases',
		id: 'C-0003',
		human_signoff: true,
		reviewer: '专家复核人',
		note: '人工核对实车表现已确认'
	});
	assert.equal(singleRes.status, 200, '单条用例带 human_signoff: true 必须能直接在线签收批准');
	assert.equal(singleRes.data.state.item.review_status, 'approved');

	// 2.6 验证红灯用例 C-0004 即使带 human_signoff: true 也不能绕过 lint 门禁
	const redBlocked = await api({
		action: 'artifact.approve',
		project: projectId,
		module: moduleId,
		kind: 'cases',
		id: 'C-0004',
		human_signoff: true,
		reviewer: '专家复核人'
	});
	assert.equal(redBlocked.status, 409, '红灯硬缺陷用例绝不能绕过门禁强行批准');
	assert.equal(redBlocked.data.ok, false, '红灯阻断应返回 ok: false');

	// 2.7 验证合同按功能组整组签收（feature_group='FT-1' 仅确认 CT-1，不碰 FT-2 的 CT-2 及红灯 CT-3）
	const ctGroupRes = await api({
		action: 'review.humanSignoff',
		project: projectId,
		module: moduleId,
		kind: 'contracts',
		scope: 'feature_group',
		feature_id: 'FT-1',
		reviewer: '架构师'
	});
	assert.equal(ctGroupRes.status, 200);
	assert.deepEqual(ctGroupRes.data.state.approved, ['CT-1'], 'feature_group=FT-1 应只确认 FT-1 下的绿灯合同 CT-1');

	// 2.8 验证 client.js 包含红黄绿分流栏、按功能分组和 Alt+Enter 极速连续审阅控件
	const clientSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
	assert.ok(clientSrc.includes('review.humanSignoff'), 'client.js 必须调用 review.humanSignoff');
	assert.ok(clientSrc.includes('含 AI 已审通过 P0'), 'client.js 必须包含 P0 绿灯合并签收复选框');
	assert.ok(clientSrc.includes('按功能分组'), 'client.js 必须包含按功能分组视图切换');
	assert.ok(clientSrc.includes('批准并看下一条'), 'client.js 必须包含极速连续审阅按钮');
	assert.ok(clientSrc.includes('继承已批大纲放行绿灯点'), 'client.js 必须包含大纲向下继承放行按钮');

	console.log('ALL_APPROVAL_TRIAGE_TESTS_PASSED');
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}
