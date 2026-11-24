import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { apply } from '../index.js';
import { PixsoMcp } from '../design-mcp.js';
import { layerChildren, layerSources } from '../design.js';
import { save } from '../artifacts.js';
import { saveBindings } from '../bindings.js';

const pix = process.argv[2];
if (!pix) throw new Error('打开 Pixso 中的 V5-深浅后，传入对应的 .pix 文件路径');
const live = await new PixsoMcp(undefined, 12000).connect();
const identity = await live.callTool('eval_script', { script: 'return {name:pixso.root.name,pages:pixso.root.children.map(p=>p.id)};' });
const doc = JSON.parse(identity.content[0].text);
assert.equal(doc.name, 'V5-深浅');
const board = '3204:113780';
const closedBoard = '3825:88005';
const [png, closedPng] = await Promise.all([board, closedBoard].map(async (id) => (await live.screenshot(id, { scale: 1 })).buffer));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-preview-test-'));
const project = 'P-test';
const dir = path.join(root, 'projects', project);
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ id: project }));

let wrong = false;
let down = false;
let shots = 0;
let received = [];
let fallbackDownloads = 0;
const mock = http.createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/export/preview.png') {
		fallbackDownloads++;
		res.setHeader('content-type', 'image/png');
		return res.end(png);
	}
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const rpc = JSON.parse(Buffer.concat(chunks));
	if (down) return res.writeHead(503).end();
	let result = {};
	if (rpc.params?.name === 'eval_script') {
		result = { content: [{ type: 'text', text: JSON.stringify(wrong ? { ...doc, name: 'Wrong file' } : doc) }] };
	}
	if (rpc.params?.name === 'get_screenshot') {
		if (rpc.params.arguments.guid === board) {
			result = { isError: true, content: [{ type: 'text', text: 'Failed to get image: undefined' }] };
			return res.end(JSON.stringify({ result }));
		}
		if (++shots === 2) wrong = true;
		const image = rpc.params.arguments.guid === closedBoard ? closedPng : png;
		result = { content: [{ type: 'image', data: image.toString('base64') }] };
	}
	if (rpc.params?.name === 'get_export_image') {
		if (++shots === 2) wrong = true;
		result = { content: [{ type: 'text', text: `http://localhost:${mock.address().port}/export/preview.png\nTemporary URL` }] };
	}
	res.end(JSON.stringify({ result }));
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));

const cases = [
	{ point_id: 'T-0001', title: '控件定位', steps: ['点击【空调按钮】'], expected: '检查空调状态' },
	{ point_id: 'T-0002', title: '关闭态', steps: ['观察空调界面【空调（浅色）（关闭）】'], expected: '显示设计稿【空调（浅色）（关闭）】中的关闭外观' },
	{ point_id: 'T-0003', title: '信号', steps: ['发送报文'], expected: '检查 HVAC_AUTO' },
	{ point_id: 'T-0004', title: '待补图', steps: ['观察空调界面主面板'], expected: '显示开启状态的空调主面板' }
];
const llm = {
	listProviders: () => [{ id: 'test' }],
	listModels: async () => [{ id: 'test' }],
	resolveModelInfo: async () => ({ inputModalities: ['image'] }),
	async *stream(request) {
		const content = request.messages[0].content;
		received = content.flatMap((item, index) => item.type === 'image' ? [content[index - 1]?.text] : []);
		yield { type: 'text-delta', text: JSON.stringify({ cases }) };
	}
};
const routes = new Map();
const cleanup = [];
apply({
	get: (name) => name === 'llm' ? llm : name === 'attachments' ? {
		saveImages: async (images) => images.map((_, index) => ({ attachmentId: String(index) }))
	} : undefined,
	effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); },
	webServer: { register: (route) => routes.set(route.path, route.handler) },
	tools: { register() {} }
}, { dataDir: root, legacyRoot: false, pixsoMcpUrl: 'http://127.0.0.1:' + mock.address().port + '/mcp' });

const host = http.createServer((req, res) => {
	const handler = routes.get(new URL(req.url, 'http://local').pathname);
	Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(error.message));
});
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + host.address().port;
async function api(action, fields = {}) {
	const response = await fetch(origin + '/cts/api', { method: 'POST', body: JSON.stringify({ project, action, ...fields }) });
	const result = await response.json();
	assert.ok(result.ok, JSON.stringify(result));
	return result.state;
}
async function completed() {
	for (let index = 0; index < 500; index++) {
		const job = await api('design.previewStatus');
		if (job && !job.running) return job;
		await pause(150);
	}
	throw new Error('截图任务超时');
}

