/**
 * 阶段4/5 回归：关联继承（inherited_from）、状态分支不带错图、负面记忆、
 * 批量传播、版本影响（过期/待复核）、稳定步骤 ID、重复挂图不重复。
 * 用法：node scripts/test-ui-inherit.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { enterModule } from '../scope.js';
import { derive, match, loadLinks, recordDecision, propagate, coverage, loadIndex, stateTokens, buildIndex, uiApplicability, linkValidity, validateDecision } from '../ui.js';
import { structureCase, figurePlacement } from '../artifacts.js';
import { missingInterfaceFigures } from '../case-visuals.js';
import { attachCaseFigures, figureKey, figuresForLink } from '../ui-figures.js';
import { snapshotArtifacts, freeze, readSnapshot } from '../package.js';
import { migrationRows } from './ui-migrate-inherit.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-ui-inherit-'));
const projectId = 'P-test';
const projectDir = path.join(root, 'projects', projectId);
fs.mkdirSync(path.join(projectDir, 'design', 'images'), { recursive: true });
enterModule('M-test');
const artifactDir = path.join(root, 'artifacts', projectId, 'M-test');
fs.mkdirSync(artifactDir, { recursive: true });

let passed = 0;
const check = async (name, fn) => {
	try { await fn(); passed += 1; console.log('  ✓ ' + name); }
	catch (error) { console.error('  ✗ ' + name + '\n    ' + error.message); process.exitCode = 1; }
};

const pngChunk = (type, data) => {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	let value = 0xffffffff;
	for (const byte of body) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
	}
	crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
	return Buffer.concat([length, body, crc]);
};
const samplePng = (width, height) => {
	const row = 1 + width * 3;
	const raw = Buffer.alloc(row * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = y * row + 1 + x * 3;
			raw[at] = 210; raw[at + 1] = 225; raw[at + 2] = 240;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlib.deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0))
	]);
};

const shot = (name) => {
	const rel = 'design/images/' + name + '.png';
	fs.writeFileSync(path.join(projectDir, rel), samplePng(40, 20));
	return rel;
};
const object = (n, name, extra = {}) => ({
	id: (extra.s || 'src1') + '::' + n, s: 'src1', n, page: 'pg1', page_name: '审批详情页',
	board: 'b1', board_name: '审批详情页', board_kind: 'runtime_screen', theme: '',
	t: 'INSTANCE', name, role: 'button', texts: [], x: 10, y: 10, w: 40, h: 20,
	vis: true, component: '', component_props: null, state: '', state_raw: '', shot: shot(n), ...extra
});
const objects = [
	object('b1', '审批详情页', { role: 'board', t: 'FRAME' }),
	object('n1', '提交审批按钮'),
	object('n2', '提交申请按钮', { page: 'pg2', page_name: '申请列表页' }),
	object('n3', '提交成功提示', { role: 'dialog', board_kind: 'state_variant', state: '成功', state_raw: '成功' }),
	object('n4', '提交失败提示', { role: 'dialog', board_kind: 'state_variant', state: '失败', state_raw: '失败' }),
	object('c1', '确认按钮', { page: 'pg3', page_name: '设置页' }),
	object('c2', '确认按钮', { page: 'pg3', page_name: '设置页' })
];
const writeIndex = (list) => {
	const index = {
		version: 2, builtAt: new Date().toISOString(), digest: 'test-digest-' + list.length,
		sources: [{ id: 'src1', name: '审批设计稿', revision: 'r1', pages: 3 }],
		pages: [
			{ id: 'pg1', source: 'src1', name: '审批详情页' },
			{ id: 'pg2', source: 'src1', name: '申请列表页' },
			{ id: 'pg3', source: 'src1', name: '设置页' }
		],
		boards: [{ id: 'b1', source: 'src1', page: 'pg1', page_name: '审批详情页', name: '审批详情页', kind: 'runtime_screen', theme: '', width: 100, height: 100, shot: shot('b1') }],
		objects: list, stats: {}
	};
	fs.writeFileSync(path.join(artifactDir, 'ui-index.json'), JSON.stringify(index));
	return index;
};
writeIndex(objects);

const documents = () => ({
	facts: { items: [{ fact_id: 'F-1', statement: '在审批详情页点击提交审批按钮提交审批' }] },
	contracts: { items: [{ contract_id: 'C-1', title: '提交审批', trigger: '点击提交审批按钮', condition: '在审批详情页', expected: '显示提交成功提示', fact_refs: ['F-1'] }] },
	points: { items: [{ point_id: 'P-1', requirement: '正常提交', contract_refs: ['C-1'] }] },
	cases: { items: [
		{ case_id: 'C-0001', point_id: 'P-1', title: '正常提交', steps: ['S1. 进入审批详情页', 'S2. 点击提交审批按钮'], expected: 'S2-1. 显示提交成功提示' },
		{ case_id: 'C-0002', point_id: 'P-1', title: '失败分支', steps: ['S1. 进入审批详情页', 'S2. 点击提交审批按钮'], expected: 'S2-1. 提示提交失败' }
	] }
});
const linkOf = (doc, kind, id, purpose, extra = {}) => doc.items.find((item) =>
	item.subject.kind === kind && item.subject.id === id && item.purpose === purpose &&
	Object.entries(extra).every(([key, value]) => item.subject[key] === value));

console.log('阶段4/5 回归测试');
let result = derive(root, projectId, documents());
let doc = result.document;

check('测试点继承合同关联并记录 inherited_from', () => {
	const contract = linkOf(doc, 'contract', 'C-1', 'control');
	const point = linkOf(doc, 'point', 'P-1', 'control');
	assert(contract?.ui_id === 'src1::n1', '合同应自动匹配到提交审批按钮');
	assert(point?.inherited_from === contract.link_id, '测试点应记录继承来源');
	assert(point.method === 'inherit');
});
check('用例步骤继承/匹配到操作控件', () => {
	const step = doc.items.find((item) => item.subject.kind === 'case_step' && item.subject.id === 'C-0001' && item.ui_id === 'src1::n1');
	assert(step, '步骤应关联到提交审批按钮');
});
check('成功预期匹配到成功状态变体', () => {
	const expected = linkOf(doc, 'case_expected', 'C-0001', 'expected');
	assert(expected?.ui_id === 'src1::n3', '应匹配成功提示而不是整板');
});
check('失败分支不带成功图（状态闸门）', () => {
	const expected = linkOf(doc, 'case_expected', 'C-0002', 'expected');
	assert(!expected?.ui_id, '失败预期不能继承成功提示图');
});
check('负面记忆：被否定候选不再出现，次优候选可自动补位', () => {
	const outcome = match(loadIndex(root, projectId), { text: '在设置页点击确认按钮' }, { exclude: ['src1::c1'] });
	assert(outcome.target?.ui_id === 'src1::c2', '排除 c1 后应选 c2');
	assert(!outcome.candidates.some((entry) => entry.ui_id === 'src1::c1'));
});
check('人工否定的关联重跑后保持排除', () => {
	recordDecision(root, projectId, { subject: { kind: 'fact', id: 'F-1' }, purpose: 'reference', status: 'rejected', rejected_ui_id: 'src1::n2', target: null });
	const again = derive(root, projectId, documents()).document;
	assert(!again.items.some((item) => item.ui_id === 'src1::n2' && item.subject.kind === 'fact'), '被否定候选不得回流');
});

// 批量传播：把合同操作控件纠正为 n2，下游继承链一起更新。
const contractControl = linkOf(doc, 'contract', 'C-1', 'control');
const newTarget = { ui_id: 'src1::n2', name: '提交申请按钮', page_name: '申请列表页', state: '', shot: shot('n2') };
recordDecision(root, projectId, { subject: contractControl.subject, purpose: 'control', status: 'confirmed', target: newTarget });
const propagated = propagate(root, projectId, { from_subject: contractControl.subject, purpose: 'control', target: newTarget, old_ui_id: 'src1::n1', documents: documents() });
check('一次纠正批量传播到测试点与用例步骤', () => {
	assert(propagated.affected >= 2, '至少影响测试点与用例步骤各一条，实际 ' + propagated.affected);
	const point = linkOf(propagated, 'point', 'P-1', 'control');
	assert(point.ui_id === 'src1::n2');
	const step = propagated.items.find((item) => item.subject.kind === 'case_step' && item.subject.id === 'C-0001' && item.purpose === 'control' && String(item.subject.name).includes('点击提交审批按钮'));
	assert(step.ui_id === 'src1::n2', '继承的步骤应跟随纠正');
});
check('重新 derive 不冲掉继承来的纠正', () => {
	const again = derive(root, projectId, documents()).document;
	const point = linkOf(again, 'point', 'P-1', 'control');
	assert(point.ui_id === 'src1::n2', '继承纠正应在重跑后保留');
});
check('人工确认的关联不被传播覆盖', () => {
	const confirmed = propagated.items.find((item) => item.subject.kind === 'contract' && item.subject.id === 'C-1' && item.purpose === 'control');
	assert(confirmed.status === 'confirmed' && confirmed.ui_id === 'src1::n2');
});

// 版本影响：节点消失 → 过期；状态变化 → 预期待复核。
check('设计节点消失时关联标为过期', () => {
	writeIndex(objects.filter((entry) => entry.n !== 'n3'));
	const stale = derive(root, projectId, documents());
	const expected = linkOf(stale.document, 'case_expected', 'C-0001', 'expected');
	assert(expected.status === 'stale', '成功提示节点被删后应标 stale');
	assert(stale.stats.stale >= 1);
});
check('状态变化时预期关联待复核', () => {
	writeIndex(objects.map((entry) => entry.n === 'n3' ? { ...entry, state: '失败', state_raw: '失败', name: '提交成功提示-改' } : entry));
	const reviewed = derive(root, projectId, documents());
	const expected = linkOf(reviewed.document, 'case_expected', 'C-0001', 'expected');
	assert(['review'].includes(expected.status) || expected.needs_review, '名称/状态变化应触发待复核');
	assert(reviewed.stats.review >= 1);
});
writeIndex(objects);
result = derive(root, projectId, documents());
doc = result.document;

check('稳定步骤 ID：插入步骤后图跟着内容走', () => {
	const item = { steps: ['S1. 点击确认按钮'], expected: '' };
	structureCase(item);
	const figure = { role: '操作定位', step: 1, step_id: item.step_items[0].id, file: 'x.png' };
	assert.deepEqual(missingInterfaceFigures(item, [figure]), [], '原步骤不应报缺口');
	item.steps = ['S1. 进入设置页面', 'S2. 点击确认按钮'];
	structureCase(item);
	const gaps = missingInterfaceFigures(item, [figure]);
	assert.deepEqual(gaps, [{ step: 1, role: '操作定位' }], '图应留在原内容步骤（现第2步），新步骤报缺口');
});
check('structureCase 与配图路径的稳定 ID 规则一致', () => {
	const item = { steps: ['S1. 点击确认按钮'], expected: 'S1-1. 确认按钮变为选中' };
	structureCase(item);
	const figure = { role: '操作定位', step: 1, step_id: item.step_items[0].id, file: 'x.png' };
	assert.deepEqual(missingInterfaceFigures(item, [figure]), []);
});
check('R17 两个同文步骤保持不同 ID', () => {
	const item = { steps: ['S1. 点击确认', 'S2. 点击确认'], expected: '' };
	structureCase(item);
	const [a, b] = item.step_items;
	assert.notEqual(a.id, b.id, '同文步骤不得共用一个 ID');
	const figures = [
		{ role: '操作定位', step_id: a.id, file: 'a.png' },
		{ role: '操作定位', step_id: b.id, file: 'b.png' }
	];
	assert.deepEqual(missingInterfaceFigures(item, figures), [], '两张图各自对位');
	const again = { steps: ['S1. 点击确认', 'S2. 点击确认'], expected: '', step_items: item.step_items };
	structureCase(again);
	assert.deepEqual(again.step_items.map((step) => step.id), [a.id, b.id], '重复运行 ID 稳定');
	assert.equal(new Set(again.expected_items.map((entry) => entry.id)).size, again.expected_items.length);
});
check('R16 插入步骤并重编号后旧 ID 跟着内容走', () => {
	const item = { steps: ['S1. 进入设置页面', 'S2. 点击确认'], expected: '' };
	structureCase(item);
	const before = item.step_items.map((step) => step.id);
	item.steps = ['S1. 进入设置页面', 'S2. 填写信息', 'S3. 点击确认'];
	structureCase(item);
	assert.equal(item.step_items[0].id, before[0]);
	assert.equal(item.step_items[2].id, before[1], '重编号后旧步骤保持原 ID');
	assert(!before.includes(item.step_items[1].id), '新步骤不得复用旧 ID');
});
check('R18 步骤语义变化 → 旧图不默认挂到第一步', () => {
	const item = { steps: ['S1. 点击确认按钮'], expected: '' };
	structureCase(item);
	const figure = { role: '操作定位', step_id: item.step_items[0].id, file: 'x.png' };
	item.steps = ['S1. 点击取消按钮'];
	structureCase(item);
	assert.notEqual(item.step_items[0].id, figure.step_id, '语义变化必须换新 ID');
	assert.deepEqual(missingInterfaceFigures(item, [figure]), [{ step: 1, role: '操作定位' }]);
});
await check('coverage 按稳定 ID 统计且排除过期关联', async () => {
	const docs = documents();
	const index = loadIndex(root, projectId);
	const links = loadLinks(root, projectId);
	for (const item of docs.cases.items) {
		structureCase(item);
		await attachCaseFigures({ projectDir, index, links, caseItem: item });
	}
	const stats = coverage(root, projectId, { cases: docs.cases }).stats;
	assert(stats.uiSteps > 0 && stats.stepsCovered > 0, '步骤覆盖应大于零');
	const report = coverage(root, projectId, { cases: docs.cases });
	assert(report.metrics.find((metric) => metric.key === 'asset').status === '未测', '没有独立素材清单时必须写未测');
	assert(report.metrics.find((metric) => metric.key === 'sampling').status === '未测');
});

// 重复挂图：attachCaseFigures 幂等，人工图保留。
await check('重复运行不重复挂图，人工图保留', async () => {
	const index = loadIndex(root, projectId);
	const caseItem = { case_id: 'C-0001', steps: ['S1. 进入审批详情页'], expected: '', image_refs: [{ file: 'manual.png', role: '操作定位', step: 1, manual: true }] };
	structureCase(caseItem);
	const links = { items: [{ subject: { kind: 'case_step', id: 'C-0001', step_id: caseItem.step_items[0].id }, purpose: 'page', ui_id: 'src1::b1', status: 'auto', target: { ui_id: 'src1::b1', source: 'src1', node_id: 'b1' } }] };
	const board = index.objects.find((entry) => entry.id === 'src1::b1');
	const input = path.join(projectDir, board.shot);
	const spec = { input, stamp: fs.statSync(input).mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex') };
	fs.mkdirSync(path.join(projectDir, 'design', 'case-images'), { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'design', 'case-images', figureKey(spec) + '.png'), Buffer.from('fake'));
	await attachCaseFigures({ projectDir, index, links, caseItem });
	const first = caseItem.image_refs.length;
	await attachCaseFigures({ projectDir, index, links, caseItem });
	assert(caseItem.image_refs.length === first, '重复运行不得叠加配图');
	assert(caseItem.image_refs.some((figure) => figure.manual), '人工图必须保留');
	assert(caseItem.image_refs.some((figure) => figure.step_id === caseItem.step_items[0].id), '自动图应带稳定步骤 ID');
});

await check('冻结快照盘点包含 ui-links', () => {
	const snapshot = snapshotArtifacts(root, projectId);
	assert(snapshot['ui-links'], '冻结 digest 应覆盖 UI 关联');
});

const writeMultiIndex = () => {
	const index = {
		version: 3, builtAt: new Date().toISOString(), digest: 'multi',
		sources: [
			{ id: 'srcA', name: '稿A', revision: 'rA', pages: 1 },
			{ id: 'srcB', name: '稿B', revision: 'rB', pages: 1 }
		],
		pages: [
			{ id: 'pgA', source: 'srcA', name: 'A页' },
			{ id: 'pgB', source: 'srcB', name: 'B页' }
		],
		boards: [
			{ id: 'bA', source: 'srcA', page: 'pgA', page_name: 'A页', name: 'A页', kind: 'runtime_screen', theme: '', x: 1000, y: 2000, width: 400, height: 300, shot: shot('bA') },
			{ id: 'bB', source: 'srcB', page: 'pgB', page_name: 'B页', name: 'B页', kind: 'runtime_screen', theme: '', x: 0, y: 0, width: 400, height: 300, shot: shot('bB') }
		],
		objects: [
			object('900:1', '确认按钮', { s: 'srcA', page: 'pgA', page_name: 'A页', board: 'bA', board_name: 'A页', rev: 'rA' }),
			object('900:1', '确认按钮', { s: 'srcB', page: 'pgB', page_name: 'B页', board: 'bB', board_name: 'B页', rev: 'rB' }),
			object('7:7', '开始按钮', { s: 'srcA', page: 'pgA', page_name: 'A页', board: 'bA', board_name: 'A页', rev: 'rA', shot: '', x: 1100, y: 2050, w: 50, h: 25 }),
			object('7:8', '兄弟按钮', { s: 'srcA', page: 'pgA', page_name: 'A页', board: 'bA', board_name: 'A页', rev: 'rA', shot: shot('sib') })
		],
		stats: {}
	};
	fs.writeFileSync(path.join(artifactDir, 'ui-index.json'), JSON.stringify(index));
	return index;
};

check('R01 两来源同 nodeId，无来源上下文 → ambiguous', () => {
	const multi = writeMultiIndex();
	const outcome = match(multi, { text: '设计节点 900:1 点击确认按钮' }, { purpose: 'control' });
	assert.equal(outcome.status, 'ambiguous');
	assert.equal(outcome.target, null, '不得按数组顺序取第一条');
});
check('R02 证据明确来源 → 只选该来源', () => {
	const multi = writeMultiIndex();
	const outcome = match(multi, { text: '设计节点 900:1 点击确认按钮' }, { purpose: 'control', source: 'srcB' });
	assert.equal(outcome.status, 'auto');
	assert.equal(outcome.target?.source, 'srcB');
	assert.equal(outcome.target?.revision, 'rB');
});
check('R04 目标无图、兄弟有图 → 保持缺截图', () => {
	const multi = writeMultiIndex();
	const outcome = match(multi, { text: '设计节点 7:7' }, { purpose: 'control' });
	assert.equal(outcome.status, 'missing_asset');
	assert.equal(outcome.target?.shot, '', '不能借用兄弟节点图');
});
check('R09 未激活/激活、未选中/选中不混用', () => {
	assert.deepEqual(stateTokens('开关未激活'), ['未激活']);
	assert.deepEqual(stateTokens('开关已激活'), ['激活']);
	assert.deepEqual(stateTokens('未选中且默认'), ['未选中', '默认']);
	assert.deepEqual(stateTokens('已选中'), ['选中']);
});
check('R09b 设计稿 /off 记法算未选中，散文里的 off 不算', () => {
	assert.deepEqual(stateTokens('B-按钮/off'), ['未选中']);
	assert.deepEqual(stateTokens('offset 调低'), []);
	assert.deepEqual(stateTokens('cutoff'), []);
});
check('R09c 名字整体是英文角色词时不算定位成功', () => {
	const bare = {
		digest: 'bare-role', sources: [{ id: 'src1', name: '设计稿', revision: 'r1' }],
		pages: [{ id: 'pg9', source: 'src1', name: '车辆设置页' }],
		boards: [{ id: 'b9', source: 'src1', page: 'pg9', page_name: '车辆设置页', name: '车辆设置页', kind: 'runtime_screen', theme: '', width: 100, height: 100, shot: shot('b1') }],
		objects: [{ ...object('g1', 'button'), page: 'pg9', page_name: '车辆设置页', board: 'b9', board_name: '车辆设置页' }],
		stats: {}
	};
	const outcome = match(bare, { name: 'SomeButton', text: '连续3帧，上报按键被按下' }, { purpose: 'expected', projectDir });
	assert.notEqual(outcome.status, 'auto', '泛名 button 不能给信号名定案');
	assert.match(outcome.reason, /泛名/);
});
check('R09d 设计修改批注不当控件定位图，温度小数不被误判', () => {
	const note = { ...object('note1', '1.间距调整至6px 2.调整循环图标 3.数字放大'), t: 'TEXT', role: 'icon' };
	note.texts = ['1.间距调整至6px\n2.调整循环图标\n3.数字放大'];
	const temperature = { ...object('temp1', '温度显示'), t: 'TEXT', role: 'text', texts: ['1.5 2.5'] };
	const withNote = {
		digest: 'annotation', sources: [{ id: 'src1', name: '设计稿', revision: 'r1' }],
		pages: [{ id: 'pg1', source: 'src1', name: '审批详情页' }],
		boards: [{ id: 'b1', source: 'src1', page: 'pg1', page_name: '审批详情页', name: '修改日志', kind: 'runtime_screen', theme: '', width: 100, height: 100, shot: shot('b1') }],
		objects: [note, temperature], stats: {}
	};
	const outcome = match(withNote, { text: '在审批详情页观察【循环图标】状态的显示' }, { purpose: 'control', projectDir });
	assert.notEqual(outcome.target?.node_id, 'note1', '批注文字层不能当定位答案');
	assert.deepEqual(stateTokens('温度 1.5 至 2.5'), []);
	const kept = match(withNote, { text: '在审批详情页读取【温度显示】' }, { purpose: 'control', projectDir });
	assert.equal(kept.target?.node_id, 'temp1', '正常温度文本仍可定位');
});
check('R19/R20 UI 适用性分层', () => {
	const level = (text, context = '') => uiApplicability(text, context).level;
	assert.equal(level('POST 请求返回成功'), 'not_applicable');
	assert.equal(level('查询数据库记录成功'), 'not_applicable');
	assert.equal(level('查看 CAN 日志，确认请求连续发送三帧'), 'not_applicable');
	assert.equal(level('关闭服务后重试 API'), 'not_applicable');
	assert.equal(level('确认状态正常'), 'unknown');
	assert.equal(level('保存成功'), 'unknown');
	assert.equal(level('点击审批详情页的提交按钮'), 'required');
	assert.equal(level('审批页面显示提交成功提示'), 'required');
	assert.equal(level('观察屏幕按钮，同时核对 CAN 反馈'), 'required');
	assert.equal(level('确认已禁用', '在设置页点击确认按钮'), 'required');
	assert.equal(level('显示提交成功提示'), 'required');
});

await check('R12/R13/R14/R15 无效关联不挂图，同图两步各自保留引用', async () => {
	const multi = writeMultiIndex();
	const caseItem = {
		case_id: 'C-0009', title: '挂图规则',
		steps: ['S1. 点击确认按钮', 'S2. 点击提交按钮'],
		expected: 'S1-1. 显示提交成功提示'
	};
	structureCase(caseItem);
	const [step1, step2] = caseItem.step_items;
	const expectedId = caseItem.expected_items[0].id;
	const targetB = { ui_id: 'srcB::900:1', source: 'srcB', node_id: '900:1', revision: 'rB' };
	const targetMissing = { ui_id: 'srcA::7:7', source: 'srcA', node_id: '7:7', revision: 'rA' };
	const links = {
		items: [
			{ link_id: 'L1', subject: { kind: 'case_step', id: 'C-0009', step_id: step1.id }, purpose: 'control', ui_id: 'srcB::900:1', target: targetB, status: 'auto' },
			{ link_id: 'L2', subject: { kind: 'case_step', id: 'C-0009', step_id: step2.id }, purpose: 'control', ui_id: 'srcB::900:1', target: targetB, status: 'auto' },
			{ link_id: 'L3', subject: { kind: 'case_step', id: 'C-0009', step_id: step2.id }, purpose: 'page', ui_id: 'srcA::7:7', target: targetMissing, status: 'stale', reason: '设计节点已不存在' },
			{ link_id: 'L4', subject: { kind: 'case_expected', id: 'C-0009', expected_id: expectedId }, purpose: 'expected', ui_id: 'srcA::7:7', target: targetMissing, status: 'confirmed', needs_review: true, reason: '设计状态已变化' }
		]
	};
	caseItem.image_refs = [
		{ file: 'manual.png', role: '操作定位', step_id: step1.id, manual: true },
		{ file: 'old-expected.png', role: '预期界面参考', expected_id: expectedId, purpose: 'expected', ui_id: 'srcA::7:7', revision: 'rA' },
		{ file: 'old-step2.png', role: '操作定位', step_id: step2.id, purpose: 'control', ui_id: 'srcA::7:7', revision: 'rA' }
	];
	const attached = await attachCaseFigures({ projectDir, index: multi, links, caseItem });
	assert(caseItem.image_refs.some((figure) => figure.manual), '人工图保留');
	const stepFigures = caseItem.image_refs.filter((figure) => !figure.manual && figure.role === '操作定位');
	assert.equal(stepFigures.length, 2, '两个步骤各保留一条引用');
	assert.equal(stepFigures[0].file, stepFigures[1].file, '同一截图可被两个步骤引用');
	assert.notEqual(stepFigures[0].step_id, stepFigures[1].step_id);
	assert(!caseItem.image_refs.some((figure) => figure.expected_id === expectedId), 'stale/待复核/缺图的旧自动图必须撤下');
	const excluded = await attachCaseFigures({ projectDir, index: multi, links, caseItem, allowedDesigns: new Map([['srcB', 'other-revision']]) });
	assert.equal(excluded.length, 0, '模块未选入的修订不能使用项目索引中仍有缓存的图');
	assert(caseItem.image_refs.every((figure) => figure.manual), '人工图可回查');
	assert(!caseItem.image_refs.some((figure) => figure.file === 'old-step2.png'));
	assert.equal(attached.results.filter((entry) => entry.status === 'attached').length, 2);
	const skipped = attached.results.filter((entry) => entry.status === 'skipped');
	assert.equal(skipped.length, 2, 'stale 与 needs_review 关联都应记录跳过原因');
	assert(skipped.some((entry) => entry.validity === 'stale'));
	assert(skipped.some((entry) => entry.validity === 'review'));
});
check('R11 预期两个状态只找到一个 → 部分完成', async () => {
	const item = { case_id: 'C-0011', title: '双状态', steps: ['S1. 点击审批详情页的按钮'], expected: 'S1-1. A 选中且 B 默认' };
	structureCase(item);
	const expectedId = item.expected_items[0].id;
	fs.writeFileSync(path.join(projectDir, 'a-selected.png'), samplePng(40, 20));
	item.image_refs = [{ file: 'a-selected.png', role: '预期界面参考', purpose: 'expected', expected_id: expectedId, state: '选中', manual: true }];
	const report = coverage(root, projectId, { cases: { items: [item] } });
	const row = report.cases[0].expected[0];
	assert.equal(row.needs_ui, true);
	assert.equal(row.covered, false);
	assert.equal(row.partial, true);
	assert.deepEqual(row.states, ['选中', '默认']);
	assert.ok(row.reason.includes('默认'));
	assert.equal(report.metrics.find((metric) => metric.key === 'expected').partial, 1);
});
writeIndex(objects);
check('R22 拒绝限定对象，不扩大到全模块', () => {
	recordDecision(root, projectId, { subject: { kind: 'point', id: 'P-2' }, purpose: 'control', status: 'rejected', rejected_ui_id: 'src1::n1' });
	const excluded = match(loadIndex(root, projectId), { text: '在审批详情页点击提交审批按钮' }, { purpose: 'control', exclude: ['src1::n1'] });
	assert.notEqual(excluded.target?.ui_id, 'src1::n1');
	const other = match(loadIndex(root, projectId), { text: '提交审批按钮' }, { purpose: 'reference' });
	assert.equal(other.target?.ui_id, 'src1::n1', '拒绝只作用于对应对象与用途');
});

/* --------- R05/R06：真实 SQLite 源 + 祖先/画板包含关系与坐标 --------- */
await check('R05/R06 祖先截图、画板原点与非零坐标标框', async () => {
	const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-ui-index-'));
	try {
		enterModule('M-test');
		const pid = 'P-syn';
		const projectDir = path.join(root2, 'projects', pid);
		const workspace = path.join(root2, 'design', pid);
		const rev = 'a'.repeat(64);
		const bundle = path.join(workspace, 'mcp-store', 'source_bundles', 'mcp', 'srcA', rev);
		const images = path.join(projectDir, 'design', 'images', rev);
		fs.mkdirSync(path.join(bundle, 'index'), { recursive: true });
		fs.mkdirSync(images, { recursive: true });
		fs.writeFileSync(path.join(projectDir, 'design', 'images', rev, 'g1.png'), samplePng(120, 60));
		fs.writeFileSync(path.join(projectDir, 'design', 'images', rev, 'b1.png'), samplePng(400, 300));
		fs.writeFileSync(path.join(projectDir, 'design', 'images', rev, 'b3.png'), samplePng(400, 300));
		fs.writeFileSync(path.join(projectDir, 'design', 'images', rev, 'n2.png'), samplePng(40, 20));
		fs.writeFileSync(path.join(workspace, 'mcp-store', 'compiled_ui_registry.json'), JSON.stringify({
			sources: { srcA: { logical_file_id: 'srcA', current_bundle_ref: path.join('source_bundles', 'mcp', 'srcA', rev), source_sha256: rev } }
		}));
		fs.writeFileSync(path.join(bundle, 'source.json'), JSON.stringify({ name: '合成稿', fileKey: 'fk-a', pages: [{ id: 'p1' }] }));
		const db = new DatabaseSync(path.join(bundle, 'index', 'compiled_ui.sqlite'));
		db.exec(`create table pages(page_id text, name text);
			create table boards(board_id text, page_id text, name text, width real, height real, board_kind text);
			create table texts(node_id text, text text, font_size real);
			create table nodes(node_id text, name text, node_type text, parent_id text, page_id text, board_id text, semantic_class text, visible integer, x real, y real, width real, height real, component_key text);`);
		const node = db.prepare('insert into nodes values(?,?,?,?,?,?,?,?,?,?,?,?,?)');
		db.prepare("insert into pages values('p1','合成页')").run();
		const board = db.prepare('insert into boards values(?,?,?,?,?,?)');
		board.run('b1', 'p1', '合成页', 400, 300, 'runtime_screen');
		board.run('b2', 'p1', '无图页', 400, 300, 'runtime_screen');
		board.run('b3', 'p1', '画板页', 400, 300, 'runtime_screen');
		node.run('b1', '合成页', 'FRAME', '', 'p1', 'b1', '', 1, 1000, 2000, 400, 300, '');
		node.run('g1', '操作区', 'FRAME', 'b1', 'p1', 'b1', '', 1, 1100, 2050, 120, 60, '');
		node.run('n1', '提交按钮', 'INSTANCE', 'g1', 'p1', 'b1', 'semantic', 1, 1100, 2050, 40, 20, '');
		node.run('b2', '无图页', 'FRAME', '', 'p1', 'b2', '', 1, 1000, 2000, 400, 300, '');
		node.run('n2', '兄弟按钮', 'INSTANCE', 'b2', 'p1', 'b2', 'semantic', 1, 1300, 2100, 40, 20, '');
		node.run('n3', '目标按钮', 'INSTANCE', 'b2', 'p1', 'b2', 'semantic', 1, 1100, 2050, 50, 25, '');
		node.run('b3', '画板页', 'FRAME', '', 'p1', 'b3', '', 1, 1000, 2000, 400, 300, '');
		node.run('n4', '画板按钮', 'INSTANCE', 'b3', 'p1', 'b3', 'semantic', 1, 1100, 2050, 50, 25, '');
		db.close();
		const index = buildIndex(projectDir, pid, root2);
		const n1 = index.objects.find((entry) => entry.n === 'n1');
		assert.equal(n1.shot_node, 'g1', '应使用包含目标的祖先截图');
		assert.equal(n1.shot_visibility, 'full');
		assert.ok(Math.abs(n1.shot_scope[0]) < 1e-9 && Math.abs(n1.shot_scope[1]) < 1e-9);
		assert.ok(Math.abs(n1.shot_scope[2] - 1 / 3) < 1e-6 && Math.abs(n1.shot_scope[3] - 1 / 3) < 1e-6);
		const n3 = index.objects.find((entry) => entry.n === 'n3');
		assert.equal(n3.shot, '', '兄弟有图也不能借图');
		const b1 = index.boards.find((entry) => entry.id === 'b1');
		assert.equal(b1.x, 1000, '画板原点取自 nodes 表');
		assert.equal(b1.y, 2000);
		assert.equal(b1.width, 400);
		const n4 = index.objects.find((entry) => entry.n === 'n4');
		assert.equal(n4.shot_node, 'b3', '无祖先图时退到完整画板图');
		const near = (a, b) => Math.abs(a - b) < 1e-6;
		assert.ok(near(n4.shot_scope[0], 0.25) && near(n4.shot_scope[1], 1 / 6) && near(n4.shot_scope[2], 0.125) && near(n4.shot_scope[3], 1 / 12));
		const figures = await figuresForLink(projectDir, index, { purpose: 'control', ui_id: 'srcA::n4', subject: { step_id: 's1' }, target: null }, n4);
		assert.equal(figures.length, 2, '画板截图应生成概览和局部图');
		assert.equal(figures[0].shot_node, 'b3');
		assert.equal(figures[0].source_id, 'srcA');
		assert.equal(figures[0].revision, rev);
		assert.equal(figures[0].coords, 'normalized');
		assert.equal(figures[0].visibility, 'full');
		assert.ok(figures.every((figure) => figure.sha256?.length === 64 && fs.existsSync(path.join(projectDir, figure.file))));
		assert.ok(near(figures[0].bounds[0], 0.25) && near(figures[0].bounds[1], 1 / 6));
	} finally {
		fs.rmSync(root2, { recursive: true, force: true });
	}
});

