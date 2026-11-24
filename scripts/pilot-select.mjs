import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { api, saveJson, project, module } from './dsh-client.mjs';

/**
 * P2 pilot selection: the 8 fixed regression targets first (mapped from the old
 * case ids to the new branch points), then stratified sampling to 20. A target
 * whose branch is blocked stays blocked — we verify the interception and take a
 * substitute, never quietly generate it.
 *
 * usage: node scripts/pilot-select.mjs <acceptanceDir>
 */
const out = process.argv[2];
if (!out) throw new Error('usage: pilot-select.mjs <acceptanceDir>');
const state = await api('artifacts.load');
const points = state.points.items;
const byId = new Map(points.map((point) => [point.point_id, point]));
const generatable = points.filter((point) => point.classification === 'required');
const blocked = points.filter((point) => point.classification !== 'required');

const quoteOf = (point) => point.source?.quote || '';
const pick = (predicate) => generatable.find(predicate);

// old case → the new branch point that carries the same source clause.
const regression = [
	{ old: 'C-0001', defect: '状态条件「空调处于吹脚出风模式时」被当成执行步骤', match: (p) => /当空调处于吹脚出风模式/.test(quoteOf(p)) && p.action.startsWith('只读') },
	{ old: 'C-0053', defect: '两项点击后结果挂在点击前的 S01', match: (p) => /自动空调开关按键被按下/.test(quoteOf(p)) && /快速除霜即时切换到/.test(quoteOf(p)) && /IVI_Air_Button/.test(quoteOf(p)) },
	{ old: 'C-0054', defect: '连续三帧检查挂在 S01 初值确认', match: (p) => /自动空调开关按键被按下/.test(quoteOf(p)) && /IVI_Air_Button（连续3帧）/.test(quoteOf(p)) && /选中状态/.test(quoteOf(p)) },
	{ old: 'C-0068', defect: '吹面三项结果全部放在点击前', match: (p) => /吹面开关按键被按下/.test(quoteOf(p)) && /快速除霜即时切换到/.test(quoteOf(p)) },
	{ old: 'C-0095', defect: '请求值 TBD；来源 6.1.7 初态4档/恢复6档自相矛盾', match: (p) => /空调此时状态：开启、吹面、4档/.test(quoteOf(p)) },
	{ old: 'C-0108', defect: 'UI 判据错挂到读取报文的 S04', match: (p) => /快速除雾关闭时，单击dock栏/.test(quoteOf(p)) },
	{ old: 'C-0209', defect: '唯一步骤「单击【空调温度】」，无初态/观察/恢复', match: (p) => /单击【空调温度】，仅弹窗/.test(quoteOf(p)) },
	{ old: 'C-0469', defect: '唯一步骤「IVI 发出进入快速除霜请求」，30S 无计时起点', match: (p) => /快速除雾开启时，单击dock栏/.test(quoteOf(p)) }
];

const selected = [];
const mapping = [];
const intercepted = [];
for (const target of regression) {
	const found = pick(target.match);
	const blockedMatch = blocked.find(target.match);
	if (found) {
		selected.push(found.point_id);
		mapping.push({ old_case_id: target.old, new_point_id: found.point_id, branch_id: found.scenario_refs?.[0] || '', defect: target.defect, disposition: 'mapped', quote: quoteOf(found).slice(0, 120), location: found.source?.location });
	} else if (blockedMatch) {
		intercepted.push({ old_case_id: target.old, blocked_point_id: blockedMatch.point_id, classification: blockedMatch.classification, reason: blockedMatch.rule_reason, defect: target.defect, disposition: 'intercepted_needs_substitute' });
		mapping.push({ old_case_id: target.old, new_point_id: blockedMatch.point_id, branch_id: blockedMatch.scenario_refs?.[0] || '', defect: target.defect, disposition: 'blocked', quote: quoteOf(blockedMatch).slice(0, 120), location: blockedMatch.source?.location });
	} else {
		mapping.push({ old_case_id: target.old, new_point_id: '', branch_id: '', defect: target.defect, disposition: 'no_source_branch' });
	}
}

// Stratified top-up: 普通界面 / 联动 / 通信 / 异常时序, ordered by SHA-256(frozen digest + id).
const stratum = (point) => {
	const kinds = (point.expected_items || []).map((entry) => entry.kind);
	if (kinds.includes('can_request')) return '通信';
	if (/异常|丢失|恢复|超时/.test(point.section || point.requirement)) return '异常时序';
	if ((point.expected_items || []).length > 2) return '联动';
	return '普通界面';
};
const digest = state.points.source_ecsm_digest || '';
const order = (point) => crypto.createHash('sha256').update(digest + point.point_id).digest('hex');
const chosen = new Set(selected);
const layers = ['普通界面', '联动', '通信', '异常时序'];
const perLayer = Math.ceil((20 - chosen.size) / layers.length);
for (const layer of layers) {
	const candidates = generatable.filter((point) => !chosen.has(point.point_id) && stratum(point) === layer).sort((a, b) => order(a).localeCompare(order(b)));
	for (const point of candidates.slice(0, perLayer)) {
		if (chosen.size >= 20) break;
		chosen.add(point.point_id);
		selected.push(point.point_id);
		mapping.push({ old_case_id: '', new_point_id: point.point_id, branch_id: point.scenario_refs?.[0] || '', defect: '', disposition: 'sampled_' + layer, quote: quoteOf(point).slice(0, 120), location: point.source?.location });
	}
}
// If a layer was short, fill from the remaining pool by the same ordering.
if (chosen.size < 20) {
	const rest = generatable.filter((point) => !chosen.has(point.point_id)).sort((a, b) => order(a).localeCompare(order(b)));
	for (const point of rest) {
		if (chosen.size >= 20) break;
		chosen.add(point.point_id);
		selected.push(point.point_id);
		mapping.push({ old_case_id: '', new_point_id: point.point_id, branch_id: point.scenario_refs?.[0] || '', defect: '', disposition: 'sampled_fill', quote: quoteOf(point).slice(0, 120), location: point.source?.location });
	}
}

await fs.mkdir(out, { recursive: true });
await saveJson(out, 'pilot-selection.json', { at: new Date().toISOString(), project, module, baseline_digest: digest, count: selected.length, point_ids: selected, intercepted, strata: Object.fromEntries(Object.entries(Object.groupBy(selected.map((id) => byId.get(id)), (p) => stratum(p))).map(([k, v]) => [k, v.length])) });
const cols = ['old_case_id', 'new_point_id', 'branch_id', 'disposition', 'defect', 'location', 'quote'];
await fs.writeFile(path.join(out, 'old-to-new.tsv'), [cols.join('\t'), ...mapping.map((row) => cols.map((key) => String(row[key] ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n');
console.log(JSON.stringify({ selected: selected.length, intercepted: intercepted.length, strata: Object.fromEntries(Object.entries(Object.groupBy(selected.map((id) => byId.get(id)), (p) => stratum(p))).map(([k, v]) => [k, v.length])), point_ids: selected }));