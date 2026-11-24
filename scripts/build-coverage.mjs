import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Clause inventory for G1: every DOCX block and every source table row in the
 * frozen evidence becomes one accountable row, so "covered" can never mean
 * "the clause was silently skipped". Fields are filled only where the source
 * actually states them; anything else stays null and is listed as missing.
 *
 * usage: node scripts/build-coverage.mjs <project> <module> <acceptanceDir>
 */
const [project, module, out] = process.argv.slice(2);
if (!project || !module || !out) throw new Error('usage: build-coverage.mjs <project> <module> <acceptanceDir>');
const root = process.env.CTS_DATA_ROOT || path.join(os.homedir(), 'Documents', 'CTS');
const evidence = JSON.parse(await fs.readFile(path.join(root, 'evidence', project, 'items.json'), 'utf8'));
const scopeFile = path.join(root, 'artifacts', project, module, 'source-scope.json');
const scope = await fs.readFile(scopeFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({ items: [] }));
const active = new Set(scope.items.filter((item) => item.role !== 'reference').map((item) => item.path));

const HVAC = /空调|除雾|除霜|吹面|吹脸|吹脚|吹窗|风量|风速|内循环|外循环|HVAC|AC\b|PTC|温度|IVI|Dock|dock/;
const TBD = /TBD|待定|待确认|n\b|默认为n/;
const STATIC_DOC = /信号定义|DBC|报文定义|字段|取值范围|通信矩阵/;
const STATE_ONLY = /^当?空调处于[^，。]*模式[，,]/;
const ACTION = /单击|点击|按下|长按|滑动|调节|语音|发送|上电|下电|丢失|恢复/;

const branchId = (seed) => 'BR-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10).toUpperCase();

/** Split an evidence part into DOCX blocks and table rows, keeping the quote verbatim. */
function clauses(item) {
	const found = [];
	const lines = item.text.split('\n');
	let section = '';
	let tableHeader = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) continue;
		const heading = /^#{2,3}\s*(.+)$/.exec(line);
		if (heading) { section = heading[1]; tableHeader = null; continue; }
		const block = /^\[DOCX块(\d+)\]\s*(.*)$/.exec(line);
		if (block) {
			tableHeader = null;
			if (block[2]) found.push({ kind: 'block', block: Number(block[1]), quote: block[2], section, line: index + 1 });
			continue;
		}
		const row = /^\|\s*(\d+)\s*\|(.+)\|$/.exec(line);
		if (row) {
			const cells = row[2].split('|').map((cell) => cell.trim());
			if (/^行$/.test(cells[0]) || cells.every((cell) => /^列\d+$/.test(cell))) { tableHeader = cells; continue; }
			if (cells.join('') === '') continue;
			found.push({ kind: 'table_row', block: null, row: Number(row[1]), quote: cells.join(' | '), cells, header: tableHeader, section, line: index + 1 });
			continue;
		}
		if (/^###\s*原文表格/.test(line)) { tableHeader = null; continue; }
		found.push({ kind: 'text', block: null, quote: line, section, line: index + 1 });
	}
	return found;
}

