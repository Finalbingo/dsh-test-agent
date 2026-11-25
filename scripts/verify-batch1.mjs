import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import * as pluginModule from '../index.js';
import { parseXlsx } from '../parsers/xlsx.js';

const activate = pluginModule.activate || pluginModule.register || Object.values(pluginModule).find((v) => typeof v === 'function');
assert.equal(typeof activate, 'function', 'index.js 必须导出插件激活入口函数');

// 1. 验证 client.js Markdown 块级防碎表搜索 & 相对路径图片安全解析
const scriptSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const fnStart = scriptSrc.indexOf('const INLINE =');
const fnEnd = scriptSrc.indexOf('function SkillManager()');
const mdModuleFn = new Function('h', scriptSrc.slice(fnStart, fnEnd) + '\nreturn { markdown, filterMarkdownByQuery };');
const { markdown, filterMarkdownByQuery } = mdModuleFn((tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() }));

const sampleMd = `---
title: 需求文档
---
# 第一章 信号表

| 信号名 | 取值 | 说明 |
| --- | --- | --- |
| Sig_Alpha | 0x0 | 关闭 |
| Sig_Beta | 0x1 | 开启高亮 |

![架构图](./imgs/arch.png)
![越界图](../secret.png)
`;
const filteredMd = filterMarkdownByQuery(sampleMd, 'sig_beta');
assert.ok(filteredMd.includes('| 信号名 | 取值 | 说明 |'), 'Markdown 搜索过滤必须保留表头');
assert.ok(filteredMd.includes('Sig_Beta'), 'Markdown 搜索过滤必须保留命中行');
assert.ok(!filteredMd.includes('Sig_Alpha'), 'Markdown 搜索过滤应剔除未命中行');
const renderedFiltered = markdown(filteredMd, { scope: 'project', project: 'P-1', dir: 'prd' });
assert.ok(renderedFiltered.some((n) => n.tag === 'div' && n.props.className === 'cts-table-wrap'), '过滤后仍必须渲染为完整表格组件而非碎文本');

const renderedFull = markdown(sampleMd, { scope: 'project', project: 'P-1', dir: 'prd' });
const fullJson = JSON.stringify(renderedFull);
assert.ok(fullJson.includes('/cts/file?project=P-1&path=prd%2Fimgs%2Farch.png'), '相对路径图片应自动解析为 /cts/file');
assert.ok(!fullJson.includes('secret.png","alt"'), '包含 .. 的越界图片必须被安全拦截不渲染为 img');

// 2. 内存级沙盒路由仿真验证 P0-1 / P0-2 / P0-3 / .doc 预览 / agent.status
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-b1-'));
const routes = new Map();
let toolRound = 0;

const mockCase = (title = '修复后开启测试') => ({
	point_id: 'T-0001',
	case_role: 'primary',
	title,
	type: '功能',
	priority: 'P0',
	precondition: '系统处于运行模式；主控页面可见',
	prepare_items: [{ key: 'p1', text: '确认初始状态', object: '功能开关', target: '关闭', establish: '在主控页面核对状态', read_back: '在主控页面观察【功能开关】为关闭', on_failure: '停止' }],
	steps: [
		{ key: 's1', role: 'action', text: '在主控页面单击一次【功能开关】' },
		{ key: 's2', role: 'observe', text: '在主控页面观察【功能开关】，记录状态' }
	],
	expected_items: [
		{ key: 'e1', assertion_ref: '', trigger: 's1', observe: 's2', object: '功能开关', target: '切换为开启状态', kind: 'ui_immediate', evidence_ref: 'F-0001', frames: 0, since: '', delay_s: 0, unresolved: '' }
	],
	restore_items: [{ key: 'r1', text: '在主控页面单击【功能开关】恢复关闭', baseline: 'p1', read_back: '在主控页面观察【功能开关】为关闭', on_failure: '停止' }],
	deferred_items: [],
	failure_policy: '截图记录',
	basis: 'F-0001'
});

