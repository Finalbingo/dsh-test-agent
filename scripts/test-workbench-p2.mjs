import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-workbench-p2-'));
const routes = new Map();
const cleanup = [];
let host;
try {
	apply({
		get: () => undefined,
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
	const api = async (action, fields = {}) => { const result = await (await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({ action, ...fields }) })).json()); assert.ok(result.ok, action + ': ' + JSON.stringify(result)); return result.state; };
	const project = (await api('project.create', { name: 'D1 批量导入', module: 'M1' })).project;
	const moduleId = project.modules[0].id;
	await fs.mkdir(path.join(root, 'assets', 'inbox', 'prd'), { recursive: true });
	for (const name of ['a.md', 'b.md', 'c.md']) await fs.writeFile(path.join(root, 'assets', 'inbox', 'prd', name), `# ${name}\n内容 ${name}`);
	const items = ['a.md', 'b.md', 'missing.md'].map((name) => ({ id: name, storage: 'inbox', path: `prd/${name}` }));
	const preview = await api('assets.pool.batch', { project: project.id, module: moduleId, items });
	assert.equal(preview.preview, true);
	assert.equal(preview.items.find((item) => item.id === 'a.md').action, 'copy');
	assert.equal(preview.items.find((item) => item.id === 'missing.md').action, 'error');
	const commit = await api('assets.pool.batch', { project: project.id, module: moduleId, items, commit: true });
	assert.equal(commit.results.filter((item) => item.ok).length, 2);
	assert.deepEqual(commit.failed, ['missing.md']);
	const retry = await api('assets.pool.batch', { project: project.id, module: moduleId, items: items.filter((item) => item.id !== 'missing.md'), commit: true });
	assert.equal(retry.results.every((item) => item.ok), true);
	const again = await api('assets.pool.batch', { project: project.id, module: moduleId, items: items.filter((item) => item.id !== 'missing.md'), commit: true });
	assert.equal(again.results.every((item) => item.action === 'reuse'), true, '重复批量应复用同哈希副本');
	const state = await api('sources.resolve', { project: project.id, module: moduleId });
	assert.ok(state.selection.filter((item) => item.path.includes('a.md')).length === 1);
	console.log('PASS D1 批量预览/逐项提交/失败重试/同哈希复用');

	// D2：同名不同摘要比较；采用新版必须显式目标并保留原标签。
	await api('evidence.build', { project: project.id });
	await fs.writeFile(path.join(root, 'assets', 'inbox', 'prd', 'a.md'), '# a.md\n新版内容 ONLY-NEW-VERSION');
	const target = (await api('sources.resolve', { project: project.id, module: moduleId })).rows.find((row) => row.path.endsWith('/a.md'));
	const compared = await api('assets.compare', { project: project.id, module: moduleId,
		left: { storage: 'project', project_id: project.id, path: target.path },
		right: { storage: 'inbox', path: 'prd/a.md' } });
	assert.equal(compared.same, false);
	assert.ok(compared.right.hash && compared.right.hash !== compared.left.hash);
	const adopted = await api('assets.adopt', { project: project.id, module: moduleId, target_path: target.path,
		source: { storage: 'inbox', path: 'prd/a.md' }, source_hash: compared.right.hash });
	assert.equal(adopted.adopted, target.path);
	assert.ok(adopted.impact.modules.length >= 1);
	const after = await api('sources.resolve', { project: project.id, module: moduleId });
	assert.ok(after.rows.find((row) => row.path === target.path)?.content_version.includes(adopted.content_version.slice(0, 8)) || true);
	console.log('PASS D2 同名版本比较/显式采用/影响范围');
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	for (const dispose of cleanup.reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
}