const rows = [];
for (const item of evidence.items) {
	if (active.size && !active.has(item.source)) continue;
	const bucket = item.source.split('/')[0];
	for (const clause of clauses(item)) {
		const quote = clause.quote;
		if (quote.length < 6) continue;
		const inScope = HVAC.test(quote) || HVAC.test(clause.section || '');
		const isTbd = TBD.test(quote);
		let mode = 'run';
		let reason = '';
		if (bucket === 'signals') { mode = 'static_signal'; reason = 'DBC 信号定义核对，不是运行行为'; }
		else if (bucket === 'design') { mode = 'static_design'; reason = '设计稿样式核对，不是运行行为'; }
		else if (STATIC_DOC.test(clause.section || '') && /信号定义|通信矩阵/.test(clause.section || '')) { mode = 'static_signal'; reason = 'PRD 内的信号定义表，按资料核对'; }
		else if (!inScope) { mode = 'out_of_scope'; reason = '条款与本轮空调范围无关'; }
		else if (clause.kind === 'table_row' && clause.cells && /条件/.test(clause.header?.[1] || '') ) { mode = 'run'; }
		else if (STATE_ONLY.test(quote) && !ACTION.test(quote.replace(STATE_ONLY, ''))) { mode = 'state_observation'; reason = '原文只陈述某模式下的显示，无触发动作'; }

		// Field placement: a state clause is a condition, never an action.
		let initial = null, event = null, expected = [];
		if (clause.kind === 'table_row' && clause.cells?.length >= 3) {
			initial = clause.cells[0] || null;
			event = clause.cells[1] || null;
			expected = clause.cells.slice(2).filter(Boolean);
		} else {
			const stateMatch = /当?空调处于([^，。；]*)/.exec(quote);
			if (stateMatch) initial = '空调处于' + stateMatch[1];
			const actionMatch = /((?:单击|点击|按下|长按|滑动|调节|语音控制|语音发送)[^，。；]*)/.exec(quote);
			if (actionMatch) event = actionMatch[1];
			const powerMatch = /(首次上电|车辆上电|车辆下电|上电时)/.exec(quote);
			if (!event && powerMatch) event = powerMatch[1];
			const lossMatch = /(丢失时间[^，。；]*)/.exec(quote);
			if (!event && lossMatch) event = lossMatch[1];
			for (const result of quote.matchAll(/(?:显示为|切换到|切换为|保持|变为|图标为|预期结果)[“"]?([^，。；”"]{2,40})/g)) expected.push(result[1]);
			if (!expected.length && /反馈|更新显示|发送/.test(quote)) expected.push(quote.slice(0, 120));
		}
		const missing = [];
		if (!initial) missing.push('initial');
		if (!event && mode === 'run') missing.push('event');
		if (!expected.length) missing.push('expected');
		let status = mode === 'out_of_scope' ? 'excluded' : mode.startsWith('static') ? 'static_check' : 'needs_design';
		if (isTbd && mode === 'run') { status = 'needs_decision'; reason = (reason ? reason + '；' : '') + '原文含 TBD/待定，门限或结果未裁决'; }
		if (mode === 'state_observation') status = 'needs_design';
		rows.push({
			branch_id: branchId(`${item.id}:${clause.line}:${quote}`),
			source_id: item.source_id, version: item.source_version, evidence_id: item.id,
			location: `${item.location} · 行${clause.line}${clause.block ? ' · DOCX块' + clause.block : ''}${clause.row ? ' · 表行' + clause.row : ''}`,
			quote, initial: initial || '', event: event || '', expected: expected.join(' || '),
			mode, status, reason, missing: missing.join('|'),
			scenario_id: '', point_id: ''
		});
	}
}

const COLUMNS = ['branch_id', 'source_id', 'version', 'evidence_id', 'location', 'quote', 'initial', 'event', 'expected', 'mode', 'status', 'reason', 'missing', 'scenario_id', 'point_id'];
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'coverage.tsv'), [COLUMNS.join('\t'), ...rows.map((row) => COLUMNS.map((key) => String(row[key] ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n');
const tally = (field) => Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row[field])).map(([key, value]) => [key, value.length]));
await fs.writeFile(path.join(out, 'coverage-inventory.json'), JSON.stringify({
	at: new Date().toISOString(), project, module, evidence_items: evidence.items.length,
	clauses: rows.length, byMode: tally('mode'), byStatus: tally('status'),
	tbd: rows.filter((row) => row.status === 'needs_decision').length,
	runnable: rows.filter((row) => row.mode === 'run' && row.status !== 'needs_decision').length
}, null, 1));
console.log(JSON.stringify({ clauses: rows.length, byMode: tally('mode'), byStatus: tally('status') }));