let genCall = 0;
const mockLlm = {
	listProviders: () => [{ id: 'mock' }],
	listModels: async () => [{ id: 'mock-1' }],
	stream: async function* ({ messages }) {
		const allStr = JSON.stringify(messages);
		// Chat copilot call
		if (allStr.includes('TEST_EXPORT_ZENTAO') || allStr.includes('TEST_IMPACT') || allStr.includes('TEST_REPAIR')) {
			if (allStr.includes('TEST_EXPORT_ZENTAO')) {
				if (toolRound++ === 0) yield { type: 'text-delta', text: JSON.stringify({ tool: 'delivery.export', args: { template: 'zentao' } }) };
				else yield { type: 'text-delta', text: '导出完成' };
			} else if (allStr.includes('TEST_IMPACT')) {
				if (toolRound++ === 0) yield { type: 'text-delta', text: JSON.stringify({ tool: 'impact.analyze', args: {} }) };
				else yield { type: 'text-delta', text: '分析完成' };
			} else if (allStr.includes('TEST_REPAIR')) {
				if (toolRound++ === 0) yield { type: 'text-delta', text: JSON.stringify({ tool: 'review.batch_repair', args: { limit: 3 } }) };
				else yield { type: 'text-delta', text: '修复完成' };
			}
			yield { type: 'finish', reason: { kind: 'stop' } };
			return;
		}
		if (allStr.includes('独立审查（cts-review）')) {
			yield { type: 'text-delta', text: JSON.stringify({ receipts: [{ case_id: 'C-0001', conclusion: '待修改', findings: [{ code: 'STEP_NOT_OPERABLE', field: 'steps[0]', message: '步骤需补充页面定位' }] }] }) };
			yield { type: 'finish', reason: { kind: 'stop' } };
			return;
		}
		if (allStr.includes('测试点设计（cts-test-design）')) {
			yield { type: 'text-delta', text: JSON.stringify({ points: [{ requirement: '开启测试', condition: '系统处于运行模式；功能开关关闭', action: '在主控页面单击【功能开关】', expected: '主控页面【功能开关】切换为开启状态', type: '功能', priority: 'P0', fact_refs: ['F-0001'] }] }) };
			yield { type: 'finish', reason: { kind: 'stop' } };
			return;
		}
		if (allStr.includes('可执行测试用例编写（cts-case-authoring）')) {
			genCall += 1;
			yield { type: 'text-delta', text: JSON.stringify({ cases: [mockCase(genCall === 1 ? '初始开启测试' : '审查修复后开启测试')] }) };
			yield { type: 'finish', reason: { kind: 'stop' } };
			return;
		}
		yield { type: 'text-delta', text: JSON.stringify({ facts: [{ statement: '在主控页面单击功能开关可开启功能', type: '行为', source: { evidence_id: 'E-0001', quote: '当在主控页面单击【功能开关】时，功能开关切换为开启状态。' }, evidence_refs: ['E-0001'] }] }) };
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
	assert.ok(handler, `Route not found: ${u.pathname}`);
	const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : Buffer.alloc(0);
	const req = Object.assign(Readable.from(payload.length ? [payload] : []), {
		method,
		url: u.pathname + u.search,
		headers: { 'content-type': 'application/json' }
	});
	const chunks = [];
	let statusCode = 200;
	const headers = {};
	let resolveDone;
	const done = new Promise((r) => { resolveDone = r; });
	const res = {
		get statusCode() { return statusCode; },
		set statusCode(v) { statusCode = v; },
		destroyed: false,
		writableEnded: false,
		setHeader(k, v) { headers[k.toLowerCase()] = v; },
		writeHead(c, h) { statusCode = c; if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v; },
		write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; },
		end(c) { if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); this.writableEnded = true; resolveDone(); },
		once() {}
	};
	await handler(req, res);
	await done;
	return { statusCode, headers, buf: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') };
};

const api = async (b) => JSON.parse((await callRoute('POST', '/cts/api', b)).text);

