import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { save, load, digestOf } from '../artifacts.js';
import { withModule } from '../scope.js';
import { saveStates } from '../states.js';
import { caseContentDigest, loadReviews, recordReview } from '../quality-gate.js';
import { listRuns } from '../case-runs.js';

/**
 * G0: one failed point must not produce a filler case, must not approve anything,
 * and a retry on the same baseline must only fill the gap while keeping the
 * successful cases byte-identical.
 */
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-g0-'));
const project = 'P-g0';
const module = 'M-main';
const dir = path.join(root, 'projects', project);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); assert.ok(ok, name + (detail ? ' · ' + detail : '')); };

const points = [
	{ point_id: 'T-0001', requirement: '吹脚选中', condition: '空调处于吹脚出风模式', action: '单击【吹脚】开关一次', expected: '吹脚图标显示选中', fact_refs: ['F-0001'], review_status: 'approved', priority: 'P1' },
	{ point_id: 'T-0002', requirement: '吹面选中', condition: '空调处于吹面出风模式', action: '单击【吹面】开关一次', expected: '吹面图标显示选中', fact_refs: ['F-0002'], review_status: 'approved', priority: 'P1' },
	{ point_id: 'T-0003', requirement: '除霜请求', condition: '前除霜关闭', action: '单击 Dock【快速除雾】一次', expected: '发出进入快速除霜请求', fact_refs: ['F-0003'], review_status: 'approved', priority: 'P1' }
];
const caseFor = (point) => ({
	point_id: point.point_id, title: point.requirement, type: '状态显示', priority: 'P1',
	precondition: point.condition,
	prepare_detail: `记录初态：${point.condition}；无法读回则停止`,
	steps: [`在空调界面确认初态：${point.condition}`, point.action, '观察目标图标并记录'],
	expected: `观察目标图标：${point.expected}`,
	restore_steps: ['按记录的初态恢复并读回'], failure_policy: '记录实际结果与证据后停止',
	basis: `依据测试点 ${point.point_id}、事实 ${point.fact_refs.join('、')}`
});

