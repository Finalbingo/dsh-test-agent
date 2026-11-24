import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { apply } from '../index.js';

// 资产中心：全局 / 项目 / 模块三层作用域、可见性关闭与软删除。
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-asset-'));
const project = 'P-test';
const module = 'M-main';
const routes = new Map();
const cleanup = [];
let host;
const write = async (file, text = '# asset') => {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text);
};
try {
	await write(path.join(root, 'projects', project, 'project.json'), JSON.stringify({
		id: project, name: '资产测试', modules: [{ id: module, name: '主模块' }],
		quality: { capabilities: ['text'], surfaces: ['页面'], default_surface: '页面', sources: {} }
	}));
	await write(path.join(root, 'projects', project, 'prd', '需求.md'));
	await write(path.join(root, 'projects', project, 'modules', module, 'assets', 'other', '模块补充.md'));
	await write(path.join(root, 'assets', 'global', 'other', '全局模板.md'));
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
	const api = async (action, fields = {}) => (await (await fetch(base + '/cts/api', {
		method: 'POST', body: JSON.stringify({ action, project, module, ...fields })
	})).json());
	let result = await api('assets.tags.view');
	assert.equal(result.ok, true);
	assert.deepEqual(result.state.assets.find((item) => item.path === 'prd/需求.md').tags, ['']);
	result = await api('assets.tags.update', { path: 'prd/需求.md', module, add: true });
	assert.equal(result.ok, true);
	assert.deepEqual(result.state.tags, ['', module]);
	const otherModule = await api('module.create', { project, name: '第二模块' });
	await api('assets.tags.update', { path: 'prd/需求.md', module: otherModule.state.module.id, add: true });
	result = await api('assets.tags.view', { module });
	assert.ok(result.state.assets.find((item) => item.path === 'prd/需求.md').tags.includes(otherModule.state.module.id));
	result = await api('assets.tags.update', { path: 'prd/需求.md', module, add: false });
	assert.deepEqual(result.state.tags, ['', otherModule.state.module.id]);

	result = await api('assets.center');
	assert.equal(result.ok, true);
	assert.ok(result.state.global.some((item) => item.name === '全局模板.md'));
	assert.ok(result.state.global.some((item) => item.kind === 'Skill'));
	assert.deepEqual(result.state.project.map((item) => item.name), ['需求.md']);
	assert.deepEqual(result.state.moduleAssets.map((item) => item.name), ['模块补充.md']);
	assert.equal(result.state.effective.filter((item) => item.scope === 'project').length, 1);

	result = await api('assets.visibility', { path: 'prd/需求.md', visible: false });
	assert.equal(result.ok, true);
	result = await api('assets.center');
	assert.equal(result.state.visibilityDefault, false);
	assert.equal(result.state.project[0].visible, false);
	assert.equal(result.state.effective.some((item) => item.scope === 'project'), false);

	await api('assets.visibility', { path: 'prd/需求.md', visible: true });
	result = await api('assets.center');
	assert.equal(result.state.project[0].visible, true);

	result = await api('assets.trash', { scope: 'module', path: 'other/模块补充.md' });
	assert.equal(result.ok, true);
	assert.equal(fsSync.existsSync(path.join(root, 'projects', project, 'modules', module, 'assets', 'other', '模块补充.md')), false);
	const trash = await api('assets.trashList', { scope: 'module' });
	assert.equal(trash.state.items.length, 1);
	assert.equal(trash.state.items[0].original_path, 'other/模块补充.md');
	await api('assets.restore', { scope: 'module', trash: trash.state.items[0].trash });
	result = await api('assets.center');
	assert.equal(result.state.moduleAssets.length, 1);

	result = await api('assets.transfer', { scope: 'module', target_scope: 'project', path: 'other/模块补充.md', mode: 'copy' });
	assert.equal(result.ok, true);
	result = await api('assets.center');
	assert.equal(result.state.project.length, 2);
	assert.ok(result.state.project.some((item) => item.name === '模块补充.md'));

	result = await api('assets.refs', { path: 'prd/需求.md' });
	assert.equal(result.ok, true);
	assert.equal(result.state.modules[0].visible, true);
	console.log('资产池标签、软删除/恢复、引用与多模块复用通过');
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	for (const dispose of cleanup.reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
}
