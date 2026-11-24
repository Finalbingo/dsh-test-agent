import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { apply } from '../index.js';

// 验收：MCP 直导不依赖 .pix；来源 ID/版本进入当前模块，其他模块不自动选入。
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-mcp-direct-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4GBgYERBgAAtQ0DFf0m8wAAAABJRU5ErkJggg==', 'base64');
const sessions = new Set();
let fake;
let boardName = '首页画板';
let screenshot = png;
let emptyDocument = false;
const routes = new Map();
const cleanup = [];
let host;
const fakeMcp = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (chunk) => { raw += chunk; });
	req.on('end', () => {
		let body = {};
		try { body = JSON.parse(raw || '{}'); } catch {}
		const send = (payload, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };
		if (body.method === 'initialize') {
			const session = 'mcp-test';
			sessions.add(session);
			send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-pixso' }, capabilities: { tools: {} } } }, { 'mcp-session-id': session });
			return;
		}
		if (body.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
		if (body.method === 'tools/list') {
			send({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'eval_script' }, { name: 'get_screenshot' }, { name: 'get_node_dsl' }] } });
			return;
		}
		if (body.method === 'tools/call' && body.params?.name === 'eval_script') {
			const script = String(body.params.arguments?.script || '');
			if (script.includes('pixso.root.children')) {
				send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ name: 'MCP设计稿', fileKey: 'file-mcp', pages: ['page-1'] }) }] } });
				return;
			}
			send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({
				name: 'MCP设计稿', fileKey: 'file-mcp', pageName: '首页', total: emptyDocument ? 0 : 1,
				nodes: emptyDocument ? [] : [{ id: 'node-1', parent: 'page-1', type: 'FRAME', name: boardName, visible: true, box: { x: 0, y: 0, width: 200, height: 100 }, componentKey: '', componentProperties: null, text: '' }]
			}) }] } });
			return;
		}
		if (body.method === 'tools/call' && body.params?.name === 'get_screenshot') {
			send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: screenshot.toString('base64') }] } });
			return;
		}
		send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }] } });
	});
});
try {
	await new Promise((resolve) => fakeMcp.listen(0, '127.0.0.1', resolve));
	const fakeUrl = `http://127.0.0.1:${fakeMcp.address().port}/mcp`;
	apply({
		get: () => undefined,
		effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); },
		webServer: { register: (route) => routes.set(route.path, route.handler) },
		tools: { register() {} }
	}, { dataDir: root, legacyRoot: false, pixsoMcpUrl: fakeUrl });
	host = http.createServer((req, res) => {
		const handler = routes.get(new URL(req.url, 'http://local').pathname);
		Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(error.message));
	});
	await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
	const base = 'http://127.0.0.1:' + host.address().port;
	const api = async (action, fields = {}) => { const result = await (await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({ action, ...fields }) })).json()); assert.ok(result.ok, action + ': ' + JSON.stringify(result)); return result.state; };
	const project = (await api('project.create', { name: 'MCP直导验收', module: '空调' })).project;
	const projectId = project.id;
	const a1 = project.modules[0].id;
	const a2 = (await api('module.create', { project: projectId, name: '香薰' })).module.id;
	// A1 先显式只选 PRD；直导后 PRD 必须保留，只新增设计引用。
	await fs.mkdir(path.join(root, 'projects', projectId, 'prd'), { recursive: true });
	await fs.writeFile(path.join(root, 'projects', projectId, 'prd', '需求.md'), '# 需求\nONLY-PRD-A1');
	await api('evidence.build', { project: projectId });
	const evidenceFile = path.join(root, 'evidence', projectId, 'items.json');
	const beforeImport = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
	const originalPrd = beforeImport.items.find((item) => item.source === 'prd/需求.md');
	originalPrd.location = '已经评审过的原文位置';
	await fs.writeFile(evidenceFile, JSON.stringify(beforeImport));
	const prdView = await api('sources.view', { project: projectId, module: a1 });
	await api('sources.save', { project: projectId, module: a1, version: prdView.version, mode: 'selected', items: [{ path: 'prd/需求.md', role: 'requirement' }] });
	const waitImport = async () => {
		let current;
		for (let i = 0; i < 80; i++) {
			current = await api('design.previewStatus', { project: projectId });
			if (current && !current.running) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return current;
	};
	await api('design.importCurrent', { project: projectId, module: a1 });
	let status = await waitImport();
	assert.equal(status?.phase, 'complete', JSON.stringify(status));
	assert.ok(status.designSource?.source_id && status.designSource?.version, '直导应返回来源 ID/版本');
	assert.equal(status.designSource.module, a1);
	const files = [];
	const walk = async (dir) => { for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) await walk(full); else files.push(full);
	} };
	await walk(path.join(root, 'projects', projectId));
	assert.equal(files.filter((file) => file.endsWith('.pix')).length, 0, 'MCP 直导不能产生 .pix');
	const screenshots = files.filter((file) => file.endsWith('.png'));
	assert.ok(screenshots.length > 0, '应缓存可打开的截图');
	const bytes = await fs.readFile(screenshots[0]);
	assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
	const a1Rows = (await api('sources.resolve', { project: projectId, module: a1 })).rows;
	const a2Rows = (await api('sources.resolve', { project: projectId, module: a2 })).rows;
	const designA1 = a1Rows.find((row) => row.path === `design/${status.designSource.source_id}`);
	const designA2 = a2Rows.find((row) => row.path === `design/${status.designSource.source_id}`);
	assert.ok(designA1?.used, '设计证据应进入当前模块');
	assert.equal(designA1.content_version, status.designSource.version);
	assert.ok(!designA2?.used, '其他模块不能自动选入');
	const prdA1 = a1Rows.find((row) => row.path === 'prd/需求.md');
	assert.ok(prdA1?.used, '直导不能挤掉原有 PRD 选择');
	const afterImport = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
	assert.deepEqual(afterImport.items.find((item) => item.id === originalPrd.id), originalPrd, '只刷新设计证据时不得重算已有的 PRD 定位');
	assert.equal(a1Rows.filter((row) => row.path === `design/${status.designSource.source_id}`).length, 1);
	emptyDocument = true;
	await api('design.importCurrent', { project: projectId, module: a1 });
	const empty = await waitImport();
	assert.equal(empty.phase, 'error');
	assert.match(empty.error, /没有图层/);
	assert.equal((await api('sources.resolve', { project: projectId, module: a1 })).rows
		.find((row) => row.path === designA1.path).content_version, status.designSource.version);
	emptyDocument = false;
	const previousDesign = afterImport.items.find((item) => item.source === designA1.path);
	previousDesign.text = previousDesign.text.replace(/｜runtime_screen/g, '｜FRAME');
	previousDesign.sha256 = (await import('node:crypto')).createHash('sha256').update(previousDesign.text).digest('hex');
	await fs.writeFile(evidenceFile, JSON.stringify(afterImport));
	// 重复导入同稿：模块来源仍一条，版本更新。
	const firstVersion = status.designSource.version;
	await api('design.importCurrent', { project: projectId, module: a1 });
	const repeated = await waitImport();
	const repeatModuleId = repeated.designSource.module;
	assert.equal(repeatModuleId, a1, '重复导入必须仍落发起模块');
	const repeatRows = (await api('sources.resolve', { project: projectId, module: a1 })).rows;
	const repeatDesign = repeatRows.filter((row) => row.path === `design/${repeated.designSource.source_id}`);
	assert.equal(repeatDesign.length, 1, '同稿重复导入只能一条模块来源');
	assert.notEqual(repeatDesign[0].content_version, firstVersion, '新修订应更新版本');
	const equivalent = JSON.parse(await fs.readFile(evidenceFile, 'utf8')).items.find((item) => item.source === designA1.path);
	assert.equal(equivalent.id, previousDesign.id);
	assert.equal(equivalent.sha256, previousDesign.sha256, '原生类型只在页面投影逐字一致时保留旧证据');
	// 移出本轮：设计引用消失，PRD 保留，A2 不变。
	await api('sources.selection.remove', { project: projectId, module: a1, path: repeatDesign[0].path });
	const afterRemove = (await api('sources.resolve', { project: projectId, module: a1 })).rows;
	assert.ok(!afterRemove.find((row) => row.path.startsWith('design/'))?.used, '移出本轮后设计引用应消失');
	assert.ok(afterRemove.find((row) => row.path === 'prd/需求.md')?.used, '移出设计不能移除 PRD');
	assert.ok(!(await api('sources.resolve', { project: projectId, module: a2 })).rows.find((row) => row.path.startsWith('design/'))?.used, '移出不能影响其他模块');
	// 同一界面重新加入。
	await api('design.importCurrent', { project: projectId, module: a1 });
	const readd = await waitImport();
	const readded = (await api('sources.resolve', { project: projectId, module: a1 })).rows.find((row) => row.path === `design/${readd.designSource.source_id}`);
	assert.ok(readded?.used, '重新导入应重新加入当前模块');
	boardName = '第二模块新版画板';
	screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
	await api('design.importCurrent', { project: projectId, module: a2 });
	const secondModule = await waitImport();
	assert.equal(secondModule.designSource.module, a2);
	assert.equal(secondModule.designSource.source_id, readd.designSource.source_id);
	const rowFor = async (module) => (await api('sources.resolve', { project: projectId, module })).rows
		.find((row) => row.path === readded.path);
	const old = await rowFor(a1);
	assert.equal(old.content_version, readd.designSource.version);
	assert.equal(old.used, true, '有索引及证据快照的旧版仍可使用');
	const current = await rowFor(a2);
	assert.equal(current.content_version, secondModule.designSource.version);
	assert.equal(current.used, true);
	const scoped = [a1, a2].map((module) => ({ project: projectId, module, source: readd.designSource.source_id }));
	const dict = [{ board: '首页画板', png }, { board: boardName, png: screenshot }];
	const allPaths = [];
	for (const [i, scope] of scoped.entries()) {
		const { index } = await api('evidence.index', scope);
		const evidence = index.items.find((item) => item.source === readded.path);
		assert.match((await api('evidence.read', { ...scope, id: evidence.id })).text, new RegExp(dict[i].board));
		assert.equal((await api('design.nodeInfo', { ...scope, id: 'node-1' })).name, dict[i].board);
		assert.ok((await api('design.search', { ...scope, query: dict[i].board })).results.some((hit) => hit.name === dict[i].board));
		assert.equal((await api('design.search', { ...scope, query: dict[1 - i].board })).results.length, 0);
		const ui = await api('ui.build', scope);
		assert.equal(ui.sources.find((entry) => entry.id === scope.source)?.revision,
			i === 0 ? old.content_version : current.content_version);
		const { rendered } = await api('design.renderNodes', { ...scope, nodes: ['node-1'], cacheOnly: true });
		const file = path.join(root, 'projects', projectId, rendered['node-1']);
		const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
		assert.equal(sha(await fs.readFile(file)), sha(dict[i].png));
		allPaths.push(file);
	}
	assert.notEqual(...allPaths);
	await fs.unlink(allPaths[0]);
	const missing = await api('design.renderNodes', { ...scoped[0], nodes: ['node-1'] });
	assert.equal(missing.count, 0);
	assert.match(missing.failed['node-1'], /旧版/);
	await fs.unlink(allPaths[1]);
	const goodPng = screenshot;
	screenshot = Buffer.alloc(32);
	await api('design.cachePreviews', scoped[1]);
	const failed = await waitImport();
	assert.equal(failed.failed, 1);
	assert.equal(failed.module, a2);
	assert.equal((await api('activity.list')).items.find((event) => event.run === failed.id).stage, 'partial');
	screenshot = goodPng;
	await api('design.cachePreviews', scoped[1]);
	const repaired = await waitImport();
	assert.equal(repaired.done, 1);
	assert.equal(repaired.failed, 0);
	assert.equal(repaired.module, a2);
	assert.deepEqual(await fs.readFile(allPaths[1]), screenshot);
	assert.equal((await rowFor(a2)).content_version, current.content_version, '补图请求保留当前设计版本');
	const events = (await api('activity.list')).items.filter((event) => event.run === repaired.id);
	assert.deepEqual(events.map((event) => event.stage), ['completed', 'progress', 'started']);
	assert.ok(events.every((event) => event.module === a2 && event.artifact === 'design'));
	assert.equal(await api('design.previewStatus', scoped[0]), null);
	assert.equal((await api('design.previewStatus', scoped[1])).id, repaired.id);
	console.log('PASS MCP 直导：0 .pix、截图可打开、PRD保留、来源ID/版本进当前模块、其他模块不选入、重复导入单来源、移出/重加');
	console.log('PASS 同稿双模块选择：分别读到版本原文、节点、对应图片 SHA，旧版截图缺失时禁止用新版');
} finally {
	await new Promise((resolve) => host ? host.close(resolve) : resolve());
	await new Promise((resolve) => fakeMcp.close(resolve));
	for (const dispose of cleanup.reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
}