try {
	const upload = await fetch(origin + '/cts/api/upload', {
		method: 'POST',
		headers: { 'x-project': project, 'x-dir': 'design', 'x-filename': encodeURIComponent(path.basename(pix)) },
		body: await fs.readFile(pix)
	});
	assert.equal(upload.status, 200);
	assert.equal((await api('design.previewStatus')).phase, 'compile');
	const interrupted = await completed();
	assert.equal(interrupted.done, 1, JSON.stringify(interrupted));
	assert.match(interrupted.error, /已切换/);
	console.log('PASS upload starts caching and rejects screenshot after document switch');

	const attempts = shots;
	wrong = false;
	await api('design.cachePreviews');
	const job = await completed();
	assert.equal(job.done, job.total, JSON.stringify(job));
	assert.ok(job.total > 20);
	assert.equal(shots - attempts, job.total - 1);
	assert.ok(fallbackDownloads > 0);
	console.log('PASS resume skips cached images, ' + job.done + ' layers');

	down = true;
	const [source] = layerSources(root, project);
	const preview = await api('design.renderNodes', { source: source.id, nodes: [board] });
	const image = await fetch(origin + '/cts/file?path=' + encodeURIComponent(project + '/' + preview.rendered[board]));
	assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
	const child = layerChildren(root, project, board, source.id)
		.find((node) => node.visible && node.width > 0 && node.height > 0 && node.width < 1500);
	assert.ok(child);
	const facts = cases.map((_, index) => ({ fact_id: 'F-000' + (index + 1), statement: '空调' }));
	const points = cases.map((item, index) => ({
		point_id: item.point_id, requirement: '空调', condition: '上电', action: item.steps[0],
		expected: item.expected, type: '状态显示', priority: 'P1', fact_refs: [facts[index].fact_id]
	}));
	await save(root, project, 'points', { items: points });
	await save(root, project, 'facts', { items: facts });
	const bind = (index, kind, name, target) => ({
		status: 'bound', kind, subject: { name, fact_ids: [facts[index].fact_id] }, target
	});
	saveBindings(root, project, [
		bind(0, 'control', '空调按钮', { node_id: child.id, source_id: source.id }),
		bind(1, 'control', '空调（浅色）（关闭）', { node_id: closedBoard, source_id: source.id }),
		bind(2, 'signal', 'HVAC_AUTO', { name: 'HVAC_AUTO', message: 'HVAC', message_id: '0x501', min: 0, max: 1, source: 'test.dbc' })
	]);
	const generation = await fetch(origin + '/cts/api/generate', {
		method: 'POST', body: JSON.stringify({ project, kind: 'cases' })
	});
	const stream = await generation.text();
	assert.ok(!stream.includes('event: error'), stream);
	assert.match(stream, /"missingImages":1/);
	assert.ok(received.some((item) => item?.startsWith('T-0001 · 操作定位 · ')), JSON.stringify(received));
	assert.ok(received.some((item) => item?.startsWith('T-0002 · 预期界面参考 · ')), JSON.stringify(received));
	assert.ok(received.some((item) => item?.startsWith('T-0003 · 信号参考 · ')), JSON.stringify(received));
	const { cases: { items } } = await api('artifacts.load');
	assert.equal(items[0].image_refs.length, 2);
	assert.equal(items[0].image_refs[0].step, 1);
	assert.equal(items[1].image_refs[0].role, '预期界面参考');
	assert.equal(items[2].image_refs[0].role, '信号参考');
	const edit = await api('cases.images', { id: items[3].case_id, node: board, step: 1, role: '预期界面参考' });
	assert.ok(edit.item.image_refs[0].manual);
	console.log('PASS offline preview, model image input, step references and manual addition');

	const workbook = await api('artifacts.export');
	execFileSync('python3', ['-c',
		'import sys,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(sys.argv[1]); d=E.fromstring(z.read("xl/drawings/drawing1.xml")); assert [int(a.text) for a in d.findall("./{*}oneCellAnchor/{*}from/{*}row")]==[1,1,2,3,4]; assert sum(n.startswith("xl/media/") for n in z.namelist())==5; print("PASS 5 embedded Excel pictures")',
		workbook.file], { stdio: 'inherit' });
	await fetch(origin + '/cts/api/upload', {
		method: 'POST',
		headers: { 'x-project': project, 'x-dir': 'design', 'x-filename': 'invalid.pix' },
		body: 'not a Pixso archive'
	});
	const failedCompile = await completed();
	assert.equal(failedCompile.compiled, false);
	assert.equal(layerSources(root, project)[0].revision, source.revision);
	assert.deepEqual((await api('design.renderNodes', { source: source.id, nodes: [board] })).rendered, preview.rendered);
	console.log('PASS invalid upload preserves previous index and offline images');
} finally {
	cleanup.forEach((dispose) => dispose());
	host.closeAllConnections();
	host.close();
	mock.closeAllConnections();
	mock.close();
	await fs.rm(root, { recursive: true, force: true });
}
