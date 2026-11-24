#!/usr/bin/env node
/**
 * Rubric-based quality score, because character similarity to the baseline moves
 * with the metric definition and says little about whether a case is executable.
 *
 * Usage: node scripts/quality-score.mjs [--project P-v5-test] [--module M-ac]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const dataRoot = arg('data', path.join(os.homedir(), 'Documents', 'CTS'));
const project = arg('project', 'P-v5-test');
const moduleId = arg('module', '');
const projectDir = path.join(dataRoot, 'artifacts', project);
const dir = path.join(projectDir, moduleId);
if (!['cases', 'points'].some((name) => fs.existsSync(path.join(dir, name + '.json')))) {
	throw new Error(`未找到测试产物：${dir}，分模块项目请传入 --module`);
}
const read = (name) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')).items || [];
	} catch {
		return [];
	}
};

const cases = read('cases');
const points = read('points');

const SIGNAL = /(IVI_|HVAC_|CDC_|CAN_)[A-Za-z0-9_]+/;
const QUALIFIED = /[A-Za-z0-9_]+\(0x[0-9A-Fa-f]+\)\.[A-Za-z0-9_]+/;
const OBSERVABLE = /0x[0-9A-Fa-f]|图标|显示|选中|置灰|点亮|弹层|切换|帧/;
const POWER = /上电|电源|KL15|KL30|ON 档|整车上电/;
const ACTION = /单击|双击|长按|点击|拖动|滑动|发送|注入|语音|切换|进入|唤醒|调节/;

const adapt = (item) => ({
	expected: item.expected || '',
	precondition: item.precondition || item.condition || '',
	steps: item.steps || [item.action || ''].filter(Boolean),
	basis: item.basis || (item.fact_refs || []).join(' ') || ''
});

const rawChecks = [
	{
		key: '信号写全',
		relevant: (item) => SIGNAL.test(`${item.expected} ${item.steps.join(' ')}`),
		pass: (item) => QUALIFIED.test(`${item.expected} ${item.steps.join(' ')}`)
	},
	{
		key: '预期可观察',
		pass: (item) => OBSERVABLE.test(item.expected)
	},
	{
		key: '前置可构造',
		pass: (item) => POWER.test(item.precondition) || SIGNAL.test(item.precondition) || /状态|已开启|已关闭/.test(item.precondition)
	},
	{
		key: '步骤可执行',
		pass: (item) => item.steps.length >= 1 && ACTION.test(item.steps.join(' '))
	},
	{
		key: '有依据',
		pass: (item) => /[FE]-\d{4}/.test(item.basis)
	}
];

const checks = rawChecks;

function scoreSet(input, label) {
	const items = input.map(adapt);
	const rows = checks.map((check) => {
		const relevant = items.filter((item) => (check.relevant ? check.relevant(item) : true));
		const pass = relevant.filter((item) => check.pass(item)).length;
		return { key: check.key, total: relevant.length, pass, pct: relevant.length === 0 ? null : Math.round((pass / relevant.length) * 100) };
	});
	const failed = items.filter((item) => checks.some((check) => (check.relevant ? check.relevant(item) : true) && !check.pass(item))).length;
	console.log(`\n## ${label}（${items.length} 条）`);
	console.log('| 检查 | 适用 | 通过 | 比例 |');
	console.log('| --- | --- | --- | --- |');
	for (const row of rows) console.log(`| ${row.key} | ${row.total} | ${row.pass} | ${row.pct === null ? '—' : `${row.pct}%`} |`);
	console.log(`\n至少一项不合格：${failed} 条（${Math.round((failed / Math.max(1, items.length)) * 100)}%）`);
	return { rows, failed };
}

const caseResult = scoreSet(cases, '用例');
const pointResult = scoreSet(points, '测试点');

const report = [
	`# 质量评分（规则口径）· ${project}`,
	'',
	`生成时间：${new Date().toISOString()}`,
	'',
	'## 用例',
	'| 检查 | 适用 | 通过 | 比例 |',
	'| --- | --- | --- | --- |',
	...caseResult.rows.map((row) => `| ${row.key} | ${row.total} | ${row.pass} | ${row.pct === null ? '—' : `${row.pct}%`} |`),
	'',
	`至少一项不合格：${caseResult.failed} / ${cases.length}`,
	'',
	'## 测试点',
	'| 检查 | 适用 | 通过 | 比例 |',
	'| --- | --- | --- | --- |',
	...pointResult.rows.map((row) => `| ${row.key} | ${row.total} | ${row.pass} | ${row.pct === null ? '—' : `${row.pct}%`} |`),
	'',
	`至少一项不合格：${pointResult.failed} / ${points.length}`
];

const file = path.join(dataRoot, 'reports', `quality-${project}-${new Date().toISOString().slice(0, 10)}.md`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, report.join('\n'), 'utf8');
console.log(`\n写入：${file}`);
