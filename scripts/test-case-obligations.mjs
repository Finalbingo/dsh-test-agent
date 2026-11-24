import assert from 'node:assert/strict';
import { classify } from '../adapters/v5-hvac-prd.js';
import { buildStructuredCase, renderLegacyFields, validateAnchors } from '../case-structure.js';
import { decorateCases, lint, mergeCasesDetailed, buildClosedLoopCoveragePlan, closedLoopForBatch, evaluateClosedLoopCoverage, buildExhaustiveExpansionHints, resolvePointFeedbackAttribution, enrichPrepareFeedbackReadback } from '../artifacts.js';
import { evaluateStateEligibility, filterEligibleStateFeatures, validate as validateState } from '../states.js';
import { buildOutlineFromBranches } from '../test-design.js';

const source = '当中控屏空调界面语音降低风量，空调风量调节条即时会切换到调节后的温度显示，空调A/C开关按键即时会切换到“默认状态”。'
	+ 'IVI发送信号CDC_Voice Fan speed(gears) （连续3帧），上报请求。IVI发送信号CDC_Voice AC mode。'
	+ '根据信号HVAC_Mode_change、HVAC_Defrost、HVAC_On_Off变化以便30s后更新显示。';
const { expected } = classify(source, { heading: '示例' });
assert.deepEqual(expected.filter((item) => item.kind === 'can_request').map(({object, frames, blocking}) => [object, frames, blocking]), [
	['CDC_Voice Fan speed', 3, true], ['CDC_Voice AC mode', undefined, undefined]
]);
assert.equal(expected.find((item) => item.object === 'A/C开关')?.quote, 'A/C开关按键即时会切换到“默认状态”');
assert.deepEqual(classify('IVI 发送信号IVI_B/L_Button（连续3帧），上报按键被按下。', {heading: '示例'})
	.expected.map(({object, frames}) => [object, frames]), [['IVI_B/L_Button', 3]]);
assert.ok(expected.some((item) => item.object === '空调风量调节条' && item.blocking));
assert.deepEqual(expected.find((item) => item.delay_s === 30).signals, ['HVAC_Mode_change', 'HVAC_Defrost', 'HVAC_On_Off']);
assert.equal(expected.find((item) => item.delay_s === 30).since, '');
assert.match(expected.find((item) => item.delay_s === 30).unresolved, /计时起点/);
const explicitWindow = classify('自发出请求30S后，根据信号 HVAC_On_Off 变化更新空调开关显示，按该信号变化以便30S后更新空调开关显示。', {heading: '示例'}).expected.find((item) => item.delay_s === 30);
assert.equal(explicitWindow.since, '发出请求');
const unnamedWindow = classify('发出请求30S后更新显示。', {heading: '示例'}).expected.at(0);
assert.deepEqual([unnamedWindow.delay_s, unnamedWindow.since, unnamedWindow.blocking], [30, '发出请求', true]);
const group = classify('接收信号 HVAC_Defrost，记录反馈。并接收信号 HVAC_Mode_change 、 HVAC_Defrost、HVAC_On_Off，根据信号 HVAC_Mode_change、HVAC_Defrost、HVAC_On_Off 变化以便30S后更新显示。', { heading: '示例' }).expected;
assert.deepEqual(group.filter((item) => item.kind === 'can_feedback').map((item) => item.object), ['HVAC_Defrost', 'HVAC_Mode_change', 'HVAC_On_Off']);
assert.equal(group.find((item) => item.kind === 'ui_feedback_30s').blocking, true);

const prior = {version: 1, items: [{items: [{branch_id: 'BR-A', expected_items: [{id: 'BR-A-E1', kind: 'can_request', object: 'Request'}]}]}]};
const branch = {branch_id: 'BR-A', event: '操作', section: '入口', quote: '原文', expected: [
	{kind: 'ui_feedback', object: '显示'}, {kind: 'can_request', object: 'Request'}
]};
const outline = buildOutlineFromBranches({ digest: 'model', features: [] }, [branch], prior);
assert.deepEqual(outline.items[0].expected_items.map((item) => item.id), ['BR-A-E2', 'BR-A-E1']);

const point = {point_id: 'T-1', expected_items: [
	{id: 'BR-A-E2', object: '显示', kind: 'ui_feedback', quote: '显示', blocking: true},
	{id: 'BR-A-E1', object: 'Request', kind: 'state_observation', quote: 'E-0001'}
]};
const raw = {point_id: 'T-1', title: '观察', basis: 'E-0001', steps: [{key: 'read', role: 'observe', text: '在页面观察Request'}],
	expected_items: [{object: 'Request', kind: 'state_observation', target: '状态', observe: 'read', evidence_ref: 'E-0001'}],
	deferred_items: [{object: '显示', kind: 'ui_feedback', target: '更新显示', unresolved: '待确认'}]};
const structured = buildStructuredCase(raw, point);
assert.equal(buildStructuredCase({...raw, expected_items: [{...raw.expected_items[0], evidence_ref: '模型给的新出处'}]}, point)
	.expected_items[0].evidence_ref, 'E-0001');
