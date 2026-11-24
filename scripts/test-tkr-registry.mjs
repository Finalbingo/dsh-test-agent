/**
 * B1 离线回归：规则包校验、r8 逐字段复现、四个负例。
 *   node cts-agent/scripts/test-tkr-registry.mjs
 * 篡改在临时副本上做，不动插件里的规则包。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundle, loadRules, verifyBundle, makeSelection, selectionGate, digest, digestFieldValid, PACK_DIR } from '../tkr/registry.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/tkr-r8/', import.meta.url));
const rd = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE, name), 'utf8'));
const profile = rd('profile.hvac_front_defrost.r8.json');
const policy = rd('policy.ev18_g100p_pilot.r3.json');
const gold = rd('gold.hvac_front_defrost.r8.json');
const order = rd('rule-order.json').order;

const results = [];
const check = (name, fn) => {
	try { fn(); results.push({ name, ok: true }); }
	catch (error) { results.push({ name, ok: false, error: error.message }); }
};

const bundle = loadBundle('pilot_registry.v0.3.manifest.json');
const { rules, errors } = loadRules(bundle);
const byId = new Map(rules.map((rule) => [rule.knowledge_id, rule]));
const ordered = order.map((id) => byId.get(id));
const replay = () => makeSelection(profile, ordered, bundle, policy, 'candidate_dry_run', { selectionRevision: 8, bundleErrors: errors });

check('清单 15 个成员全部校验通过', () => {
	assert.equal(bundle.objects.length, 15);
	assert.equal(rules.length, 15);
	assert.deepEqual(errors, []);
	assert.ok(digestFieldValid(bundle, 'bundle_digest_sha256'));
	for (const member of bundle.objects) {
		const rule = byId.get(member.knowledge_id);
		assert.equal(rule.revision, member.revision);
		assert.equal(rule.object_digest_sha256, member.digest);
		assert.ok(digestFieldValid(rule, 'object_digest_sha256'));
	}
});

check('canonical 摘要与原始文件摘要不同', () => {
	const member = bundle.objects[0];
	const raw = fs.readFileSync(path.join(PACK_DIR, member.path));
	const fileSha = crypto.createHash('sha256').update(raw).digest('hex');
	assert.notEqual(fileSha, member.digest, '原始文件 SHA-256 不应等于 canonical 摘要');
	assert.ok(digestFieldValid(JSON.parse(raw.toString('utf8')), 'object_digest_sha256'));
});

check('r8 逐字段复现，含选规摘要', () => {
	const got = replay();
	assert.deepEqual(Object.keys(gold).filter((key) => JSON.stringify(got[key]) !== JSON.stringify(gold[key])), []);
	assert.equal(got.selection_digest_sha256, gold.selection_digest_sha256);
	assert.equal(got.applied_rules.length, 10);
	assert.equal(got.not_applied_rules.length, 5);
	assert.equal(got.outputs.length, 74);
	assert.equal(got.outputs.filter((o) => o.output_class === 'formal_coverage_target').length, 72);
	assert.equal(got.findings.length, 3);
	assert.equal(got.findings.filter((f) => f.startsWith('AUTO-FINDING')).length, 2);
	assert.equal(got.status, 'blocked_by_input_status');
	assert.equal(got.formal_gate.eligible, false);
});

check('清单序算不出 gold 摘要（顺序约定必须显式固定）', () => {
	const manifestOrder = makeSelection(profile, rules, bundle, policy, 'candidate_dry_run', { selectionRevision: 8, bundleErrors: errors });
	assert.notEqual(manifestOrder.selection_digest_sha256, gold.selection_digest_sha256);
	assert.deepEqual(new Set(manifestOrder.outputs.map((o) => o.output_id)), new Set(gold.outputs.map((o) => o.output_id)));
});

// 负例一：缺件。
check('负例 · 缺成员被检出', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkr-missing-'));
	fs.cpSync(PACK_DIR, tmp, { recursive: true });
	fs.rmSync(path.join(tmp, bundle.objects[0].path));
	const got = loadRules(loadBundle('pilot_registry.v0.3.manifest.json', tmp), tmp);
	assert.ok(got.errors.some((e) => e.startsWith('registry_bundle_member_file_missing:')), got.errors.join(','));
	assert.ok(got.errors.some((e) => e.startsWith('registry_bundle_member_missing:')));
	assert.equal(got.rules.length, 14);
	fs.rmSync(tmp, { recursive: true, force: true });
});

// 负例二：篡改。
check('负例 · 篡改成员被检出', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkr-tamper-'));
	fs.cpSync(PACK_DIR, tmp, { recursive: true });
	const target = path.join(tmp, bundle.objects[0].path);
	const rule = JSON.parse(fs.readFileSync(target, 'utf8'));
	rule.rationale = (rule.rationale || '') + ' 篡改';
	fs.writeFileSync(target, JSON.stringify(rule, null, 1));
	const got = loadRules(loadBundle('pilot_registry.v0.3.manifest.json', tmp), tmp);
	assert.ok(got.errors.some((e) => e.startsWith('registry_rule_digest_invalid:')), got.errors.join(','));
	// 更狠的一种：篡改后重算自摘要，试图冒充合法成员；此时清单摘要必须拦下。
	const resigned = JSON.parse(fs.readFileSync(target, 'utf8'));
	delete resigned.object_digest_sha256;
	resigned.object_digest_sha256 = digest({ ...resigned });
	fs.writeFileSync(target, JSON.stringify(resigned, null, 1));
	const second = loadRules(loadBundle('pilot_registry.v0.3.manifest.json', tmp), tmp);
	assert.ok(second.errors.some((e) => e.startsWith('registry_bundle_member_digest_mismatch:')), second.errors.join(','));
	fs.rmSync(tmp, { recursive: true, force: true });
});

check('负例 · 身份不符与路径逃逸被检出', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkr-identity-'));
	fs.cpSync(PACK_DIR, tmp, { recursive: true });
	const target = path.join(tmp, bundle.objects[0].path);
	const rule = JSON.parse(fs.readFileSync(target, 'utf8'));
	rule.revision += 1;
	fs.writeFileSync(target, JSON.stringify(rule));
	const b = loadBundle('pilot_registry.v0.3.manifest.json', tmp);
	assert.ok(loadRules(b, tmp).errors.some((e) => e.startsWith('registry_bundle_member_identity_mismatch:')));
	const escape = { ...b, objects: [{ ...b.objects[0], path: '../../../etc/passwd' }, ...b.objects.slice(1)] };
	assert.ok(loadRules(escape, tmp).errors.some((e) => e.startsWith('registry_bundle_member_path_escape:')));
	fs.rmSync(tmp, { recursive: true, force: true });
});

// 负例三：缺产品依据。
check('负例 · 缺预期依据的维度变成需求问题，不算覆盖目标', () => {
	const stripped = structuredClone(profile);
	const dimension = 'request_feedback_normal';
	assert.ok(stripped.dimension_support[dimension], '夹具应含该维度');
	stripped.dimension_support[dimension] = { support_items: [], requirement_ids: [], oracle_refs: [] };
	delete stripped.object_digest_sha256;
	const rest = { ...stripped };
	stripped.object_digest_sha256 = digest(rest);
	const got = makeSelection(stripped, ordered, bundle, policy, 'candidate_dry_run', { selectionRevision: 8, bundleErrors: errors });
	const affected = got.outputs.filter((o) => o.dimension === dimension);
	assert.ok(affected.length > 0);
	assert.ok(affected.every((o) => o.formal_eligibility === 'no_normative_expected'), JSON.stringify(affected.map((o) => o.formal_eligibility)));
	assert.ok(affected.every((o) => o.output_class !== 'formal_coverage_target'));
	assert.ok(got.findings.some((f) => f.endsWith(`:${dimension}:no_normative_expected`)));
	assert.ok(got.outputs.filter((o) => o.output_class === 'formal_coverage_target').length < 72);
});

check('负例 · 缺判据依据同样降级', () => {
	const stripped = structuredClone(profile);
	const dimension = 'request_feedback_normal';
	stripped.dimension_support[dimension].support_items = stripped.dimension_support[dimension].support_items.map((item) => ({ ...item, oracle_refs: [] }));
	delete stripped.object_digest_sha256;
	stripped.object_digest_sha256 = digest({ ...stripped });
	const got = makeSelection(stripped, ordered, bundle, policy, 'candidate_dry_run', { selectionRevision: 8, bundleErrors: errors });
	assert.ok(got.outputs.filter((o) => o.dimension === dimension).every((o) => o.formal_eligibility === 'no_resolving_oracle'));
});

// 负例四：候选包误放行。
check('负例 · 候选包不能当作已批准放行', () => {
	const gate = selectionGate(profile, ordered, bundle, policy, errors);
	assert.equal(gate.eligible, false);
	assert.ok(gate.blockers.includes('registry_bundle_approved'));
	assert.equal(bundle.status, 'candidate_under_review');
	// formal 模式下本应正式的目标塌成需求问题，不产生可交付覆盖目标。
	const formal = makeSelection(profile, ordered, bundle, policy, 'formal', { selectionRevision: 8, bundleErrors: errors });
	assert.equal(formal.outputs.filter((o) => o.output_class === 'formal_coverage_target').length, 0);
	assert.ok(formal.findings.length > gold.findings.length);
});

check('负例 · 已批准包成员为零，不能凭空放行', () => {
	const approved = loadBundle('approved_registry.v0.1.manifest.json');
	assert.equal(approved.objects.length, 0);
	assert.equal(approved.status, 'withheld_pending_human_approval');
	const loaded = loadRules(approved);
	assert.equal(loaded.rules.length, 0);
	const gate = selectionGate(profile, loaded.rules, approved, policy, loaded.errors);
	assert.equal(gate.eligible, false);
	assert.ok(gate.blockers.includes('registry_rules_approved'));
	assert.ok(gate.blockers.includes('registry_bundle_approved'));
});

check('上游业务值不进入选规记录的项目预期引用', () => {
	const got = replay();
	// 预期引用只能来自画像的 requirement_ids；规则包本身不提供产品数值。
	const ruleText = JSON.stringify(rules);
	for (const output of got.outputs) {
		for (const ref of output.expected_refs) assert.ok(!ref.includes('EV18') || profile.requirement_refs.includes(ref), ref);
	}
	assert.ok(got.outputs.every((o) => o.source_refs[0] === profile.profile_id));
	assert.ok(ruleText.length > 0);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + r.error}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过 · gold 摘要 ${gold.selection_digest_sha256.slice(0, 16)}…`);
process.exit(failed.length ? 1 : 0);