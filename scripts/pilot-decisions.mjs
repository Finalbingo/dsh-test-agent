import fs from 'node:fs/promises';
import path from 'node:path';
import { structureCase } from '../artifacts.js';
import { parseDbc, auditCases } from '../signal-audit.js';

/**
 * P2 adjudication queue: every gap that blocks or limits a judgement, with the
 * verbatim source, the affected case/assertion, impact and the recheck condition.
 * Nothing here decides the answer — it registers what a human must decide.
 *
 * usage: node scripts/pilot-decisions.mjs <project> <module> <acceptanceDir>
 */
const [project, module, out] = process.argv.slice(2);
const root = process.env.CTS_DATA_ROOT || path.join(process.env.HOME, 'Documents', 'CTS');
const dir = path.join(root, 'artifacts', project, module);
const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
const [cases, points, branches] = await Promise.all([read('cases.json'), read('points.json'), read('branches.json')]);
for (const item of cases.items) structureCase(item);
const pointById = new Map(points.items.map((point) => [point.point_id, point]));
const rows = [];
const add = (row) => rows.push({
	decision_id: 'D-' + String(rows.length + 1).padStart(4, '0'),
	owner: '产品/需求（V5 空调）', status: '待裁决', ...row
});

// 1) 阻断缺口：本轮判不了的判据。
for (const item of cases.items) {
	for (const entry of item.deferred_items || []) {
		const point = pointById.get(item.point_id);
		add({
			kind: '阻断缺口', case_id: item.case_id, ref_id: entry.id, object: entry.object,
			target: entry.target, timing: entry.delay_s ? `自${entry.since}起${entry.delay_s}s` : '',
			reason: entry.unresolved, impact: '该判据本轮不可判定，用例其余判据仍可执行',
			source: entry.evidence_ref, location: point?.source?.location || '',
			recheck: '原文点名显示对象或给出判定门限后，重跑该测试点并重新评审'
		});
	}
}
// 2) 范围缺口：能判但判据范围被原文限制。
for (const item of cases.items) {
	for (const entry of item.expected_items || []) {
		if (!entry.unresolved) continue;
		const point = pointById.get(item.point_id);
		add({
			kind: '范围缺口', case_id: item.case_id, ref_id: entry.id, object: entry.object,
			target: entry.target, timing: entry.delay_s ? `自${entry.since}起${entry.delay_s}s` : '',
			reason: entry.unresolved, impact: '判据可执行，但判定范围窄于功能意图',
			source: entry.evidence_ref, location: point?.source?.location || '',
			recheck: '原文补齐帧数/取值映射后回填并重跑'
		});
	}
}
// 3) DBC 与原文写法不一致：不自动替换，等确认。
const dbcName = (await fs.readdir(path.join(root, 'projects', project, 'signals')).catch(() => [])).find((name) => name.toLowerCase().endsWith('.dbc'));
if (dbcName) {
	const dbc = parseDbc(path.join(root, 'projects', project, 'signals', dbcName));
	const seen = new Set();
	for (const row of auditCases(cases.items, dbc)) {
		if (!['name_format_differs', 'value_undefined'].includes(row.status)) continue;
		const key = `${row.status}|${row.written}`;
		if (seen.has(key)) continue;
		seen.add(key);
		add({
			kind: row.status === 'name_format_differs' ? '信号写法待确认' : '取值表缺失',
			case_id: row.case_id, ref_id: row.ref_id || '', object: row.written,
			target: row.signal || '', timing: '', reason: row.detail,
			impact: row.status === 'name_format_differs' ? '须确认原文写法与 DBC 字段是同一字段，未确认前不得替换' : '写死取值缺少 DBC 取值表支撑，须由原文或产品确认',
			source: row.evidence, location: `${dbc.file} · ${row.message_name || ''}`,
			recheck: '确认后在原文或 DBC 侧统一写法/补取值表，再重跑信号核对'
		});
	}
}
// 4) 分支级未决：TBD、自相矛盾、缺可判定预期。
for (const branch of branches.items || []) {
	if (!['needs_decision', 'needs_design'].includes(branch.status)) continue;
	add({
		kind: branch.status === 'needs_decision' ? '原文未决/矛盾' : '缺可判定预期',
		case_id: '', ref_id: branch.branch_id, object: branch.initial || branch.event || '',
		target: '', timing: '', reason: branch.open_question || (branch.tbd ? '原文含 TBD/待定' : '原文未给出可逐项判定的预期表述'),
		impact: '该分支本轮不生成运行用例，保留在覆盖分母内',
		source: branch.quote, location: `${branch.section} · 行${branch.line}`,
		recheck: '裁决后重拆分支并重跑该分支'
	});
}
// 5) 图证缺口：设计库没有对应状态素材。
const uiMissing = cases.items.flatMap((item) => (item.expected_items || [])
	.filter((entry) => /^ui_|^state_/.test(entry.kind) && !(item.image_refs || []).some((figure) => figure.expected_id === entry.id))
	.map((entry) => ({ item, entry })));
