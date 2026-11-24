/**
 * 不联网的客户端单测：严格校验、语义修复重试、自动闸门、缓存命中重算。
 * 运行：node scripts/test-ui-vision-client.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OUTPUT_SCHEMA, autoEligible, runVisionTask, validateVisionResult } from '../ui-vision-client.js';
import { PROMPT_VERSION, SCHEMA_VERSION, VISION_MODEL } from '../ui-vision.js';

const checks = [];
const check = (name, ok, detail = '') => {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''));
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-vision-client-test-'));
process.env.OPENROUTER_API_KEY = 'test-key-not-used-online';

const assertion = { assertion_id: 'a-1', assertion_text: 'Dock 栏【开关】图标变为选中状态' };
const candidate = {
	candidate_id: 'c:1', ui_id: 's::1', name: '开关', role: 'icon', state: '选中',
	page: '桌面', source: 's', revision: 'r1', asset_status: 'shot', images: []
};
const task = {
	task_id: 'v-test', basis_digest: 'basis', purpose: 'expected',
	text: assertion.assertion_text, target: { object_text: '开关', role: 'icon', requested_state: '选中', requested_text: null },
	assertions: [assertion], candidates: [candidate], images: [{ image_id: 'page:1', role: 'page_context', sha256: 'abc', width: 1, height: 1, file: 'missing.png' }],
	context: { page: '桌面' }, subject: { kind: 'case_expected', id: 'C-1', expected_id: 'e-1', assertion_id: 'a-1' }
};

const good = {
	task_id: 'v-test', decision: 'match', candidate_id: 'c:1', identity: 'supported', page: 'supported',
	appearance: '支持', assertions: [{ assertion_id: 'a-1', assessment: 'supported', observed_text: '', evidence_image_ids: ['page:1'], evidence_refs: ['page:1'], reason: '图标高亮' }],
	alternatives: [], missing_evidence: [], confidence: 0.9
};

check('合法 match 通过校验', validateVisionResult(task, good).valid);
check('合法 match 自动闸门通过', autoEligible(task, good));
check('发明断言 ID 被拒绝', !validateVisionResult(task, { ...good, assertions: [{ ...good.assertions[0], assertion_id: 'a2' }] }).valid);
check('发明图片 ID 被拒绝', !validateVisionResult(task, { ...good, assertions: [{ ...good.assertions[0], evidence_image_ids: ['page:nope'] }] }).valid);
check('match 但身份相反被拒绝', !validateVisionResult(task, { ...good, identity: 'contradicted' }).valid);
check('状态元数据不符不自动写', !autoEligible({ ...task, candidates: [{ ...candidate, state: '' }] }, good));
check('角色不兼容不自动写', !autoEligible({ ...task, candidates: [{ ...candidate, role: 'text' }] }, good));
check('候选文字与原文不符不自动写', !autoEligible({ ...task, candidates: [{ ...candidate, name: '变更记录', texts: ['变更记录'] }] }, good));
check('候选页面与原文不符不自动写', !autoEligible({ ...task, candidates: [{ ...candidate, page: '车辆设置' }] }, good));
check('候选文字含目标词可自动写', autoEligible({ ...task, candidates: [{ ...candidate, name: 'A-按钮开关', texts: ['空调'] }] }, good));
check('含时序/通信的断言不自动写', !autoEligible({ ...task, text: '发出请求30S后更新为选中状态' }, good));

const content = (payload) => JSON.stringify(payload);
let queue = [
	content({ ...good, decision: 'match', identity: 'contradicted', page: 'unknown', assertions: [{ ...good.assertions[0], assessment: 'unknown' }] }),
	content({ ...good, decision: 'ambiguous', candidate_id: null, identity: 'unknown', page: 'unknown', assertions: [{ ...good.assertions[0], assessment: 'unknown' }] })
];
const calls = [];
globalThis.fetch = async (url, options) => {
	calls.push(JSON.parse(options.body));
	const payload = queue.shift();
	return new Response(JSON.stringify({
		id: 'resp-' + calls.length, model: VISION_MODEL,
		choices: [{ message: { content: payload }, finish_reason: 'stop' }], usage: {}
	}), { status: 200, headers: { 'content-type': 'application/json' } });
};

const retry = await runVisionTask({ task, projectDir: dir, resume: false });
check('语义自相矛盾触发一次修复重试', retry.attempts.some((entry) => entry.kind === 'invalid_semantic_retry'));
check('修复后按严格标准接受 ambiguous', retry.ok && retry.result.decision === 'ambiguous' && !retry.auto_eligible);
check('修复请求包含原断言 ID', calls.at(-1).messages.at(-1).content.includes('a-1'));

queue = [content(good)];
const first = await runVisionTask({ task, projectDir: dir, resume: false });
check('合法 match 写入并自动可用', first.ok && first.auto_eligible && !first.cached);
const [cacheFile] = (await fsp.readdir(path.join(dir, 'design', 'vision-cache'))).filter((name) => name.endsWith('.json'));
const cached = JSON.parse(await fsp.readFile(path.join(dir, 'design', 'vision-cache', cacheFile), 'utf8'));
check('缓存保留视觉依据', cached.ok && cached.result.decision === 'match' && cached.request.model === VISION_MODEL);
const changedRole = { ...task, candidates: [{ ...candidate, role: 'text' }] };
const resumed = await runVisionTask({ task: changedRole, projectDir: dir, resume: true });
check('缓存命中仍重新计算闸门', resumed.cached && resumed.ok && !resumed.auto_eligible);

const noMatch = {
	...good, decision: 'no_match', candidate_id: null, identity: 'unknown', page: 'unknown',
	assertions: [{ ...good.assertions[0], assessment: 'unknown' }]
};
check('合法 no_match 不自动写', validateVisionResult(task, noMatch).valid && !autoEligible(task, noMatch));

const failed = checks.filter((entry) => !entry.ok);
await fsp.rm(dir, { recursive: true, force: true });
console.log(JSON.stringify({
	total: checks.length, failed: failed.length,
	model: VISION_MODEL, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION,
	schema_bytes: JSON.stringify(OUTPUT_SCHEMA).length
}, null, 1));
if (failed.length) process.exit(1);