let call = 0;
let firstCaseCall = true;
let throwBudget = 0;
let failMode = 'omit-second';
let omitPoint = null;
const llm = {
	listProviders: () => [{ id: 'test' }],
	listModels: async () => [{ id: 'test' }],
	resolveModelInfo: async () => ({ inputModalities: ['text'] }),
	async *stream(request) {
		const input = JSON.stringify(request.messages);
		if (input.includes('每条测试点生成一条用例')) {
			call += 1;
			const first = firstCaseCall;
			firstCaseCall = false;
			if (throwBudget > 0) { throwBudget -= 1; throw new Error('模拟模型 429'); }
			const requested = [...new Set([...input.matchAll(/\[(T-\d{4})\]/g)].map((match) => match[1]))];
			const wanted = points.filter((point) => requested.includes(point.point_id) && point.point_id !== omitPoint && !(first && failMode === 'omit-second' && point.point_id === 'T-0002'));
			yield { type: 'text-delta', text: JSON.stringify({ cases: wanted.map(caseFor) }) };
			return;
		}
		if (input.includes('receipts')) {
			const ids = [...new Set([...input.matchAll(/\[(C-\d{4})\]/g)].map((match) => match[1]))];
			yield { type: 'text-delta', text: JSON.stringify({ receipts: ids.map((case_id) => ({ case_id, conclusion: '通过', findings: [] })) }) };
			return;
		}
		yield { type: 'text-delta', text: JSON.stringify({ points: [] }) };
	}
};
const routes = new Map();
const cleanup = [];
let host;
try {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ id: project, name: 'G0', modules: [{ id: module, name: '空调' }] }));
	await withModule(module, async () => {
		const facts = points.map((point, index) => ({ fact_id: `F-000${index + 1}`, type: 'rule', statement: point.expected, evidence_refs: ['E-0001'] }));
		const features = [{ feature_id: 'FT', name: '出风模式', fact_refs: facts.map((fact) => fact.fact_id) }];
		await save(root, project, 'facts', { items: facts });
		await save(root, project, 'features', { items: features });
		saveStates(root, project, [{ feature_id: 'FT', states: [{ state_id: 'S1', name: '就绪' }], transitions: [] }], { source_facts_digest: digestOf(facts), source_features_digest: digestOf(features) });
	});
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
	const post = (route, fields) => fetch(base + route, { method: 'POST', body: JSON.stringify({ project, module, ...fields }) });
	const raw = async (action, fields) => (await post('/cts/api', { action, ...fields })).json();
	const api = async (action, fields) => { const result = await raw(action, fields); assert.ok(result.ok, action + ': ' + JSON.stringify(result)); return result.state; };
	const events = async (kind, fields = {}) => {
		const text = await (await post('/cts/api/generate', { kind, draft: false, ...fields })).text();
		const parsed = {};
		for (const block of text.split('\n\n')) {
			const [event, data] = block.split('\n');
			if (!data?.startsWith('data: ')) continue;
			parsed[event.replace('event: ', '')] = JSON.parse(data.slice(6));
		}
		return { text, parsed };
	};

	const frozen = await api('ecsm.freeze');
	await withModule(module, async () => {
		await save(root, project, 'points', { items: points, meta: { source_ecsm_digest: frozen.digest, source_ecsm_version: frozen.version, source_kind: 'facts' } });
	});

	// ---- first run: point 2 never comes back -------------------------------
	const first = await events('cases', { replace: true });
	const end = first.parsed['run.end'];
	check('G0 首次生成返回批次清单', Boolean(end?.run_id && end?.baseline_digest), JSON.stringify(end?.completed_ids));
	check('G0 成功 2 条', end.completed_ids.length === 2 && end.completed_ids.includes('T-0001') && end.completed_ids.includes('T-0003'), JSON.stringify(end.completed_ids));
	check('G0 待重试 1 条', end.pending_ids.length === 1 && end.pending_ids[0] === 'T-0002', JSON.stringify(end.pending_ids));
	check('G0 失败名单含 T-0002', end.failed_ids.includes('T-0002'), JSON.stringify(end.failed_ids));
	let state = await api('artifacts.load');
	check('G0 替补用例 0 条', state.cases.items.length === 2, String(state.cases.items.length));
	check('G0 自动批准 0 条', state.cases.items.every((item) => item.review_status !== 'approved'), JSON.stringify(state.cases.items.map((item) => item.review_status)));
	check('G0 没有复制测试点的补数用例', state.cases.items.every((item) => (item.steps || []).length > 1));
	const kept = state.cases.items.map((item) => ({ case_id: item.case_id, point_id: item.point_id, digest: caseContentDigest(item), figures: (item.image_refs || []).map((figure) => [figure.role, figure.step_id, figure.expected_id, figure.file]) }));
	const runs = await withModule(module, async () => listRuns(root, project));
	check('G0 运行清单落盘', runs.length === 1 && runs[0].batches.length === 1 && runs[0].pending_ids.includes('T-0002'));

	// ---- draft export must advertise the gap -------------------------------
	const bundle = await api('artifacts.exportBundle', { label: 'g0-draft' });
	const draftHtml = await fs.readFile(bundle.html, 'utf8');
	check('G0 草稿页首标候选／未跑台架', /候选／未跑台架/.test(draftHtml));
	check('G0 草稿显示三类计数', /已完成 <b>2<\/b>/.test(draftHtml) && /生成失败待重试 <b>1<\/b>/.test(draftHtml) && /未生成 <b>1<\/b>/.test(draftHtml), draftHtml.slice(0, 400));
	check('G0 草稿带缺口表', /缺口表/.test(draftHtml) && /T-0002/.test(draftHtml));
	check('G0 草稿 JSON 标候选', JSON.parse(await fs.readFile(bundle.json, 'utf8')).status === 'candidate');
	if (process.argv[2]) {
		await fs.mkdir(process.argv[2], { recursive: true });
		await fs.copyFile(bundle.html, path.join(process.argv[2], '草稿样例.html'));
	}

	// ---- approval gates ----------------------------------------------------
	const target = state.cases.items[0].case_id;
	const noReview = await raw('artifact.approve', { kind: 'cases', id: target });
	check('G0 无评审记录不得批准', noReview.ok === false && /缺少本版本的逐例评审记录/.test(noReview.error), noReview.error);
	await withModule(module, async () => recordReview(root, project, { case_id: target, case_digest: caseContentDigest(state.cases.items[0]), review_kind: 'lint', conclusion: '结构检查通过', reviewer: 'linter' }));
	const lintOnly = await raw('artifact.approve', { kind: 'cases', id: target });
	check('G0 结构检查通过仍是候选', lintOnly.ok === false && /只有结构检查记录/.test(lintOnly.error), lintOnly.error);
	await withModule(module, async () => recordReview(root, project, { case_id: target, case_digest: '0'.repeat(64), review_kind: 'content', conclusion: '通过', reviewer: '旧基线评审' }));
	const stale = await raw('artifact.approve', { kind: 'cases', id: target });
	check('G0 旧基线评审意见被拒绝', stale.ok === false && /评审记录对应旧内容/.test(stale.error), stale.error);
	await withModule(module, async () => recordReview(root, project, { case_id: target, case_digest: caseContentDigest(state.cases.items[0]), review_kind: 'content', conclusion: '通过', reviewer: '独立评审' }));
	const good = await raw('artifact.approve', { kind: 'cases', id: target });
	check('G0 本版本内容评审后可批准', good.ok === true, JSON.stringify(good.error || ''));

	// ---- retry on the same baseline ---------------------------------------
	call = 0;
	const second = await events('cases', { replace: false });
	const end2 = second.parsed['run.end'];
	state = await api('artifacts.load');
	check('G0 重试后同基线恰 3 条', state.cases.items.length === 3, String(state.cases.items.length));
	check('G0 重试只补失败项', end2.completed_ids.length === 1 && end2.completed_ids[0] === 'T-0002', JSON.stringify(end2.completed_ids));
	check('G0 重试后待办清空', end2.pending_ids.length === 0, JSON.stringify(end2.pending_ids));
	const after = state.cases.items.map((item) => ({ case_id: item.case_id, point_id: item.point_id, digest: caseContentDigest(item), figures: (item.image_refs || []).map((figure) => [figure.role, figure.step_id, figure.expected_id, figure.file]) }));
	for (const before of kept) {
		const now = after.find((entry) => entry.case_id === before.case_id);
		check(`G0 成功项 ${before.case_id} ID 与内容不变`, now && now.point_id === before.point_id && now.digest === before.digest, now ? now.digest.slice(0, 12) + ' vs ' + before.digest.slice(0, 12) : '丢失');
		check(`G0 成功项 ${before.case_id} 配图锚点不变`, now && JSON.stringify(now.figures) === JSON.stringify(before.figures));
	}
	check('G0 重试不新增重复条数', new Set(state.cases.items.map((item) => item.point_id)).size === 3);

	// ---- 限定范围的重试取「所选 ∩ 缺陷」，范围外一条都不动 -------------------
	const outside = state.cases.items.find((item) => item.point_id === 'T-0001');
	const outsideDigest = caseContentDigest(outside);
	const untouchedBefore = state.cases.items.filter((item) => item.point_id !== 'T-0003').map((item) => [item.case_id, caseContentDigest(item)]);
	await withModule(module, async () => recordReview(root, project, { case_id: outside.case_id, variant_id: outside.point_id,
		case_digest: outsideDigest, review_kind: 'content', conclusion: '待修改', reviewer: '独立评审', fields: { STEP_NOT_OPERABLE: '没写在哪读' } }));
	const scoped = await events('cases', { retry_defective: true, point_ids: ['T-0003'] });
	const scopedEnd = scoped.parsed['run.end'];
	state = await api('artifacts.load');
	check('G0 限定范围重试不重做范围外退回项', !(scopedEnd?.completed_ids || []).includes('T-0001'), JSON.stringify(scopedEnd?.completed_ids));
	check('G0 限定范围重试不丢用例', state.cases.items.length === 3, String(state.cases.items.length));
	const untouchedAfter = state.cases.items.filter((item) => item.point_id !== 'T-0003').map((item) => [item.case_id, caseContentDigest(item)]);
	check('G0 只选 1 个点时其余用例内容摘要不变', JSON.stringify(untouchedAfter) === JSON.stringify(untouchedBefore), JSON.stringify(untouchedAfter));
	check('G0 范围外缺陷被如实计数而非静默跳过', (scoped.parsed['cases.defective']?.out_of_scope ?? 0) >= 1, JSON.stringify(scoped.parsed['cases.defective']));

	// ---- 生成失败后原用例仍可读：新候选成功才替换 ---------------------------
	const doomed = state.cases.items.find((item) => item.point_id === 'T-0003');
	const doomedDigest = caseContentDigest(doomed);
	await withModule(module, async () => recordReview(root, project, { case_id: doomed.case_id, variant_id: doomed.point_id,
		case_digest: doomedDigest, review_kind: 'content', conclusion: '待修改', reviewer: '独立评审', fields: { NO_REF: '缺依据' } }));
	omitPoint = 'T-0003';
	const failedRun = await events('cases', { retry_defective: true, point_ids: ['T-0003'] });
	state = await api('artifacts.load');
	const survivor = state.cases.items.find((item) => item.point_id === 'T-0003');
	check('G0 生成失败后原用例仍在', Boolean(survivor), JSON.stringify(failedRun.parsed['run.end']?.failed_ids));
	check('G0 生成失败后原用例内容不变', survivor && caseContentDigest(survivor) === doomedDigest,
		survivor ? Object.keys(survivor).filter((key) => JSON.stringify(survivor[key]) !== JSON.stringify(doomed[key])).join(',') || '摘要不同但字段相同' : '丢失');
	omitPoint = null;

	// ---- point-copy filler can never be approved ---------------------------
	await withModule(module, async () => {
		const doc = await load(root, project, 'cases');
		const { items, version, updatedAt, digest, ...meta } = doc;
		items.push({ case_id: 'C-9001', point_id: 'T-0002', title: '复制补数', precondition: points[1].condition, steps: [points[1].action], expected: points[1].expected, basis: '依据 F-0002', review_status: 'candidate' });
		await save(root, project, 'cases', { version, items, meta });
	});
	const copyApprove = await raw('artifact.approve', { kind: 'cases', id: 'C-9001' });
	check('G0 复制测试点的用例不得批准', copyApprove.ok === false && /复制成唯一步骤/.test(copyApprove.error), copyApprove.error);
	const freeze = await raw('package.freeze', {});
	check('G0 冻结被拒绝', freeze.ok === false, freeze.error);
	const audited = await api('artifacts.load');
	check('G0 审计列出未展开用例', audited.delivery.approvals.unexpanded.includes('C-9001'), JSON.stringify(audited.delivery.approvals.unexpanded));

	// ---- model failure keeps the already completed batches ------------------
	await withModule(module, async () => {
		const doc = await load(root, project, 'cases');
		const { items, version, updatedAt, digest, ...meta } = doc;
		await save(root, project, 'cases', { version, items: items.filter((item) => item.case_id !== 'C-9001' && item.point_id !== 'T-0002'), meta });
	});
	const beforeFailure = (await api('artifacts.load')).cases.items.map((item) => caseContentDigest(item));
	call = 0;
	firstCaseCall = true;
	failMode = 'throw-second';
	throwBudget = 3;
	const third = await events('cases', { replace: false });
	check('G0 模型异常上报失败批次', Boolean(third.parsed['batch.failed']), JSON.stringify(Object.keys(third.parsed)));
	const afterFailure = (await api('artifacts.load')).cases.items;
	check('G0 模型异常不丢已完成批次', afterFailure.length === 2 && beforeFailure.every((digest) => afterFailure.some((item) => caseContentDigest(item) === digest)), JSON.stringify(afterFailure.map((item) => item.case_id)));
	check('G0 失败后缺口仍可见', third.parsed['run.end'].pending_ids.includes('T-0002'), JSON.stringify(third.parsed['run.end'].pending_ids));
	const runsAfter = await withModule(module, async () => listRuns(root, project));
	check('G0 失败批次写入清单', runsAfter.at(-1).batches.some((batch) => batch.status === 'failed'), JSON.stringify(runsAfter.at(-1).batches));

	const out = process.argv[2];
	if (out) {
		await fs.mkdir(out, { recursive: true });
		await fs.writeFile(path.join(out, 'g0-results.json'), JSON.stringify({ at: new Date().toISOString(), root, checks: results }, null, 1));
		await fs.writeFile(path.join(out, 'batches.jsonl'), await fs.readFile(path.join(root, 'artifacts', project, module, 'case-runs', 'batches.jsonl'), 'utf8'));
	}
	console.log(JSON.stringify({ passed: results.length, failed: 0, root }));
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	for (const dispose of cleanup) await Promise.resolve(dispose()).catch(() => {});
	if (!process.argv[2]) await fs.rm(root, { recursive: true, force: true });
}