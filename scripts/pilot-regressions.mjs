import fs from 'node:fs/promises';
import path from 'node:path';
import { validateAnchors } from '../case-structure.js';
import { structureCase } from '../artifacts.js';
import { parseDbc, auditCases } from '../signal-audit.js';

/**
 * P2 regression gate: each defect named in the manual is checked against the
 * cases the plugin actually produced, by source clause rather than by case id
 * (ids change between revisions).
 *
 * usage: node scripts/pilot-regressions.mjs <project> <module> <acceptanceDir>
 */
const [project, module, out] = process.argv.slice(2);
if (!project || !module || !out) throw new Error('usage: pilot-regressions.mjs <project> <module> <acceptanceDir>');
const root = process.env.CTS_DATA_ROOT || path.join(process.env.HOME, 'Documents', 'CTS');
const dir = path.join(root, 'artifacts', project, module);
const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
const [cases, points] = await Promise.all([read('cases.json'), read('points.json')]);
// 与插件读取路径同一视图：来源缺口是读取期落章的派生标注。
for (const item of cases.items) structureCase(item);
const mapping = (await fs.readFile(path.join(out, 'old-to-new.tsv'), 'utf8')).split('\n').slice(1)
	.filter(Boolean).map((line) => line.split('\t'));
const pointById = new Map(points.items.map((point) => [point.point_id, point]));
const caseFor = (oldId) => {
	const row = mapping.find((entry) => entry[0] === oldId);
	if (!row) return null;
	return cases.items.find((item) => item.point_id === row[1]) || null;
};
const checks = [];
const check = (oldId, name, fn) => {
	const item = caseFor(oldId);
	if (!item) { checks.push({ old_id: oldId, name, pass: false, detail: '没有对应用例（分支被拦截或未生成）' }); return; }
	let result;
	try { result = fn(item, pointById.get(item.point_id)); } catch (error) { result = { pass: false, detail: String(error.message) }; }
	checks.push({ old_id: oldId, new_case_id: item.case_id, point_id: item.point_id, name, ...result });
};
const stepOf = (item, id) => (item.step_items || []).find((step) => step.id === id);
const assertionsOn = (item, predicate) => (item.expected_items || []).filter(predicate);

// T-0001 class: a state clause is a condition, never an execution step.
check('C-0001', '状态条件不写成执行步骤', (item, point) => {
	const clickSteps = (item.step_items || []).filter((step) => /单击|点击|按下/.test(step.text));
	const readOnly = (item.step_items || []).every((step) => step.role === 'observe');
	const stateInCondition = /吹脚/.test(item.precondition || '') || /吹脚/.test(point?.condition || '');
	return { pass: clickSteps.length === 0 && readOnly && stateInCondition,
		detail: `点击类步骤 ${clickSteps.length}，全为观察 ${readOnly}，初态含吹脚 ${stateInCondition}` };
});

// C-0053 / C-0068 class: every post-click result hangs on a post-click observation.
for (const oldId of ['C-0053', 'C-0068', 'C-0054']) {
	check(oldId, '点击后结果挂在点击后的观察步骤', (item) => {
		const bad = validateAnchors(item).filter((entry) => ['ANCHOR_BEFORE_CAUSE', 'NO_OBSERVATION_STEP', 'TRIGGER_MISSING', 'OBSERVATION_MISSING'].includes(entry.code));
		// 触发不一定是点击：台架断帧/恢复同样是动作。只排除启动/停止采集这类准备动作。
		const clickAt = (item.step_items || []).findIndex((step) => step.role === 'action' && !/启动|停止/.test(step.text));
		const after = assertionsOn(item, (entry) => entry.kind !== 'state_observation' && entry.step_index > clickAt + 1);
		return { pass: bad.length === 0 && clickAt >= 0 && after.length > 0,
			detail: `锚点错误 ${bad.length}，触发动作步 S${clickAt + 1}，挂在触发之后的判据 ${after.length}/${(item.expected_items || []).length}` };
	});
}

// C-0108 class: the UI assertion and the CAN assertion each own an observation step.
check('C-0108', 'UI 判据与报文判据各挂自己的观察步骤', (item) => {
	const ui = assertionsOn(item, (entry) => entry.kind.startsWith('ui_'));
	const can = assertionsOn(item, (entry) => /^can_/.test(entry.kind));
	const distinct = new Set([...ui, ...can].map((entry) => entry.step_id));
	const separated = ui.every((entry) => can.every((other) => other.step_id !== entry.step_id));
	return { pass: ui.length > 0 && can.length > 0 && separated && distinct.size === ui.length + can.length,
		detail: `UI 判据 ${ui.length}，报文判据 ${can.length}，观察步骤去重 ${distinct.size}，互不共用 ${separated}` };
});

