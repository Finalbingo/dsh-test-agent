/**
 * B 阶段回归：冻结范围只有一份；重建不抹人工评审；覆盖按实际断言对账。
 *   node cts-agent/scripts/test-scope-unification.mjs [dataRoot] [projectId] [moduleId]
 * 不带参数时用内置的最小夹具，不碰真实项目。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { enterModule, enterProjectConfig } from '../scope.js';
import { buildOutlineFromBranches, branchResolvers, outlineCoverage, deliveryCases } from '../test-design.js';
import { keepPointReviews, digestOf } from '../artifacts.js';

const results = [];
const check = (name, fn) => {
	try { fn(); results.push({ name, ok: true }); }
	catch (error) { results.push({ name, ok: false, error: error.message }); }
};

enterModule('M-test');
enterProjectConfig({ capabilities: ['text'], surfaces: ['审批列表页'], default_surface: '审批列表页' });

const branch = (id, over = {}) => ({
	branch_id: id, section: '3.1 提交', initial: '文档处于草稿状态', precondition: '',
	event: '提交人在文档编辑页单击【提交】', quote: '文档状态变为待审批', location: 'prd/doc.md:20',
	evidence_id: 'E-0001', version: 'V1.0', source_id: 'S-1', prd_sha256: 'a'.repeat(64),
	mode: 'interaction', status: 'ready', tbd: false, open_question: '',
	expected: [{ kind: 'ui_immediate', object: '文档状态', target: '待审批', quote: '文档状态变为待审批' }],
	...over
});
const branches = [branch('BR-1'), branch('BR-2', { status: 'needs_decision', tbd: true }), branch('BR-3', { mode: 'meta', status: 'excluded' })];
const model = { digest: 'm1', features: [{ feature_id: 'F-1', name: '提交' }] };
const facts = [{ fact_id: 'F-0001', statement: '文档状态变为待审批', evidence_refs: ['E-0001'] }];
const resolvers = branchResolvers(facts, new Map([['F-0001', 'F-1']]));

const outline = buildOutlineFromBranches(model, branches, { version: 1 }, resolvers);

check('大纲承载全部分支，不只可生成项', () => {
	assert.equal(outline.items.length, 3);
	assert.equal(outline.source_kind, 'branches');
	assert.equal(outline.source_branches_digest, digestOf(branches));
	assert.deepEqual(outline.items.map((i) => i.classification), ['required', 'needs_evidence', 'excluded']);
});

check('空分支清单被拒绝', () => {
	assert.throws(() => buildOutlineFromBranches(model, [], { version: 1 }, resolvers), /还没有冻结的需求分支/);
});

check('只读观察用项目声明的界面名', () => {
	const ro = buildOutlineFromBranches(model, [branch('BR-9', { mode: 'state_observation', event: '' })], { version: 1 }, resolvers);
	assert.match(ro.items[0].action, /在审批列表页读取/);
});

const pointsOf = (design) => design.items.map((item, index) => ({
	...item, point_id: 'T-' + String(index + 1).padStart(4, '0'), scenario_refs: [item.scenario_id], review_status: 'candidate'
}));
const points = pointsOf(outline);

check('两处入口的场景集合双向相等', () => {
	const fromOutline = new Set(outline.items.map((i) => i.scenario_id));
	const fromPoints = new Set(points.flatMap((p) => p.scenario_refs));
	assert.equal(fromOutline.size, fromPoints.size);
	assert.ok([...fromOutline].every((id) => fromPoints.has(id)));
});

check('内容未变的重建保留人工评审', () => {
	const prior = pointsOf(outline).map((p) => p.point_id === 'T-0001' ? { ...p, review_status: 'approved', reviewed_at: '2026-11-18T00:00:00.000Z' } : p);
	const rebuilt = pointsOf(outline);
	assert.equal(keepPointReviews(rebuilt, prior), 1);
	assert.equal(rebuilt[0].review_status, 'approved');
	assert.equal(rebuilt[0].reviewed_at, '2026-11-18T00:00:00.000Z');
	assert.equal(digestOf(rebuilt), digestOf(prior), '保留评审后内容摘要必须与原版一致');
});

check('内容变了的重建回到候选，不沿用旧批准', () => {
	const prior = pointsOf(outline).map((p) => p.point_id === 'T-0001' ? { ...p, review_status: 'approved', reviewed_at: 'x' } : p);
	const changed = pointsOf(buildOutlineFromBranches(model, [branch('BR-1', { initial: '文档处于已驳回状态' }), ...branches.slice(1)], { version: 2 }, resolvers));
	assert.equal(keepPointReviews(changed, prior), 0);
	assert.equal(changed[0].review_status, 'candidate');
});

const approvedPoints = { items: points.map((p) => ({ ...p, review_status: 'approved' })), source_outline_digest: 'od' };
const design = { ...outline, digest: 'od', items: outline.items };
const caseFor = (point, over = {}) => ({
	case_id: 'C-' + point.point_id, point_id: point.point_id, review_status: 'approved',
	expected_items: (point.expected_items || []).filter((e) => !e.blocking).map((e) => ({ object: e.object, target: e.target, assertion_ref: e.id })),
	...over
});

check('用例未批准不算覆盖', () => {
	const cases = { items: [caseFor(points[0], { review_status: 'candidate' })], source_points_digest: digestOf(approvedPoints.items) };
	const rows = outlineCoverage(design, approvedPoints, cases);
	assert.equal(rows[0].state, 'case_incomplete');
	assert.equal(rows[0].assertions_covered, 0);
	assert.equal(rows.filter((r) => r.state === 'covered').length, 0);
});

check('同版签核延期只剔除延期草稿，过期延期仍阻断', () => {
	const pointsDigest = digestOf(approvedPoints.items);
	const draft = caseFor(points[0], { review_status: 'candidate' });
	const approved = caseFor(points[1]);
	const cases = { items: [draft, approved], source_points_digest: pointsDigest };
	const delay = { point_id: draft.point_id, outline_digest: 'od', points_digest: pointsDigest,
		reason: '待补观察环境', reviewer: '评审人', owner: '负责人', reviewed_at: '2026-11-21T00:00:00Z' };
	const rows = outlineCoverage(design, approvedPoints, cases, [delay]);
	assert.equal(rows[0].state, 'deferred');
	assert.equal(rows[0].assertions_covered, 0);
	assert.deepEqual(deliveryCases(cases, rows).items, [approved]);
	assert.equal(cases.items.length, 2);
	const stale = outlineCoverage(design, approvedPoints, cases, [{ ...delay, points_digest: 'old' }]);
	assert.equal(stale[0].state, 'case_incomplete');
	assert.equal(deliveryCases(cases, stale), cases);
});

check('判据齐全且已批准才算覆盖', () => {
	const cases = { items: [caseFor(points[0])], source_points_digest: digestOf(approvedPoints.items) };
	const rows = outlineCoverage(design, approvedPoints, cases);
	assert.equal(rows[0].state, 'covered');
	assert.equal(rows[0].assertions_required, 1);
	assert.equal(rows[0].assertions_covered, 1);
});

check('追加另一条已批准变体不能掩盖前一条待评审变体', () => {
	const draft = caseFor(points[0], { case_id: 'C-path-1', review_status: 'candidate' });
	const approved = caseFor(points[0], { case_id: 'C-path-2' });
	const cases = { items: [draft, approved], source_points_digest: digestOf(approvedPoints.items) };
	assert.equal(outlineCoverage(design, approvedPoints, cases)[0].state, 'case_incomplete');
});

check('按判据引用对账，名字不同也算命中', () => {
	const item = caseFor(points[0]);
	item.expected_items[0].object = '【提交】后的文档状态';
	const cases = { items: [item], source_points_digest: digestOf(approvedPoints.items) };
	assert.equal(outlineCoverage(design, approvedPoints, cases)[0].state, 'covered');
});

check('缺一条判据就是判据不全，不是覆盖', () => {
	const two = { ...approvedPoints.items[0], expected_items: [...points[0].expected_items, { id: 'BR-1-E2', kind: 'ui_immediate', object: '提示', target: '已提交', blocking: false }] };
	const pts = { items: [two, ...approvedPoints.items.slice(1)], source_outline_digest: 'od' };
	const cases = { items: [caseFor(points[0])], source_points_digest: digestOf(pts.items) };
	const rows = outlineCoverage({ ...design, items: [two, ...design.items.slice(1)] }, pts, cases);
	assert.equal(rows[0].state, 'case_incomplete');
	assert.equal(rows[0].assertions_required, 2);
	assert.equal(rows[0].assertions_covered, 1);
});

check('阻断判据单列，不计入可判定分母', () => {
	const blocked = { ...approvedPoints.items[0], expected_items: [...points[0].expected_items, { id: 'BR-1-E9', kind: 'ui_feedback_30s', object: '显示', target: '按时更新', blocking: true }] };
	const pts = { items: [blocked, ...approvedPoints.items.slice(1)], source_outline_digest: 'od' };
	const cases = { items: [caseFor(points[0])], source_points_digest: digestOf(pts.items) };
	const rows = outlineCoverage({ ...design, items: [blocked, ...design.items.slice(1)] }, pts, cases);
	assert.equal(rows[0].state, 'covered');
	assert.equal(rows[0].assertions_required, 1);
	assert.equal(rows[0].assertions_deferred, 1);
});

check('点未批准时是待评审，不是覆盖', () => {
	const cases = { items: [caseFor(points[0])], source_points_digest: digestOf(approvedPoints.items) };
	const rows = outlineCoverage(design, { ...approvedPoints, items: points }, cases);
	assert.equal(rows[0].state, 'review');
});

// 带真实项目参数时，额外核对现网范围确实只有一份。
const [root, project, module] = process.argv.slice(2);
if (root && project && module) {
	check('现网大纲与测试点范围双向相等', () => {
		const dir = path.join(root, 'artifacts', project, module);
		const ol = JSON.parse(fs.readFileSync(path.join(dir, 'outline.json'), 'utf8'));
		const pt = JSON.parse(fs.readFileSync(path.join(dir, 'points.json'), 'utf8'));
		assert.equal(pt.source_outline_digest, ol.digest, '测试点没有真实大纲关联');
		assert.equal(ol.items[0].source_kind, 'branches');
		const a = new Set(ol.items[0].items.map((i) => i.scenario_id));
		const b = new Set(pt.items.flatMap((i) => i.scenario_refs || []));
		assert.equal(a.size, b.size);
		assert.ok([...a].every((id) => b.has(id)));
	});
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + r.error}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
