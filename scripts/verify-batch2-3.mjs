import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as pluginModule from '../index.js';
import { mergeFacts, mergeFeatures } from '../artifacts.js';
import { enterScope, isolateScope, currentModule, runScope } from '../scope.js';

const activate = pluginModule.activate || pluginModule.register || Object.values(pluginModule).find((v) => typeof v === 'function');

// 1. 验证 mergeFacts 修复 28 字符前缀截断误删 Bug
const evidenceIds = new Set(['E-0001', 'E-0002', 'E-0003']);
const sharedPrefixFacts = {
	facts: [
		{ type: 'rule', statement: '当系统进入初始化自检阶段且处于运行供电状态时，状态显示区域内的【主告警指示项A】点亮3秒后自动熄灭', evidence_refs: ['E-0001'] },
		{ type: 'rule', statement: '当系统进入初始化自检阶段且处于运行供电状态时，状态显示区域内的【辅助状态指示项B】点亮3秒后自动熄灭', evidence_refs: ['E-0002'] },
		{ type: 'rule', statement: '当系统进入初始化自检阶段且处于运行供电状态时，状态显示区域内的【通信故障指示项C】点亮1.5秒后自动熄灭', evidence_refs: ['E-0003'] },
		// 真正完全同文的重复项仍应被去重
		{ type: 'rule', statement: '当系统进入初始化自检阶段且处于运行供电状态时，状态显示区域内的【主告警指示项A】点亮3秒后自动熄灭。', evidence_refs: ['E-0001'] }
	]
};
const mergedFacts = mergeFacts([], sharedPrefixFacts, evidenceIds);
assert.equal(mergedFacts.length, 3, `共享长前缀的 3 条不同实体事实必须全部保留，实际保留 ${mergedFacts.length} 条`);

// 2. 验证 mergeFeatures 跨批次同名功能点合并 fact_refs 而非丢弃
const factIds = new Set(['F-0001', 'F-0002', 'F-0003', 'F-0004']);
const existingFeatures = [{ feature_id: 'FTR_001', name: '初始化自检', summary: '上电自检', fact_refs: ['F-0001', 'F-0002'], status: 'candidate' }];
const batch2Features = {
	features: [
		{ name: '初始化自检', summary: '上电自检补充', fact_refs: ['F-0003', 'F-0004'] }
	]
};
const addedFeatures = mergeFeatures(existingFeatures, batch2Features, factIds);
assert.equal(addedFeatures.length, 0, '同名功能点不应重复新建条目');
assert.deepEqual(existingFeatures[0].fact_refs, ['F-0001', 'F-0002', 'F-0003', 'F-0004'], '跨批次同名功能点必须合并保留新增 fact_refs');

// 3. 验证 isolateScope 严格隔离父子异步上下文
await runScope({ module: 'M-PARENT', config: { a: 1 } }, async () => {
	assert.equal(currentModule(), 'M-PARENT');
	await isolateScope(async () => {
		enterScope({ module: 'M-CHILD', config: { a: 2 } });
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(currentModule(), 'M-CHILD');
	});
	assert.equal(currentModule(), 'M-PARENT', '子调用 enterScope 绝不能反向污染父异步上下文');
});

// 4. 验证 client.js 第二批双轨分流与模块内联预览/角色配置渲染结构
const clientSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
new Function(clientSrc); // 完整语法检查
assert.ok(clientSrc.includes('⚡ 快速设计') && clientSrc.includes('🛡 ECSM 建模'), '模块导航栏必须显式展示快速设计与 ECSM 双轨');
assert.ok(clientSrc.includes('⚡ 进入快速测试设计（推荐）'), '模块资料准备页必须提供快速测试设计主入口');
assert.ok(clientSrc.includes('模块资料用途角色配置'), '模块资料页必须内联恢复 SourceScope 角色配置');
assert.ok(!clientSrc.includes('const [scopeOpen, setScopeOpen]'), 'AssetsView 遗留死代码必须清理干净');

// 5. 验证独立审查 3 路并发池提速（12 条用例，pageSize=4 -> 3 页并发在单轮延迟内完成）与同项目双模块并行不阻塞
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-b23-'));
const routes = new Map();
let activeStreams = 0;
let maxConcurrentStreams = 0;