await check('R21/R23 传播只影响真实下游，预览后变化拒绝覆盖', async () => {
	const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-ui-propagate-'));
	try {
		const pid = 'P-prop';
		const pdir = path.join(root3, 'projects', pid);
		fs.mkdirSync(path.join(pdir, 'design', 'images'), { recursive: true });
		fs.mkdirSync(path.join(root3, 'artifacts', pid, 'M-test'), { recursive: true });
		const shot3 = (name) => {
			const rel = 'design/images/' + name + '.png';
			fs.writeFileSync(path.join(pdir, rel), samplePng(40, 20));
			return rel;
		};
		const obj = (n, name, extra = {}) => ({
			id: 'src1::' + n, s: 'src1', n, page: 'pg1', page_name: '审批详情页', board: 'b1', board_name: '审批详情页',
			board_kind: 'runtime_screen', theme: '', t: 'INSTANCE', name, role: 'button', texts: [], x: 10, y: 10, w: 40, h: 20,
			vis: true, component: '', component_props: null, state: '', state_raw: '', shot: shot3(n), ...extra
		});
		fs.writeFileSync(path.join(root3, 'artifacts', pid, 'M-test', 'ui-index.json'), JSON.stringify({
			version: 3, builtAt: new Date().toISOString(), digest: 'prop',
			sources: [{ id: 'src1', name: '审批设计稿', revision: 'r1', pages: 1 }],
			pages: [{ id: 'pg1', source: 'src1', name: '审批详情页' }],
			boards: [{ id: 'b1', source: 'src1', page: 'pg1', page_name: '审批详情页', name: '审批详情页', kind: 'runtime_screen', theme: '', width: 100, height: 100, shot: shot3('b1') }],
			objects: [
				obj('b1', '审批详情页', { role: 'board', t: 'FRAME' }),
				obj('n1', '提交审批按钮'),
				obj('n2', '提交申请按钮'),
				obj('n3', '提交成功提示', { role: 'dialog', board_kind: 'state_variant', state: '成功', state_raw: '成功' })
			],
			stats: {}
		}));
		const docs = {
			facts: { items: [{ fact_id: 'F-1', statement: '在审批详情页点击提交审批按钮提交审批' }] },
			contracts: { items: [
				{ contract_id: 'C-91', title: '首次提交', trigger: '点击提交审批按钮', condition: '在审批详情页', expected: '显示提交成功提示', fact_refs: ['F-1'] },
				{ contract_id: 'C-92', title: '再次提交', trigger: '点击提交审批按钮', condition: '在审批详情页', expected: '显示提交成功提示', fact_refs: ['F-1'] }
			] },
			points: { items: [
				{ point_id: 'P-91', requirement: '首次提交', contract_refs: ['C-91'] },
				{ point_id: 'P-92', requirement: '再次提交', contract_refs: ['C-92'] }
			] },
			cases: { items: [
				{ case_id: 'C-0091', point_id: 'P-91', title: '首次提交', steps: ['S1. 进入审批详情页', 'S2. 点击提交审批按钮'], expected: 'S2-1. 显示提交成功提示' },
				{ case_id: 'C-0092', point_id: 'P-92', title: '再次提交', steps: ['S1. 进入审批详情页', 'S2. 点击提交审批按钮'], expected: 'S2-1. 显示提交成功提示' }
			] }
		};
		const seeded = derive(root3, pid, docs).document;
		const a = linkOf(seeded, 'contract', 'C-91', 'control');
		const b = linkOf(seeded, 'contract', 'C-92', 'control');
		assert.equal(a?.ui_id, 'src1::n1');
		assert.equal(b?.ui_id, 'src1::n1', '两个需求碰巧绑定同一 UI');
		const target = { ui_id: 'src1::n2', name: '提交申请按钮', page_name: '审批详情页', state: '', shot: shot3('n2') };
		recordDecision(root3, pid, { subject: a.subject, purpose: 'control', status: 'confirmed', target });
		const result = propagate(root3, pid, { from_subject: a.subject, purpose: 'control', target, old_ui_id: 'src1::n1', documents: docs });
		assert(result.affected >= 1, '至少更新真实下游的测试点');
		assert.equal(linkOf(result, 'point', 'P-91', 'control')?.ui_id, 'src1::n2');
		assert.equal(linkOf(result, 'point', 'P-92', 'control')?.ui_id, 'src1::n1', '另一需求的测试点不得被改');
		assert.equal(linkOf(result, 'contract', 'C-92', 'control')?.ui_id, 'src1::n1', '另一需求的合同不得被改');
		const case92 = docs.cases.items.find((item) => item.case_id === 'C-0092');
		const step92 = result.items.find((item) => item.subject.kind === 'case_step' && item.subject.id === 'C-0092' && item.subject.step_id === case92.step_items[1].id && item.purpose === 'control' && item.ui_id);
		assert.equal(step92?.ui_id, 'src1::n1', '另一需求的步骤也不得被改');
		const preview = propagate(root3, pid, { from_subject: a.subject, purpose: 'control', target, old_ui_id: 'src1::n1', documents: docs, preview: true });
		assert.equal(preview.preview, true);
		assert(preview.baseline, '预览应返回基线');
		recordDecision(root3, pid, { subject: { kind: 'point', id: 'P-77' }, purpose: 'control', status: 'confirmed', target: { ui_id: 'src1::n1', source: 'src1', node_id: 'n1' } });
		const applied = propagate(root3, pid, { from_subject: a.subject, purpose: 'control', target, old_ui_id: 'src1::n1', documents: docs, baseline: preview.baseline });
		assert(applied.conflict, '预览后数据变化必须拒绝应用');
		assert.equal(applied.affected, 0);
	} finally {
		fs.rmSync(root3, { recursive: true, force: true });
	}
});

