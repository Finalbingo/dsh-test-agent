import fs from 'node:fs/promises';
import path from 'node:path';
import { structureCase } from '../artifacts.js';
import { validateAnchors } from '../case-structure.js';

/**
 * P2 independent walk-through: every case, every field, every assertion.
 * Mechanical findings are recorded per item; content judgement is written by the
 * reviewer into the same table. Nothing here approves a case.
 *
 * usage: node scripts/pilot-review.mjs <project> <module> <acceptanceDir>
 */
const [project, module, out] = process.argv.slice(2);
const root = process.env.CTS_DATA_ROOT || path.join(process.env.HOME, 'Documents', 'CTS');
const dir = path.join(root, 'artifacts', project, module);
const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
const [cases, points] = await Promise.all([read('cases.json'), read('points.json')]);
for (const item of cases.items) structureCase(item);
const pointById = new Map(points.items.map((point) => [point.point_id, point]));

const PAGE = /(空调界面|中控屏|Dock|dock|桌面|弹窗|弹层|页面|采集|CAN|CANoe|诊断|DBC|设计稿|原文|PRD|文档|表格|调节条|配图|图|台架)/;
const OBJECT = /(【[^】]+】|「[^」]+」|图标|按键|开关|调节条|弹窗|报文|信号|采集|显示|界面|表格|行|列|文档|原文|温度|风量|循环|风门|状态|语音|空调|AC|PTC|0x[0-9A-Fa-f]{3})/;
const ACTION = /(单击|点击|按下|长按|双击|滑动|拖动|调节|启动|停止|进入|退出|发送|语音|上电|下电|断开|恢复|打开|关闭|记录|保存|中断|构造|使|等待|采集)/;
const READ = /(观察|读取|检查|确认|核对|识别|记录|查看|比对|对比)/;
const VAGUE = /(正常$|无异常|符合设计|正确显示|显示正确|工作正常|无问题)/;
// 报文 ID 与信号名里的数字不是业务数值，先剔除再比对。
const numbers = (text) => [...String(text || '').replace(/0x[0-9A-Fa-f]+/g, ' ').replace(/[A-Za-z][A-Za-z0-9_]*\d[A-Za-z0-9_]*/g, ' ').matchAll(/\d+(?:\.\d+)?/g)].map((hit) => hit[0]);

