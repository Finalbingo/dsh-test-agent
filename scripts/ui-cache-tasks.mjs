#!/usr/bin/env node
/**
 * 截图缺口任务队列：从 UI 关联反推缺截图的节点，按
 * project/source/revision/captureNode 去重，支持断点续跑。
 * 默认只生成/合并任务清册（不连 MCP、不改设计缓存）；--run 才通过 Pixso MCP 补图。
 * 用法：node scripts/ui-cache-tasks.mjs [--data <dir>] [--project <pid>] [--module <mid>]
 *        [--out <json>] [--run] [--retry] [--limit 50] [--scale 1] [--url <mcp>] [--token <t>]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { enterModule } from '../scope.js';
import { loadIndex, loadLinks } from '../ui.js';
import { layerSources, layerPagesOfFile, previewFile } from '../design.js';
import { PixsoMcp, DEFAULT_URL, isRemote } from '../design-mcp.js';
import { isFrozen } from '../package.js';
import { parseArgs, dataRootOf, resolveTargets } from './targets.mjs';

const { values, flags } = parseArgs();
const dataRoot = dataRootOf(values);
const run = flags.has('run');
const retry = flags.has('retry');
const limit = Math.max(0, Number(values.limit) || 0);
const scale = Number(values.scale) || 1;
const token = values.token || '';
const outArg = values.out || '';
const targets = resolveTargets(dataRoot, { project: values.project || '', module: values.module || '' });

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const pngInfo = (buffer) => {
	if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	return width > 0 && height > 0 ? { width, height } : null;
};
const classify = (message) => {
	const text = String(message || '');
	if (/请在 Pixso 打开|已切换|设计稿.*(不一致|变化)|不是当前设计稿/.test(text)) return 'document_mismatch';
	if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|connect|MCP|未连接/i.test(text)) return 'mcp_unavailable';
	if (/timeout|超时|timed out/i.test(text)) return 'timeout';
	if (/找不到|不存在|not found|node.*missing/i.test(text)) return 'node_not_found';
	if (/PNG|图片|image/i.test(text)) return 'invalid_image';
	return 'unknown';
};
const writeLedger = (file, ledger) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = file + '.' + crypto.randomUUID() + '.tmp';
	fs.writeFileSync(temp, JSON.stringify(ledger, null, 1), 'utf8');
	fs.renameSync(temp, file);
};

function buildTasks({ project, module, index, links, sources, projectDir }) {
	const objectById = new Map((index.objects || []).map((object) => [object.id, object]));
	const tasks = new Map();
	for (const link of links.items) {
		if (!link.ui_id) continue;
		const fallback = link.target ? {
			id: link.target.ui_id, s: link.target.source, n: link.target.node_id,
			name: link.target.name, board: link.target.board, shot: link.target.shot,
			rev: link.target.revision, shot_node: link.target.shot_node
		} : null;
		const object = objectById.get(link.ui_id) || fallback;
		if (!object) continue;
		const source = sources.find((entry) => entry.id === object.s || entry.name === object.s);
		if (!source) continue;
		const shot = object.shot || '';
		const file = shot ? path.join(projectDir, shot) : '';
		const usable = Boolean(file) && fs.existsSync(file) && fs.statSync(file).size > 0;
		if (usable) continue;
		const captureNode = object.shot_node || object.n || object.board || String(object.id).split('::').at(-1);
		if (!captureNode) continue;
		const key = [project, source.id, source.revision || '', captureNode].join('|');
		const task = tasks.get(key) || {
			task_id: hash(key), project, module, source: source.id, source_name: source.name,
			revision: source.revision || '', capture_node: captureNode,
			name: object.name || object.board_name || captureNode,
			reason: shot ? 'shot_file_missing' : 'no_shot',
			status: 'pending', attempts: 0, links: []
		};
		if (!task.links.some((entry) => entry.link_id === link.link_id)) {
			task.links.push({ link_id: link.link_id, subject: `${link.subject.kind}:${link.subject.id}`, purpose: link.purpose });
		}
		tasks.set(key, task);
	}
	return [...tasks.values()];
}

function mergeLedger(previous, fresh, projectDir) {
	const prior = new Map((previous?.tasks || []).map((task) => [task.task_id, task]));
	const merged = fresh.map((task) => {
		const old = prior.get(task.task_id);
		if (!old) return task;
		if (old.status === 'done') {
			const cached = old.file && fs.existsSync(path.join(projectDir, old.file));
			return cached ? { ...task, ...old, links: task.links } : task;
		}
		return { ...task, ...old, links: task.links };
	});
	const known = new Set(merged.map((task) => task.task_id));
	for (const old of prior.values()) if (!known.has(old.task_id)) {
		// 缺口已消失的任务保留一条 done 审计，避免清册丢失历史。
		if (old.status === 'done') merged.push(old);
	}
	return merged;
}

async function execute(target, ledger, file) {
	const projectDir = path.join(dataRoot, 'projects', target.project);
	enterModule(target.module);
	const sources = layerSources(dataRoot, target.project);
	const url = values.url || (isRemote(values.url) ? values.url : DEFAULT_URL);
	const client = new PixsoMcp(url, 45000, token);
	await client.connect();
	const activeDocument = async () => JSON.parse((await client.callTool('eval_script', {
		script: 'return { name: pixso.root.name, fileKey: pixso.fileKey || "", pages: pixso.root.children.map(page => page.id) };'
	})).content.find((entry) => entry.type === 'text').text);
	const sameDocument = (doc, source, pages) =>
		String(doc.name || '').normalize('NFC').trim().replace(/\.pix$/i, '').toLowerCase() ===
			String(source.name || '').normalize('NFC').trim().replace(/\.pix$/i, '').toLowerCase() &&
		(!source.fileKey || doc.fileKey === source.fileKey) &&
		doc.pages.length > 0 && doc.pages.every((id) => pages.some((page) => page.id === id));
	let executed = 0;
	let done = 0;
	let failed = 0;
	for (const task of ledger.tasks) {
		if (limit && executed >= limit) break;
		if (task.status === 'done' || (task.status === 'failed' && !retry)) continue;
		const source = sources.find((entry) => entry.id === task.source);
		if (!source || (source.revision || '') !== task.revision) {
			task.status = 'failed';
			task.classification = 'source_changed';
			task.error = '设计来源已更新或移除，请重建索引后重试';
			continue;
		}
		const pages = layerPagesOfFile(source.db, source.id);
		try {
			if (!sameDocument(await activeDocument(), source, pages)) throw new Error(`请在 Pixso 打开 ${source.name} 后补图`);
			const shot = await client.screenshot(task.capture_node, { scale });
			const info = pngInfo(shot.buffer);
			if (!info || shot.buffer.length < 100 || info.width > 16384 || info.height > 16384) throw new Error('截图不是有效 PNG 或尺寸异常');
			if (!sameDocument(await activeDocument(), source, pages)) throw new Error('截图期间 Pixso 已切换设计稿，未保存');
			const { file: targetFile } = previewFile(projectDir, source, task.capture_node);
			const base = path.resolve(projectDir, 'design', 'images');
			if (!path.resolve(targetFile).startsWith(base + path.sep)) throw new Error('截图目标路径不属于本项目');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			const temp = targetFile + '.' + crypto.randomUUID() + '.tmp';
			try {
				fs.writeFileSync(temp, shot.buffer);
				const saved = fs.readFileSync(temp);
				if (!pngInfo(saved)) throw new Error('写入后 PNG 校验失败');
				fs.renameSync(temp, targetFile);
			} finally {
				fs.rmSync(temp, { force: true });
			}
			task.status = 'done';
			task.file = path.relative(projectDir, targetFile);
			task.bytes = shot.buffer.length;
			task.width = info.width;
			task.height = info.height;
			task.captured_at = new Date().toISOString();
			task.error = null;
			task.classification = null;
			done += 1;
		} catch (error) {
			task.status = 'failed';
			task.attempts = (task.attempts || 0) + 1;
			task.error = String(error?.message || error);
			task.classification = classify(task.error);
			task.failed_at = new Date().toISOString();
			failed += 1;
		}
		executed += 1;
		ledger.executed = executed;
		writeLedger(file, ledger);
	}
	ledger.executed = executed;
	return { executed, done, failed };
}

const summary = { dataRoot, generatedAt: new Date().toISOString(), run, modules: [] };
for (const target of targets) {
	enterModule(target.module);
	const index = loadIndex(dataRoot, target.project);
	if (!index.digest) { console.log(`${target.project}/${target.module}: 无 UI 索引，跳过`); continue; }
	const links = loadLinks(dataRoot, target.project);
	const projectDir = path.join(dataRoot, 'projects', target.project);
	let sources = [];
	try { sources = layerSources(dataRoot, target.project); } catch { /* no design */ }
	const fresh = buildTasks({ ...target, index, links, sources, projectDir });
	const file = outArg
		? (targets.length > 1 ? outArg.replace(/\.json$/i, `-${target.project}-${target.module}.json`) : outArg)
		: path.join(dataRoot, 'reports', 'ui-cache', `${target.project}-${target.module}-tasks.json`);
	const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
	const ledger = { project: target.project, module: target.module, updated_at: new Date().toISOString(), tasks: mergeLedger(previous, fresh, projectDir) };
	const frozen = isFrozen(dataRoot, target.project);
	if (run && frozen) ledger.error = '已冻结，未执行补图';
	if (run && !frozen) {
		try {
			await execute(target, ledger, file);
		} catch (error) {
			ledger.error = String(error?.message || error);
			console.error(`## ${target.project}/${target.module} 执行失败：${ledger.error}`);
		}
	}
	writeLedger(file, ledger);
	const counts = ledger.tasks.reduce((acc, task) => {
		acc[task.status] = (acc[task.status] || 0) + 1;
		if (task.status === 'failed') acc.byClass[task.classification || 'unknown'] = (acc.byClass[task.classification || 'unknown'] || 0) + 1;
		return acc;
	}, { byClass: {} });
	summary.modules.push({ ...target, out: file, tasks: ledger.tasks.length, counts, error: ledger.error || null });
	console.log(`## ${target.project}/${target.module}${run ? '' : '（仅生成任务）'}`);
	console.log(`任务 ${ledger.tasks.length}：${JSON.stringify(counts)}`);
	if (ledger.error) console.log(`错误：${ledger.error}`);
}
if (outArg && targets.length === 1) {
	// 单目标时 --out 就是任务清册本身，不再另写汇总，避免覆盖。
	console.log(`\n任务清册 ${outArg}`);
} else {
	const report = outArg || path.join(dataRoot, 'reports', 'ui-cache', `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	fs.mkdirSync(path.dirname(report), { recursive: true });
	fs.writeFileSync(report, JSON.stringify(summary, null, 1), 'utf8');
	console.log(`\n汇总已写入 ${report}`);
}