await check('R24 旧点继承迁移：完整依据才补引用，草稿与多义候选不动', async () => {
	const base = { condition: '在审批详情页', action: '点击提交审批按钮', expected: '显示提交成功提示', fact_refs: ['F-1'] };
	const contracts = [
		{ contract_id: 'C-1', feature_id: 'F-A', status: 'approved', title: '提交审批', ...base },
		{ contract_id: 'C-2', feature_id: 'F-A', status: 'draft', title: '提交审批（草稿）', ...base },
		{ contract_id: 'C-3', feature_id: 'F-B', status: 'approved', title: '温度上限', condition: '温度显示为32℃', action: '向上拖动温度调节条', expected: '不发送设置报文', fact_refs: ['F-2'] },
		{ contract_id: 'C-4', feature_id: 'F-B', status: 'approved', title: '温度上限合并合同', condition: '温度显示为32℃', action: '向上拖动温度调节条', expected: '不发送设置报文', fact_refs: ['F-3'] },
		{ contract_id: 'C-5', feature_id: 'F-C', status: 'approved', title: '提交审批（另一预期）', ...base, expected: '显示审批通过提示' },
		{ contract_id: 'C-6', feature_id: 'F-C', status: 'approved', title: '提交审批（缺动作）', condition: '在审批详情页', action: '', expected: '显示提交成功提示', fact_refs: ['F-1'] }
	];
	const points = [
		{ point_id: 'P-1', feature_id: 'F-A', requirement: '提交审批', condition: '在审批详情页', action: '点击提交审批按钮', expected: '显示提交成功提示', fact_refs: ['F-1'] },
		{ point_id: 'P-2', feature_id: 'F-A', requirement: '提交审批', condition: '别的条件', action: '别的动作', expected: '别的预期', fact_refs: ['F-1'] },
		{ point_id: 'P-3', feature_id: 'F-B', requirement: '温度边界-32℃向上拖动', condition: '温度显示为32℃', action: '向上拖动温度调节条', expected: '不发送设置报文；温度显示保持32℃', fact_refs: ['F-9'] },
		{ point_id: 'P-4', feature_id: 'F-C', requirement: '提交审批', condition: '在审批详情页', action: '点击提交审批按钮', expected: '显示提交成功提示', fact_refs: ['F-1'] },
		{ point_id: 'P-5', requirement: '已有来源', condition: 'x', action: 'y', expected: 'z', contract_refs: ['C-1'] }
	];
	const rows = migrationRows(points, contracts);
	const byId = new Map(rows.map((row) => [row.point_id, row]));
	assert.equal(byId.get('P-1').decision, 'apply');
	assert.deepEqual(byId.get('P-1').candidates.map((c) => c.contract_id), ['C-1'], '草稿合同不得作为迁移依据');
	assert.equal(byId.get('P-2').decision, 'pending', '只有事实引用一致不足以补引用');
	assert.equal(byId.get('P-3').decision, 'apply', '条件+动作完整且语义唯一即可迁移');
	assert.equal(byId.get('P-3').candidates.length, 2, '语义相同的拆分合同可多对多');
	assert.equal(byId.get('P-4').decision, 'pending', '多个语义不同的完整候选必须保留待判断');
	assert.equal(byId.get('P-5').decision, 'already_linked');
});