const rows = [];
for (const item of cases.items) {
	const point = pointById.get(item.point_id);
	const source = `${point?.source?.quote || ''} ${point?.condition || ''} ${(point?.expected_items || []).map((entry) => entry.quote).join(' ')}`;
	const findings = [];
	const add = (field, code, detail) => findings.push({ field, code, detail });

	if (!item.precondition) add('precondition', 'MISSING_FIELD', '前置条件为空');
	if (!item.failure_policy) add('failure_policy', 'MISSING_FIELD', '失败处理为空');
	if (!item.basis) add('basis', 'MISSING_FIELD', '依据为空');
	if (!item.source_reference && !point?.source?.location) add('source_reference', 'MISSING_FIELD', '无来源定位');

	for (const entry of item.prepare_items || []) {
		for (const key of ['object', 'target', 'establish', 'read_back', 'on_failure']) {
			if (!entry[key]) add(`prepare_items[${entry.id}].${key}`, 'MISSING_FIELD', '准备项字段为空');
		}
	}
	for (const entry of item.restore_items || []) {
		for (const key of ['baseline', 'read_back', 'on_failure']) {
			if (!entry[key]) add(`restore_items[${entry.id}].${key}`, 'MISSING_FIELD', '恢复项字段为空');
		}
	}
	if (!(item.restore_items || []).length && !(item.restore_steps || []).length) add('restore_items', 'MISSING_FIELD', '无恢复项');

	const steps = item.step_items || [];
	if (steps.length < 2 && !(item.expected_items || []).every((entry) => entry.kind === 'state_observation')) {
		add('step_items', 'NOT_EXECUTABLE', `只有 ${steps.length} 步且不是只读状态观察`);
	}
	for (const step of steps) {
		if (!step.text) { add(`step_items[${step.id}]`, 'MISSING_FIELD', '步骤为空'); continue; }
		if (!PAGE.test(step.text)) add(`step_items[${step.id}]`, 'NO_PLACE', `未写明在哪个页面/工具：${step.text.slice(0, 40)}`);
		if (!OBJECT.test(step.text)) add(`step_items[${step.id}]`, 'NO_OBJECT', `未写明对哪个对象：${step.text.slice(0, 40)}`);
		if (step.role === 'action' && !ACTION.test(step.text)) add(`step_items[${step.id}]`, 'NO_ACTION', `操作步骤没有动作：${step.text.slice(0, 40)}`);
		if (step.role === 'observe' && !READ.test(step.text)) add(`step_items[${step.id}]`, 'NO_READ', `观察步骤没写从哪里读：${step.text.slice(0, 40)}`);
		if (/那个按钮|该按钮|上述按钮|相应控件/.test(step.text)) add(`step_items[${step.id}]`, 'UNNAMED_CONTROL', '用了「那个按钮」这类指代');
		if (/对比[^。]{0,40}反馈[^。]{0,10}与/.test(step.text)) add(`step_items[${step.id}]`, 'MERGED_OBSERVATION', `读报文与看界面合并成一步：${step.text.slice(0, 40)}`);
		if (/目标温度|相应挡位|目标挡位|指定温度/.test(step.text)) add(`step_items[${step.id}]`, 'UNSPECIFIED_VALUE', `步骤含未定值：${step.text.slice(0, 40)}`);
	}

	for (const entry of item.expected_items || []) {
		const at = `expected_items[${entry.id}]`;
		for (const key of ['object', 'target', 'kind', 'evidence_ref']) {
			if (!entry[key]) add(`${at}.${key}`, 'MISSING_FIELD', '判据字段为空');
		}
		if (VAGUE.test(entry.target || '')) add(at, 'NOT_JUDGEABLE', `预期不可判定：${entry.target}`);
		// 数值必须能在本版原文里找到，否则是无依据数值。
		const allowed = new Set([...numbers(source), String(entry.frames || ''), String(entry.delay_s || '')]);
		const unsupported = numbers(entry.target).filter((value) => !allowed.has(value));
		if (unsupported.length) add(at, 'UNSUPPORTED_NUMBER', `原文无此数值：${unsupported.join('、')}（目标：${entry.target.slice(0, 40)}）`);
		const benchText = `${entry.target} ${steps.map((step) => step.text).join(' ')}`;
		const forbidden = /(?:不得|禁止|不能|不要|不应|严禁)[^。；]{0,20}(?:台架代发|由台架发送|模拟发送)/g;
		const sends = benchText.replace(forbidden, '');
		if (entry.kind === 'can_request' && /台架代发|由台架发送|模拟发送/.test(sends)) {
			add(at, 'BENCH_SENDS_REQUEST', '请求类判据不得由台架代发 IVI 请求');
		}
	}
	for (const error of validateAnchors(item)) {
		add(error.at, error.code, error.message + (error.severity === 'warning' ? '（警告）' : ''));
	}

	rows.push({
		case_id: item.case_id, point_id: item.point_id, title: item.title, type: item.type,
		steps: steps.length, assertions: (item.expected_items || []).length,
		prepares: (item.prepare_items || []).length, restores: (item.restore_items || []).length,
		gaps: (item.expected_items || []).filter((entry) => entry.unresolved).length,
		figures: (item.image_refs || []).length,
		findings: findings.filter((entry) => !entry.detail.endsWith('（警告）')),
		warnings: findings.filter((entry) => entry.detail.endsWith('（警告）')),
		source_location: point?.source?.location || ''
	});
}

const tally = {};
for (const row of rows) for (const finding of row.findings) tally[finding.code] = (tally[finding.code] || 0) + 1;
const clean = rows.filter((row) => row.findings.length === 0);
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'pilot-review.json'), JSON.stringify({
	at: new Date().toISOString(), reviewer: 'machine-walkthrough', cases: rows.length,
	clean: clean.length, tally, rows
}, null, 1));
const cols = ['case_id', 'point_id', 'title', 'steps', 'assertions', 'prepares', 'restores', 'gaps', 'figures', 'finding_count', 'findings'];
await fs.writeFile(path.join(out, 'pilot-review.tsv'),
	[cols.join('\t'), ...rows.map((row) => [row.case_id, row.point_id, row.title, row.steps, row.assertions, row.prepares, row.restores, row.gaps, row.figures, row.findings.length,
		row.findings.map((entry) => `${entry.field} ${entry.code} ${entry.detail}`).join(' ｜ ')].map((value) => String(value ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n');
console.log(JSON.stringify({ cases: rows.length, clean: clean.length, tally,
	dirty: rows.filter((row) => row.findings.length).map((row) => `${row.case_id}: ${row.findings.map((entry) => entry.code).join(',')}`) }, null, 1));