structured.step_items.unshift({id: 'navigate', role: 'action', text: '进入页面'});
renderLegacyFields(structured);
assert.deepEqual(structured.steps, ['S01. 进入页面', 'S02. 在页面观察Request']);
assert.equal(structured.expected_items[0].step_index, 2);
const baselines = buildStructuredCase({ ...raw, prepare_items: [
	{ text: '记录初值', object: 'Exact_Signal', read_back: '读取 Exact_Signal 的当前值' },
	{ text: '留通信缺口', object: 'Near_Signal', read_back: '无法读回 Near_Signal' }
] }, { ...point, protocol_readbacks: { Exact_Signal: {message: 'FrameDef', message_id: '0x123'} } });
assert.equal(baselines.prepare_items[0].object, '被动采集会话');
assert.match(baselines.prepare_items[1].read_back, /FrameDef\(0x123\)/);
assert.equal(baselines.prepare_items[2].read_back, '无法读回 Near_Signal');
assert.match(baselines.restore_items.at(-1).text, /停止本例采集/);
assert.equal(validateAnchors(baselines).some((row) => row.code === 'CAPTURE_NOT_RECORDING'), false);
const timedPoint = { ...point, expected_items: [point.expected_items[0], {
	...point.expected_items[1], since: '来源事件发生', delay_s: 30
}] };
const timed = { ...raw, expected_items: [{...raw.expected_items[0], since: '模型推测的首帧', delay_s: 30}] };
assert.equal(buildStructuredCase(timed, timedPoint).expected_items[0].since, '来源事件发生');
const mistimed = { ...timed, expected_items: [{ ...timed.expected_items[0], delay_s: 25 }] };
assert.equal(mergeCasesDetailed([], {cases: [mistimed]}, new Set([point.point_id]), new Map([[point.point_id, timedPoint]])).dropped[0].reason,
	'ASSERTION_WINDOW_MISMATCH');
assert.equal(structured.deferred_items[0].assertion_ref, 'BR-A-E2');
const points = new Map([[point.point_id, point]]);
assert.equal(mergeCasesDetailed([], {cases: [raw]}, new Set(points.keys()), points).added.length, 1);
const groundedPoint = { ...point, source: { evidence_id: 'E-0001', location: '审批说明第 2 段' }, fact_refs: ['F-0001'] };
const grounded = mergeCasesDetailed([], { cases: [{ ...raw, basis: 'F-539593BA4A', source_reference: 'F-9999' }] },
	new Set(points.keys()), new Map([[point.point_id, groundedPoint]])).added[0];
assert.equal(grounded.source_reference, 'E-0001;F-0001');
assert.match(grounded.basis, /E-0001 · 审批说明第 2 段/);
const noExecutable = mergeCasesDetailed([], {cases: [{...raw, expected_items: [], deferred_items: [
	{...raw.deferred_items[0], assertion_ref: 'BR-A-E2'}
]}]}, new Set(points.keys()), points);
assert.deepEqual(noExecutable.dropped[0].assertion_refs, ['BR-A-E2']);
assert.equal(noExecutable.dropped[0].reason, 'NO_EXECUTABLE_ASSERTIONS');
assert.equal(noExecutable.added.length, 0);
const missing = mergeCasesDetailed([], {cases: [{...raw, deferred_items: []}]}, new Set(points.keys()), points);
assert.equal(missing.dropped[0].reason, 'ASSERTION_COVERAGE_MISSING');
const unchecked = { ...point, expected_items: [...point.expected_items, {
	id: 'CAN-1', object: 'Raw field', kind: 'can_feedback', quote: '接收 Raw field', blocking: true,
	binding_blocked: true, target: '接收后记录', unresolved: '通信矩阵字段待确认'
}] };
const uncheckedPoints = new Map([[point.point_id, unchecked]]);
const deferred = mergeCasesDetailed([], {cases: [raw]}, new Set(points.keys()), uncheckedPoints);
assert.equal(deferred.added[0].deferred_items.find((entry) => entry.assertion_ref === 'CAN-1').evidence_ref, '接收 Raw field');
const inventedRead = { ...raw, expected_items: [...raw.expected_items, {assertion_ref: 'CAN-1', object: 'Raw_field'}] };
assert.equal(mergeCasesDetailed([], {cases: [inventedRead]}, new Set(points.keys()), uncheckedPoints).dropped[0].reason, 'SIGNAL_BINDING_UNRESOLVED');
structured.deferred_items[0].assertion_ref = 'BR-OTHER-E2';
assert.ok(lint([{...structured, point_id: 'T-1', structured: true, basis: 'E-0001'}], new Set(points.keys()), new Set(), points)
	.some((entry) => entry.code === 'ASSERTION_REF_MISMATCH'));

const boot = {id: 'cap', establish: '启动被动采集', read_back: '确认采集为记录中'};
const read = {id: 'base', establish: '只读', read_back: '在原始采集记录中读取两个字段'};
const stop = {id: 'stop', text: '停止采集并保存'};
const restore = {id: 'restore', text: '复核恢复', read_back: '在原始采集记录中复核两个字段'};
const captureIssues = (p, r) => validateAnchors({prepare_items: p, restore_items: r}).filter((item) => item.code === 'CAPTURE_NOT_RECORDING');
assert.equal(captureIssues([boot, read], [restore, stop]).length, 0);
assert.equal(captureIssues([read, boot], [restore, stop]).length, 1);
assert.equal(captureIssues([boot, read], [stop, restore]).length, 1);
assert.equal(captureIssues([{...boot, establish: '使用已有采集会话'}, read], [restore, stop]).length, 0);
const misplaced = {...raw, prepare_items: [{...read, text: '读回基线'}, {...boot, text: '启动采集'}]};
assert.equal(mergeCasesDetailed([], {cases: [misplaced]}, new Set(points.keys()), points).dropped[0].reason, 'CAPTURE_NOT_RECORDING');
assert.equal(mergeCasesDetailed([], {cases: [{...misplaced, prepare_items: [...misplaced.prepare_items].reverse()}]}, new Set(points.keys()), points).added.length, 1);
assert.equal(mergeCasesDetailed([], {cases: [misplaced, raw]}, new Set(points.keys()), points).added.length, 1);
const recordId = { key: 'identity', text: '保存记录编号', establish: '在文档列表取得编号', read_back: '核对编号可定位记录' };
const snapshot = { key: 'snapshot', text: '保存记录基线', establish: '按准备项 identity 定位并保存记录', read_back: '核对基线可打开' };
const prepared = (items) => mergeCasesDetailed([], {cases: [{...raw, prepare_items: items}]}, new Set(points.keys()), points);
assert.equal(prepared([recordId, snapshot]).added.length, 1);
assert.equal(prepared([snapshot, recordId]).dropped[0].reason, 'PREPARE_UNAVAILABLE_INPUT');
assert.equal(prepared([{ ...recordId, establish: '按准备项 identity 查询记录编号' }]).dropped[0].reason, 'PREPARE_UNAVAILABLE_INPUT');
const requestPoint = {...point, expected_items: [{id: 'REQ', object: 'Request', kind: 'can_request'}]};
const requestCase = {...raw, steps: [{key: 'click', role: 'action', text: '在页面点击请求按钮'}, ...raw.steps],
	restore_items: [{text: '在页面恢复测试前状态', baseline: '测试前状态', read_back: '在页面核对状态'}],
	deferred_items: [], expected_items: [{...raw.expected_items[0], trigger: 'click', kind: 'can_request', frames: 3, assertion_ref: 'REQ'}]};