// C-0209 class: more than one step, with preparation read-back and restore.
check('C-0209', '不是把测试点动作复制成唯一步骤', (item) => {
	const prepares = (item.prepare_items || []).filter((entry) => entry.read_back);
	return { pass: (item.step_items || []).length >= 3 && prepares.length > 0 && (item.restore_items || []).length > 0,
		detail: `步骤 ${(item.step_items || []).length}，带读回的准备项 ${prepares.length}，恢复项 ${(item.restore_items || []).length}` };
});

// C-0469 class: the 30s window is counted from request emission.
check('C-0469', '30S 自发出请求起算', (item) => {
	const timed = [...(item.expected_items || []), ...(item.deferred_items || [])].filter((entry) => entry.delay_s === 30);
	const deferredTimed = (item.deferred_items || []).filter((entry) => entry.delay_s === 30).length;
	return { pass: timed.length > 0 && timed.every((entry) => entry.since === '发出请求'),
		detail: `30s 判据 ${timed.length}（其中待裁决 ${deferredTimed}），计时起点 ${JSON.stringify([...new Set(timed.map((entry) => entry.since))])}` };
});

// C-0113 / C-0034 class: no absent or misspelled field survives into a case.
const declaredDbc = JSON.parse(await fs.readFile(path.join(root, 'projects', project, 'project.json'), 'utf8')).quality?.sources?.dbc;
if (!declaredDbc) throw new Error('项目未声明 quality.sources.dbc');
const dbcFile = path.join(root, 'projects', project, declaredDbc);
const dbc = parseDbc(dbcFile);
const rows = auditCases(cases.items, dbc);
const hard = rows.filter((row) => ['unknown_signal', 'unknown_message', 'ambiguous_message'].includes(row.status));
checks.push({ old_id: 'C-0113/C-0034', name: '不存在或拼错的字段不进入用例', pass: hard.length === 0,
	detail: `依赖行 ${rows.length}，硬缺陷 ${hard.length}${hard.length ? '：' + hard.map((row) => row.written).join('、') : ''}` });
const invented = cases.items.flatMap((item) => (item.expected_items || [])
	.filter((entry) => /HVAC_TempSet|HVAV_/.test(`${entry.object} ${entry.target} ${entry.signal}`)).map((entry) => `${item.case_id}/${entry.id}`));
checks.push({ old_id: 'C-0113/C-0034', name: 'HVAC_TempSet 与 HVAV_Mode_change 未被沿用', pass: invented.length === 0,
	detail: `命中 ${invented.length}${invented.length ? '：' + invented.join('、') : ''}` });

// Every assertion is judgeable: object, target, evidence, and a registered gap when the source is silent.
const all = cases.items.flatMap((item) => (item.expected_items || []).map((entry) => ({ item, entry })));
const unjudgeable = all.filter(({ entry }) => !entry.object || !entry.target || !entry.evidence_ref);
checks.push({ old_id: '全部', name: '每项判据有对象/目标/来源', pass: unjudgeable.length === 0,
	detail: `${all.length - unjudgeable.length}/${all.length}` });
const silent = all.filter(({ entry }) => entry.kind === 'can_request' && !entry.frames && !entry.unresolved);
checks.push({ old_id: '全部', name: '来源未给帧数时登记缺口而不是编数值', pass: silent.length === 0,
	detail: `无帧数且无缺口的发送判据 ${silent.length}` });

await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'pilot-regressions.json'), JSON.stringify({
	at: new Date().toISOString(), total: checks.length, passed: checks.filter((entry) => entry.pass).length, checks
}, null, 1));
const cols = ['old_id', 'new_case_id', 'point_id', 'name', 'pass', 'detail'];
await fs.writeFile(path.join(out, 'pilot-regressions.tsv'),
	[cols.join('\t'), ...checks.map((row) => cols.map((key) => String(row[key] ?? '').replaceAll('\t', ' ')).join('\t'))].join('\n') + '\n');
console.log(JSON.stringify({ total: checks.length, passed: checks.filter((entry) => entry.pass).length,
	failed: checks.filter((entry) => !entry.pass).map((entry) => `${entry.old_id} ${entry.name}: ${entry.detail}`) }, null, 1));