const mockLlm = {
	listProviders: () => [{ id: 'mock' }],
	listModels: async () => [{ id: 'mock-1' }],
	stream: async function* ({ messages }) {
		const allStr = JSON.stringify(messages);
		if (allStr.includes('独立审查（cts-review）')) {
			activeStreams += 1;
			maxConcurrentStreams = Math.max(maxConcurrentStreams, activeStreams);
			await new Promise((r) => setTimeout(r, 80));
			activeStreams -= 1;
			const ids = [...allStr.matchAll(/【(C-\d{4}) 的独立审查输入】/g)].map((m) => m[1]);
			yield {
				type: 'text-delta',
				text: JSON.stringify({ receipts: ids.map((id) => ({ case_id: id, conclusion: '通过', findings: [] })) })
			};
			yield { type: 'finish', reason: { kind: 'stop' } };
			return;
		}
		if (allStr.includes('测试点设计（cts-test-design）')) {
			const pts = Array.from({ length: 12 }, (_, i) => ({
				requirement: `独立指示项_${i + 1}`,
				condition: '系统处于运行模式',
				action: `在主控页面触发【指示项_${i + 1}】`,
				expected: `主控页面【指示项_${i + 1}】切换为点亮状态`,
				type: '状态显示',
				priority: 'P1',
				fact_refs: ['F-0001']
			}));
			yield { type: 'text-delta', text: JSON.stringify({ points: pts }) };
			yield { type: 'finish', reason: { kind: 'stop' } };
			return;
		}
		if (allStr.includes('可执行测试用例编写（cts-case-authoring）')) {
			const ptIds = [...new Set([...allStr.matchAll(/\b(T-\d{4})\b/g)].map((m) => m[1]))].filter((id) => id !== 'T-0000');
			// 仅返回本批实际请求的测试点
			const requestedPts = [...allStr.matchAll(/\[(T-\d{4})\]/g)].map((m) => m[1]);
			const targetPts = requestedPts.length ? requestedPts : ptIds.slice(0, 1);
			const cases = targetPts.map((pid) => ({
				point_id: pid,
				case_role: 'primary',
				title: `验证 ${pid}`,
				type: '状态显示',
				priority: 'P1',
				precondition: '系统处于运行模式；主控页面可见',
				prepare_items: [{ key: 'p1', text: '确认初态', object: '状态开关', target: '关闭', establish: '在主控页面核对状态', read_back: '在主控页面观察【状态开关】为关闭', on_failure: '停止' }],
				steps: [
					{ key: 's1', role: 'action', text: '在主控页面单击一次【状态开关】' },
					{ key: 's2', role: 'observe', text: '在主控页面观察【状态开关】，记录状态' }
				],
				expected_items: [
					{ key: 'e1', assertion_ref: '', trigger: 's1', observe: 's2', object: '状态开关', target: '切换为点亮状态', kind: 'ui_immediate', evidence_ref: 'F-0001', frames: 0, since: '', delay_s: 0, unresolved: '' }
				],
				restore_items: [{ key: 'r1', text: '在主控页面单击【状态开关】恢复关闭', baseline: 'p1', read_back: '在主控页面观察【状态开关】为关闭', on_failure: '停止' }],
				deferred_items: [],
				failure_policy: '截图记录',
				basis: 'F-0001'
			}));
			yield { type: 'text-delta', text: JSON.stringify({ cases }) };
			yield { type: 'finish', reason: { kind: 'stop' } };
			return;
		}
		yield { type: 'text-delta', text: JSON.stringify({ facts: [{ type: 'rule', statement: '单击状态开关切换为点亮状态', evidence_refs: ['E-0001'] }] }) };
		yield { type: 'finish', reason: { kind: 'stop' } };
	}
};

const mockCtx = {
	config: { dataDir: tmpDir, provider: 'mock', model: 'mock-1' },
	get: (svc) => (svc === 'llm' ? mockLlm : null),
	effect: (fn) => fn(),
	tools: { register: () => {} },
	webServer: { register: ({ path: p, handler }) => routes.set(p, handler) }
};

await activate(mockCtx, { dataDir: tmpDir, provider: 'mock', model: 'mock-1' });