if (uiMissing.length) {
	add({
		kind: '状态图缺失', case_id: [...new Set(uiMissing.map(({ item }) => item.case_id))].join(','),
		ref_id: '', object: `${uiMissing.length} 项界面判据`, target: '各自的目标状态图', timing: '',
		reason: 'V5 设计库 367 个画板均无状态标注，24915 个对象中仅 218 个带状态且与空调控件无关；预期关联 0 条可用（23 missing + 58 ambiguous）',
		impact: '界面判据缺目标状态图，图证适用率不达标；不得用静态整板冒充状态图',
		source: 'ui-index.json / ui-links.json', location: `artifacts/${project}/${module}`,
		recheck: '设计补充各控件选中/默认/置灰状态变体（或带状态标注的画板）后重建索引并重跑挂图'
	});
}

await fs.mkdir(out, { recursive: true });
const cols = ['decision_id', 'kind', 'status', 'case_id', 'ref_id', 'object', 'target', 'timing', 'reason', 'impact', 'source', 'location', 'owner', 'recheck'];
await fs.writeFile(path.join(out, 'pilot-decisions.tsv'),
	[cols.join('\t'), ...rows.map((row) => cols.map((key) => String(row[key] ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n');
await fs.writeFile(path.join(out, 'pilot-decisions.json'), JSON.stringify({ at: new Date().toISOString(), total: rows.length, rows }, null, 1));
const tally = {};
for (const row of rows) tally[row.kind] = (tally[row.kind] || 0) + 1;
// 同一个未知量只裁决一次：点名了对象与目标的具体缺口按问题归并；
// 分支级「原文没有可判定预期」是逐分支设计工作，按来源位置各自留行，不按相同措辞误合。
const issues = new Map();
for (const row of rows) {
	const named = Boolean(row.object && row.target);
	const key = [row.kind, row.object, row.target, row.reason, named ? '' : row.location].join('|');
	const hit = issues.get(key);
	if (hit) { hit.decision_ids.push(row.decision_id); hit.affected_cases.push(row.case_id); hit.affected_refs.push(row.ref_id); continue; }
	issues.set(key, { issue_id: 'I-' + String(issues.size + 1).padStart(4, '0'), kind: row.kind, object: row.object, target: row.target,
		reason: row.reason, source: row.source, location: row.location, recheck: row.recheck, owner: row.owner, status: row.status,
		decision_ids: [row.decision_id], affected_cases: [row.case_id], affected_refs: [row.ref_id] });
}
const grouped = [...issues.values()].map((issue) => ({ ...issue,
	affected_cases: [...new Set(issue.affected_cases.filter(Boolean))],
	affected_refs: [...new Set(issue.affected_refs.filter(Boolean))], occurrence_count: issue.decision_ids.length }));
await fs.writeFile(path.join(out, 'adjudication-issues.json'), JSON.stringify({ at: new Date().toISOString(), raw_records: rows.length, unique_issues: grouped.length, issues: grouped }, null, 1));
console.log(JSON.stringify({ total: rows.length, uniqueIssues: grouped.length, byKind: tally }));