try {
	const created = await api({ action: 'project.create', name: 'B1Verify', firstModule: '默认模块' });
	const pid = created.state.project.id;
	const mid = created.state.project.modules[0].id;

	const prdDir = path.join(tmpDir, 'projects', pid, 'prd');
	fs.mkdirSync(prdDir, { recursive: true });

	// 验证 .doc 二进制 Word 预览
	const txtTmp = path.join(tmpDir, 'sample.txt');
	const docFile = path.join(prdDir, 'legacy.doc');
	fs.writeFileSync(txtTmp, '1.1 系统供电要求\n\n工作电压范围为 9V~16V。\n');
	execFileSync('/usr/bin/textutil', ['-convert', 'doc', txtTmp, '-output', docFile]);
	const docPreview = await api({ action: 'assets.preview', scope: 'project', project: pid, path: 'prd/legacy.doc' });
	assert.equal(docPreview.ok, true);
	assert.equal(docPreview.state.kind, 'blocks');
	assert.ok(docPreview.state.blocks.some((b) => b.text.includes('工作电压范围')), '.doc 预览必须成功提取中文段落');

	// 构建真实证据、事实、测试点、用例与审查基线
	fs.writeFileSync(path.join(prdDir, 'spec.md'), '# 主控页面\n当在主控页面单击【功能开关】时，功能开关切换为开启状态。\n');
	await api({ action: 'assets.tags.update', project: pid, module: mid, path: 'prd/spec.md', add: true });
	await api({ action: 'evidence.build', project: pid, module: mid });
	await callRoute('POST', '/cts/api/generate', { project: pid, module: mid, kind: 'facts', draft: true, replace: true });
	await callRoute('POST', '/cts/api/generate', { project: pid, module: mid, kind: 'points', replace: true, source_mode: 'facts' });
	await api({ action: 'artifact.approveBatch', project: pid, module: mid, kind: 'points', scope: 'all_pending' });
	await callRoute('POST', '/cts/api/generate', { project: pid, module: mid, kind: 'cases', replace: true, source_mode: 'facts' });
	await callRoute('POST', '/cts/api/review', { project: pid, module: mid, stage: 'cases', retry_rounds: 0 });

	const findToolEnd = (events, toolName) => {
		const start = events.find((e) => e.event === 'tool.start' && e.data.tool === toolName);
		return start ? events.find((e) => e.event === 'tool.end' && e.data.callId === start.data.callId) : null;
	};

	const runChatEvents = async (msg) => {
		toolRound = 0;
		const r = await callRoute('POST', '/cts/api/chat', { project: pid, module: mid, message: msg });
		return r.text.split('\n\n').filter(Boolean).map((blk) => {
			const ev = /^event:\s*(.+)$/m.exec(blk)?.[1];
			const dt = /^data:\s*(.+)$/m.exec(blk)?.[1];
			return ev && dt ? { event: ev, data: JSON.parse(dt) } : null;
		}).filter(Boolean);
	};

	// 验证 P0-1: review.batch_repair 真实修复打回用例
	const repEvents = await runChatEvents('TEST_REPAIR');
	const repEnd = findToolEnd(repEvents, 'review.batch_repair');
	assert.equal(repEnd?.data?.ok, true, `review.batch_repair 调用失败: ${JSON.stringify(repEnd)}`);
	assert.equal(repEnd.data.data.repaired_count, 1, `review.batch_repair 必须成功修复 1 条用例: ${JSON.stringify(repEnd.data.data)}`);

	// 验证 P0-2: delivery.export 禅道模板生效 + 下载链接 200 OK
	const expEvents = await runChatEvents('TEST_EXPORT_ZENTAO');
	assert.ok(expEvents.some((e) => e.event === 'agent.status'), '工具缓冲期必须推送 agent.status 事件');
	const stateChanged = expEvents.find((e) => e.event === 'state.changed');
	assert.ok(stateChanged?.data?.download?.url?.startsWith('/cts/api/download?path='), `download_url 必须使用 ?path=，实际为 ${stateChanged?.data?.download?.url}`);
	const dlRes = await callRoute('GET', stateChanged.data.download.url);
	assert.equal(dlRes.statusCode, 200, '点击下载链接必须返回 200 OK');
	const sheets = parseXlsx(dlRes.buf);
	assert.ok(JSON.stringify(sheets[0].rows[0]).includes('用例标题'), '禅道导出模板必须生效（含“用例标题”列）');

	// 验证 P0-3: impact.analyze
	const impEvents = await runChatEvents('TEST_IMPACT');
	const impEnd = findToolEnd(impEvents, 'impact.analyze');
	assert.equal(impEnd?.data?.ok, true);
	assert.ok('source_changes' in impEnd.data.data && 'coverage_gaps' in impEnd.data.data, 'impact.analyze 应返回变更分析与覆盖缺口');

	console.log('BATCH_1_ALL_ASSERTIONS_PASSED');
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}
