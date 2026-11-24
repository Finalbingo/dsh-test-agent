/**
 * P5 离线验证：在项目副本上写 vision 关联、上提到测试点、重复执行幂等、
 * derive 保留有效依据，并在原图变化后使依据失效。不触碰真实 artifacts。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyVisionResults } from '../ui-vision-apply.js';
import { buildVisionTasks, prepareVisionTask } from '../ui-vision.js';
import { enterModule } from '../scope.js';
import { linkKey, loadIndex, loadLinks, derive, loadIndex as reloadIndex } from '../ui.js';
import { load as loadArtifact } from '../artifacts.js';
import { PROMPT_VERSION, SCHEMA_VERSION, VISION_MODEL } from '../ui-vision.js';

const SOURCE_ROOT = '/Users/Admin/Documents/CTS';
const projectId = 'P-v5-test';
const moduleId = 'M-ac';
const checks = [];
const check = (name, ok, detail = '') => {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''));
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-vision-apply-test-'));
const artifacts = path.join(root, 'artifacts', projectId);
const projectDir = path.join(root, 'projects', projectId);
fs.mkdirSync(artifacts, { recursive: true });
fs.cpSync(path.join(SOURCE_ROOT, 'artifacts', projectId), artifacts, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.copyFileSync(path.join(SOURCE_ROOT, 'projects', projectId, 'project.json'), path.join(projectDir, 'project.json'));
const shot = 'design/images/2b1a5a9a2d6365077732377c74405508a7deaed75f4a12af0e6e825970646e40/2702_168184.png';
fs.mkdirSync(path.dirname(path.join(projectDir, shot)), { recursive: true });
fs.copyFileSync(path.join(SOURCE_ROOT, 'projects', projectId, shot), path.join(projectDir, shot));

// 夹具专用：让 T-0028 的原文点名「变更记录」，以覆盖视觉依据正向上提；
// 真实项目数据不改。另一条拒绝路径由真实批次验证。
const pointsFile = path.join(artifacts, moduleId, 'points.json');
const pointsDoc = JSON.parse(fs.readFileSync(pointsFile, 'utf8'));
const fixturePoint = (pointsDoc.items || []).find((point) => point.point_id === 'T-0028');
fixturePoint.condition = `变更记录页面，${fixturePoint.condition}`;
fixturePoint.contract_refs = ['CT-fixture'];
fs.writeFileSync(pointsFile, JSON.stringify(pointsDoc, null, 1), 'utf8');
const contractsFile = path.join(artifacts, moduleId, 'contracts.json');
const contractsDoc = fs.existsSync(contractsFile)
	? JSON.parse(fs.readFileSync(contractsFile, 'utf8'))
	: { version: 1, items: [] };
contractsDoc.items = (contractsDoc.items || []).filter((contract) => contract.contract_id !== 'CT-fixture');
contractsDoc.items.push({
	contract_id: 'CT-fixture', title: '夹具合同', condition: '变更记录页面',
	trigger: '单击空调图标', expected: '空调图标为选中状态', fact_refs: []
});
fs.writeFileSync(contractsFile, JSON.stringify(contractsDoc, null, 1), 'utf8');

enterModule(moduleId);
const built = await buildVisionTasks({ dataRoot: root, projectId, moduleId, options: { includeMatched: true } });
const task = built.tasks.find((entry) => entry.subject.expected_id === 'e-5a4d620181');
const prepared = await prepareVisionTask({ dataRoot: root, projectId, task });
const candidate = prepared.candidates.find((entry) => entry.ui_id === 'pixso.P-v5-test.3::2702:168186');
check('夹具任务有唯一状态候选', Boolean(candidate) && candidate.state === '选中' && candidate.role === 'icon', candidate?.candidate_id);
const result = {
	task_id: task.task_id, decision: 'match', candidate_id: candidate.candidate_id,
	identity: 'supported', page: 'supported', appearance: '图标呈选中态',
	assertions: [{
		assertion_id: task.subject.assertion_id, assessment: 'supported', observed_text: '选中',
		evidence_image_ids: candidate.images.map((image) => image.image_id), evidence_refs: [], reason: '夹具：图标高亮'
	}],
	alternatives: [], missing_evidence: [], confidence: 0.9
};
const row = {
	task_id: task.task_id, purpose: task.purpose, text: task.text, subject: task.subject,
	target: task.target, retrieval: prepared.retrieval,
	candidates: prepared.candidates.map((entry) => ({ candidate_id: entry.candidate_id, ui_id: entry.ui_id, name: entry.name, role: entry.role, page: entry.page, state: entry.state, asset_status: entry.asset_status })),
	images: prepared.images.map((image) => ({ image_id: image.image_id, role: image.role, sha256: image.sha256, width: image.width, height: image.height })),
	ok: true, auto_eligible: true, decision: 'match', candidate_id: candidate.candidate_id,
	validation: { valid: true, errors: [] }, error: '', result,
	request: { model: VISION_MODEL, basis_digest: task.basis_digest, prompt_version: PROMPT_VERSION, schema_version: SCHEMA_VERSION },
	created_at: new Date().toISOString(), cache_key: 'fixture', attempts: []
};

const first = await applyVisionResults({ dataRoot: root, projectId, moduleId, results: [row] });
check('写入一条视觉关联', first.applied.length === 1 && first.stats.applied === 1, JSON.stringify(first.skipped));
const visionLink = first.document.items.find((item) => item.method === 'vision' && item.subject.kind === 'case_expected');
check('关联使用 method=vision/status=auto', visionLink?.method === 'vision' && visionLink?.status === 'auto');
check('关联不是 confirmed', first.document.items.every((item) => !(item.method === 'vision' && item.status === 'confirmed')));
check('保存复核所需依据', Boolean(visionLink?.vision_evidence?.candidate?.shot_sha256) && visionLink.vision_evidence.verified_assertion_ids.length === 1);
const pointLink = first.document.items.find((item) => item.method === 'vision' && item.subject.kind === 'point' && item.subject.id === 'T-0028');
check('视觉依据上提到测试点', Boolean(pointLink) && pointLink.inherited_from === visionLink.link_id, JSON.stringify({ applied: first.propagation.applied, skipped: first.propagation.skipped.filter((entry) => entry.point_id === 'T-0028') }));
const contractLink = first.document.items.find((item) => item.method === 'vision' && item.subject.kind === 'contract' && item.subject.id === 'CT-fixture');
check('视觉依据上提到需求合同', Boolean(contractLink) && contractLink.inherited_from === pointLink?.link_id, JSON.stringify(first.propagation.skipped.filter((entry) => entry.contract_id === 'CT-fixture')));

const before = first.document.items.length;
const second = await applyVisionResults({ dataRoot: root, projectId, moduleId, results: [row] });
check('重复执行幂等', second.document.items.length === before && second.applied.length === 0);
const sameLink = second.document.items.find((item) => linkKey(item.subject, item.purpose) === linkKey(visionLink.subject, visionLink.purpose));
check('重复执行保留 link_id', sameLink?.link_id === visionLink.link_id && sameLink?.method === 'vision');

const links = loadLinks(root, projectId);
const [facts, contracts, points, cases] = await Promise.all(['facts', 'contracts', 'points', 'cases'].map((kind) => loadArtifact(root, projectId, kind)));
const derived = derive(root, projectId, { facts, contracts, points, cases, links }, { links, save: false });
const preserved = derived.document.items.find((item) => item.link_id === visionLink.link_id);
check('derive 保留有效视觉依据', preserved?.method === 'vision' && preserved?.status === 'auto');

const index = loadIndex(root, projectId);
const targetShot = path.join(projectDir, visionLink.vision_evidence.candidate.shot);
const original = fs.readFileSync(targetShot);
fs.appendFileSync(targetShot, Buffer.from([0]));
const stale = derive(root, projectId, { facts, contracts, points, cases, links }, { links, save: false });
const staleLink = stale.document.items.find((item) => item.link_id === visionLink.link_id);
check('原图摘要变化后依据失效', staleLink?.method !== 'vision' || staleLink?.status !== 'auto');
fs.writeFileSync(targetShot, original);
reloadIndex(root, projectId);

await fsp.rm(root, { recursive: true, force: true });
const failed = checks.filter((entry) => !entry.ok);
console.log(JSON.stringify({ total: checks.length, failed: failed.length }, null, 1));
if (failed.length) process.exit(1);