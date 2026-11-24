import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { match, namedObjectsIn, pageHintsIn, uiApplicability } from '../ui.js';

/**
 * Does the authored trigger→observe anchor give the figure matcher a name/page
 * cue the assertion text alone lacks? Measures before changing production code.
 *
 * usage: node scripts/probe-expected-figures.mjs [acceptanceDir]
 */
const root = process.env.CTS_DATA_ROOT || path.join(os.homedir(), 'Documents', 'CTS');
const project = process.env.CTS_PROJECT;
const module = process.env.CTS_MODULE;
if (!project || !module) throw new Error('必须提供 CTS_PROJECT / CTS_MODULE');
const dir = path.join(root, 'artifacts', project, module);
const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
const [cases, index] = await Promise.all([read('cases.json'), read('ui-index.json')]);
const norm = (value) => String(value || '').replace(/[\s【】「」“”"']/g, '').toLowerCase();

const tally = { before: {}, after: {} };
const rows = [];
for (const item of cases.items) {
	const steps = item.step_items || [];
	const stepText = steps.map((step) => step.text || '').join(' ');
	for (const entry of item.expected_items || []) {
		if (uiApplicability(entry.text, `${item.title || ''} ${stepText}`).level !== 'required') continue;
		const base = {
			text: entry.text, name: '', roleHint: '',
			pageHints: pageHintsIn(index, [item.title, item.precondition, stepText]),
			contextText: `${item.precondition || ''} ${stepText}`, useContextTokens: false
		};
		const before = match(index, base, { purpose: 'expected' });
		const trigger = steps.find((step) => step.id === entry.trigger_step_id);
		const observe = steps.find((step) => step.id === entry.step_id);
		const anchorText = [trigger?.text, observe?.text].filter(Boolean).join(' ');
		const names = namedObjectsIn(anchorText);
		const hint = names.find((name) => norm(entry.object).includes(norm(name)) || norm(name).includes(norm(entry.object))) || '';
		const after = match(index, {
			...base, name: hint,
			pageHints: pageHintsIn(index, [item.title, item.precondition, anchorText, stepText]),
			contextText: `${base.contextText} ${anchorText}`
		}, { purpose: 'expected' });
		tally.before[before.status] = (tally.before[before.status] || 0) + 1;
		tally.after[after.status] = (tally.after[after.status] || 0) + 1;
		rows.push({
			case_id: item.case_id, expected_id: entry.id, object: entry.object, hint,
			before: before.status, before_reason: before.reason || '',
			after: after.status, after_reason: after.reason || '',
			after_target: after.target?.name || '', after_state: after.target?.state || '',
			after_page: after.target?.page_name || ''
		});
	}
}
const out = process.argv[2];
if (out) {
	await fs.mkdir(out, { recursive: true });
	await fs.writeFile(path.join(out, 'expected-figure-probe.json'), JSON.stringify({ tally, rows }, null, 1));
	const cols = ['case_id', 'expected_id', 'object', 'hint', 'before', 'before_reason', 'after', 'after_reason', 'after_target', 'after_state', 'after_page'];
	await fs.writeFile(path.join(out, 'expected-figure-probe.tsv'),
		[cols.join('\t'), ...rows.map((row) => cols.map((key) => String(row[key] ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n');
}
console.log(JSON.stringify({ assertions: rows.length, ...tally }));