assert.equal(mergeCasesDetailed([], {cases: [requestCase]}, new Set(points.keys()), new Map([[point.point_id, requestPoint]])).dropped[0].reason, 'ASSERTION_FRAME_COUNT_MISMATCH');
requestPoint.expected_items[0].frames = 3;
assert.equal(mergeCasesDetailed([], {cases: [requestCase]}, new Set(points.keys()), new Map([[point.point_id, requestPoint]])).added.length, 1);
const wrongDirection = {...requestCase, expected_items: [{...requestCase.expected_items[0], kind: 'can_feedback'}]};
assert.equal(mergeCasesDetailed([], {cases: [wrongDirection]}, new Set(points.keys()), new Map([[point.point_id, requestPoint]])).dropped[0].reason, 'ASSERTION_PROTOCOL_KIND_MISMATCH');
const passiveCause = buildStructuredCase({ ...raw, steps: [
	{ key: 'past', role: 'observe', text: '在原始采集记录中读取反馈值' }, ...raw.steps
], expected_items: [{ ...raw.expected_items[0], kind: 'ui_feedback', trigger: 'past' }] }, point);
assert.ok(validateAnchors(passiveCause).some(issue => issue.code === 'PASSIVE_READBACK_AS_TRIGGER'));
assert.equal(mergeCasesDetailed([], {cases: [{...requestCase, expected_items: [{...requestCase.expected_items[0], trigger: 'unknown'}]}]},
	new Set(points.keys()), new Map([[point.point_id, requestPoint]])).dropped[0].reason, 'TRIGGER_MISSING');
// 上游测试点只写了泛称或整句条件时，用例把义务细化成可观察对象并在出处/缺口里说明，不算挂错判据；
// 没有出处或明显指向另一个对象时仍必须阻断（只放宽「来源不可观察 + 用例更具体 + 有出处」这一种）。
const vaguePoint = { point_id: 'T-VAGUE', expected_items: [
	{ id: 'BR-V-E1', object: '显示', kind: 'ui_feedback_30s' },
	{ id: 'BR-V-E2', object: '丢失报文信号恢复正常之后', kind: 'ui_immediate' },
	{ id: 'BR-V-E3', object: '风量显示', kind: 'ui_immediate' }
] };
const vaguePoints = new Map([[vaguePoint.point_id, vaguePoint]]);
const refCase = (expected) => ({ case_id: 'C-V', point_id: vaguePoint.point_id, steps: ['S01. 在空调界面观察'],
	expected: 'S01-1. 观察', basis: 'E-0001', expected_items: expected });
const refMismatch = (item) => lint([item], new Set([vaguePoint.point_id]), new Set(), vaguePoints)
	.filter((entry) => entry.code === 'ASSERTION_REF_MISMATCH');
assert.equal(refMismatch(refCase([{ id: 'e1', assertion_ref: 'BR-V-E1', object: '快速除雾图标', kind: 'ui_immediate',
	unresolved: '原文未点名具体图标' }])).length, 0);
assert.equal(refMismatch(refCase([{ id: 'e2', assertion_ref: 'BR-V-E2', object: '吹风模式显示', kind: 'ui_immediate',
	evidence_ref: '原文：丢失报文信号恢复正常之后' }])).length, 0);
assert.equal(refMismatch(refCase([{ id: 'e3', assertion_ref: 'BR-V-E1', object: '快速除雾图标', kind: 'ui_immediate' }])).length, 1);
assert.equal(refMismatch(refCase([{ id: 'e4', assertion_ref: 'BR-V-E3', object: '温度显示', kind: 'ui_immediate',
	unresolved: '不是同一个对象' }])).length, 1);
const canPoint = { point_id: 'T-CAN', expected_items: [{ id: 'BR-C-E1', object: 'RAW_FIELD', kind: 'can_request' }] };
assert.equal(lint([{ case_id: 'C-CAN', point_id: 'T-CAN', steps: ['S01. 在采集工具读取'], expected: 'S01-1. 读取',
	basis: 'E-0001', expected_items: [{ id: 'e1', assertion_ref: 'BR-C-E1', object: 'OTHER_FIELD', kind: 'can_feedback',
	unresolved: 'x' }] }], new Set(['T-CAN']), new Set(), new Map([['T-CAN', canPoint]]))
	.filter((entry) => entry.code === 'ASSERTION_REF_MISMATCH').length, 1);
const designCase = { steps: ['S01. 在页面观察【吹脚】按键显示'] };
decorateCases([designCase], { items: [{ kind: 'control', status: 'bound', subject: { name: '吹脚' }, target: { node_id: '1:2' } }] });
assert.deepEqual(designCase.steps, ['S01. 在页面观察【吹脚】按键显示']);
assert.equal(designCase.controls[0].node_id, '1:2');

