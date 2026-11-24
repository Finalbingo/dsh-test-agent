import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

// P0 工作台流程验收：同名来源隔离、显式空范围、导入版本与选择记录。
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-workbench-p0-'));
const routes = new Map();
const cleanup = [];
let host;
let seenPrompt = '';
let evidenceBuilds = 0;
const llm = {
	listProviders: () => [{ id: 'test' }],
	listModels: async () => [{ id: 'test' }],
	resolveModelInfo: async () => ({ inputModalities: ['text'] }),
	async *stream(request) {
		seenPrompt = JSON.stringify(request.messages);
		yield { type: 'text-delta', text: JSON.stringify({ facts: [
			{ statement: '本模块提取到需求事实', type: 'rule', evidence_refs: ['E-0001'] }
		] }) };
	}
};
try {
	apply({
		get: (name) => name === 'llm' ? llm : undefined,
		effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); },
		webServer: { register: (route) => routes.set(route.path, route.handler) },
		tools: { register() {} }
	}, { dataDir: root, legacyRoot: false });
	host = http.createServer((req, res) => {
		const handler = routes.get(new URL(req.url, 'http://local').pathname);
		Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(error.message));
	});
	await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
	const base = 'http://127.0.0.1:' + host.address().port;
	const raw = async (action, fields = {}) => (await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({ action, ...fields }) })).json());
	const api = async (action, fields = {}) => {
		const result = await raw(action, fields);
		assert.ok(result.ok, action + ': ' + JSON.stringify(result));
		return result.state;
	};
	const projectA = (await api('project.create', { name: 'A', module: 'A1' })).project;
	const projectB = (await api('project.create', { name: 'B', module: 'B1' })).project;
	const a1 = projectA.modules[0].id;
	const a2 = (await api('module.create', { project: projectA.id, name: 'A2' })).module.id;
	const a3 = (await api('module.create', { project: projectA.id, name: '空模块' })).module.id;
	const b1 = projectB.modules[0].id;
	const projectC = (await api('project.create', { name: 'C-empty', module: 'C1' })).project;
	const c1 = projectC.modules[0].id;
	const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
	for (const [project, module, name, text] of [
		[projectA, a1, 'A1.md', '# A1\nONLY-A1 需求正文'],
		[projectA, a2, 'A2.md', '# A2\nONLY-A2 需求正文'],
		[projectA, a1, 'shared.md', '# 共享\nSHARED-BYTES 两份相同'],
		[projectA, a2, 'shared.md', '# 共享\nSHARED-BYTES 两份相同'],
		[projectB, b1, 'shared-b.md', '# 共享\nSHARED-BYTES 两份相同']
	]) {
		const inbox = path.join(root, 'assets', 'inbox', 'prd', `${project.id}-${module}-${name}`);
		await write(inbox, text);
		const imported = await api('assets.pool.import', { project: project.id, module, storage: 'inbox', path: path.relative(path.join(root, 'assets', 'inbox'), inbox) });
		assert.equal(imported.project, project.id);
	}
	// 旧文件不走导入，只靠历史共享标签迁移；解析失败文件也要出现在资料页。
	await write(path.join(root, 'projects', projectA.id, 'prd', 'legacy.md'), '# 旧共享\nLEGACY-ONLY');
	await write(path.join(root, 'projects', projectA.id, 'prd', 'broken.pdf'), 'not a pdf');
	await api('evidence.build', { project: projectA.id });
	evidenceBuilds += 1;
	const resolveA1 = await api('sources.resolve', { project: projectA.id, module: a1 });
	const byPathA1 = new Map(resolveA1.rows.map((row) => [row.path, row]));
	const shared = [...byPathA1.values()].find((row) => row.path.includes('shared'));
	assert.ok(shared, '共享文件应出现在 A1');
	assert.ok(byPathA1.get('prd/legacy.md')?.selected, '历史共享文件应可见并标明来源');
	assert.ok(resolveA1.rows.some((row) => row.path === 'prd/broken.pdf' && /解析失败/.test(row.exclusion || '')));
	const a2rows = (await api('sources.resolve', { project: projectA.id, module: a2 })).rows;
	assert.ok(!a2rows.some((row) => row.path.includes('A1.md') && row.used), 'A2 不应使用 A1 唯一资料');
	const a1rows = resolveA1.rows;
	assert.ok(!a1rows.some((row) => row.path.includes('A2.md') && row.used), 'A1 不应使用 A2 唯一资料');
	assert.equal((await api('sources.resolve', { project: projectC.id, module: c1 })).counts.used, 0, '空项目模块可用资料数必须为 0');

	// 生成调用实际读取 A1 证据，不能只信卡片。
	const generation = await (await fetch(base + '/cts/api/generate', { method: 'POST', body: JSON.stringify({ project: projectA.id, module: a1, kind: 'facts', draft: true }) })).text();
	assert.match(generation, /event: run\.end/);
	assert.match(seenPrompt, /ONLY-A1/);
	assert.doesNotMatch(seenPrompt, /ONLY-A2/);
	console.log('PASS A1 跨模块唯一标记、历史共享、解析失败和显式空范围');

	// A3：修改一个文件的选用状态时，其他文件的用途/版本不能被抹掉；显式空范围仍为 selected。
	const roleView = await api('sources.view', { project: projectA.id, module: a1 });
	const sharedRow = roleView.materials.find((row) => row.path === shared.path);
	const legacyRow = roleView.materials.find((row) => row.path === 'prd/legacy.md');
	assert.ok(sharedRow && legacyRow);
	await api('sources.save', { project: projectA.id, module: a1, version: roleView.version, mode: 'selected', items: [
		{ path: sharedRow.path, role: 'requirement' }, { path: legacyRow.path, role: 'reference' }
	] });
	await api('assets.visibility', { project: projectA.id, module: a1, path: sharedRow.path, visible: false });
	const afterHide = await api('sources.view', { project: projectA.id, module: a1 });
	const preserved = afterHide.materials.find((row) => row.path === legacyRow.path);
	assert.equal(preserved.role, 'reference', '隐藏其他文件不应覆盖 reference 用途');
	assert.equal(afterHide.materials.find((row) => row.path === sharedRow.path)?.selected, false);
	console.log('PASS A3 可见性修改保留其他资料用途');

	// A4：配置建议只取本模块有效来源；多来源给候选，不静默借用 A2。
	const a1Only = (await api('sources.resolve', { project: projectA.id, module: a1 })).rows.find((row) => row.path.includes('A1.md'));
	const a1View = await api('sources.view', { project: projectA.id, module: a1 });
	await api('sources.save', { project: projectA.id, module: a1, version: a1View.version, mode: 'selected', items: [{ path: a1Only.path, role: 'requirement' }] });
	const ambiguous = await api('project.autoConfig', { project: projectA.id, module: a1 });
	assert.ok(ambiguous.candidates.prd.length >= 1);
	const configuredA1 = await api('project.autoConfig', { project: projectA.id, module: a1 });
	assert.equal(configuredA1.quality.sources.prd, a1Only.path);
	assert.ok(!String(configuredA1.quality.sources.prd).includes('A2'));
	const a2View = await api('sources.view', { project: projectA.id, module: a2 });
	const a2Only = (await api('sources.resolve', { project: projectA.id, module: a2 })).rows.find((row) => row.path.includes('A2.md'));
	await api('sources.save', { project: projectA.id, module: a2, version: a2View.version, mode: 'selected', items: [{ path: a2Only.path, role: 'requirement' }] });
	const a2Auto = await api('project.autoConfig', { project: projectA.id, module: a2 });
	assert.ok(String(a2Auto.quality.sources.prd).includes('A2'));
	assert.notEqual(a2Auto.quality.sources.prd, configuredA1.quality.sources.prd);
	// 手工覆盖指向已移出的来源时必须标失效，而不是继续当默认值。
	const staleOverride = await api('project.update', { project: projectA.id, quality: { ...configuredA1.quality, sources: { ...configuredA1.quality.sources, prd: 'prd/legacy.md' } } });
	assert.equal(staleOverride.project.quality.sources.prd, 'prd/legacy.md');
	const repairedConfig = await api('project.autoConfig', { project: projectA.id, module: a1 });
	assert.equal(repairedConfig.quality.sources.prd, a1Only.path);
	assert.ok(repairedConfig.invalid_overrides.some((item) => item.path === 'prd/legacy.md'));
	console.log('PASS A4 模块来源配置建议与失效覆盖');

	// 显式空范围必须保持 selected，而不是回退 all。
	const view = await api('sources.view', { project: projectA.id, module: a1 });
	await api('sources.save', { project: projectA.id, module: a1, version: view.version, mode: 'selected', items: [] });
	assert.equal((await api('sources.resolve', { project: projectA.id, module: a1 })).counts.used, 0, '显式空范围应为 0');
	await api('sources.save', { project: projectA.id, module: a1, version: (await api('sources.view', { project: projectA.id, module: a1 })).version, mode: 'selected', items: [{ path: shared.path, role: 'requirement' }] });
	assert.ok((await api('sources.resolve', { project: projectA.id, module: a1 })).counts.used >= 1);

	// 连续导入两次：同哈希复用，一条本轮引用。
	const inbox = path.join(root, 'assets', 'inbox', 'prd', 'repeat.md');
	await write(inbox, '# repeat\nONLY-REPEAT');
	const first = await api('assets.pool.import', { project: projectA.id, module: a1, storage: 'inbox', path: 'prd/repeat.md' });
	const second = await api('assets.pool.import', { project: projectA.id, module: a1, storage: 'inbox', path: 'prd/repeat.md' });
	assert.equal(first.path, second.path);
	await api('evidence.build', { project: projectA.id, module: a1 });
	const importedScope = await api('sources.resolve', { project: projectA.id, module: a1 });
	assert.ok(importedScope.rows.find((item) => item.path === first.path)?.used, '显式范围下用于本轮的资料应参与解析');
	assert.ok(importedScope.rows.find((item) => item.path === shared.path)?.used, '新加入资料不能清空原范围');
	const selection = (await api('sources.resolve', { project: projectA.id, module: a1 })).selection;
	assert.equal(selection.filter((item) => item.path === first.path).length, 1, '同资产本轮引用只能一条');
	const mismatch = await raw('assets.pool.import', { project: projectA.id, module: a1, storage: 'inbox', path: 'prd/repeat.md', asset_hash: 'bad' });
	assert.equal(mismatch.ok, false);
	assert.match(mismatch.error, /版本/);
	console.log('PASS A2 重复导入去重、版本校验与本轮选择');

	// P0-2 B1/B2：空模块和缺上游都返回同一套 phase/blockers/next_action。
	const emptyState = await api('workbench.state', { project: projectC.id, module: c1 });
	assert.equal(emptyState.phase, 'materials');
	assert.equal(emptyState.next_action.id, 'select_materials');
	assert.ok(emptyState.blockers.some((item) => item.code === 'MATERIAL_SOURCE_MISSING'));
	const upstreamState = await api('workbench.state', { project: projectA.id, module: a1 });
	assert.equal(upstreamState.next_action.id, 'generate_upstream');
	assert.equal(upstreamState.phase, 'upstream');
	console.log('PASS B1/B2 统一状态：空资料与缺上游的 next_action/blockers');

	// A3 补充：回收站恢复要按原身份恢复标签，不能变成未分配。
	const trashTarget = (await api('sources.resolve', { project: projectA.id, module: a1 })).selection[0];
	assert.ok(trashTarget, '应有本轮选择用于回收站测试');
	const trashed = await api('assets.trash', { project: projectA.id, module: a1, scope: 'project', path: trashTarget.path });
	const restored = await api('assets.restore', { project: projectA.id, module: a1, scope: 'project', trash: trashed.trash });
	assert.deepEqual(restored.tags, [a1], '恢复后应保留原模块标签');
	const afterRestore = (await api('sources.resolve', { project: projectA.id, module: a1 })).rows.find((row) => row.path === trashTarget.path);
	assert.ok(afterRestore?.tag_scope === 'module', '恢复后仍应是模块标签');
	console.log('PASS A3 回收站恢复原标签身份');
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	for (const dispose of cleanup.reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
}