const callRoute = async (method, urlStr, bodyObj = null) => {
	const u = new URL(urlStr, 'http://127.0.0.1');
	const handler = routes.get(u.pathname);
	const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : Buffer.alloc(0);
	const req = Object.assign(Readable.from(payload.length ? [payload] : []), {
		method, url: u.pathname + u.search, headers: { 'content-type': 'application/json' }
	});
	const chunks = [];
	let statusCode = 200;
	let resolveDone;
	const done = new Promise((r) => { resolveDone = r; });
	const res = {
		get statusCode() { return statusCode; },
		set statusCode(v) { statusCode = v; },
		destroyed: false, writableEnded: false,
		setHeader() {}, writeHead(c) { statusCode = c; },
		write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; },
		end(c) { if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); this.writableEnded = true; resolveDone(); },
		once() {}
	};
	await handler(req, res);
	await done;
	return { statusCode, text: Buffer.concat(chunks).toString('utf8') };
};
const api = async (b) => JSON.parse((await callRoute('POST', '/cts/api', b)).text);

try {
	const created = await api({ action: 'project.create', name: 'B23Verify', firstModule: '模块A' });
	const pid = created.state.project.id;
	const modA = created.state.project.modules[0].id;
	const modBRes = await api({ action: 'module.create', project: pid, name: '模块B', keywords: ['模块B'] });
	const modB = modBRes.state.module?.id || (await api({ action: 'module.list', project: pid })).state.modules.find((m) => m.name === '模块B').id;

	const prdDir = path.join(tmpDir, 'projects', pid, 'prd');
	fs.mkdirSync(prdDir, { recursive: true });
	fs.writeFileSync(path.join(prdDir, 'spec.md'), '# 主控页面\n当在主控页面单击【状态开关】时，状态开关切换为点亮状态。\n');
	await api({ action: 'assets.tags.update', project: pid, module: modA, path: 'prd/spec.md', add: true });
	await api({ action: 'assets.tags.update', project: pid, module: modB, path: 'prd/spec.md', add: true });
	await api({ action: 'evidence.build', project: pid, module: modA });

	// 同项目双模块并行生成事实与测试点，验证模块级细粒度锁互不阻塞且作用域不串扰
	await Promise.all([
		callRoute('POST', '/cts/api/generate', { project: pid, module: modA, kind: 'facts', draft: true, replace: true }),
		callRoute('POST', '/cts/api/generate', { project: pid, module: modB, kind: 'facts', draft: true, replace: true })
	]);
	await callRoute('POST', '/cts/api/generate', { project: pid, module: modA, kind: 'points', replace: true, source_mode: 'facts' });
	await api({ action: 'artifact.approveBatch', project: pid, module: modA, kind: 'points', scope: 'all_pending' });
	await callRoute('POST', '/cts/api/generate', { project: pid, module: modA, kind: 'cases', replace: true, source_mode: 'facts' });

	const loadedA = await api({ action: 'artifacts.load', project: pid, module: modA });
	assert.equal(loadedA.state.cases.items.length, 12, '模块A 应生成 12 条用例');

	// 验证并发池审查（12 条用例，默认 pageSize=5 -> 3 页，concurrency=3 -> 峰值并发必为 3！）
	const t0 = Date.now();
	const revRes = await callRoute('POST', '/cts/api/review', { project: pid, module: modA, stage: 'cases' });
	const elapsed = Date.now() - t0;
	assert.ok(revRes.text.includes('"published":true'), `并发审查必须完整发布结果: ${revRes.text.slice(-200)}`);
	assert.equal(maxConcurrentStreams, 3, `12 条用例（3 页）必须达到 3 路并发审查，实际峰值并发=${maxConcurrentStreams}`);
	assert.ok(elapsed < 230, `3 页 × 80ms 并发应在 <230ms 内完成（串行需 >240ms，旧版 2条/页串行需 >480ms），实际=${elapsed}ms`);

	// 6. 零领域词硬编码守卫检查
	const forbiddenDomainWords = ['G207', 'EV18', '空调压缩机', '远光灯', '近光灯', '后雾灯', '车速表'];
	for (const skillFile of ['cts-facts.md', 'cts-test-design.md', 'cts-case-authoring.md', 'cts-review.md']) {
		const content = fs.readFileSync(new URL(`../skills/${skillFile}`, import.meta.url), 'utf8');
		for (const word of forbiddenDomainWords) {
			assert.ok(!content.includes(word), `通用规则文件 ${skillFile} 严禁包含领域硬编码词: ${word}`);
		}
	}

	console.log(`BATCH_2_AND_3_ALL_ASSERTIONS_PASSED (review 12 cases in ${elapsed}ms, peakConcurrency=${maxConcurrentStreams})`);
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}