// ============================================================================
// 改造 2、3、4 专项正反例与整体符号替换验证
// ============================================================================
function runGenericSuite({ bizName, surfMain, surfBar, surfIrrelevant, dutNode, peerNode, sigOut, sigIn, sigPeerAlt }) {
	// 1. 改造 2：跨批次全局闭环规则 × 两个适用入口 × 三个分支 + 一个无关入口
	const clFacts = [
		{ fact_id: 'F-0001', type: 'rule', statement: `全局通信约定：无操作时不发送信号，根据输入信号显示对应值；状态改变时，${dutNode}连续发送三帧有效信号，界面设置为所选状态`, evidence_refs: ['E-0001'] },
		{ fact_id: 'F-0002', type: 'rule', statement: '全局通信约定：自状态改变发送请求起，若2s内未收到反馈，界面显示状态回弹', evidence_refs: ['E-0001'] },
		{ fact_id: 'F-0003', type: 'rule', statement: '全局通信约定：若收到反馈值无效，界面显示状态回弹', evidence_refs: ['E-0001'] },
		{ fact_id: 'F-0025', type: 'control', statement: `在${surfMain}提供【${bizName}】开关选项`, evidence_refs: ['E-0010'] },
		{ fact_id: 'F-0026', type: 'signal', statement: `${bizName}控制命令 ${sigOut}，发送方为 ${dutNode}，接收方为 ${peerNode}，取值 0x0: 无输入；0x1: 关闭；0x2: 开启；0x3: 预留`, evidence_refs: ['E-0011'] },
		{ fact_id: 'F-0027', type: 'signal', statement: `${bizName}状态反馈 ${sigIn}，发送方为 ${peerNode}，接收方为 ${dutNode}，取值 0x0: 关闭；0x1: 开启；0x3: 无效`, evidence_refs: ['E-0011'] },
		{ fact_id: 'F-0045', type: 'rule', statement: `在${surfBar}单击【${bizName}】开关打开${bizName}`, evidence_refs: ['E-0020'] },
		{ fact_id: 'F-0046', type: 'rule', statement: `点击${surfIrrelevant}【帮助说明】图标仅打开帮助页面，不发送控制信号`, evidence_refs: ['E-0021'] }
	];
	const sigIdx = new Map([
		[sigOut.replace(/[\s_-]/g, '').toLowerCase(), { name: sigOut, description: `${bizName}命令`, message: 'MSG_OUT', message_id: '0x101', transmitter: dutNode, receivers: [peerNode], initial: '0x0', invalid: '0x3', valueDesc: '0x0: 无输入 0x1: 关闭 0x2: 开启 0x3: 预留' }],
		[sigIn.replace(/[\s_-]/g, '').toLowerCase(), { name: sigIn, description: `${bizName}状态反馈`, message: 'MSG_IN', message_id: '0x202', transmitter: peerNode, receivers: [dutNode], initial: '0x0', invalid: '0x3', valueDesc: '0x0: 关闭 0x1: 开启 0x3: 无效' }]
	]);
	const plan3 = buildClosedLoopCoveragePlan(clFacts, [], [], sigIdx, { dut: dutNode });
	assert.equal(plan3.branches.length, 3, '应识别出 3 个有依据的结果分支');
	assert.equal(plan3.entries.length, 2, '应识别出 2 个有依据的适用入口');
	assert.equal(plan3.cells.length, 6, '两个适用入口 × 三个分支应生成 6 个覆盖格');
	assert.ok(plan3.excluded_entries.some((e) => e.fact_id === 'F-0046'), '无关入口必须被排除且覆盖格为 0');

	// 验证跨批注入：Batch 3 仅含 F-0045、F-0046，closedLoopForBatch 必须把 F-0001..F-0003 与信号事实 F-0026、F-0027 一并注入并加入白名单
	const batch3 = clFacts.filter((f) => f.fact_id === 'F-0045' || f.fact_id === 'F-0046');
	const clBatch3 = closedLoopForBatch(batch3, plan3, clFacts);
	assert.equal(clBatch3.cells.length, 3, '目标批应关联该入口的 3 个分支格');
	assert.ok(clBatch3.allowedFactIds.has('F-0001') && clBatch3.allowedFactIds.has('F-0026') && clBatch3.allowedFactIds.has('F-0027'), '跨批引用白名单应精确包含注入的全局规则与信号事实');

	// 验证合并点与通用点不得抵扣具体格子
	const badPoints = [
		{ point_id: 'T-GEN', requirement: '通用外发协议', condition: '任意开关关闭', action: '点击任意开关', expected: '2s内未收到反馈则回弹', fact_refs: ['F-0002'] },
		{ point_id: 'T-MERGED', requirement: `${surfBar}${bizName}`, condition: `${bizName}关闭`, action: `在${surfBar}单击【${bizName}】`, expected: '若2s内收到有效反馈则保持开启，否则未收到反馈或反馈值无效时界面回弹', fact_refs: ['F-0001', 'F-0002', 'F-0003', 'F-0045'] }
	];
	const badCov = evaluateClosedLoopCoverage(badPoints, plan3);
	assert.equal(badCov.covered_cells.length, 0, '通用协议点与合并互斥分支点均不得抵扣具体覆盖格');
	assert.equal(badCov.merged_points.length, 1, '应识别出合并互斥分支的违规测试点');

	// 验证 6 条独立点可完整覆盖 6 格
	const goodPoints = plan3.cells.map((cell, idx) => ({
		point_id: `T-GOOD-${idx + 1}`,
		requirement: `${cell.entry_label}-${cell.branch_label}`,
		condition: `${bizName}处于关闭状态`,
		action: `在${cell.surface}单击【${cell.subject}】开关`,
		expected: cell.instruction,
		fact_refs: [...cell.required_fact_refs]
	}));
	const goodCov = evaluateClosedLoopCoverage(goodPoints, plan3);
	assert.equal(goodCov.covered_cells.length, 6, '6 条独立点应 100% 覆盖 6 个闭环格子');

	// 删去无效反馈规则（F-0003），确认对应两格随之消失（6 -> 4）
	const plan2 = buildClosedLoopCoveragePlan(clFacts.filter((f) => f.fact_id !== 'F-0003'), [], [], sigIdx, { dut: dutNode });
	assert.equal(plan2.branches.length, 2, '删去无效反馈规则后只剩 2 个分支');
	assert.equal(plan2.cells.length, 4, '删去无效反馈规则后对应 2 格消失，总格数应为 4');

	// 2. 改造 3：状态机资格判断六种情形 + 坏状态机负例拓扑校验
	const stateFacts = [
		{ fact_id: 'FS-1', type: 'control', statement: `${surfMain}包含【${bizName}】组件与图标展示` },
		{ fact_id: 'FS-2', type: 'control', statement: `${surfBar}包含【${bizName}】状态变体：选中、未选中` },
		{ fact_id: 'FS-3', type: 'rule', statement: `当${bizName}处于关闭状态时，在${surfMain}单击【${bizName}】开关，${bizName}切换为开启状态` },
		{ fact_id: 'FS-4', type: 'state', statement: `${bizName}状态包含开启与关闭两种状态` },
		{ fact_id: 'FS-5', type: 'rule', statement: `单击【${bizName}】按键可触发操作` },
		{ fact_id: 'FS-6', type: 'rule', statement: `【待裁决】${bizName}异常断连后的目标状态原文未明确（待确认）` }
	];
	const fStatic = { feature_id: 'FTR_STATIC', name: '静态组件展示', fact_refs: ['FS-1', 'FS-2'] };
	const fSingle = { feature_id: 'FTR_SINGLE', name: '单事实明确转移', fact_refs: ['FS-3'] };
	const fMulti = { feature_id: 'FTR_MULTI', name: '多事实有效转移', fact_refs: ['FS-4', 'FS-3'] };
	const fInsuff = { feature_id: 'FTR_INSUFF', name: '证据不足仅触发线索', fact_refs: ['FS-5', 'FS-6'] };

	assert.equal(evaluateStateEligibility(fStatic, stateFacts).status, 'skipped_static', '两条静态事实不得因数量获得状态机资格');
	assert.equal(evaluateStateEligibility(fSingle, stateFacts).status, 'eligible', '单条事实明确触发+原状态+结果状态时允许生成');
	assert.equal(evaluateStateEligibility(fMulti, stateFacts).status, 'eligible', '多事实有效转移应有资格');
	assert.equal(evaluateStateEligibility(fInsuff, stateFacts).status, 'insufficient_evidence', '有交互线索但缺转移终点的功能应记为证据不足');
	assert.equal(evaluateStateEligibility(fStatic, stateFacts, '人工确认：单击切换开启/关闭').status, 'eligible', '人工补充触发条件应参与判断并获得资格');

	const filtered = filterEligibleStateFeatures([fStatic, fSingle, fMulti, fInsuff], stateFacts);
	assert.equal(filtered.eligible.length, 2);
	assert.equal(filtered.skipped_static.length, 1);
	assert.equal(filtered.insufficient_evidence.length, 1);

	const badMachine = {
		state_id: 'FTR_BAD',
		feature_id: 'FTR_BAD',
		name: '坏状态机负例',
		states: [{ state_id: 'FTR_BAD.S01', name: '开启' }, { state_id: 'FTR_BAD.S02', name: '孤立态' }],
		transitions: [],
		rejected: [{ from: '开启', to: '不存在态', reason: 'UNKNOWN_STATE_OR_TRIGGER' }]
	};
	const badIssues = validateState(badMachine).map((i) => i.code);
	assert.ok(badIssues.includes('NO_TRANSITIONS') && badIssues.includes('ORPHAN_STATE') && badIssues.includes('REJECTED_TRANSITION'), '原拓扑校验对坏状态机仍须生效');

	// 3. 改造 4：准备项独立反馈回读五组输入验证
	const targetPoint = {
		point_id: 'T-FB-1',
		feature_id: 'FTR_CL',
		requirement: `${bizName}关闭操作`,
		condition: `${bizName}处于开启状态`,
		action: `在${surfMain}单击【${bizName}】`,
		expected: `关闭${bizName}`,
		fact_refs: ['F-0025']
	};
	const clFeature = [{ feature_id: 'FTR_CL', name: bizName, fact_refs: ['F-0025', 'F-0026', 'F-0027'] }];

	// (a) 无 _Req/_St 命名后缀的请求与反馈 + 区分矩阵初值(0x0)与测试目标初态(0x1:开启)
	const attrNoSuffix = resolvePointFeedbackAttribution(targetPoint, {
		facts: clFacts,
		features: clFeature,
		bindings: [],
		signalIndex: sigIdx,
		dut: dutNode,
		surface: surfMain
	});
	assert.equal(attrNoSuffix.status, 'unique_feedback', '无后缀信号应按矩阵收发方向与语义唯一归属反馈');
	assert.equal(attrNoSuffix.attributions[0].feedback_signal, sigIn);
	assert.equal(attrNoSuffix.attributions[0].target_enum, '0x1（开启）', '应匹配本例目标初态 0x1（开启）而非矩阵上电初值 0x0');
	assert.equal(attrNoSuffix.attributions[0].matrix_initial, '0x0');
	assert.ok(attrNoSuffix.forbidden_request_signals.includes(sigOut), '外发请求信号必须列入禁止回读清单');

	// 验证 enrichPrepareFeedbackReadback 纠正错写外发请求信号与采集顺序
	const rawCaseToEnrich = buildStructuredCase({
		point_id: 'T-FB-1',
		title: `关闭${bizName}`,
		basis: 'E-0010',
		prepare_items: [
			{ key: 'p1', text: '读基线', object: sigOut, target: '开启', establish: '保持开启', read_back: `在原始采集记录中读取 ${sigOut}=0x2`, on_failure: '停止' },
			{ key: 'capture', text: '启动被动采集', object: '被动采集会话', target: '记录中', establish: '启动被动采集', read_back: '确认记录中', on_failure: '停止' }
		],
		steps: [{ key: 'click', role: 'action', text: `在${surfMain}单击【${bizName}】` }, { key: 'obs', role: 'observe', text: `在${surfMain}观察【${bizName}】` }],
		expected_items: [{ key: 'e1', trigger: 'click', observe: 'obs', object: bizName, target: '切换为关闭', kind: 'ui_immediate', evidence_ref: 'E-0010' }]
	}, targetPoint);
	enrichPrepareFeedbackReadback(rawCaseToEnrich, targetPoint, attrNoSuffix, surfMain);
	assert.equal(rawCaseToEnrich.prepare_items[0].key, 'capture', '被动采集启动应排在信号基线回读之前');
	assert.ok(rawCaseToEnrich.prepare_items[1].read_back.includes(sigIn) && rawCaseToEnrich.prepare_items[1].read_back.includes('0x1（开启）'), '准备项 read_back 必须写明独立反馈信号及目标初态枚举');
	assert.ok(!rawCaseToEnrich.prepare_items[1].read_back.includes(sigOut), '准备项 read_back 严禁残留被测方外发请求信号');

	// (b) 有误导性后缀的反例（外发信号名带 _St，对端反馈信号名带 _Req）
	const misleadingOut = `${sigOut}_St`;
	const misleadingIn = `${sigIn}_Req`;
	const misleadingFacts = [
		{ fact_id: 'FM-1', type: 'control', statement: `在${surfMain}提供【${bizName}】开关` },
		{ fact_id: 'FM-2', type: 'signal', statement: `${bizName}指令 ${misleadingOut}，发送方为 ${dutNode}，接收方为 ${peerNode}，取值 0x0: 关闭；0x1: 开启` },
		{ fact_id: 'FM-3', type: 'signal', statement: `${bizName}实际状态 ${misleadingIn}，发送方为 ${peerNode}，接收方为 ${dutNode}，取值 0x0: 关闭；0x1: 开启` }
	];
	const misleadingIdx = new Map([
		[misleadingOut.replace(/[\s_-]/g, '').toLowerCase(), { name: misleadingOut, description: `${bizName}指令`, message: 'M_TX', message_id: '0x111', transmitter: dutNode, receivers: [peerNode], valueDesc: '0x0: 关闭 0x1: 开启' }],
		[misleadingIn.replace(/[\s_-]/g, '').toLowerCase(), { name: misleadingIn, description: `${bizName}实际状态`, message: 'M_RX', message_id: '0x222', transmitter: peerNode, receivers: [dutNode], valueDesc: '0x0: 关闭 0x1: 开启' }]
	]);
	const attrMisleading = resolvePointFeedbackAttribution(
		{ ...targetPoint, fact_refs: ['FM-1'] },
		{ facts: misleadingFacts, features: [{ feature_id: 'FTR_CL', name: bizName, fact_refs: ['FM-1', 'FM-2', 'FM-3'] }], bindings: [], signalIndex: misleadingIdx, dut: dutNode, surface: surfMain }
	);
	assert.equal(attrMisleading.status, 'unique_feedback');
	assert.equal(attrMisleading.attributions[0].feedback_signal, misleadingIn, '误导性后缀下仍必须按矩阵真实收发方向选择对端反馈信号');
	assert.ok(attrMisleading.forbidden_request_signals.includes(misleadingOut), '误导性 _St 外发信号必须被识别为被测方发送并禁止当作反馈回读');

	// (c) 同功能多个对等反馈候选 -> ambiguous_feedback
	const multiFbFacts = [
		...clFacts,
		{ fact_id: 'F-0028', type: 'signal', statement: `${bizName}状态反馈 ${sigPeerAlt}，发送方为 ${peerNode}，接收方为 ${dutNode}，取值 0x0: 关闭；0x1: 开启`, evidence_refs: ['E-0011'] }
	];
	const multiFbIdx = new Map([
		...sigIdx,
		[sigPeerAlt.replace(/[\s_-]/g, '').toLowerCase(), { name: sigPeerAlt, description: `${bizName}状态反馈`, message: 'MSG_IN2', message_id: '0x203', transmitter: peerNode, receivers: [dutNode], valueDesc: '0x0: 关闭 0x1: 开启' }]
	]);
	const attrMulti = resolvePointFeedbackAttribution(targetPoint, {
		facts: multiFbFacts,
		features: [{ feature_id: 'FTR_CL', name: bizName, fact_refs: ['F-0025', 'F-0026', 'F-0027', 'F-0028'] }],
		bindings: [],
		signalIndex: multiFbIdx,
		dut: dutNode,
		surface: surfMain
	});
	assert.equal(attrMulti.status, 'ambiguous_feedback', '同功能存在多个对等候选反馈时不得擅自猜测');

	// (d) 只有外发请求信号 -> only_request
	const onlyReqFacts = clFacts.filter((f) => f.fact_id !== 'F-0027');
	const attrOnlyReq = resolvePointFeedbackAttribution(targetPoint, {
		facts: onlyReqFacts,
		features: [{ feature_id: 'FTR_CL', name: bizName, fact_refs: ['F-0025', 'F-0026'] }],
		bindings: [],
		signalIndex: new Map([[sigOut.replace(/[\s_-]/g, '').toLowerCase(), sigIdx.get(sigOut.replace(/[\s_-]/g, '').toLowerCase())]]),
		dut: dutNode,
		surface: surfMain
	});
	assert.equal(attrOnlyReq.status, 'only_request', '仅有请求信号时应识别为 only_request');

	// (e) 纯 UI 无信号 -> pure_ui
	const attrPureUi = resolvePointFeedbackAttribution(
		{ ...targetPoint, requirement: '纯界面弹窗', condition: '弹窗处于关闭状态', fact_refs: ['FS-1'] },
		{ facts: [stateFacts[0]], features: [fStatic], bindings: [], signalIndex: new Map(), dut: dutNode, surface: surfMain }
	);
	assert.equal(attrPureUi.status, 'pure_ui', '纯 UI 无信号时应识别为 pure_ui');

	// 4. Round 4：单入口闭环开关 + 全量展开提示 + 复合前置多信号独立回读 + 采集订阅清单 + 修饰词容错
	const auxName = `${bizName}辅助`;
	const sigAuxOut = `${sigOut}_Aux`;
	const sigAuxIn = `${sigIn}_Aux`;
	const sigLevelIn = `${sigIn}_Lvl`;
	const singleEntryFacts = [
		...clFacts,
		{ fact_id: 'F-0047', type: 'control', statement: `在${surfMain}提供【${auxName}】开关，点击可开启或关闭${auxName}`, evidence_refs: ['E-0022'] },
		{ fact_id: 'F-0048', type: 'signal', statement: `${auxName}控制命令 ${sigAuxOut}，发送方为 ${dutNode}，接收方为 ${peerNode}，取值 0x0: 无输入；0x1: 关闭；0x2: 开启`, evidence_refs: ['E-0022'] },
		{ fact_id: 'F-0049', type: 'signal', statement: `${auxName}状态反馈 ${sigAuxIn}，发送方为 ${peerNode}，接收方为 ${dutNode}，取值 0x0: 关闭；0x1: 开启`, evidence_refs: ['E-0022'] }
	];
	const extSigIdx = new Map([
		...sigIdx,
		[sigAuxOut.replace(/[\s_-]/g, '').toLowerCase(), { name: sigAuxOut, description: `${auxName}命令`, message: 'MSG_AUX_OUT', message_id: '0x105', transmitter: dutNode, receivers: [peerNode], initial: '0x0', valueDesc: '0x0: 无输入 0x1: 关闭 0x2: 开启' }],
		[sigAuxIn.replace(/[\s_-]/g, '').toLowerCase(), { name: sigAuxIn, description: `${auxName}状态反馈`, message: 'MSG_AUX_IN', message_id: '0x205', transmitter: peerNode, receivers: [dutNode], initial: '0x0', valueDesc: '0x0: 关闭 0x1: 开启' }],
		[sigLevelIn.replace(/[\s_-]/g, '').toLowerCase(), { name: sigLevelIn, description: `${bizName}档位反馈`, message: 'MSG_LVL_IN', message_id: '0x206', transmitter: peerNode, receivers: [dutNode], initial: '0x0', valueDesc: '0x0: 关闭 0x1: 1档 0x2: 2档 0x3: 3档 0x4: 4档' }]
	]);
	const planDefaultSingles = buildClosedLoopCoveragePlan(singleEntryFacts, [], [], extSigIdx, { dut: dutNode });
	const planWithSingles = buildClosedLoopCoveragePlan(singleEntryFacts, [], [], extSigIdx, { dut: dutNode, includeSingleEntries: true });
	assert.equal(planDefaultSingles.entries.length, 2, '默认模式应聚焦多入口对象');
	assert.equal(planWithSingles.entries.length, 3, '开启 includeSingleEntries 后应纳入单入口可交互对象');
	assert.equal(planWithSingles.cells.length, 9, '3 入口 × 3 分支应生成 9 个闭环格');

	const exhaustiveBatch = [
		{ fact_id: 'FE-1', type: 'signal', statement: `${bizName}档位信号 ${sigLevelIn} 支持 0x1~0x4 四档调节` },
		{ fact_id: 'FE-2', type: 'rule', statement: `当系统处于受限模式置灰不可操作时，点击【${bizName}】、【${auxName}】弹出不可操作提示` },
		{ fact_id: 'FE-3', type: 'rule', statement: `${bizName}支持自动模式、手动模式、节能模式三种模式切换，开启节能模式时退出自动模式` }
	];
	const exhaustiveHints = buildExhaustiveExpansionHints(exhaustiveBatch, extSigIdx, [
		{ kind: 'control', status: 'bound', subject: { name: bizName, fact_ids: ['FE-2'] }, target: { name: bizName } },
		{ kind: 'control', status: 'bound', subject: { name: auxName, fact_ids: ['FE-2'] }, target: { name: auxName } }
	]);
	assert.ok(exhaustiveHints.length >= 3, '全量展开模式应产出离散枚举/档位、受限条件×控件、多模式互斥退出三类展开指令');

	// 复合前置条件（多子句含否定子句）独立反馈回读 + 自动前置采集与订阅清单
	const compoundPoint = {
		point_id: 'T-CMP-1',
		feature_id: 'FTR_CMP',
		requirement: `${bizName}联动切换`,
		condition: `${bizName}处于开启状态；且${auxName}处于非开启状态`,
		action: `在${surfMain}单击【${bizName}】`,
		expected: `关闭${bizName}`,
		fact_refs: ['F-0025', 'F-0047']
	};
	const cmpFeatures = [
		{ feature_id: 'FTR_CMP', name: bizName, fact_refs: ['F-0025', 'F-0026', 'F-0027'] },
		{ feature_id: 'FTR_AUX', name: auxName, fact_refs: ['F-0047', 'F-0048', 'F-0049'] }
	];
	const attrCompound = resolvePointFeedbackAttribution(compoundPoint, {
		facts: singleEntryFacts,
		features: cmpFeatures,
		bindings: [],
		signalIndex: extSigIdx,
		dut: dutNode,
		surface: surfMain
	});
	assert.equal(attrCompound.status, 'unique_feedback');
	assert.equal(attrCompound.attributions.length, 2, '复合前置条件应归属主子句与次子句两条独立反馈信号');
	assert.equal(attrCompound.attributions[0].feedback_signal, sigIn);
	assert.equal(attrCompound.attributions[0].target_enum, '0x1（开启）');
	assert.equal(attrCompound.attributions[1].feedback_signal, sigAuxIn);
	assert.equal(attrCompound.attributions[1].target_enum, '0x0（关闭）');

	const cmpCase = buildStructuredCase({
		point_id: 'T-CMP-1',
		title: `${bizName}复合前置关闭测试`,
		basis: 'E-0010',
		prepare_items: [
			{ key: 'p1', text: '建立主初态', object: bizName, target: '开启', establish: `在${surfMain}确认【${bizName}】开启`, read_back: `在${surfMain}观察【${bizName}】已开启`, on_failure: '停止' }
		],
		steps: [
			{ key: 'click', role: 'action', text: `在${surfMain}单击【${bizName}】` },
			{ key: 'obs', role: 'observe', text: `在${surfMain}观察【${bizName}】` }
		],
		expected_items: [{ key: 'e1', trigger: 'click', observe: 'obs', object: bizName, target: '切换为关闭', kind: 'ui_immediate', evidence_ref: 'E-0010' }],
		restore_items: [{ key: 'r1', text: '恢复初态', baseline: '测试前状态', read_back: `在${surfMain}核对【${bizName}】恢复` }]
	}, compoundPoint);
	enrichPrepareFeedbackReadback(cmpCase, compoundPoint, attrCompound, surfMain, { items: [] });
	assert.equal(cmpCase.prepare_items[0].object, '被动采集会话', '缺失被动采集启动项时应自动前置注入');
	assert.ok(cmpCase.prepare_items[0].read_back.includes('已订阅') && cmpCase.prepare_items[0].read_back.includes(sigIn) && cmpCase.prepare_items[0].read_back.includes(sigAuxIn), '被动采集启动项 read_back 须列明本例订阅信号清单');
	assert.ok(cmpCase.prepare_items.some((p) => (p.read_back || '').includes(sigIn) && (p.read_back || '').includes('0x1（开启）')), '主子句须有独立反馈信号回读');
	assert.ok(cmpCase.prepare_items.some((p) => (p.read_back || '').includes(sigAuxIn) && (p.read_back || '').includes('0x0（关闭）')), '复合次子句须有独立反馈信号回读');
	assert.match(cmpCase.restore_items.at(-1).text, /停止本例采集/, '自动前置采集启动后须在恢复末尾自动补齐停止采集项');

	// 观察对象修饰词容错：允许 4+ 字中文对象词中间插 1-2 个修饰字，仍严格拦截真正对象不匹配
	const modOkCase = buildStructuredCase({
		point_id: 'T-MOD-1',
		title: '当前界面观察',
		basis: 'E-0010',
		steps: [{ key: 'obs', role: 'observe', text: `在${surfMain}观察当前所在界面` }],
		expected_items: [{ key: 'e1', trigger: '', observe: 'obs', object: '当前界面', target: '保持在当前页面', kind: 'ui_immediate', evidence_ref: 'E-0010' }]
	}, { point_id: 'T-MOD-1', expected_items: [] });
	assert.equal(validateAnchors(modOkCase).filter((i) => i.code === 'OBSERVATION_OBJECT_MISMATCH').length, 0, '“当前界面”应匹配含修饰词的“当前所在界面”');
	const modBadCase = buildStructuredCase({
		point_id: 'T-MOD-2',
		title: '对象不匹配',
		basis: 'E-0010',
		steps: [{ key: 'obs', role: 'observe', text: `在${surfMain}观察温度数值显示` }],
		expected_items: [{ key: 'e1', trigger: '', observe: 'obs', object: '当前界面', target: '保持显示', kind: 'ui_immediate', evidence_ref: 'E-0010' }]
	}, { point_id: 'T-MOD-2', expected_items: [] });
	assert.equal(validateAnchors(modBadCase).filter((i) => i.code === 'OBSERVATION_OBJECT_MISMATCH').length, 1, '无关观察对象仍须报 OBSERVATION_OBJECT_MISMATCH');

	return {
		cells3: plan3.cells.length,
		cells2: plan2.cells.length,
		cellsSingles: planWithSingles.cells.length,
		exhaustiveHintCount: exhaustiveHints.length,
		compoundAttrCount: attrCompound.attributions.length,
		eligibleCount: filtered.eligible.length,
		skippedCount: filtered.skipped_static.length,
		insuffCount: filtered.insufficient_evidence.length,
		fbRole: attrNoSuffix.status,
		fbEnum: attrNoSuffix.attributions[0].target_enum
	};
}

