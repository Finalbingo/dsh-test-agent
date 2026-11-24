import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseDbc, auditCases, dependencyTsv } from '../signal-audit.js';

/**
 * usage: node scripts/audit-signals.mjs <project> <module> <acceptanceDir> [label]
 * Checks every technical dependency in the current cases against the project's
 * own frozen DBC. Near-miss names are listed, never substituted.
 */
const [project, module, out, label = 'current'] = process.argv.slice(2);
if (!project || !module || !out) throw new Error('usage: audit-signals.mjs <project> <module> <acceptanceDir> [label]');
const root = process.env.CTS_DATA_ROOT || path.join(os.homedir(), 'Documents', 'CTS');
const projectDir = path.join(root, 'projects', project);
const dbcFiles = (await fs.readdir(path.join(projectDir, 'signals')).catch(() => [])).filter((name) => name.toLowerCase().endsWith('.dbc'));
if (!dbcFiles.length) throw new Error('项目没有 DBC 文件');
const dbc = parseDbc(path.join(projectDir, 'signals', dbcFiles[0]));
const cases = JSON.parse(await fs.readFile(path.join(root, 'artifacts', project, module, 'cases.json'), 'utf8'));
const rows = auditCases(cases.items, dbc);
const tally = {};
for (const row of rows) tally[row.status] = (tally[row.status] || 0) + 1;
const hard = rows.filter((row) => ['unknown_signal', 'unknown_message', 'ambiguous_message'].includes(row.status));
const byCase = {};
for (const row of hard) (byCase[row.case_id] ||= new Set()).add(row.written);
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, `signal-dependencies-${label}.tsv`), dependencyTsv(rows));
await fs.writeFile(path.join(out, `signal-defects-${label}.json`), JSON.stringify({
	dbc_file: dbc.file, dbc_sha256: dbc.sha256, messages: dbc.messages.size, signals: dbc.signalCount,
	rows: rows.length, tally, affectedCases: Object.keys(byCase).length,
	byCase: Object.fromEntries(Object.entries(byCase).map(([key, value]) => [key, [...value]]))
}, null, 1));
console.log(JSON.stringify({ dbc: dbc.file, sha256: dbc.sha256.slice(0, 12), rows: rows.length, tally, affectedCases: Object.keys(byCase).length }));