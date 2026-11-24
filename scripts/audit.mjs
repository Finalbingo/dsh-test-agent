#!/usr/bin/env node
/**
 * Recompute the numbers the plan board keeps getting wrong.
 * Usage: node scripts/audit.mjs [--data <dir>] [--project <id>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataRoot = arg('data', path.join(os.homedir(), 'Documents', 'CTS'));
const project = arg('project', 'P-v5-test');
const moduleId = arg('module', '');
	const flat = path.join(dataRoot, 'artifacts', project);
	const dir = fs.existsSync(path.join(flat, moduleId || '_')) && moduleId
		? path.join(flat, moduleId)
		: (fs.existsSync(path.join(flat, 'facts.json')) ? flat : path.join(flat, moduleId || (fs.readdirSync(flat).find((name) => !name.startsWith('.')) || 'default')));

const read = (name) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')).items || [];
	} catch {
		return [];
	}
};

const facts = read('facts');
const features = read('features');
const states = read('states');
const points = read('points');
const cases = read('cases');
const bindings = read('bindings');
const questions = read('questions');
const review = read('review');

const transitions = states.reduce((sum, machine) => sum + (machine.transitions || []).length, 0);
const stateCount = states.reduce((sum, machine) => sum + (machine.states || []).length, 0);
const pointsWithTransition = points.filter((point) => point.transition_ref).length;
const coveredTransitions = new Set(points.map((point) => point.transition_ref).filter(Boolean)).size;
const casePointIds = new Set(cases.map((item) => item.point_id));
const orphanPoints = points.filter((point) => !casePointIds.has(point.point_id)).length;
const factIds = new Set(facts.map((fact) => fact.fact_id));
const pointIds = new Set(points.map((point) => point.point_id));
const danglingPoints = points.filter((point) => (point.fact_refs || []).some((ref) => !factIds.has(ref))).length;
const danglingCases = cases.filter((item) => !pointIds.has(item.point_id)).length;
const bindStats = {
	total: bindings.length,
	bound: bindings.filter((item) => item.status === 'bound').length,
	pending: bindings.filter((item) => item.status === 'ambiguous' || item.status === 'unmatched').length
};
const openQuestions = questions.filter((item) => item.status === 'open').length;

const rows = [
	['事实', facts.length],
	['功能点', features.length],
	['状态机（功能点）', states.length],
	['状态', stateCount],
	['状态转移', transitions],
	['转移覆盖', transitions === 0 ? '—' : `${coveredTransitions}/${transitions} = ${Math.round((coveredTransitions / transitions) * 100)}%`],
	['测试点', points.length],
	['其中挂转移', pointsWithTransition],
	['无对应用例的测试点', orphanPoints],
	['用例', cases.length],
	['用例带信号', cases.filter((item) => (item.signals || []).length > 0).length],
	['用例带控件节点', cases.filter((item) => (item.controls || []).length > 0).length],
	['用例带功能点ID', cases.filter((item) => item.feature_id).length],
	['悬空引用（点→事实）', danglingPoints],
	['悬空引用（用例→点）', danglingCases],
	['绑定', `${bindStats.bound}/${bindStats.total} 已绑，${bindStats.pending} 待定`],
	['待回答问题', openQuestions],
	['审查发现', review.length]
];

const lines = [
	`# 指标核对 · ${project}`,
	'',
	`生成时间：${new Date().toISOString()}`,
	'',
	'| 指标 | 值 |',
	'| --- | --- |',
	...rows.map(([name, value]) => `| ${name} | ${value} |`),
	'',
	'## 判断',
	'',
	orphanPoints > 0 ? `- ⚠️ ${orphanPoints} 条测试点没有对应用例，覆盖率与比例会失真` : '- ✅ 测试点与用例一一对应',
	danglingPoints + danglingCases > 0 ? `- ⚠️ 悬空引用 ${danglingPoints + danglingCases} 处` : '- ✅ 无悬空引用',
	cases.filter((item) => (item.controls || []).length > 0).length === 0 ? '- ⚠️ 用例没有任何控件节点注入（绑定不足或未装饰）' : '- ✅ 用例已注入控件节点'
];

const reportDir = path.join(dataRoot, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const file = path.join(reportDir, `audit-${project}-${new Date().toISOString().slice(0, 10)}.md`);
fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
console.log(`\n写入：${file}`);