// 第一次运行：通用智能锁夹具
const runA = runGenericSuite({
	bizName: '智能锁',
	surfMain: '主控面板',
	surfBar: '快捷栏',
	surfIrrelevant: '状态栏',
	dutNode: 'TERM_A',
	peerNode: 'CTRL_B',
	sigOut: 'Cmd_SmartLock_Action',
	sigIn: 'Report_SmartLock_Channel',
	sigPeerAlt: 'Report_SmartLock_Backup'
});

// 第二次运行：整体替换业务名、入口名、节点名与信号名（天幕遮阳帘夹具）
const runB = runGenericSuite({
	bizName: '天幕遮阳帘',
	surfMain: '顶棚控制界面',
	surfBar: '小组件栏',
	surfIrrelevant: '导航栏',
	dutNode: 'GW_HOST',
	peerNode: 'ROOF_NODE',
	sigOut: 'FrameOut_Canopy_Drive',
	sigIn: 'FrameIn_Canopy_Observe',
	sigPeerAlt: 'FrameIn_Canopy_Mirror'
});

assert.deepEqual(runA, runB, '整体替换业务名、入口名、节点名与信号名后，分支数、状态机资格和读回方向必须完全一致');

console.log('原文义务、判据引用、稳定 ID、采集顺序、四项改造正反例与整体符号替换验证全部通过');
