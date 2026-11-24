/**
 * C 阶段回归：变体锚首审、语义退回可定向重做、评审逐 ID 回执。
 *   node cts-agent/scripts/test-review-gate.mjs
 * 全部在临时目录造数据，不碰真实项目。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enterModule } from '../scope.js';
import { recordReviews, loadReviews, firstReviewStats, approvalGate, caseContentDigest, PASS, validateReceipts, loadReviewPages, saveReviewPage, reviewConfigKey } from '../quality-gate.js';
import { digestOf, reviewPrompt, applyPatch, structureCase, normalizeCaseStructure } from '../artifacts.js';

const results = [];
const check = (name, fn) => {
	try { fn(); results.push({ name, ok: true }); }
	catch (error) { results.push({ name, ok: false, error: error.message }); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-review-'));
const project = 'P-test';
enterModule('M-test');
const dir = path.join(tmp, 'artifacts', project, 'M-test');
fs.mkdirSync(dir, { recursive: true });

const caseOf = (id, pointId, text) => ({ case_id: id, point_id: pointId, title: text, structured: true,
	step_items: [{ id: 's1', key: 'read', text, index: 1, role: 'observe', anchor: 'S01' }],
	expected_items: [{ id: 'e1', object: '状态', target: '已提交', kind: 'ui_immediate', step_id: 's1', trigger_step_id: '' }] });

const gateContext = (item, reviews) => {
	const point = { point_id: item.point_id, review_status: 'approved', action: '单击【提交】', expected_items: [] };
	const points = { items: [point] };
	return { reviews, errors: [], point, points, cases: { items: [item], source_points_digest: digestOf(points.items) } };
};

const oldCase = caseOf('C-0001', 'T-0001', '在审批列表页观察文档状态');
const newCase = caseOf('C-0020', 'T-0001', '在审批列表页观察文档状态，并记录提交时间');

check('首审按变体保留：换号后的通过不能掩盖旧号的退回', () => {
	recordReviews(tmp, project, [{ case_id: 'C-0001', variant_id: 'T-0001', case_digest: caseContentDigest(oldCase), review_kind: 'content', conclusion: '待修改', reviewer: 'r1', fields: { STEP_NOT_OPERABLE: '没写在哪读' } }]);
	recordReviews(tmp, project, [{ case_id: 'C-0020', variant_id: 'T-0001', case_digest: caseContentDigest(newCase), review_kind: 'content', conclusion: '通过', reviewer: 'r1' }]);
	const doc = loadReviews(tmp, project);
	assert.equal(doc.items.length, 2, '两条记录都应保留，不合并覆盖');
	const byCase = doc.items.filter((r) => PASS.has(r.first_result || r.conclusion)).length;
	assert.equal(byCase, 1, '按编号看有 1 条通过');
	const stats = firstReviewStats(doc);
	assert.equal(stats.denominator, 1, '同一变体只算一个分母');
	assert.equal(stats.passed, 0, '变体首审是退回，不是通过');
	assert.equal(stats.rows[0].case_id, 'C-0001');
});

check('缺 variant_id 时由调用方按测试点补齐', () => {
	const doc = { items: [
		{ case_id: 'C-0001', case_digest: 'a', review_kind: 'content', conclusion: '待修改', first_result: '待修改', first_at: '2026-11-18T01:00:00Z' },
		{ case_id: 'C-0020', case_digest: 'b', review_kind: 'content', conclusion: '通过', first_result: '通过', first_at: '2026-11-18T02:00:00Z' }
	] };
	const stats = firstReviewStats(doc, new Map([['C-0001', 'T-0001'], ['C-0020', 'T-0001']]));
	assert.equal(stats.denominator, 1);
	assert.equal(stats.passed, 0);
});

check('真正首次即通过的变体计入分子', () => {
	recordReviews(tmp, project, [{ case_id: 'C-0030', variant_id: 'T-0002', case_digest: 'x', review_kind: 'content', conclusion: '通过', reviewer: 'r1' }]);
	const stats = firstReviewStats(loadReviews(tmp, project));
	assert.equal(stats.denominator, 2);
	assert.equal(stats.passed, 1);
});

check('同一变体多次返工只保留最早事件', () => {
	recordReviews(tmp, project, [{ case_id: 'C-0030', variant_id: 'T-0002', case_digest: 'y', review_kind: 'content', conclusion: '待修改', reviewer: 'r1' }]);
	const stats = firstReviewStats(loadReviews(tmp, project));
	assert.equal(stats.passed, 1, '后来的退回不能抹掉首次通过');
	assert.equal(stats.denominator, 2);
});

check('模型与校验回执不计作正式首审，待审变体留在范围分母', () => {
	const doc = { items: [{ case_id: 'C-0001', variant_id: 'T-0001', review_kind: 'content',
		at: '2026-11-19T02:00:00Z', conclusion: '待修改',
		history: [{ at: '2026-11-19T01:00:00Z', review_kind: 'model', conclusion: '通过' }] },
	{ case_id: 'C-0002', variant_id: 'T-0002', review_kind: 'model', at: '2026-11-19T02:00:00Z', conclusion: '通过' }] };
	const stats = firstReviewStats(doc, new Map(), new Set(['T-0001', 'T-0002']));
	assert.equal(stats.denominator, 2);
	assert.equal(stats.reviewed, 1);
	assert.equal(stats.passed, 0);
});

check('语义退回但结构合格的用例仍被批准闸门拦住', () => {
	const item = { ...newCase, review_status: 'approved' };
	const reviews = { items: [{ case_id: item.case_id, variant_id: item.point_id, case_digest: caseContentDigest(item), review_kind: 'content', conclusion: '待修改', fields: { EXPECTED_VAGUE: '没写具体状态' } }] };
	const gate = approvalGate(item, gateContext(item, reviews));
	assert.equal(gate.ok, false, '内容退回必须阻止批准');
});

check('本版内容评审通过才可批准', () => {
	const item = { ...newCase, review_status: 'approved' };
	const reviews = { items: [{ case_id: item.case_id, variant_id: item.point_id, case_digest: caseContentDigest(item), review_kind: 'content', conclusion: '通过' }] };
	const gate = approvalGate(item, gateContext(item, reviews));
	assert.equal(gate.ok, true, gate.reasons.join(','));
});

check('旧摘要的评审不能批准新内容', () => {
	const item = { ...newCase, review_status: 'approved' };
	const reviews = { items: [{ case_id: item.case_id, variant_id: item.point_id, case_digest: '0'.repeat(64), review_kind: 'content', conclusion: '通过' }] };
	assert.equal(approvalGate(item, gateContext(item, reviews)).ok, false);
});

check('结构检查通过不算内容批准', () => {
	const item = { ...newCase, review_status: 'approved' };
	const reviews = { items: [{ case_id: item.case_id, variant_id: item.point_id, case_digest: caseContentDigest(item), review_kind: 'lint', conclusion: '结构检查通过' }] };
	assert.equal(approvalGate(item, gateContext(item, reviews)).ok, false);
});

check('模型原始回执的「通过」不算裁决，不能批准', () => {
	const item = { ...newCase, review_status: 'approved' };
	const record = { case_id: item.case_id, variant_id: item.point_id, case_digest: caseContentDigest(item), conclusion: '通过', reviewer: '独立评审模型' };
	const raw = approvalGate(item, gateContext(item, { items: [{ ...record, review_kind: 'model' }] }));
	assert.equal(raw.ok, false, '未经裁决的模型通过不得具备批准资格');
	assert.match(raw.reasons.join(','), /未经独立裁决/);
	// 同一内容经裁决写成 content 后才可批准。
	assert.equal(approvalGate(item, gateContext(item, { items: [{ ...record, review_kind: 'content', reviewer: 'agent:qoder-cn' }] })).ok, true);
});

check('评审提示词的锚点标号与步骤行一致，空触发不写成 S0', () => {
	const item = { ...newCase, expected_items: [{ ...newCase.expected_items[0], trigger_step_index: 0, step_index: 1 }] };
	const prompt = reviewPrompt([item]);
	assert.match(prompt, /S01 \[observe\]/);
	assert.match(prompt, /触发 无独立触发（只读观察） → 观察 S01/);
	assert.equal(/S0\b/.test(prompt), false, '不得出现不存在的 S0 标号');
});

check('评审提示词里未解析的观察锚点写明未解析', () => {
	const item = { ...newCase, expected_items: [{ ...newCase.expected_items[0], trigger_step_index: 2, step_index: 0 }] };
	assert.match(reviewPrompt([item]), /触发 S02 → 观察 未解析/);
});

const receipt = (id, findings = []) => ({ case_id: id, conclusion: findings.length ? '待修改' : '通过', findings });
const finding = (code, message) => ({ code, field: 'steps[0]', message });

check('漏答的用例不得被当成通过', () => {
	assert.throws(() => validateReceipts({ receipts: [receipt('C-0001')] }, ['C-0001', 'C-0002']), /回执缺少用例编号：C-0002/);
});

check('外来编号与重复编号都退回整页', () => {
	assert.throws(() => validateReceipts({ receipts: [receipt('C-0001'), receipt('C-9999')] }, ['C-0001']), /未请求的用例编号：C-9999/);
	assert.throws(() => validateReceipts({ receipts: [receipt('C-0001'), receipt('C-0001')] }, ['C-0001']), /重复返回用例编号：C-0001/);
});

check('结论与发现条数不一致的回执被拒', () => {
	assert.throws(() => validateReceipts({ receipts: [{ case_id: 'C-0001', conclusion: '通过', findings: [finding('NO_REF', '缺依据')] }] }, ['C-0001']), /结论与发现条数不一致/);
	assert.throws(() => validateReceipts({ receipts: [{ case_id: 'C-0001', conclusion: '待修改', findings: [] }] }, ['C-0001']), /结论与发现条数不一致/);
});

check('同码三条逐条留档，不被压成一条', () => {
	const rows = validateReceipts({ receipts: [receipt('C-0001', [finding('STEP_NOT_OPERABLE', '一'), finding('STEP_NOT_OPERABLE', '二'), finding('STEP_NOT_OPERABLE', '三')])] }, ['C-0001']);
	assert.equal(rows[0].findings.length, 3);
	recordReviews(tmp, project, [{ case_id: 'C-0001', variant_id: 'T-0001', case_digest: 'd', review_kind: 'content', conclusion: '待修改', reviewer: 'r', findings: rows[0].findings }]);
	const stored = loadReviews(tmp, project).items.find((entry) => entry.case_id === 'C-0001');
	assert.equal(stored.findings.length, 3, '落盘后仍须是 3 条');
	assert.deepEqual(stored.findings.map((entry) => entry.message), ['一', '二', '三']);
});

check('成功页按基线留档，重跑只补失败页', () => {
	const ids = ['C-0001', 'C-0002'];
	saveReviewPage(tmp, project, { baseline: 'b1', config: 'c1', ids, receipts: ids.map((id) => receipt(id)) });
	const document = loadReviewPages(tmp, project);
	assert.equal(Object.keys(document.pages).length, 1);
	assert.deepEqual(document.pages[digestOf(ids)].ids, ids);
	saveReviewPage(tmp, project, { baseline: 'b1', config: 'c1', ids: ['C-0003'], receipts: [receipt('C-0003')] });
	assert.equal(Object.keys(loadReviewPages(tmp, project).pages).length, 2, '第二页失败后补跑不得清掉第一页');
});

check('内容基线或评审配置改变后旧回执不再复用', () => {
	saveReviewPage(tmp, project, { baseline: 'b1', config: 'c1', ids: ['C-0001'], receipts: [receipt('C-0001')] });
	saveReviewPage(tmp, project, { baseline: 'b2', config: 'c1', ids: ['C-0002'], receipts: [receipt('C-0002')] });
	const afterBaseline = loadReviewPages(tmp, project);
	assert.equal(afterBaseline.baseline, 'b2');
	assert.equal(Object.keys(afterBaseline.pages).length, 1, '换基线必须丢掉旧页');
	saveReviewPage(tmp, project, { baseline: 'b2', config: 'c2', ids: ['C-0003'], receipts: [receipt('C-0003')] });
	assert.equal(Object.keys(loadReviewPages(tmp, project).pages).length, 1, '换评审配置必须丢掉旧页');
});

check('结构化判据可经 artifact.update 修订，旧字符串同步重渲染', () => {
	const doc = { items: [{ case_id: 'C-0001', point_id: 'T-0001', structured: true, precondition: '已上电',
		step_items: [{ id: 's1', key: 'a', text: '在空调界面观察【开关】显示', index: 1, role: 'observe', anchor: 'S01' }],
		expected_items: [{ id: 'e1', object: '开关', target: '默认状态', kind: 'state_observation', text: '开关：默认状态',
			step_id: 's1', step_index: 1, trigger_step_id: '', trigger_step_index: 0, evidence_ref: 'E-1', unresolved: '形态未定义' }],
		expected: 'S01-1. 开关：默认状态', steps: ['S01. 在空调界面观察【开关】显示'] }] };
	const patched = applyPatch(doc, 'C-0001', { expected_items: [{ ...doc.items[0].expected_items[0], target: '未激活显示（原文关闭↔默认）', text: '开关：未激活显示（原文关闭↔默认）', unresolved: '' }] }, 'cases');
	assert.equal(patched.expected_items[0].unresolved, '', '缺口应可被依据清除');
	assert.equal(patched.expected_items[0].id, 'e1', '修订不得换锚点');
	assert.match(patched.expected, /未激活显示/, '旧 expected 字符串须同步重渲染');
	assert.equal(patched.review_status, 'candidate', '修订后须回到待评审');
	assert.equal(applyPatch(doc, 'C-0001', { bogus_field: 1 }, 'cases').bogus_field, undefined, '未声明字段仍被忽略');
});

check('评审配置键覆盖模型/提示/参数/证据，换任一即重审', () => {
	const base = { reviewer: 'R', pageSize: 2, skill: 'sk1', provider: 'p1', model: 'm1', prompt: '模板A', params: { maxTokens: 4000 }, evidence: 'ev1' };
	const key = reviewConfigKey(base);
	assert.equal(reviewConfigKey({ ...base }), key, '同输入必须同键');
	for (const patch of [{ provider: 'p2' }, { model: 'm2' }, { prompt: '模板B' }, { skill: 'sk2' },
		{ params: { maxTokens: 6000 } }, { evidence: 'ev2' }, { reviewer: 'R2' }, { pageSize: 4 }]) {
		assert.notEqual(reviewConfigKey({ ...base, ...patch }), key, `换 ${Object.keys(patch)[0]} 必须换键`);
	}
	// 键变了，旧成功页就不能复用。
	saveReviewPage(tmp, project, { baseline: 'bX', config: key, ids: ['C-0009'], receipts: [receipt('C-0009')] });
	const stored = loadReviewPages(tmp, project);
	assert.equal(stored.config, key);
	saveReviewPage(tmp, project, { baseline: 'bX', config: reviewConfigKey({ ...base, model: 'm2' }), ids: ['C-0009'], receipts: [receipt('C-0009')] });
	assert.notEqual(loadReviewPages(tmp, project).config, key, '换模型后旧页必须被丢弃');
});

check('结构化内容不因缺 structured 标记被字符串反推降级', () => {
	const item = { case_id: 'C-0002', point_id: 'T-0002',
		steps: ['S01. 在空调界面观察【开关】显示（设计节点 1:2）'],
		expected: 'S01-1. 开关：默认状态',
		step_items: [{ id: 's-keep', key: 'before', text: '在空调界面观察【开关】显示', index: 1, role: 'observe', anchor: 'S01' }],
		expected_items: [{ id: 'e-keep', assertion_ref: 'BR-1-E1', object: '开关', target: '默认状态', kind: 'state_observation',
			text: '开关：默认状态', step_id: 's-keep', step_index: 1, trigger_step_id: '', trigger_step_index: 0, evidence_ref: 'E-1' }] };
	for (const fn of [structureCase, normalizeCaseStructure]) {
		const probe = JSON.parse(JSON.stringify(item));
		fn(probe);
		assert.equal(probe.step_items[0].id, 's-keep', `${fn.name} 不得换步骤锚点`);
		assert.equal(probe.step_items[0].role, 'observe', `${fn.name} 不得丢 role`);
		assert.equal(probe.step_items[0].text, '在空调界面观察【开关】显示', `${fn.name} 不得把渲染串当原文`);
		assert.equal(probe.expected_items[0].object, '开关', `${fn.name} 不得丢观察对象`);
		assert.equal(probe.expected_items[0].assertion_ref, 'BR-1-E1', `${fn.name} 不得丢断言引用`);
	}
});

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + r.error}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
