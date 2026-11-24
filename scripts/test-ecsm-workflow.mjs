import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply } from '../index.js';
import { save, digestOf } from '../artifacts.js';
import { withModule } from '../scope.js';
import { saveStates } from '../states.js';
import { layerSources, previewFile, saveMcpDesign } from '../design.js';
import { loadReviews } from '../quality-gate.js';
import { buildWorkbook } from '../xlsx.js';
import { parseXlsx } from '../parsers/xlsx.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-ecsm-'));
const project = 'P-test';
const dir = path.join(root, 'projects', project);
const point = { requirement: '提示状态', condition: '设备就绪', action: '点击确认', expected: '界面显示已确认', fact_refs: ['F-0001'], transition_ref: 'FT.T01' };
const example = { point_id: 'T-0001', title: '确认操作', precondition: '设备就绪', prepare_detail: '记录设备初态并读回，无法辨认则停止', steps: ['确认设备就绪并记录初态', '点击【确认】一次', '观察界面提示'], expected: '观察界面提示：显示已确认', restore_steps: ['按记录的初态恢复并读回'], failure_policy: '记录实际结果与证据后停止' };
let seenPrompt = '';
let variantFixture = false;
let reviewFinding = null;
const llm = {
	listProviders: () => [{ id: 'test' }],
	listModels: async () => [{ id: 'test' }],
	resolveModelInfo: async () => ({ inputModalities: ['text'] }),
	async *stream(request) {
		const input = JSON.stringify(request.messages);
		seenPrompt = input;
		if (input.includes('总数以给出的统计为准')) {
			yield { type: 'text-delta', text: JSON.stringify({ summary: '按当前大纲查阅覆盖和延期。' }) };
			return;
		}
		if (input.includes('只根据选中的意见和原文建议修改')) {
			yield { type: 'text-delta', text: JSON.stringify({ patch: { title: '归档修订建议', status: 'approved' } }) };
			return;
		}
		if (input.includes('角色：质量审查 Agent')) {
			const ids = [...new Set([...input.matchAll(/\[((?:C|T)-\d{4}|(?:RC|SC)-[a-f0-9-]+)\]/g)].map((match) => match[1]))];
			const receipts = ids.map((case_id) => ({ case_id, conclusion: reviewFinding?.id === case_id ? '待修改' : '通过',
				findings: reviewFinding?.id === case_id ? reviewFinding.findings : [] }));
			yield { type: 'text-delta', text: JSON.stringify({ receipts }) };
			return;
		}
		const pathRole = /case_role 原样填写 (path-\d+)/.exec(input);
		if (pathRole) {
			yield { type: 'text-delta', text: JSON.stringify({ cases: [{ ...example, title: '归档路径', case_role: pathRole[1] }] }) };
			return;
		}
		if (variantFixture && input.includes('每条测试点生成一条用例')) {
			const clickCase = { ...example, case_role: 'click', title: '点击重做' };
			const brokenClick = { ...clickCase, steps: [{ key: 'observe', role: 'observe', text: '在页面观察记录' }],
				expected_items: [{ object: '记录', target: '保留', observe: 'observe', kind: 'ui_immediate' }] };
			const cases = input.includes('只重做以下用例角色')
				? [input.includes('只重新提交本次校验未通过') ? clickCase : brokenClick]
				: [{ ...example, case_role: 'drag', title: '拖动' }, { ...example, case_role: 'click', title: '点击' }];
			yield { type: 'text-delta', text: JSON.stringify({ cases }) };
			return;
		}
		const result = input.includes('每条测试点生成一条用例') ? { cases: [input.includes('审批后归档') ? { ...example, title: '归档操作', precondition: '审批已完成', steps: ['确认审批已完成并记录初态', '运行归档', '查询归档记录'], expected: '查询到归档记录保留' } : example] }
			: input.includes('将事实拆成独立') ? { contracts: [{ title: '审批后归档', condition: '审批已完成', trigger: '运行归档', expected: '归档记录保留', fact_refs: ['F-0001'] }] }
			: input.includes('下面是产品事实，请归并成功能点') ? { features: [{ name: '归档', fact_refs: ['F-0001'] }] }
			: input.includes('归档规则') ? { facts: [{ statement: '完成审批后归档', type: 'rule', evidence_refs: ['E-0001'] }] }
			: input.includes('receipts') ? { receipts: [...new Set([...input.matchAll(/\[(C-\d{4})\]/g)].map((match) => match[1]))].map((case_id) => ({ case_id, conclusion: '通过', findings: [] })) }
			: { points: [point] };
		yield { type: 'text-delta', text: JSON.stringify(result) };
	}
};
const routes = new Map();
const cleanup = [];
let host;
try {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ id: project, name: '测试', modules: [{ id: 'M-a', name: '同名模块' }, { id: 'M-b', name: '同名模块' }] }));
	for (const module of ['M-a', 'M-b']) {
		await withModule(module, async () => {
			const facts = [{ fact_id: 'F-0001', type: 'rule', statement: `操作依据 ${module}`, evidence_refs: ['E-0001'] }];
			const features = [{ feature_id: 'FT', name: module, fact_refs: ['F-0001'] }];
			await save(root, project, 'facts', { items: facts });
			await save(root, project, 'features', { items: features });
			const savedStates = saveStates(root, project, [{ feature_id: 'FT', states: [{ state_id: 'S1', name: '就绪' }, { state_id: 'S2', name: '确认' }], transitions: [{ transition_id: 'FT.T01', from: 'S1', to: 'S2', trigger: '点击' }] }], {
				source_facts_digest: digestOf(facts), source_features_digest: digestOf(features)
			});
			// states 也必须有稳定的内容摘要，方便和 facts/points/cases 一样做版本对账。
			assert.equal(typeof savedStates.digest, 'string');
			assert.equal(savedStates.digest.length, 16);
			assert.equal(savedStates.digest, digestOf(savedStates.items));
		});
	}
	apply({
		get: (name) => name === 'llm' ? llm : undefined,
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
	const send = (route, fields) => fetch(base + route, { method: 'POST', body: JSON.stringify({ project, module: 'M-b', ...fields }) });
	const api = async (action, fields) => {
		const result = await (await send('/cts/api', { action, ...fields })).json();
		assert.ok(result.ok, action + ': ' + JSON.stringify(result));
		return result.state;
	};
	const generate = async (kind) => (await send('/cts/api/generate', { kind, draft: false })).text();
	assert.match(await generate('points'), /请先在 ECSM/);
	const frozen = await api('ecsm.freeze');
	assert.equal((await api('ecsm.freeze')).version, frozen.version);
	const name = 'cts-test-design';
	const before = (await api('skills.list')).items.find((item) => item.name === name);
	const replacement = await api('skills.replace', { name, filename: 'SKILL.md', content: '# 临时测试点规则 314159' });
	assert.equal(replacement.items.find((item) => item.name === name).canRestore, true);
	assert.match(await generate('points'), /event: run\.end/);
	assert.match(seenPrompt, /临时测试点规则 314159/);
	const restored = await api('skills.restore', { name });
	assert.equal(restored.items.find((item) => item.name === name).content, before.content);
	const points = await api('artifacts.load');
	assert.equal(points.points.source_ecsm_digest, frozen.digest);
	assert.equal(points.points.items.length, 1);
	assert.equal((await api('artifacts.load', { module: 'M-a' })).points.items.length, 0);
	assert.match(await generate('cases'), /批准测试点/);
	await api('artifact.regenerate', { kind: 'points', id: 'T-0001' });
	assert.equal((await api('artifacts.load')).points.source_ecsm_digest, frozen.digest);
	await api('artifact.approve', { kind: 'points', id: 'T-0001' });
	assert.match(await generate('cases'), /event: run\.end/);
	let state = await api('artifacts.load');
	assert.equal(state.cases.source_points_digest, digestOf(state.points.items));
	assert.equal((await api('ecsm.view')).drifted, false, '下游生成不改变模型版本');
	assert.equal((await api('ecsm.version', { version: frozen.version })).digest, frozen.digest);
	assert.equal((await api('ecsm.impact', { transition_id: 'FT.T01' })).cases.length, 1);
	const beforeRefresh = state.cases.digest;
	await api('pipeline.refresh');
	assert.equal((await api('artifacts.load')).cases.digest, beforeRefresh);

	const imageRef = 'design/case-images/' + 'a'.repeat(64) + '.png';
	const image = path.join(dir, imageRef);
	await fs.mkdir(path.dirname(image), { recursive: true });
	execFileSync(process.env.CTS_PYTHON || 'python3', ['-c', 'from PIL import Image; import sys; Image.new("RGB",(64,64),"blue").save(sys.argv[1])', image]);
	const caseId = state.cases.items[0].case_id;
	await withModule('M-b', async () => {
		const { items, version, updatedAt, digest, ...meta } = state.cases;
		items[0].image_required = false;
		items[0].image_refs = [{ file: imageRef, name: '信号卡', role: '信号参考', step: 0 }];
		await save(root, project, 'cases', { items, version, meta });
	});
	state = await api('artifacts.load');
	assert.ok(state.delivery.gaps[caseId].length, '信号卡不能算作界面图');
	assert.equal(state.delivery.blocker.step, 'cases');
	await withModule('M-b', async () => {
		const { items, version, updatedAt, digest, ...meta } = state.cases;
		items[0].image_refs = [
			{ file: imageRef, name: '确认控件', role: '操作定位', step: 2 },
			{ file: imageRef, name: '确认结果', role: '预期界面参考', step: 3 }
		];
		await save(root, project, 'cases', { items, version, meta });
	});
	const review = await (await send('/cts/api/review', {})).text();
	assert.match(review, /event: run\.end/);
	const chat = await (await send('/cts/api/chat', { module: 'M-a', message: '仅用于测试的聊天内容' })).text();
	assert.match(chat, /event: tool\.end/);
	const { items: activity } = await api('activity.list');
	assert.ok(activity.some((item) => item.module === 'M-a' && item.action === 'Agent 对话' && item.stage === 'tool_completed'));
	assert.ok(activity.some((item) => item.module === 'M-b' && item.action === '生成用例' && item.stage === 'completed'));
	assert.ok(activity.some((item) => item.action === '独立审查用例' && item.stage === 'completed'));
	assert.ok(activity.some((item) => item.action === '重生成条目' && item.stage === 'completed'));
	assert.ok(activity.some((item) => item.action === '生成测试点' && item.stage === 'failed'));
	assert.ok(!JSON.stringify(activity).includes('仅用于测试的聊天内容'));
	// 模型回执不具备批准资格，先写入独立裁决记录。
	const beforeApprove = (await api('artifacts.load')).cases;
	await api('cases.reviewApply', { version: beforeApprove.version, digest: beforeApprove.digest,
		rows: [{ case_id: caseId, review_conclusion: '通过', review_comment: '逐条核对无缺陷', reviewer: 'agent:裁决' }] });
	await api('artifact.approve', { kind: 'cases', id: caseId });
	assert.equal((await api('artifacts.load')).delivery.reviewStale, false, '审批不改变独立审查所依据的用例内容');
	const record = await api('package.freeze');
	assert.equal(record.ecsm.digest, frozen.digest);
	await api('package.fork');
	await api('artifact.update', { kind: 'cases', id: caseId, patch: { title: '新草稿' } });
	await fs.unlink(image);
	const exported = await api('package.export', { package_id: record.package_id });
	const xlsx = execFileSync('unzip', ['-Z1', exported.file], { encoding: 'utf8' });
	assert.match(xlsx, /xl\/media\//, '历史导出从冻结副本嵌入图片');
	const first = await api('ecsm.export', { module: 'M-a' });
	const second = await api('ecsm.export');
	assert.notEqual(first.file, second.file);
	assert.match(first.file, /M-a/);
	assert.match(second.file, /M-b/);
	await api('artifact.update', { kind: 'facts', id: 'F-0001', patch: { statement: '新确认的事实' } });
	assert.equal((await api('ecsm.view')).drifted, true);
	assert.match(await generate('points'), /产品模型有修改/);
	const repairId = 'F-0001';
	await api('ecsm.repair', { kind: 'fact', id: repairId, patch: { statement: '需要补证据', evidence_refs: [] } });
	const changed = await api('ecsm.view');
	assert.ok(changed.issues.some((issue) => issue.category === 'evidence' && issue.ref === repairId));
	await api('ecsm.repair', { kind: 'fact', id: repairId, patch: { statement: '可追溯的事实', evidence_refs: ['E-0001'] } });
	const repaired = await api('ecsm.view');
	assert.ok(!repaired.issues.some((issue) => issue.ref === repairId && issue.message === '事实没有来源证据'));
	assert.ok(repaired.drifted);
	await api('ecsm.repair', { kind: 'transition', feature_id: 'FT', id: 'FT.T01', patch: { from: 'S1', to: 'S2', trigger: '重新确认的触发', conditions: ['已就绪'], actions: ['确认'] } });
	assert.equal((await api('ecsm.view')).model.features[0].transitions[0].trigger, '重新确认的触发');
	assert.equal((await api('ecsm.version', { version: frozen.version })).features[0].transitions[0].trigger, '点击');

	const module = 'M-a';
	const evidenceDir = path.join(root, 'evidence', project);
	await fs.mkdir(evidenceDir, { recursive: true });
	const writeEvidence = (text) => fs.writeFile(path.join(evidenceDir, 'items.json'), JSON.stringify({
		items: [{ id: 'E-0001', source: 'prd/test.md', location: '确认操作', text }]
	}));
	await writeEvidence('设备就绪时点击确认，界面显示已确认');
	const patch = { feature_id: 'FT', title: '确认操作', condition: '设备就绪', trigger: '点击确认', expected: '界面显示已确认', fact_refs: ['F-0001'], transition_ref: 'FT.T01' };
	const pending = await api('contracts.save', { module, patch: { ...patch, title: '尚未评审' } });
	assert.equal(pending.item.status, 'draft');
	const incomplete = await (await send('/cts/api', { action: 'contracts.save', module, patch: { ...patch, expected: '' }, approve: true })).json();
	assert.match(incomplete.error, /可观察预期/);
	const firstContract = await api('contracts.save', { module, patch, approve: true });
	const secondContract = await api('contracts.save', { module, patch: { ...patch, title: '同一场景', trigger: '点击 确认' }, approve: true });
	const branch = await api('contracts.save', { module, patch: { ...patch, title: '未就绪', condition: '设备未就绪', expected: '界面提示请等待' }, approve: true });
	const contractVersion = await api('ecsm.freeze', { module });
	const contractSnapshot = await api('ecsm.version', { module, version: contractVersion.version });
	assert.equal(contractSnapshot.inputs.contracts.items.length, 4);
	const generateContracts = async () => (await send('/cts/api/generate', { module, kind: 'points', draft: false, from_contracts: true })).text();
	seenPrompt = '';
	assert.match(await generateContracts(), /event: run\.end/);
	assert.equal(seenPrompt, '', '合同转测试点无需调用模型');
	const contractPoints = (await api('artifacts.load', { module })).points;
	assert.equal(contractPoints.source_ecsm_digest, contractVersion.digest);
	assert.equal(contractPoints.source_kind, 'contracts');
	assert.equal(contractPoints.items.length, 2);
	assert.equal(contractPoints.items[0].transition_ref, 'FT.T01');
	assert.deepEqual(contractPoints.items.map((item) => item.contract_refs), [
		[firstContract.item.contract_id, secondContract.item.contract_id], [branch.item.contract_id]
	]);
	const invalidEdit = await (await send('/cts/api', { action: 'artifact.update', module, kind: 'points', id: 'T-0001', patch: { expected: '未经合同确认的预期' } })).json();
	assert.match(invalidEdit.error, /需求合同/);
	for (const item of contractPoints.items) await api('artifact.approve', { module, kind: 'points', id: item.point_id });
	assert.match(await (await send('/cts/api/generate', { module, kind: 'cases', draft: false })).text(), /event: run\.end/);
	const linkedCase = (await api('artifacts.load', { module })).cases.items.find((item) => item.point_id === 'T-0001');
	assert.ok(linkedCase.source_reference.includes(firstContract.item.contract_id));
	assert.ok(!(await api('pipeline.status', { module })).stale.includes('points'));
	await writeEvidence('操作依据已调整');
	const drift = await api('ecsm.view', { module });
	assert.equal(drift.drifted, true);
	assert.deepEqual(drift.model.inputs.contracts.items.map((item) => item.status), ['draft', 'stale', 'stale', 'stale']);
	assert.match(await generateContracts(), /产品模型有修改/);
	await api('ecsm.freeze', { module });
	assert.match(await generateContracts(), /请先确认需求合同/);
	const mismatch = await api('contracts.save', { module, patch: { ...patch, title: '不同预期', expected: '界面提示未确认' } });
	const queue = await api('conflicts.view', { module });
	const conflictSuggestion = queue.suggestions.find((item) => item.related && [item.contract_id, item.related.id].includes(mismatch.item.contract_id));
	assert.ok(conflictSuggestion, '相同条件和动作的不同预期应出现待核对建议');
	assert.equal(queue.items.length, 0, '系统建议不自动登记裁决');
	const recorded = await api('conflict.save', { module, version: queue.version, ...conflictSuggestion });
	assert.equal(recorded.items[0].status, 'open');
	assert.ok(!recorded.suggestions.some((item) => item.reason === conflictSuggestion.reason && item.contract_id === conflictSuggestion.contract_id));
	console.log('ECSM 双模块流程、合同确认与去重、证据变更、评审及历史图片导出通过');
	const nonCockpit = 'P-documents';
	const docDir = path.join(root, 'projects', nonCockpit);
	await fs.mkdir(path.join(docDir, 'prd'), { recursive: true });
	await fs.writeFile(path.join(docDir, 'project.json'), JSON.stringify({ id: nonCockpit, name: '归档审批', quality: { capabilities: ['text'] }, modules: [{ id: 'M-archive', name: '归档' }] }));
	const documentPath = path.join(docDir, 'prd', 'rules.md');
	await fs.writeFile(documentPath, '# 归档规则\n完成审批后归档，归档记录保留。');
	const ns = { project: nonCockpit, module: 'M-archive' };
	await api('evidence.build', ns);
	const sources = await api('sources.view', ns);
	await api('sources.save', { ...ns, version: sources.version, items: [{ path: 'prd/rules.md', role: 'requirement' }] });
	const runArchive = async (kind, fields = {}) => (await send('/cts/api/generate', { ...ns, kind, ...fields })).text();
	assert.match(await runArchive('facts'), /event: run\.end/);
	assert.match(await runArchive('features'), /event: run\.end/);
	const moduleModel = await api('ecsm.view', ns);
	const archId = moduleModel.model.features[0].feature_id;
	assert.match(await runArchive('contracts', { feature_ids: [archId] }), /event: run\.end/);
	const candidate = (await api('ecsm.view', ns)).model.inputs.contracts.items[0];
	assert.equal(candidate.status, 'draft');
	const archiveContract = await api('contracts.save', { ...ns, id: candidate.contract_id, patch: {
		...candidate, trigger: '运行归档或选择归档', verification: '人工查询归档记录', rule_ids: ['baseline']
	}, approve: true });
	await withModule('M-archive', async () => {
		await save(root, nonCockpit, 'features', { items: [...moduleModel.model.inputs.features.items, { feature_id: 'OTHER', name: '范围外', fact_refs: [] }] });
	});
	const conflict = await api('conflict.save', { ...ns, version: 0, contract_id: archiveContract.item.contract_id, kind: 'missing_evidence', reason: '确认归档记录要求' });
	assert.equal((await api('ecsm.view', ns)).model.inputs.contracts.items[0].status, 'stale');
	await api('conflict.save', { ...ns, version: conflict.version, id: conflict.items[0].id, conclusion: '以产品文档为准', reviewer: '评审人' });
	await api('contracts.save', { ...ns, id: archiveContract.item.contract_id, patch: archiveContract.item, approve: true });
	const archiveModel = await api('ecsm.freeze', ns);
	assert.deepEqual((await api('outline.view', ns)).features.map((item) => item.id), [archId]);
	const invalidScope = await send('/cts/api', { action: 'outline.save', ...ns, version: 0, model_digest: archiveModel.digest, scope: [archId, 'OTHER'], budget: 10 });
	assert.equal((await invalidScope.json()).ok, false);
	assert.equal((await api('outline.view', ns)).version, 0);
	const saveOutline = await api('outline.save', { ...ns, version: 0, model_digest: archiveModel.digest, scope: [archId], budget: 10 });
	const draftState = await api('artifacts.load', ns);
	assert.equal(draftState.outlineStatus.status, 'draft');
	assert.equal(draftState.delivery.blocker.step, 'outline');
	const blockedDelivery = await send('/cts/api', { action: 'package.freeze', ...ns });
	assert.equal((await blockedDelivery.json()).error, draftState.delivery.blocker.message);
	assert.equal(saveOutline.rows[0].state, 'missing');
	assert.equal(saveOutline.outline.outside[0].id, 'OTHER');
	const exportedOutline = await api('outline.export', ns);
	assert.equal((await api('outline.reviewPreview', { ...ns, file: exportedOutline.xmind })).changes.length, 0);
	assert.equal((await api('outline.reviewPreview', { ...ns, file: exportedOutline.xlsx })).changes.length, 0);
	const suggestion = await api('outline.reviewPreview', { ...ns, changes: [{ id: saveOutline.rows[0].scenario_id, action: 'edit', comment: '核对审批后归档' }] });
	await api('outline.apply', { ...ns, ...suggestion, reviewer: '评审人' });
	const updatedOutline = await api('outline.view', ns);
	assert.equal(updatedOutline.rows[0].requirement, '核对审批后归档');
	assert.equal(updatedOutline.outline.status, 'draft');
	await api('outline.approve', { ...ns, version: updatedOutline.version, model_digest: archiveModel.digest, reviewer: '评审人' });
	assert.equal((await api('artifacts.load', ns)).outlineStatus.status, 'approved');
	const generateArchive = async (kind) => (await send('/cts/api/generate', { ...ns, kind, draft: false, from_contracts: true })).text();
	assert.match(await generateArchive('points'), /"transitions":0,"transitionScope":"outline","covered":0/);
	await api('artifact.delete', { ...ns, kind: 'points', id: 'T-0001' });
	assert.equal((await api('outline.view', ns)).rows[0].state, 'missing');
	assert.match(await generateArchive('points'), /event: run\.end/);
	await api('artifact.approve', { ...ns, kind: 'points', id: 'T-0001' });
	assert.match(await generateArchive('cases'), /event: run\.end/);
	const draftExport = await api('artifacts.export', ns);
	const casePreview = await api('cases.reviewPreview', { ...ns, file: draftExport.file });
	assert.equal(casePreview.changes.length, 0);
	const newCases = (await api('artifacts.load', ns)).cases;
	assert.match(await (await send('/cts/api/review', ns)).text(), /event: run\.end/);
	const reviewedId = newCases.items[0].case_id;
	const recordOf = () => withModule('M-archive', () => loadReviews(root, nonCockpit)).items.find((entry) => entry.case_id === reviewedId);
	// 模型回执只是证据：写成 model，未经裁决不得批准。
	assert.equal(recordOf().review_kind, 'model');
	await assert.rejects(api('artifact.approve', { ...ns, kind: 'cases', id: reviewedId }), /未经独立裁决/);
	const sameCode = [{ code: 'STEP_NOT_OPERABLE', field: 'steps[0]', message: '甲：没写明地点' }, { code: 'STEP_NOT_OPERABLE', field: 'steps[1]', message: '乙：没写明幅度' }];
	const webRow = { case_id: reviewedId, review_conclusion: '待修改', review_comment: '两条同码意见', reviewer: 'agent:回流甲', findings: sameCode };
	const live = (await api('artifacts.load', ns)).cases;
	assert.equal((await api('cases.reviewPreview', { ...ns, rows: [webRow] })).changes.length, 1, 'web 意见应可预览');
	assert.equal(recordOf().review_kind, 'model', '预览不得写台账');
	await api('cases.reviewApply', { ...ns, version: live.version, digest: live.digest, rows: [webRow] });
	assert.deepEqual(recordOf().findings.map((entry) => entry.message), ['甲：没写明地点', '乙：没写明幅度'], 'web 入口同码两条须逐条留档');
	assert.equal(recordOf().variant_id, newCases.items[0].point_id, '回流须带变体锚');
	// Excel 入口：逐条发现列往返；坏 JSON 与空 message 都必须拒绝，不得静默丢意见。
	const excelFile = path.join(root, 'review-reflow.xlsx');
	const writeExcel = async (cell) => {
		const current = (await api('artifacts.load', ns)).cases;
		await fs.writeFile(excelFile, buildWorkbook([
			{ name: '评审基线', headers: ['用例版本', '内容摘要'], rows: [[current.version, current.digest]] },
			{ name: '测试用例', headers: ['用例ID', '评审结论', '修改意见', '评审人', '逐条发现'], rows: [[reviewedId, '待修改', '甲乙两条', 'agent:回流乙', cell]] }
		]));
		return current;
	};
	await writeExcel(JSON.stringify(sameCode));
	const excelPreview = await api('cases.reviewPreview', { ...ns, file: excelFile });
	assert.equal(excelPreview.rows[0].findings.length, 2, 'Excel 逐条发现须被解析');
	await api('cases.reviewApply', { ...ns, ...excelPreview });
	assert.deepEqual(recordOf().findings.map((entry) => entry.message), ['甲：没写明地点', '乙：没写明幅度'], 'Excel 入口同码两条须逐条留档');
	await writeExcel('{坏 JSON');
	await assert.rejects(api('cases.reviewPreview', { ...ns, file: excelFile }), /不是合法 JSON/);
	await writeExcel(JSON.stringify([{ code: 'X' }]));
	await assert.rejects(api('cases.reviewPreview', { ...ns, file: excelFile }), /没有一条含 message/);
	// 裁决通过后才可批准。
	const adjudicate = (await api('artifacts.load', ns)).cases;
	await api('cases.reviewApply', { ...ns, version: adjudicate.version, digest: adjudicate.digest,
		rows: [{ case_id: reviewedId, review_conclusion: '通过', review_comment: '逐条已关闭', reviewer: 'agent:裁决', findings: [] }] });
	assert.equal(recordOf().review_kind, 'content');
	await api('artifact.approve', { ...ns, kind: 'cases', id: reviewedId });
	const stalePreview = await (await send('/cts/api', { ...ns, action: 'cases.reviewApply', ...casePreview })).json();
	assert.match(stalePreview.error, /版本已变化/);
	assert.equal((await api('artifacts.load', ns)).delivery.blocker, null);
	const archivePackage = await api('package.freeze', ns);
	const frozenWorkbench = await api('workbench.state', ns);
	assert.equal(frozenWorkbench.state, 'frozen');
	assert.equal(frozenWorkbench.next_action.id, 'delivery');
	assert.deepEqual(frozenWorkbench.blockers, []);
	const archiveExport = await api('package.export', { ...ns, package_id: archivePackage.package_id, bundle: true });
	assert.match(await fs.readFile(archiveExport.html, 'utf8'), /图文用例 · 冻结交付[\s\S]*设计图证 · 不适用/);
	const structured = JSON.parse(await fs.readFile(archiveExport.json, 'utf8'));
	assert.equal(structured.outline.outside[0].id, 'OTHER');
	assert.equal(structured.evidence[0].source, 'prd/rules.md');
	assert.deepEqual(structured.cases.items[0].contract_refs, [archiveContract.item.contract_id]);
	await api('package.fork', { ...ns, note: '同一点两条路径回归' });
	variantFixture = true;
	assert.match(await runArchive('cases', { draft: false, replace: true }), /event: run\.end/);
	const variants = (await api('artifacts.load', ns)).cases;
	assert.equal(variants.items.length, 2);
	const click = variants.items.find((item) => item.case_role === 'click');
	const drag = variants.items.find((item) => item.case_role === 'drag');
	await api('cases.reviewApply', { ...ns, version: variants.version, digest: variants.digest,
		rows: [{ case_id: click.case_id, review_conclusion: '待修改', review_comment: '仅重做点击路径', reviewer: 'agent:裁决' },
			{ case_id: drag.case_id, review_conclusion: '通过', review_comment: '拖动已核验', reviewer: 'agent:裁决' }] });
	const variantReviews = withModule('M-archive', () => loadReviews(root, nonCockpit)).items;
	assert.equal(variantReviews.find((entry) => entry.case_id === click.case_id).variant_id, 'T-0001/click');
	assert.equal(variantReviews.find((entry) => entry.case_id === drag.case_id).variant_id, 'T-0001/drag');
	const reviewedDrag = (await api('artifacts.load', ns)).cases.items.find((item) => item.case_role === 'drag');
	for (const stage of ['contracts', 'outline', 'points']) {
		const log = await (await send('/cts/api/review', { ...ns, stage })).text();
		assert.match(log, /"published":true/);
		const report = await api('agent.review.view', { ...ns, stage });
		assert.equal(report.role, 'quality');
		assert.equal(report.items.length, 1);
	}
	const contractId = archiveContract.item.contract_id;
	reviewFinding = { id: contractId, findings: [{ code: 'TITLE', field: 'title', message: '标题应点明归档动作' }] };
	assert.match(await (await send('/cts/api/review', { ...ns, stage: 'contracts', object_ids: [contractId], reviewer: '定向审查' })).text(), /"published":true/);
	const contractSelection = { ...ns, stage: 'contracts', object_id: contractId, finding_indexes: [0] };
	const contractBase = await api('agent.review.repairPreview', contractSelection);
	const contractAdvice = await api('agent.review.suggest', { ...contractSelection, basis: contractBase.basis });
	assert.deepEqual(contractAdvice.changes.map((entry) => entry.field), ['title']);
	assert.match(seenPrompt, /角色：需求 Agent/);
	assert.equal((await api('agent.design.coverageAdvice', ns)).skill, 'cts-test-design');
	assert.equal((await api('agent.review.deliverySummary', ns)).skill, 'cts-review');
	await api('skills.replace', { name: 'cts-review', filename: 'review-test.md', content: '审查覆盖版本标记' });
	reviewFinding = { id: click.case_id, findings: [{ code: 'STEP_NOT_OPERABLE', field: 'S02', message: '只改点击',
		evidence_ref: 'E-9999', quote: '证据中没有这句话' }] };
	const scopedReview = await (await send('/cts/api/review', { ...ns, stage: 'cases', object_ids: [click.case_id] })).text();
	assert.match(scopedReview, /"published":true/);
	assert.match(seenPrompt, /审查覆盖版本标记/);
	const report = await api('agent.review.view', { ...ns, stage: 'cases' });
	assert.equal(report.items[0].conclusion, '待证据');
	assert.equal(report.items[0].findings[0].code, 'EVIDENCE_REQUIRED');
	assert.equal(report.items[0].findings[0].evidence_ref, undefined);
	assert.equal(withModule('M-archive', () => loadReviews(root, nonCockpit)).items.find((entry) => entry.case_id === click.case_id).review_kind, 'content');
	const selection = { object_id: click.case_id, finding_indexes: [0] };
	const preview = await api('agent.review.repairPreview', { ...ns, stage: 'cases', ...selection });
	const retry = { draft: false, retry_defective: true, case_ids: [click.case_id], point_ids: [click.point_id],
		review_repair: { ...selection, basis: preview.basis } };
	assert.match(await runArchive('cases', { ...retry, case_ids: [drag.case_id] }), /重新预览/);
	const retryLog = await runArchive('cases', retry);
	reviewFinding = null;
	await api('skills.restore', { name: 'cts-review' });
	assert.match(retryLog, /event: batch\.candidate_rejected[\s\S]*TRIGGER_MISSING/);
	assert.match(retryLog, /event: repair\.diff/);
	assert.match(retryLog, /event: run\.end/);
	const retried = (await api('artifacts.load', ns)).cases.items;
	assert.equal(retried.length, 2);
	assert.equal(retried.find((item) => item.case_role === 'click').title, '点击重做');
	assert.equal(retried.find((item) => item.case_role === 'click').case_id, click.case_id);
	assert.deepEqual(retried.find((item) => item.case_role === 'drag'), reviewedDrag);
	assert.equal((await api('agent.review.view', { ...ns, stage: 'cases' })).stale, true);
	const replayedExport = await api('package.export', { ...ns, package_id: archivePackage.package_id, bundle: true });
	assert.deepEqual(JSON.parse(await fs.readFile(replayedExport.json, 'utf8')), structured);
	assert.equal(await fs.readFile(replayedExport.html, 'utf8'), await fs.readFile(archiveExport.html, 'utf8'));
	assert.deepEqual(parseXlsx(await fs.readFile(replayedExport.xlsx)), parseXlsx(await fs.readFile(archiveExport.xlsx)));
	variantFixture = false;
	const generatePath = (action) => runArchive('cases', { draft: false, point_ids: ['T-0001'], case_variant: { point_id: 'T-0001', action } });
	assert.match(await generatePath('原文未规定的操作'), /请选择同一已批准测试点/);
	assert.match(await generatePath('运行归档'), /"completed_ids":\["T-0001"\]/);
	assert.match(await generatePath('选择归档'), /"completed_ids":\["T-0001"\]/);
	const separatePaths = (await api('artifacts.load', ns)).cases.items.filter((item) => item.variant_action);
	assert.deepEqual(separatePaths.map((item) => [item.case_role, item.variant_action]), [['path-1', '运行归档'], ['path-2', '选择归档']]);
	await fs.writeFile(documentPath, '# 归档规则\n审批后生成归档审计记录。');
	await api('evidence.build', ns);
	assert.equal((await api('evidence.read', { ...ns, id: 'E-0001' })).historical, true);
	assert.equal((await api('ecsm.view', ns)).drifted, true);
	const afterSourceChange = await api('package.export', { ...ns, package_id: archivePackage.package_id, bundle: true });
	assert.deepEqual(JSON.parse(await fs.readFile(afterSourceChange.json, 'utf8')), structured);
	assert.equal(await fs.readFile(afterSourceChange.html, 'utf8'), await fs.readFile(archiveExport.html, 'utf8'));
	assert.deepEqual(parseXlsx(await fs.readFile(afterSourceChange.xlsx)), parseXlsx(await fs.readFile(archiveExport.xlsx)));
	console.log('纯文档项目：来源版本、裁决、范围大纲、XMind/Excel 往返、删除重现缺口、交付包通过');

	const uiProject = 'P-approval-ui';
	const uiDir = path.join(root, 'projects', uiProject);
	const uiScope = { project: uiProject, module: 'M-approval' };
	await fs.mkdir(uiDir, { recursive: true });
	await fs.writeFile(path.join(uiDir, 'project.json'), JSON.stringify({ id: uiProject, name: '审批界面', modules: [{ id: uiScope.module, name: '审批' }] }));
	await withModule(uiScope.module, async () => {
		await save(root, uiProject, 'points', { items: [{ point_id: 'T-0001' }] });
		await save(root, uiProject, 'cases', { items: [{ case_id: 'C-0001', point_id: 'T-0001',
			steps: ['S01. 点击【提交审批】控件'], expected: 'S01-1. 界面显示【审批成功】' }] });
	});
	const box = { x: 0, y: 0, width: 1, height: 1 };
	const nodes = [['approval', 'page', '审批详情'], ['submit', 'approval', '提交审批'], ['success', 'page', '审批成功']]
		.map(([id, parent, name]) => ({ id, parent, name, type: 'FRAME', box, visible: true }));
	const source = { name: '审批界面', fileKey: 'approval', pages: ['page'] };
	saveMcpDesign(root, uiProject, source, [{ id: 'page', name: '审批', nodes }]);
	const [design] = layerSources(root, uiProject);
	await withModule(uiScope.module, () => save(root, uiProject, 'design-sources', {
		items: [{ source_id: design.id, version: design.revision, kind: 'pixso-mcp' }]
	}));
	saveMcpDesign(root, uiProject, { ...source, name: '另一模块的设计', fileKey: 'other' }, [{ id: 'page', name: '另一模块', nodes }]);
	await api('evidence.build', uiScope);
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
	for (const id of ['approval', 'success']) {
		const { file } = previewFile(uiDir, design, id);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, png);
	}
	assert.deepEqual((await api('cases.imageAuto', uiScope)).updated, ['C-0001']);
	const approval = (await api('artifacts.load', uiScope)).cases.items[0];
	assert.ok(approval.image_refs.some((figure) => figure.role === '操作定位' && figure.node_id === 'submit'));
	assert.ok(approval.image_refs.some((figure) => figure.role === '预期界面参考' && figure.node_id === 'success'));
	assert.ok(approval.image_refs.every((figure) => !figure.source_id || figure.source_id === design.id));
	assert.deepEqual((await api('cases.imageAuto', uiScope)).updated, [], '重复补图不重复修改用例');
	saveMcpDesign(root, uiProject, source, [{ id: 'page', name: '审批', nodes }]);
	assert.equal((await api('artifacts.load', uiScope)).delivery.staleImages['C-0001'], undefined, '已选旧版仍然有效');
	await api('evidence.build', uiScope);
	const next = layerSources(root, uiProject).find((entry) => entry.id === design.id);
	await withModule(uiScope.module, () => save(root, uiProject, 'design-sources', {
		items: [{ source_id: next.id, version: next.revision, kind: 'pixso-mcp' }]
	}));
	assert.ok((await api('artifacts.load', uiScope)).delivery.staleImages['C-0001']);
	console.log('审批项目后台补图、重复运行及设计稿版本检查通过');
} finally {
	host?.closeAllConnections();
	if (host) await new Promise((resolve) => host.close(resolve));
	cleanup.reverse().forEach((dispose) => dispose());
	await fs.rm(root, { recursive: true, force: true });
}
