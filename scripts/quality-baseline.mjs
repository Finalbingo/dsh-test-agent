import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const root = process.env.CTS_DATA_ROOT || path.join(os.homedir(), 'Documents', 'CTS');
const [project, module, out] = process.argv.slice(2);
if (!project || !module || !out) throw new Error('usage: quality-baseline.mjs <project> <module> <acceptanceDir>');
const dir = path.join(root, 'artifacts', project, module);
const read = async (name) => fs.readFile(path.join(dir, name + '.json'), 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({ items: [] }));
const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentOf = ({ review_status, reviewed_at, review_conclusion, review_comment, reviewer, ...content }) => content;

const [cases, points, contracts, facts, outline] = await Promise.all(['cases', 'points', 'contracts', 'facts', 'outline'].map(read));
const ecsm = JSON.parse(await fs.readFile(path.join(dir, 'ecsm-current.json'), 'utf8'));
const pointById = new Map(points.items.map((item) => [item.point_id, item]));
const fallbackFile = path.join(root, 'reports', 'v5-full-20261117-IdLsUm', 'case-from-approved-points.json');
const fallback = new Set((await fs.readFile(fallbackFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => [])).map((row) => row.case_id));

const rows = cases.items.map((item) => {
	const point = pointById.get(item.point_id);
	const copy = point && (item.steps || []).length === 1
		&& String(item.steps[0]).replace(/^S\d+[-\d]*\.\s*/, '').trim() === String(point.action).trim()
		&& String(item.expected).replace(/^S\d+[-\d]*\.\s*/, '').trim() === String(point.expected).trim();
	return {
		case_id: item.case_id,
		point_id: item.point_id,
		review_status: item.review_status,
		reviewed_at: item.reviewed_at || '',
		reviewer: item.reviewer || '',
		review_conclusion: item.review_conclusion || '',
		fact_refs: (item.fact_refs || []).join('|'),
		contract_refs: (item.contract_refs || []).join('|'),
		scenario_refs: (item.scenario_refs || []).join('|'),
		source_reference: item.source_reference || '',
		content_digest: sha(contentOf(item)),
		steps: (item.steps || []).length,
		expected_items: (item.expected_items || []).length,
		image_refs: (item.image_refs || []).length,
		restore_steps: (item.restore_steps || []).length,
		source_points_version: cases.source_points_version ?? '',
		source_points_digest: cases.source_points_digest || '',
		source_ecsm_digest: cases.source_ecsm_digest || '',
		fallback_copy: fallback.has(item.case_id) ? 'yes' : 'no',
		point_copy: copy ? 'yes' : 'no'
	};
});

await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'before.json'), JSON.stringify({
	captured_at: new Date().toISOString(),
	project, module, data_root: root,
	ecsm, counts: { cases: cases.items.length, points: points.items.length, contracts: contracts.items.length, facts: facts.items.length },
	case_status: Object.fromEntries(Object.entries(Object.groupBy(cases.items, (i) => i.review_status || 'unknown')).map(([k, v]) => [k, v.length])),
	point_status: Object.fromEntries(Object.entries(Object.groupBy(points.items, (i) => i.review_status || 'unknown')).map(([k, v]) => [k, v.length])),
	fallback_count: fallback.size,
	point_copy_count: rows.filter((r) => r.point_copy === 'yes').length,
	cases_version: cases.version, cases_digest: cases.digest,
	points_version: points.version, points_digest: points.digest,
	outline_digest: outline.digest || '',
	items: rows
}, null, 1));

const columns = Object.keys(rows[0]);
await fs.writeFile(path.join(out, 'baseline.tsv'), [columns.join('\t'), ...rows.map((row) => columns.map((key) => String(row[key]).replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n');
await fs.writeFile(path.join(out, 'before-cases-readonly.json'), JSON.stringify(cases));
await fs.chmod(path.join(out, 'before-cases-readonly.json'), 0o444);
console.log(JSON.stringify({ out, cases: rows.length, fallback: fallback.size, pointCopy: rows.filter((r) => r.point_copy === 'yes').length, status: Object.fromEntries(Object.entries(Object.groupBy(rows, (r) => r.review_status)).map(([k, v]) => [k, v.length])) }));