await check('R25 图对位与冻结快照逐图摘要', async () => {
	const item = {
		steps: ['S1. 打开页面', 'S2. 点击按钮'],
		step_items: [{ id: 's-a', text: 'S1. 打开页面' }, { id: 's-b', text: 'S2. 点击按钮' }],
		expected_items: [{ id: 'e-2', step_index: 2, text: '出现提示' }]
	};
	assert.deepEqual(figurePlacement(item, { step_id: 's-b' }), { step: 2, mapped: true });
	assert.equal(figurePlacement(item, { step_id: 's-gone' }).mapped, false, '失效步骤 ID 必须待核对');
	assert.deepEqual(figurePlacement(item, { expected_id: 'e-2' }), { step: 2, mapped: true });
	assert.equal(figurePlacement(item, { expected_id: 'e-gone' }).mapped, false, '失效预期 ID 必须待核对');
	assert.deepEqual(figurePlacement(item, { step: 1 }), { step: 1, mapped: true });
	assert.equal(figurePlacement(item, { step: 9 }).mapped, false, '超出步骤范围不得挂到第一步');
	assert.deepEqual(figurePlacement(item, {}), { step: 0, mapped: true });

	const root4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-ui-freeze-'));
	try {
		const pid = 'P-freeze';
		const rel = 'design/case-images/' + 'a'.repeat(64) + '.png';
		const file = path.join(root4, 'projects', pid, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, samplePng(8, 6));
		const figure = { file: rel, role: '操作定位', name: '确认按钮', revision: 'r1' };
		const snapshot = { moduleName: 'M', model: { version: 1, digest: 'd1' }, cases: { items: [{ case_id: 'C-1', title: 't', steps: ['S1. 点击'], expected: '', image_refs: [figure] }] } };
		const record = freeze(root4, pid, 'test', snapshot);
		const frozen = readSnapshot(root4, pid, record.package_id);
		assert.equal(frozen.figures.length, 1, '冻结快照必须记录每张图的摘要');
		assert.equal(frozen.figures[0].revision, 'r1');
		assert.equal(frozen.figures[0].sha256.length, 64);
		assert.equal(frozen.cases.items[0].image_refs[0].sha256, frozen.figures[0].sha256);
		const again = freeze(root4, pid, 'test', snapshot);
		assert.equal(again.package_id, record.package_id, '冻结后不得重复冻结改写');
	} finally {
		fs.rmSync(root4, { recursive: true, force: true });
	}
});

