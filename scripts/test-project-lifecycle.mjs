import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

// M1 可用性改造：项目创建、质量声明校验、改名、模块管理与永久删除。
// 目标不是验证生成质量，而是保证“新建项目入口链”不会在 API 层断掉。
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-project-'));
const routes = new Map();
let host;
const cleanup = [];
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
	let project = '';
	const api = async (action, fields = {}) => {
		const response = await fetch(base + '/cts/api', {
			method: 'POST',
			body: JSON.stringify({ action, project: project || undefined, module: 'M-main', ...fields })
		});
		const result = await response.json();
		return { status: response.status, ...result };
	};
	const assertOk = (result, label) => {
		assert.equal(result.ok, true, label + ': ' + JSON.stringify(result));
		return result.state;
	};

	const created = assertOk(await api('project.create', { name: 'M1 生命周期验收', module: '空调' }), '创建项目');
	project = created.project.id;
	assert.equal(created.project.modules[0].name, '空调');

	const missing = assertOk(await api('project.diagnose'), '新项目诊断');
	assert.ok(missing.issues.some((issue) => issue.code === 'QUALITY_MISSING'));

	const badSource = await api('project.update', { quality: { capabilities: ['text'], surfaces: ['主界面'], default_surface: '主界面', sources: { prd: 'prd/不存在.md' } } });
	assert.equal(badSource.ok, false);
	assert.match(String(badSource.error), /来源文件不存在/);

	await fs.mkdir(path.join(root, 'projects', project, 'prd'), { recursive: true });
	await fs.writeFile(path.join(root, 'projects', project, 'prd', '需求.md'), '# 测试需求\n');
	const saved = assertOk(await api('project.update', { quality: { capabilities: ['text'], surfaces: ['主界面', '列表页'], default_surface: '主界面', sources: { prd: 'prd/需求.md' } } }), '保存质量声明');
	assert.deepEqual(saved.project.quality.surfaces, ['主界面', '列表页']);
	const diagnosed = assertOk(await api('project.diagnose'), '质量声明诊断');
	assert.equal(diagnosed.issues.length, 0);

	const renamed = assertOk(await api('project.update', { name: 'M1 生命周期验收（改名）' }), '项目改名');
	assert.equal(renamed.project.name, 'M1 生命周期验收（改名）');

	const moduleCreated = assertOk(await api('module.create', { name: '第二模块', keywords: ['第二'] }), '新增模块');
	const moduleId = moduleCreated.module.id;
	assert.equal(assertOk(await api('module.update', { id: moduleId, name: '第二模块改' }), '模块改名').module.name, '第二模块改');
	assert.ok(!assertOk(await api('module.delete', { id: moduleId }), '删除模块').modules.some((item) => item.id === moduleId));

	await fs.mkdir(path.join(root, 'artifacts', project, 'M-main'), { recursive: true });
	await fs.mkdir(path.join(root, 'evidence', project), { recursive: true });
	assertOk(await api('project.delete'), '删除项目');
	assert.equal(fsSync.existsSync(path.join(root, 'projects', project)), false);
	assert.equal(fsSync.existsSync(path.join(root, 'artifacts', project)), false);
	assert.equal(fsSync.existsSync(path.join(root, 'evidence', project)), false);
	assert.ok(!assertOk(await api('state'), '删除后列表').projects.some((item) => item.id === project));

	console.log('项目创建、质量声明校验、改名、模块管理与永久删除通过');
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	for (const dispose of cleanup.reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
}
