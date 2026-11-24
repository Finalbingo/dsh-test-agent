/**
 * A 阶段回归：通用代码不含业务名，词表与来源全部来自项目声明。
 * 对 V5 必须与剥离前的硬编码行为逐字一致；对未声明能力的项目必须跳过专属检查。
 *   node cts-agent/scripts/test-decoupling.mjs [dataRoot] [projectId] [moduleId]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterModule, enterProjectConfig, termsPattern, surfaces, defaultSurface, signalPrefixes, declaredSource, hasCapability } from '../scope.js';
import { lint, structureCase, familyCoverage, buildCells } from '../artifacts.js';
import { enterSkillScope, skillDigests } from '../skills.js';
import { parseDbc, auditCases, locateSignal } from '../signal-audit.js';
import { validateAnchors } from '../case-structure.js';

const root = process.argv[2] || process.env.CTS_DATA_ROOT;
const project = process.argv[3] || process.env.CTS_PROJECT;
const module = process.argv[4] || process.env.CTS_MODULE;
assert.ok(root && project && module, '必须显式提供 dataRoot / project / module，脚本不内置项目默认值');

const config = JSON.parse(fs.readFileSync(path.join(root, 'projects', project, 'project.json'), 'utf8')).quality;
assert.ok(config, '该项目没有 quality 声明');
const dir = path.join(root, 'artifacts', project, module);
const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
const points = JSON.parse(fs.readFileSync(path.join(dir, 'points.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8'));

const results = [];
const check = (name, fn) => {
	try { fn(); results.push({ name, ok: true }); }
	catch (error) { results.push({ name, ok: false, error: error.message }); }
};

// 剥离前的硬编码表，只作为基准存在于本测试里。
const OLD_PLACE = /(空调界面|中控屏|Dock|dock|桌面|弹窗|弹层|页面|采集|CAN|CANoe|诊断|DBC|设计稿|原文|PRD|文档|表格|调节条|配图|台架)/;
const OLD_SCREEN = /界面|Dock|dock|弹窗|弹层|中控屏|桌面/;
const OLD_SIGNAL = /(IVI_|HVAC_|CDC_|CAN_)[A-Za-z0-9_]+/;
const GENERIC_PLACE = ['页面', '弹窗', '弹层', '桌面', '文档', '表格', '原文', 'PRD', '设计稿', '配图', '采集'];

enterModule(module);
enterProjectConfig(config);

const texts = [];
for (const item of cases.items) {
	structureCase(item);
	for (const step of item.step_items || []) texts.push(step.text);
	for (const entry of item.expected_items || []) texts.push(`${entry.object} ${entry.target}`);
	for (const entry of item.prepare_items || []) texts.push(entry.text || '');
	texts.push(item.expected || '', item.condition || '');
}
const corpus = texts.filter(Boolean);

// 迁移守卫只要求不丢识别：声明词表比旧硬编码表更宽是解耦的目的，不能反过来把旧行为冻死。
const gains = [];
const sameBehaviour = (oldRe, newRe, label) => {
	const lost = corpus.filter((text) => oldRe.test(text) && !newRe.test(text));
	assert.equal(lost.length, 0, `${label} 丢了剥离前能识别的写法：${lost.slice(0, 3).join(' / ')}`);
	const gained = corpus.filter((text) => !oldRe.test(text) && newRe.test(text));
	if (gained.length) gains.push(`${label} 新增识别 ${gained.length} 段：${gained.slice(0, 2).join(' / ')}`);
};

check('地点词表对 V5 行为不变', () => sameBehaviour(OLD_PLACE,
	termsPattern([...GENERIC_PLACE, ...surfaces(), 'CAN', 'CANoe', 'DBC', '诊断', '台架']), 'STEP_PLACE'));
check('界面词表对 V5 行为不变', () => sameBehaviour(OLD_SCREEN,
	termsPattern(['界面', '弹窗', '弹层', '桌面', ...surfaces()]), 'onScreen'));
check('信号前缀对 V5 行为不变', () => sameBehaviour(OLD_SIGNAL,
	new RegExp(`(?:${signalPrefixes().join('|')})[A-Za-z0-9_]+`), 'SIGNAL_NAME'));

check('结构硬错误仍为 0', () => {
	const errors = lint(cases.items, new Set(points.items.map((p) => p.point_id)),
		new Set(facts.items.map((f) => f.fact_id)), new Map(points.items.map((p) => [p.point_id, p])));
	const hard = errors.filter((e) => e.severity !== 'warning');
	assert.equal(hard.length, 0, `出现硬错误：${hard.slice(0, 3).map((e) => e.code).join(',')}`);
});

check('族与入口表对 V5 不变', () => {
	const families = familyCoverage(points.items).map((f) => f.family);
	assert.ok(families.includes('Dock 入口'), '声明的族丢失');
	const cells = buildCells({ fact_refs: facts.items.slice(0, 40).map((f) => f.fact_id) }, facts.items, 12);
	assert.ok(cells.some((c) => c.entry === '中控屏'), '兜底入口不再是声明的最后一项');
});

check('来源按声明解析', () => {
	assert.equal(declaredSource('dbc'), 'signals/V5-V7.dbc');
	assert.ok(fs.existsSync(path.join(root, 'projects', project, declaredSource('dbc'))), '声明的 DBC 不存在');
});

check('信号方向按声明的被测节点判定', () => {
	const rows = auditCases(cases.items, parseDbc(path.join(root, 'projects', project, declaredSource('dbc'))));
	const hard = rows.filter((r) => ['unknown_signal', 'unknown_message', 'ambiguous_message'].includes(r.status));
	assert.equal(hard.length, 0, `DBC 硬缺陷 ${hard.length}`);
	assert.ok(rows.some((r) => r.direction === 'IVI 发送（请求）'), '请求方向丢失');
	assert.ok(rows.some((r) => r.direction === 'AC 发送（IVI 接收反馈）'), '反馈方向丢失');
});

check('写死的报文号与信号一起校验', () => {
	const dbc = parseDbc(path.join(root, 'projects', project, declaredSource('dbc')));
	const message = [...dbc.messages.values()].find((entry) => entry.signals.length);
	const signal = message.signals[0].name;
	const bogus = '0x' + (parseInt(message.id, 16) + 1).toString(16).toUpperCase();
	const hardOf = (rows) => rows.filter((row) => ['unknown_message', 'unknown_signal'].includes(row.status));
	const wrong = auditCases([{ case_id: 'C-X', steps: [`在采集工具中监听 ${signal} 报文（ID ${bogus}）`] }], dbc);
	assert.ok(hardOf(wrong).length > 0, '写错的报文号必须报硬缺陷');
	const right = auditCases([{ case_id: 'C-Y', steps: [`在采集工具中监听 ${signal} 报文（ID ${message.id}）`] }], dbc);
	assert.equal(hardOf(right).length, 0, '写对的报文号不得误报');
});

check('拼写有差异的信号不进入已核对提示', () => {
	const dbc = parseDbc(path.join(root, 'projects', project, declaredSource('dbc')));
	const rows = auditCases(cases.items, dbc);
	const differs = [...new Set(rows.filter((row) => row.status === 'name_format_differs').map((row) => row.signal))];
	assert.ok(differs.length > 0, '语料里应存在拼写差异信号，否则本检查无意义');
	for (const name of differs) assert.equal(locateSignal(dbc, name).length, 0, `${name} 不得被精确命中后自动替换`);
});

check('诚实写明建不起来的基线可放行，但判据必须同时延期', () => {
	const point = points.items[0];
	const base = { case_id: 'C-X', point_id: point.point_id, title: '基线', structured: true, precondition: '已上电',
		steps: ['在采集工具中启动被动采集', '在原始采集记录中读取该信号'], expected: '观察到取值',
		restore_steps: ['按基线恢复'], failure_policy: '记录后停止', basis: '依据 F-0001',
		prepare_items: [{ id: 'p1', object: 'SIG_Name', target: '待通信确认', establish: '无法建立：缺报文与拼写确认', read_back: '无法读回', on_failure: '登记缺口，相关判据不执行' }] };
	const codes = (item) => lint([item], new Set([point.point_id]), new Set(facts.items.map((f) => f.fact_id))).filter((e) => e.code === 'BASELINE_NO_MESSAGE').length;
	assert.equal(codes({ ...base, deferred_items: [{ id: 'd1', object: 'SIG_Name', target: '待确认', evidence_ref: 'E-0001', unresolved: '拼写待通信确认' }] }), 0, '判据已延期时应放行');
	assert.equal(codes(base), 1, '只声明建不起来、判据没延期仍须拦下');
	assert.equal(codes({ ...base, prepare_items: [{ ...base.prepare_items[0], read_back: '在原始采集记录中读取 AC(0x2F0) 的该信号' }] }), 0, '写明报文照常放行');
});

check('界面判据的观察对象错配：抓真缺陷，且不误报括号/拼写/后缀写法', () => {
	const item = (object, body, kind = 'ui_feedback') => ({
		case_id: 'C-OBJ', structured: true,
		step_items: [{ id: 's1', key: 'a', text: '在空调界面单击一次【AC开关】', index: 1, role: 'action', anchor: 'S01' },
			{ id: 's2', key: 'b', text: body, index: 2, role: 'observe', anchor: 'S02' }],
		expected_items: [{ id: 'e1', object, target: '选中状态', kind, text: `${object}：选中状态`,
			trigger_step_id: 's1', step_id: 's2', evidence_ref: 'E-0001' }]
	});
	const fired = (object, body, kind) => validateAnchors(item(object, body, kind))
		.some((entry) => entry.code === 'OBSERVATION_OBJECT_MISMATCH' && /观察该判据的对象/.test(entry.message));
	// 真缺陷：风量显示的判据挂到只看空调开关的观察步。
	assert.ok(fired('风量显示', '在发出请求30s后的时限到达时，在空调界面观察空调开关状态显示'), '对象与观察步不符须阻断');
	assert.ok(fired('吹风模式显示', '在空调界面观察【温度】显示', 'ui_immediate'), '对象换了控件须阻断');
	// 以下都是同一对象的不同写法，不得误报。
	assert.equal(fired('【AC开关】', '在空调界面观察【AC开关】'), false, '对象自带括号不得误报');
	assert.equal(fired('AC状态显示', '在空调界面观察【A/C】状态的显示'), false, 'AC 与原文 A/C 写法不得误报');
	assert.equal(fired('内外循环状态显示', '在空调界面观察【内外循环】状态的显示'), false, '通用后缀与括号插入不得误报');
	assert.equal(fired('【PTC状态】', '在空调界面观察【PTC状态】显示'), false, '括号对象带后缀不得误报');
	assert.equal(fired('风量显示', '在空调界面观察【风量显示】'), false, '正常对位不得误报');
	// 报文类判据走信号名核对，不受这条界面规则影响。
	assert.equal(fired('HVAC_Air volume level', '在原始采集记录中读取 HVAC_Air volume level 当前值', 'can_feedback'), false);
});

check('准备项豁免的四个反例', () => {
	const point = points.items[0];
	const ids = new Set([point.point_id]);
	const fids = new Set(facts.items.map((entry) => entry.fact_id));
	const codesOf = (item) => lint([item], ids, fids).map((entry) => entry.code);
	const prepare = (object) => [{ id: 'p1', object, target: '待通信确认', establish: '无法建立：缺报文与拼写确认', read_back: '无法读回', on_failure: '登记缺口，相关判据不执行' }];
	const deferred = (object) => [{ id: 'd1', object, target: '待确认', evidence_ref: 'E-0001', unresolved: '拼写待通信确认' }];
	const executable = (object) => [{ id: 'e1', object, target: '取值相对基线变化', kind: 'can_feedback', text: `${object}：取值相对基线变化`,
		trigger_step_id: 's1', step_id: 's2', evidence_ref: 'E-0001' }];
	const base = { case_id: 'C-N', point_id: point.point_id, title: '反例', structured: true, precondition: '已上电',
		step_items: [{ id: 's1', key: 'a', text: '在采集工具中启动被动采集', index: 1, role: 'action', anchor: 'S01' }, { id: 's2', key: 'b', text: '在原始采集记录中读取该信号', index: 2, role: 'observe', anchor: 'S02' }],
		steps: ['S01. 在采集工具中启动被动采集', 'S02. 在原始采集记录中读取该信号'], expected: 'SIG_Name：取值相对基线变化',
		restore_items: [{ id: 'r1', text: '按基线恢复', baseline: '原值', read_back: '读回原值' }] };

	// 反例1：对象只是名字相近，不是同一对象 → 豁免不成立。
	const near = codesOf({ ...base, prepare_items: prepare('SIG_Nam'), deferred_items: deferred('SIG_Name'), expected_items: [] });
	assert.ok(near.includes('BASELINE_NO_MESSAGE'), '名字相近不得顶替同一对象');

	// 反例2：同一对象只有部分依赖延期，可执行判据仍挂着 → 必须阻断该判据。
	const partial = codesOf({ ...base, prepare_items: prepare('SIG_Name'), deferred_items: deferred('SIG_Name'), expected_items: executable('SIG_Name') });
	assert.ok(partial.includes('EXECUTABLE_ON_UNBUILDABLE_BASELINE'), '同对象部分延期时可执行判据须被阻断');

	// 反例3：可执行判据引用未建立基线（延期项写的是别的对象）→ 必须阻断。
	const other = codesOf({ ...base, prepare_items: prepare('SIG_Name'), deferred_items: deferred('SIG_Other'), expected_items: executable('SIG_Name') });
	assert.ok(other.includes('BASELINE_NO_MESSAGE'), '延期项对象不同则豁免不成立');

	// 反例4：删掉最后一个可执行断言 → 不报「缺少预期结果」，而是列出全部延期义务。
	const allDeferred = lint([{ ...base, expected: '', expected_items: [], prepare_items: prepare('SIG_Name'), deferred_items: deferred('SIG_Name') }], ids, fids);
	const listed = allDeferred.find((entry) => entry.code === 'ALL_ASSERTIONS_DEFERRED');
	assert.ok(listed, '全延期须报 ALL_ASSERTIONS_DEFERRED');
	assert.ok(!allDeferred.some((entry) => entry.code === 'EXPECTED_EMPTY'), '全延期不应只说缺少预期结果');
	assert.match(listed.message, /SIG_Name/);
	assert.match(listed.message, /拼写待通信确认/);
});

check('准备项与延期项的信号同样进 DBC 校验', () => {
	const dbc = parseDbc(path.join(root, 'projects', project, declaredSource('dbc')));
	const message = [...dbc.messages.values()].find((entry) => entry.signals.length);
	const signal = message.signals[0].name;
	const taken = new Set([...dbc.messages.values()].map((entry) => entry.id.toLowerCase()));
	let n = parseInt(message.id, 16) + 1;
	while (taken.has('0x' + n.toString(16))) n += 1;
	const bogus = '0x' + n.toString(16).toUpperCase();
	const item = { case_id: 'C-D', steps: [], expected: '',
		prepare_items: [{ id: 'p1', object: signal, read_back: `在原始采集记录中读取 ${signal} 报文（ID ${bogus}）` }],
		deferred_items: [{ id: 'd1', object: signal, unresolved: `待确认 ${signal} 报文（ID ${bogus}）` }] };
	const rows = auditCases([item], dbc);
	assert.ok(rows.some((row) => row.field === 'prepare'), '准备项未被扫描');
	assert.ok(rows.some((row) => row.field === 'deferred'), '延期项未被扫描');
	assert.ok(rows.filter((row) => ['unknown_message', 'unknown_signal'].includes(row.status)).length >= 2, '延期与准备项里的错报文号必须报出来');
});

check('最长优先，短前缀不截断长前缀', () => {
	assert.equal('dock栏【开关】'.replace(new RegExp('^(?:' + termsPattern(['Dock', 'dock栏']).source + ')', 'i'), ''), '【开关】');
});

check('空词表不匹配任何文本', () => {
	assert.equal(termsPattern([]).test('任意文本'), false);
	assert.equal(termsPattern(['a.b']).test('axb'), false, '词表必须按字面量转义');
});

// 依赖方向：通用引擎不得 import 项目适配器；适配器只能被脚本或宿主引用。
check('通用代码不依赖项目适配器', () => {
	const engineDir = fileURLToPath(new URL('..', import.meta.url));
	const engine = fs.readdirSync(engineDir).filter((name) => name.endsWith('.js'));
	const offenders = engine.filter((name) => /from '\.\/adapters\//.test(fs.readFileSync(path.join(engineDir, name), 'utf8')));
	assert.deepEqual(offenders, [], `通用模块引用了适配器：${offenders.join(',')}`);
});

check('运行清单记录实际加载的 Skill 摘要', () => {
	enterSkillScope(root);
	const digests = skillDigests();
	assert.equal(Object.keys(digests).length, 4);
	for (const [name, entry] of Object.entries(digests)) {
		assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${name} 摘要不是 SHA-256`);
		assert.ok(['builtin', 'override'].includes(entry.source), `${name} 未标明来源`);
	}
});

// 内置提示与 Skill 不得含任何单一项目的业务名；项目名只能由冻结原文与配置注入。
check('内置 Skill 与生成提示无业务名', () => {
	const banned = ['空调', '除霜', '除雾', '吹面', '吹脚', '中控屏', 'HVAC', 'IVI', 'Dock', 'dock', '0x2F0', '0x3A6'];
	const engineDir = fileURLToPath(new URL('..', import.meta.url));
	const targets = ['cts-facts', 'cts-test-design', 'cts-case-authoring', 'cts-review']
		.map((name) => [name + '.md', fs.readFileSync(path.join(engineDir, 'skills', name + '.md'), 'utf8')]);
	const source = fs.readFileSync(path.join(engineDir, 'artifacts.js'), 'utf8');
	targets.push(['casePrompt', source.match(/export function casePrompt[\s\S]+?\n}/)?.[0] || '']);
	targets.push(['reviewPrompt', source.match(/export function reviewPrompt[\s\S]+?\n}/)?.[0] || '']);
	for (const [name, text] of targets) {
		assert.ok(text.length > 0, `${name} 没取到内容`);
		const hits = banned.filter((word) => text.includes(word));
		assert.deepEqual(hits, [], `${name} 含业务名：${hits.join(',')}`);
	}
});

// 未声明任何能力的项目：通用词仍可定位，协议/台架专属词与信号一律不认。
enterProjectConfig({});
check('未声明能力时跳过协议与台架', () => {
	assert.equal(hasCapability('protocol'), false);
	assert.equal(declaredSource('dbc'), '');
	assert.equal(signalPrefixes().length, 0);
	assert.equal(defaultSurface(), '目标页面');
	const generic = termsPattern(GENERIC_PLACE);
	assert.ok(generic.test('在审批页面观察提交按钮'), '通用界面词必须仍然可用');
	assert.equal(generic.test('在 CANoe 中读取报文'), false, '未声明协议能力时不得认协议工具');
	assert.equal(generic.test('在台架观察'), false, '未声明台架能力时不得认台架');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + r.error}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过 · 语料 ${corpus.length} 段 · 用例 ${cases.items.length} 条 (v${cases.version})`);
for (const note of gains) console.log('NOTE  ' + note);
process.exit(failed.length ? 1 : 0);