await check('R26 手工关联入口校验对象、来源、版本与路径', async () => {
	writeIndex(objects);
	const docs = documents();
	const base = { subject: { kind: 'contract', id: 'C-1' }, purpose: 'control', status: 'confirmed', target: { ui_id: 'src1::n1', source: 'src1', node_id: 'n1', revision: 'r1' } };
	validateDecision(root, projectId, projectDir, base, docs);
	assert.throws(() => validateDecision(root, projectId, projectDir, { ...base, subject: { kind: 'point', id: 'P-404' } }, docs), /关联对象不存在/);
	assert.throws(() => validateDecision(root, projectId, projectDir, { ...base, target: { ui_id: 'src2::n1', source: 'src2', node_id: 'n1' } }, docs), /不属于本项目的设计来源/);
	assert.throws(() => validateDecision(root, projectId, projectDir, { ...base, target: { ...base.target, revision: 'r0' } }, docs), /版本已更新/);
	assert.throws(() => validateDecision(root, projectId, projectDir, { ...base, target: { ...base.target, shot: '../outside.png' } }, docs), /截图与索引不一致|不属于本项目/);
	assert.throws(() => validateDecision(root, projectId, projectDir, { ...base, subject: { kind: 'case_step', id: 'C-0001', step_id: 's-gone' } }, docs), /步骤或预期已变化/);
});

console.log(`\n${passed} 项通过${process.exitCode ? '（存在失败）' : ''}`);
fs.rmSync(root, { recursive: true, force: true });
