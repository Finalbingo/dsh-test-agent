import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Runner for the normal plugin entry. It never writes cases itself: the old
 * execute.mjs "copy the test point into one step" fallback is superseded, and
 * the plugin's lint/approval/freeze gate rejects such rows even if an external
 * script writes them. Gaps stay gaps until a retry or a reviewed deferral.
 *
 * usage: node scripts/run-cases.mjs <base> <project> <module> <acceptanceDir> [--replace] [--limit N]
 */
const [base, project, module, out] = process.argv.slice(2);
if (!base || !project || !module || !out) throw new Error('usage: run-cases.mjs <base> <project> <module> <acceptanceDir> [--replace]');
const replace = process.argv.includes('--replace');
const root = process.env.CTS_DATA_ROOT || path.join(os.homedir(), 'Documents', 'CTS');
const tokenFile = process.env.CTS_TOKEN_FILE;
const cookie = process.env.CTS_COOKIE || '';
const headers = { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) };
const post = (route, fields) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ project, module, ...fields }) });
const api = async (action, fields = {}) => {
	const result = await (await post('/cts/api', { action, ...fields })).json();
	if (!result.ok) throw new Error(action + ': ' + result.error);
	return result.state;
};

await fs.mkdir(out, { recursive: true });
const response = await post('/cts/api/generate', { kind: 'cases', draft: false, replace });
if (!response.ok) throw new Error('generate HTTP ' + response.status);
const events = [];
let buffer = '';
for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
	buffer += chunk;
	let at;
	while ((at = buffer.indexOf('\n\n')) >= 0) {
		const block = buffer.slice(0, at);
		buffer = buffer.slice(at + 2);
		const [event, data] = block.split('\n');
		if (!data?.startsWith('data: ')) continue;
		const parsed = JSON.parse(data.slice(6));
		events.push({ event: event.replace('event: ', ''), ...parsed });
		if (['run.start', 'run.manifest', 'phase', 'batch.failed', 'batch.aborted', 'run.end', 'error'].includes(event.replace('event: ', ''))) {
			console.log(new Date().toISOString(), event.replace('event: ', ''), JSON.stringify(parsed).slice(0, 400));
		}
	}
}
await fs.writeFile(path.join(out, 'generate-events.jsonl'), events.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
const end = events.find((entry) => entry.event === 'run.end');
const error = events.find((entry) => entry.event === 'error');
if (error) throw new Error('generate: ' + error.message);
if (!end) throw new Error('generate ended without run.end');

const runs = await api('cases.runs', { run_id: end.run_id });
await fs.writeFile(path.join(out, 'run-manifest.json'), JSON.stringify(runs.run, null, 1));
const source = path.join(root, 'artifacts', project, module, 'case-runs', 'batches.jsonl');
await fs.copyFile(source, path.join(out, 'batches.jsonl')).catch(() => {});
const state = await api('artifacts.load');
await fs.writeFile(path.join(out, 'delivery-state.json'), JSON.stringify(state.delivery, null, 1));
console.log(JSON.stringify({
	run_id: end.run_id, baseline_digest: end.baseline_digest,
	completed: end.completed_ids.length, failed: end.failed_ids.length, pending: end.pending_ids.length,
	cases: state.cases.items.length,
	approved: state.cases.items.filter((item) => item.review_status === 'approved').length,
	staleApprovals: state.delivery.approvals.stale.length,
	unexpanded: state.delivery.approvals.unexpanded.length,
	out
}));