import fs from 'node:fs/promises';
import path from 'node:path';
import { structureCase, figurePlacement } from '../artifacts.js';
import { validateAnchors } from '../case-structure.js';
import { stepKey } from '../steps.js';

/**
 * Stable-id retest on real pilot cases: insert a step before the trigger and
 * reorder two observation steps, then require every assertion to still point at
 * the same step CONTENT, and every figure to follow its own anchor.
 *
 * usage: node scripts/pilot-anchor-retest.mjs <project> <module> <acceptanceDir>
 */
const [project, module, out] = process.argv.slice(2);
const root = process.env.CTS_DATA_ROOT || path.join(process.env.HOME, 'Documents', 'CTS');
const cases = JSON.parse(await fs.readFile(path.join(root, 'artifacts', project, module, 'cases.json'), 'utf8'));
const results = [];
for (const original of cases.items) {
	const item = JSON.parse(JSON.stringify(original));
	structureCase(item);
	const before = (item.expected_items || []).map((entry) => ({
		id: entry.id,
		trigger: stepKey((item.step_items.find((step) => step.id === entry.trigger_step_id) || {}).text),
		observe: stepKey((item.step_items.find((step) => step.id === entry.step_id) || {}).text)
	}));
	// 图证按稳定 ID 绑定，重排后必须仍落在同一条内容上。
	const figures = (item.expected_items || []).slice(0, 2).map((entry, index) => ({
		name: `probe-${index}`, role: '预期界面参考', expected_id: entry.id, file: `design/case-images/probe-${index}.png`
	}));
	item.image_refs = figures;
	const figureBefore = figures.map((figure) => {
		const at = figurePlacement(item, figure);
		const entry = item.expected_items.find((candidate) => candidate.id === figure.expected_id);
		return { name: figure.name, mapped: at.mapped, observe: stepKey((item.step_items.find((step) => step.id === entry?.step_id) || {}).text) };
	});

	const triggerAt = item.step_items.findIndex((step) => step.role === 'action' && /单击|点击|按下/.test(step.text));
	const insertAt = triggerAt >= 0 ? triggerAt : 0;
	item.step_items.splice(insertAt, 0, { key: 'probe', role: 'observe', text: '插入步骤：确认采集工具已连接并处于记录状态' });
	// 合法重排：交换触发之后的两个观察步骤，因果关系不变。
	const causeAt = Math.max(...item.expected_items.map((entry) => item.step_items.findIndex((step) => step.id === entry.trigger_step_id)), 0);
	const swappable = item.step_items.map((step, index) => ({ step, index }))
		.filter((entry) => entry.index > causeAt && entry.step.role === 'observe');
	if (swappable.length >= 2) {
		const a = swappable.at(-2).index;
		const b = swappable.at(-1).index;
		[item.step_items[a], item.step_items[b]] = [item.step_items[b], item.step_items[a]];
	}
	item.steps = item.step_items.map((step, index) => `S${String(index + 1).padStart(2, '0')}. ${step.text}`);
	structureCase(item);

	const after = (item.expected_items || []).map((entry) => ({
		id: entry.id,
		trigger: stepKey((item.step_items.find((step) => step.id === entry.trigger_step_id) || {}).text),
		observe: stepKey((item.step_items.find((step) => step.id === entry.step_id) || {}).text)
	}));
	const drifted = after.filter((entry, index) => entry.trigger !== before[index].trigger || entry.observe !== before[index].observe);
	const figureAfter = figures.map((figure) => {
		const at = figurePlacement(item, figure);
		const entry = item.expected_items.find((candidate) => candidate.id === figure.expected_id);
		return { name: figure.name, mapped: at.mapped, observe: stepKey((item.step_items.find((step) => step.id === entry?.step_id) || {}).text) };
	});
	const figureDrift = figureAfter.filter((entry, index) => !entry.mapped || entry.observe !== figureBefore[index].observe);
	const errors = validateAnchors(item).filter((entry) => entry.severity !== 'warning');
	// 反向测试：把触发与它自己的观察步骤对调，闸门必须拒绝，不能默默接受。
	const inverted = JSON.parse(JSON.stringify(original));
	structureCase(inverted);
	const pair = inverted.expected_items.find((entry) => entry.trigger_step_id && entry.trigger_step_id !== entry.step_id);
	let rejectsInversion = null;
	if (pair) {
		const a = inverted.step_items.findIndex((step) => step.id === pair.trigger_step_id);
		const b = inverted.step_items.findIndex((step) => step.id === pair.step_id);
		[inverted.step_items[a], inverted.step_items[b]] = [inverted.step_items[b], inverted.step_items[a]];
		structureCase(inverted);
		rejectsInversion = validateAnchors(inverted).some((entry) => entry.code === 'ANCHOR_BEFORE_CAUSE');
	}
	results.push({
		case_id: original.case_id, assertions: before.length, anchorDrift: drifted.length,
		figures: figures.length, figureDrift: figureDrift.length, hardErrors: errors.length,
		rejectsInversion,
		pass: drifted.length === 0 && figureDrift.length === 0 && errors.length === 0 && rejectsInversion !== false,
		detail: drifted.length ? JSON.stringify(drifted.slice(0, 2)) : figureDrift.length ? JSON.stringify(figureDrift) : errors.length ? JSON.stringify(errors.slice(0, 2)) : '锚点与图证随内容不变'
	});
}
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'pilot-anchor-retest.json'), JSON.stringify({
	at: new Date().toISOString(), cases: results.length, passed: results.filter((entry) => entry.pass).length, results
}, null, 1));
const cols = ['case_id', 'assertions', 'anchorDrift', 'figures', 'figureDrift', 'hardErrors', 'rejectsInversion', 'pass', 'detail'];
await fs.writeFile(path.join(out, 'pilot-anchor-retest.tsv'),
	[cols.join('\t'), ...results.map((row) => cols.map((key) => String(row[key] ?? '').replaceAll('\t', ' ')).join('\t'))].join('\n') + '\n');
console.log(JSON.stringify({ cases: results.length, passed: results.filter((entry) => entry.pass).length,
	assertions: results.reduce((sum, entry) => sum + entry.assertions, 0),
	anchorDrift: results.reduce((sum, entry) => sum + entry.anchorDrift, 0),
	figureDrift: results.reduce((sum, entry) => sum + entry.figureDrift, 0),
	inversionRejected: results.filter((entry) => entry.rejectsInversion === true).length,
	inversionTestable: results.filter((entry) => entry.rejectsInversion !== null).length,
	failed: results.filter((entry) => !entry.pass).map((entry) => entry.case_id + ' ' + entry.detail) }, null, 1));