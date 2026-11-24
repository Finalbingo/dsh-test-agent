/**
 * Pixso design source.
 *
 * `.pix` is a private binary container; instead of re-implementing the decoder we
 * drive the vendored Node CLI (vendor/pixso) and read its JSON output. Existing
 * compiled stores from the old workbench are reused read-only.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sqlite from './vendor/pixso/src/sqlite.js';
import registryApi from './vendor/pixso/src/registry.js';
import queryApi from './vendor/pixso/src/query.js';
import pixsoUtil from './vendor/pixso/src/util.js';

const CLI = path.join(import.meta.dirname, 'vendor', 'pixso', 'src', 'cli.js');
const BUNDLED_NODE = path.join(process.env.HOME || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node');

function nodeBinary() {
	if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE;
	if (fs.existsSync(BUNDLED_NODE)) return BUNDLED_NODE;
	return 'node';
}

function runCli(args, timeout = 240000) {
	const output = execFileSync(nodeBinary(), ['--no-warnings', CLI, ...args], {
		encoding: 'utf8',
		timeout,
		maxBuffer: 64 * 1024 * 1024
	});
	return JSON.parse(output);
}

/** A store is only reusable when its SQLite query index was built too. */
function hasIndex(store) {
	const bundles = path.join(store, 'source_bundles');
	let found = false;
	const walk = (dir, depth) => {
		if (found || depth > 8) return;
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found) return;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name === 'compiled_ui.sqlite') found = true;
		}
	};
	walk(bundles, 0);
	return found;
}

function loadStore(store) {
	try {
		const registry = JSON.parse(fs.readFileSync(path.join(store, 'compiled_ui_registry.json'), 'utf8'));
		return hasIndex(store) ? { store, registry } : null;
	} catch {
		return null;
	}
}

/** Legacy projects ship a compiled store; our own workspace may hold another. */
export function existingStore(projectDir, dataRoot, projectId) {
	const candidates = [];
	if (dataRoot && projectId) candidates.push(path.join(workspaceOf(dataRoot, projectId), 'store'));
	candidates.push(path.join(projectDir, 'pixso', 'store'), path.join(projectDir, '.cts-store'));
	for (const store of candidates) {
		const found = loadStore(store);
		if (found) return found;
	}
	return null;
}

export function sourcesOf(registry) {
	const sources = registry && registry.sources ? Object.values(registry.sources) : [];
	return sources.map((item) => ({ logical_file_id: item.logical_file_id, sha256: item.source_sha256 }));
}

function sha256File(file) {
	try {
		return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
	} catch {
		return '';
	}
}

function findPix(projectDir, limit = 8) {
	const found = [];
	const walk = (dir, depth) => {
		if (depth > 4 || found.length >= limit) return;
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name.toLowerCase().endsWith('.pix')) found.push(full);
		}
	};
	walk(projectDir, 0);
	return found;
}

/**
 * Compile every .pix under the project into a workspace next to it. Sources must
 * live under the source-set's directory, so the set file sits at the project root.
 */
export function workspaceOf(dataRoot, projectId) {
	return path.join(dataRoot, 'design', projectId);
}

export function compile(projectDir, projectId, dataRoot, options = {}) {
	const files = findPix(projectDir);
	if (files.length === 0) throw new Error('项目里没有 .pix 设计文件');
	const workspace = workspaceOf(dataRoot, projectId);
	const store = path.join(workspace, 'store');
	const existing = existingStore(projectDir, dataRoot, projectId);
	let previous = [];
	try {
		previous = JSON.parse(fs.readFileSync(path.join(workspace, 'source-set.json'), 'utf8')).pixso_sources || [];
	} catch {
		// The first import has no local source set.
	}
	const byFile = new Map();
	for (const item of previous) {
		const link = path.join(workspace, item.path);
		try {
			byFile.set(path.resolve(path.dirname(link), fs.readlinkSync(link)), item.logical_file_id);
		} catch { /* Missing links are rebuilt below. */ }
	}
	if (existing && !options.force) {
		const sources = sourcesOf(existing.registry);
		const hashes = new Map(sources.map((source) => [source.logical_file_id, source.sha256]));
		if (sources.length === files.length && files.every((file) => {
			const id = byFile.get(file);
			return id && hashes.get(id) === sha256File(file);
		})) return { reused: true, store: existing.store, sources };
	}

	fs.mkdirSync(workspace, { recursive: true });
	const stage = fs.mkdtempSync(path.join(workspace, '.compile-'));
	const old = path.join(stage, 'previous');
	const usedIds = new Set(previous.map((item) => item.logical_file_id));
	const moved = [];
	const installed = [];
	let keepStage = false;
	try {
		fs.mkdirSync(path.join(stage, 'uploads'));
		fs.mkdirSync(old);
		let nextId = 1;
		const sources = files.map((file, index) => {
			const relative = path.join('uploads', `${index + 1}-${path.basename(file)}`);
			fs.symlinkSync(file, path.join(stage, relative));
			let id = byFile.get(file);
			if (!id) {
				do { id = `pixso.${projectId}.${nextId++}`; } while (usedIds.has(id));
				usedIds.add(id);
			}
			return { logical_file_id: id, path: relative, role: 'product_design', required: true };
		});
		const setPath = path.join(stage, 'source-set.json');
		const stageStore = path.join(stage, 'store');
		fs.writeFileSync(setPath, JSON.stringify({
			schema_id: 'project-source-set/v1',
			source_set_id: projectId,
			project: projectId,
			pixso_sources: sources
		}, null, 1), 'utf8');
		const report = runCli(['compile', '--source-set', setPath, '--store', stageStore]);
		if (report.status === 'error') throw new Error(report.message || 'Pixso 编译失败');
		const registry = loadStore(stageStore)?.registry;
		if (!registry || sourcesOf(registry).length !== sources.length) throw new Error('Pixso 设计索引不完整');
		for (const name of ['uploads', 'store', 'source-set.json']) {
			const destination = path.join(workspace, name);
			if (fs.existsSync(destination)) {
				fs.renameSync(destination, path.join(old, name));
				moved.push(name);
			}
			fs.renameSync(path.join(stage, name), destination);
			installed.push(name);
		}
		return { reused: false, store, sources: sourcesOf(registry), summary: report.summary };
	} catch (error) {
		try {
			for (const name of installed.reverse()) fs.renameSync(path.join(workspace, name), path.join(stage, name));
			for (const name of moved.reverse()) fs.renameSync(path.join(old, name), path.join(workspace, name));
		} catch (restoreError) {
			keepStage = true;
			throw new Error(`索引恢复失败，备份保存在 ${old}（${restoreError.message}）`, { cause: error });
		}
		throw error;
	} finally {
		if (!keepStage) fs.rmSync(stage, { recursive: true, force: true });
	}
}

export async function compileAsync(projectDir, projectId, dataRoot, force = false) {
	const entry = JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'design.js')).href);
	const { stdout } = await promisify(execFile)(nodeBinary(), ['--no-warnings', '--input-type=module', '-e',
		`import { compile } from ${entry}; console.log(JSON.stringify(compile(...process.argv.slice(1, 4), { force: process.argv[4] === 'true' })));`,
		projectDir, projectId, dataRoot, String(force)], { timeout: 300000, maxBuffer: 1024 * 1024 });
	return JSON.parse(stdout);
}

export function state(projectDir, projectId, dataRoot) {
	const existing = existingStore(projectDir, dataRoot, projectId);
	const imported = mcpSources(dataRoot, projectId);
	const removed = removedDesigns(dataRoot, projectId);
	if (imported.length || removed.size) {
		const sources = new Map(sourcesOf(existing?.registry).filter(() => !removed.has('default'))
			.map((source) => [source.logical_file_id, { ...source, store: existing.store }]));
		for (const source of imported) {
			const previous = sources.get(source.id);
			if (previous && source.replacesRevision && source.replacesRevision !== previous.sha256) continue;
			sources.set(source.id, { logical_file_id: source.id, sha256: source.revision, store: source.store, kind: 'pixso-mcp' });
		}
		for (const id of removed.keys()) sources.delete(id);
		const ordered = [...sources.values()].sort((a, b) => Number(Boolean(b.kind)) - Number(Boolean(a.kind)));
		return { available: ordered.length > 0, reused: true,
			store: Object.fromEntries(ordered.map((source) => [source.logical_file_id, source.store])),
			sources: ordered.map(({ store, ...source }) => source) };
	}
	if (existing) return { available: true, reused: true, store: existing.store, sources: sourcesOf(existing.registry) };
	if (findPix(projectDir).length > 0) return { available: false, reused: false, pending: true, sources: [] };
	return { available: false, reused: false, pending: false, sources: [] };
}

export function pages(store, sourceId) {
	return runCli(['pages', '--store', sourceStore(store, sourceId), '--source', sourceId], 60000);
}

function sourceStore(store, sourceId) {
	if (typeof store === 'string') return store;
	if (!Object.hasOwn(store, sourceId)) throw new Error('设计稿来源不存在');
	return store[sourceId];
}

export function search(store, text, options = {}) {
	const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
	if (typeof store !== 'string' && !options.source) {
		const results = Object.entries(store).flatMap(([logicalFileId, dir]) =>
			queryApi.search(dir, String(text), { logicalFileId, limit }).results);
		results.sort((a, b) => a.rank - b.rank);
		return { query: String(text), logical_file_id: null, result_count: Math.min(results.length, limit), results: results.slice(0, limit) };
	}
	const args = ['search', '--store', sourceStore(store, options.source), '--text', String(text), '--limit', String(limit)];
	if (options.source) args.push('--source', String(options.source));
	return runCli(args, 60000);
}

/**
 * Search hits carry only ids; the agent needs "which page". Enrich the top hits
 * with page and board names from the node detail.
 */
export function searchWithContext(store, text, options = {}) {
	return addSearchContext(search(store, text, options), options.limit,
		(source) => pages(store, source), (source, id) => node(store, source, id));
}

function addSearchContext(result, limit, readPages, readNode) {
	const hits = (result.results || []).slice(0, Math.min(10, Number(limit) || 8));
	if (hits.length === 0) return { query: result.query, hits: [] };
	const namesBySource = new Map();
	const enriched = hits.map((hit) => {
		try {
			const source = hit.logical_file_id;
			if (!namesBySource.has(source)) namesBySource.set(source, readPages(source).pages || []);
			const detail = readNode(source, hit.entity_id.split('::').at(-1));
			if (!detail) return { node: hit.entity_id, name: hit.name };
			const page = namesBySource.get(source).find((entry) => entry.page_id === detail.page_id);
			return {
				node: hit.entity_id,
				name: detail.name,
				type: detail.node_type,
				page: page?.name || detail.page_id,
				board: page?.boards.find((entry) => entry.board_id === detail.board_id)?.name || detail.board_id,
				texts: (detail.texts || []).slice(0, 5),
				visible: detail.visible !== false
			};
		} catch {
			return { node: hit.entity_id, name: hit.name };
		}
	});
	return { query: result.query, hits: enriched };
}

export function node(store, sourceId, id) {
	return runCli(['node', '--store', sourceStore(store, sourceId), '--source', sourceId, '--id', String(id)], 60000);
}

export function queryLayers(sources, { action, source: sourceId, id, text, limit = 8 }) {
	const selected = sourceId ? sources.filter((source) => source.id === sourceId) : sources;
	if (!selected.length) throw new Error('本轮没有可用的设计稿');
	const [source] = selected;
	if (action === 'pages') return queryApi.listPages(source.store, source.id, source.db);
	if (action === 'node') return queryApi.getNode(source.store, source.id, id, source.db);
	const count = Math.min(10, Math.max(1, Number(limit) || 8));
	if (!text.trim()) throw new Error('请输入查找内容');
	const results = selected.flatMap((entry) => queryApi.searchOne(entry.store, entry.id, text, count, entry.db))
		.sort((a, b) => a.rank - b.rank).slice(0, count);
	const selectedById = new Map(selected.map((entry) => [entry.id, entry]));
	const raw = { query: text, results };
	return { ...raw, ...addSearchContext(raw, count,
		(id) => queryApi.listPages(undefined, id, selectedById.get(id).db),
		(id, nodeId) => queryApi.getNode(undefined, id, nodeId, selectedById.get(id).db)) };
}

import { DatabaseSync } from 'node:sqlite';

/** Locate the compiled index for a project (the deepest compiled_ui.sqlite). */
export function indexFile(dataRoot, projectId) {
	const base = path.join(dataRoot, 'design', projectId, 'store');
	const found = [];
	const walk = (dir, depth) => {
		if (depth > 8 || found.length > 4) return;
		let entries = [];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name === 'compiled_ui.sqlite') found.push(full);
		}
	};
	walk(base, 0);
	return found[0] || '';
}

export function layerPages(dataRoot, projectId) {
	const file = indexFile(dataRoot, projectId);
	if (!file) return [];
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const rows = db.prepare("select node_id as id, name from nodes where node_type = 'CANVAS' order by name").all();
		return rows.map((row) => ({
			id: row.id,
			name: row.name || row.id,
			count: db.prepare('select count(*) as c from nodes where page_id = ?').get(row.id).c
		}));
	} finally {
		db.close();
	}
}

export function layerChildren(dataRoot, projectId, parentId, sourceId = '', sources = layerSources(dataRoot, projectId)) {
	const file = sourceId ? sources.find((source) => source.id === sourceId)?.db : sources[0]?.db;
	if (!file) return [];
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const rows = db.prepare(`select node_id as id, name, node_type as type, visible, x, y, width, height
			from nodes where parent_id = ? order by y, x`).all(parentId);
		return rows.map((row) => ({
			id: row.id,
			name: row.name || '',
			type: row.type,
			visible: Boolean(row.visible),
			x: row.x,
			y: row.y,
			width: row.width || 0,
			height: row.height || 0,
			hasChildren: Boolean(db.prepare('select 1 as one from nodes where parent_id = ? limit 1').get(row.id))
		}));
	} finally {
		db.close();
	}
}

/** Every compiled per-file index, keyed by the .pix it came from. */
function pixLayerSources(dataRoot, projectId) {
	const workspace = workspaceOf(dataRoot, projectId);
	const out = [];
	try {
		const set = JSON.parse(fs.readFileSync(path.join(workspace, 'source-set.json'), 'utf8'));
		const registry = loadStore(path.join(workspace, 'store'))?.registry;
		const revisions = new Map(sourcesOf(registry).map((item) => [item.logical_file_id, item.sha256]));
		for (const source of set.pixso_sources || []) {
			const file = path.basename(String(source.path || ''));
			const bundleRoot = path.join(workspace, 'store', 'source_bundles', 'pixso', source.logical_file_id);
			const db = indexFileIn(bundleRoot);
			if (!db) continue;
			out.push({
				id: source.logical_file_id,
				name: file.replace(/^\d+-/, '').replace(/\.pix$/i, ''),
				file,
				revision: revisions.get(source.logical_file_id) || '',
				path: path.join(workspace, source.path),
				db
			});
		}
	} catch {
		const fallback = indexFile(dataRoot, projectId);
		if (fallback) out.push({ id: 'default', name: '设计稿', file: '', db: fallback });
	}
	return out;
}

function mcpSources(dataRoot, projectId) {
	const store = path.join(workspaceOf(dataRoot, projectId), 'mcp-store');
	const registry = loadStore(store)?.registry;
	return Object.values(registry?.sources || {}).flatMap((entry) => {
		const bundle = path.join(store, entry.current_bundle_ref);
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(bundle, 'source.json'), 'utf8'));
			return [{ ...meta, id: entry.logical_file_id, revision: entry.source_sha256, store,
				file: meta.name, db: path.join(bundle, 'index', 'compiled_ui.sqlite') }];
		} catch {
			return [];
		}
	});
}

export function removedDesigns(dataRoot, projectId) {
	const file = path.join(workspaceOf(dataRoot, projectId), 'removed-designs.json');
	try {
		return new Map(JSON.parse(fs.readFileSync(file, 'utf8')));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		return new Map();
	}
}

export function setDesignRemoved(dataRoot, projectId, source, remove) {
	const removed = removedDesigns(dataRoot, projectId);
	if (remove) removed.set(source.id, source.name);
	else if (!removed.delete(source.id)) return;
	const file = path.join(workspaceOf(dataRoot, projectId), 'removed-designs.json');
	pixsoUtil.writeJsonAtomic(file, [...removed]);
}

export function deletePreviewCache(dataRoot, projectId, projectDir, source) {
	const images = path.join(projectDir, 'design', 'images');
	const sources = [...pixLayerSources(dataRoot, projectId), ...mcpSources(dataRoot, projectId)];
	const owned = new Set([source.revision, source.replacesRevision]);
	const shared = new Set();
	for (const entry of sources) {
		const revisions = entry.id === source.id ? owned : shared;
		revisions.add(entry.revision);
		revisions.add(entry.replacesRevision);
	}
	const bundles = path.join(workspaceOf(dataRoot, projectId), 'mcp-store', 'source_bundles', 'mcp', source.id);
	if (fs.existsSync(bundles)) {
		for (const revision of fs.readdirSync(bundles)) {
			if (!/^[a-f0-9]{64}$/.test(revision)) continue;
			owned.add(revision);
			const meta = path.join(bundles, revision, 'source.json');
			if (fs.existsSync(meta)) owned.add(JSON.parse(fs.readFileSync(meta, 'utf8')).replacesRevision);
		}
	}
	for (const revision of owned) {
		if (/^[a-f0-9]{64}$/.test(revision || '') && !shared.has(revision)) {
			fs.rmSync(path.join(images, revision), { recursive: true, force: true });
		}
	}

	if (!fs.existsSync(images)) return;
	const flat = new Set(fs.readdirSync(images, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.png')).map((entry) => entry.name));
	if (!flat.size) return;
	const owners = new Map();
	for (const entry of [source, ...sources]) {
		const db = new DatabaseSync(entry.db, { readOnly: true });
		try {
			for (const { id } of db.prepare('select node_id as id from nodes').iterate()) {
				const name = previewName(id);
				if (!flat.has(name)) continue;
				const owner = owners.get(name);
				owners.set(name, owner === undefined || owner === entry.id ? entry.id : null);
			}
		} finally {
			db.close();
		}
	}
	for (const [name, owner] of owners) {
		if (owner === source.id) fs.rmSync(path.join(images, name), { force: true });
	}
}

export function layerSources(dataRoot, projectId, includeRemoved = false, pinned = null) {
	const uploads = pixLayerSources(dataRoot, projectId);
	const direct = mcpSources(dataRoot, projectId).filter((source) => {
		const uploaded = uploads.find((entry) => entry.id === source.id);
		return !uploaded || !source.replacesRevision || source.replacesRevision === uploaded.revision;
	});
	const sources = [...direct, ...uploads.filter((source) => !direct.some((entry) => entry.id === source.id))].flatMap((source) => {
		const revision = pinned?.get(source.id);
		if (!revision || revision === source.revision) return [source];
		if (!source.store || !/^[\w.-]+$/.test(source.id) || !/^[a-f0-9]{64}$/.test(revision)) return [];
		const bundle = path.join(source.store, 'source_bundles', 'mcp', source.id, revision);
		const db = path.join(bundle, 'index', 'compiled_ui.sqlite');
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(bundle, 'source.json'), 'utf8'));
			return fs.existsSync(db) ? [{ ...meta, id: source.id, revision, store: source.store, file: meta.name, db, historical: true }] : [];
		} catch {
			return [];
		}
	});
	if (includeRemoved) return sources;
	const removed = removedDesigns(dataRoot, projectId);
	return sources.filter((source) => !removed.has(source.id));
}

export function saveMcpDesign(dataRoot, projectId, document, pageTrees, matchingUpload) {
	const store = path.join(workspaceOf(dataRoot, projectId), 'mcp-store');
	const identity = document.fileKey || JSON.stringify([document.name, document.pages[0]]);
	const imported = mcpSources(dataRoot, projectId);
	const existing = imported.find((source) => source.identity === identity);
	const uploadId = imported.some((source) => source.id === matchingUpload?.id) ? undefined : matchingUpload?.id;
	const id = existing?.id || uploadId || 'mcp.' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
	const revision = crypto.randomBytes(32).toString('hex');
	const bundle = path.join(store, 'source_bundles', 'mcp', id, revision);
	const source = { source_id: id, source_sha256: revision };
	const records = { pages: [], boards: [], nodes: [], texts: [], edges: [], components: [], instances: [], overrides: [], assets: [], blobs: [], styles: [] };
	// MCP 只给节点类型；语义分类在这里补齐，组件集即状态变体容器。
	const boardKindOf = (type) => type === 'COMPONENT_SET' ? 'state_variant'
		: type === 'COMPONENT' ? 'component'
			: ['FRAME', 'GROUP', 'SECTION'].includes(type) ? 'runtime_screen' : type;
	for (const page of pageTrees) {
		records.pages.push({ ...source, page_id: page.id, entity_id: `${id}::page::${page.id}`, name: page.name });
		const boards = new Map([[page.id, null]]);
		for (const row of [{ id: page.id, type: 'CANVAS', name: page.name, visible: true }, ...page.nodes]) {
			const boardId = row.parent === page.id ? row.id : boards.get(row.parent) || null;
			boards.set(row.id, boardId);
			const entityId = `${id}::node::${row.id}`;
			// 属性没有专用列：随 key 携带，索引侧解析（key||props:JSON）。
			const props = row.componentProperties && Object.keys(row.componentProperties).length > 0
				? JSON.stringify(row.componentProperties) : '';
			const componentKey = row.componentKey ? (props ? `${row.componentKey}||props:${props}` : row.componentKey) : null;
			records.nodes.push({ ...source, node_id: row.id, entity_id: entityId, node_type: row.type, name: row.name,
				parent_id: row.parent ?? null, page_id: page.id, board_id: boardId, visible: row.visible,
				absolute_box: row.box, semantic_class: null, raw_payload_sha256: null, component_key: componentKey });
			if (boardId === row.id) records.boards.push({ ...source, board_id: boardId, entity_id: `${id}::board::${row.id}`,
				page_id: page.id, name: row.name, visible: row.visible, size: row.box,
				classification: { board_kind: boardKindOf(row.type), node_type: row.type } });
			if (row.type === 'COMPONENT' || row.type === 'COMPONENT_SET') records.components.push({ ...source,
				component_id: entityId, node_id: row.id, name: row.name, component_key: row.componentKey || null,
				publish_file: null, publish_id: null, component_prop_defs: [] });
			if (row.type === 'INSTANCE' && row.componentKey) records.instances.push({ ...source,
				instance_id: entityId, node_id: row.id, name: row.name, instance_of: row.componentKey,
				symbol_node_id: row.componentKey, override_count: props ? Object.keys(row.componentProperties).length : 0,
				derived_node_count: 0, transform: null });
			if (row.text) records.texts.push({ ...source, text_id: `${entityId}::text`, node_id: row.id, entity_id: entityId,
				page_id: page.id, board_id: boardId, text: row.text, origin: 'pixso-mcp' });
		}
	}
	try {
		sqlite.buildIndex(path.join(bundle, 'index', 'compiled_ui.sqlite'), { records }, { source: 'pixso-mcp' });
		const meta = { name: document.name, fileKey: document.fileKey || '', identity, replacesRevision: matchingUpload?.revision || existing?.replacesRevision || '' };
		fs.writeFileSync(path.join(bundle, 'source.json'), JSON.stringify(meta));
		fs.writeFileSync(path.join(bundle, 'READY'), '');
		registryApi.updateRegistry(store, { sources: [{ logical_file_id: id, source_sha256: revision, bundle_path: bundle }] });
	} catch (error) {
		fs.rmSync(bundle, { recursive: true, force: true });
		throw error;
	}
	return id;
}

export function copyMcpDesign(dataRoot, fromProjectId, toProjectId, sourceId, revision, fromDir = '', toDir = '') {
	const srcBundle = path.join(workspaceOf(dataRoot, fromProjectId), 'mcp-store', 'source_bundles', 'mcp', sourceId, revision);
	if (!fs.existsSync(path.join(srcBundle, 'READY'))) {
		throw new Error('资产池中找不到该 MCP 设计稿版本');
	}
	const targetStore = path.join(workspaceOf(dataRoot, toProjectId), 'mcp-store');
	const dstBundle = path.join(targetStore, 'source_bundles', 'mcp', sourceId, revision);
	if (fromProjectId !== toProjectId || srcBundle !== dstBundle) {
		if (!fs.existsSync(path.join(dstBundle, 'READY'))) {
			fs.mkdirSync(path.dirname(dstBundle), { recursive: true });
			fs.cpSync(srcBundle, dstBundle, { recursive: true });
		}
		registryApi.updateRegistry(targetStore, {
			sources: [{ logical_file_id: sourceId, source_sha256: revision, bundle_path: dstBundle }]
		});
	}
	if (fromDir && toDir && path.resolve(fromDir) !== path.resolve(toDir)) {
		const srcImages = path.join(fromDir, 'design', 'images', revision);
		const dstImages = path.join(toDir, 'design', 'images', revision);
		if (fs.existsSync(srcImages)) {
			fs.mkdirSync(path.dirname(dstImages), { recursive: true });
			fs.cpSync(srcImages, dstImages, { recursive: true });
		}
	}
	return { id: sourceId, revision };
}

function previewName(nodeId) {
	return String(nodeId).replace(/[^0-9A-Za-z_-]/g, '_') + '.png';
}

export function previewFile(projectDir, source, nodeId, legacy = false) {
	const name = previewName(nodeId);
	const base = path.join(projectDir, 'design', 'images');
	const scoped = source?.revision ? path.join(base, source.revision, name) : path.join(base, name);
	if (fs.statSync(scoped, { throwIfNoEntry: false })?.size > 0) return { file: scoped, cached: true };
	if (legacy && source?.path) {
		const old = path.join(base, name);
		const original = fs.statSync(source.path, { throwIfNoEntry: false });
		const fresh = (file) => {
			const stat = fs.statSync(file, { throwIfNoEntry: false });
			return stat?.isFile() && stat.size > 0 && original && stat.mtimeMs >= original.mtimeMs;
		};
		if (fresh(old)) return { file: old, cached: true };
		const library = path.join(projectDir, 'design', 'library');
		const folders = fs.existsSync(library) ? fs.readdirSync(library) : [];
		for (const folder of folders) {
			try {
				const index = JSON.parse(fs.readFileSync(path.join(library, folder, 'index.json'), 'utf8'));
				const relative = index.components?.[nodeId]?.file;
				if (!relative) continue;
				const file = path.resolve(projectDir, relative);
				if (file.startsWith(path.resolve(library) + path.sep) && fresh(file)) return { file, cached: true };
			} catch { /* Incomplete library imports do not block preview. */ }
		}
	}
	return { file: scoped, cached: false };
}

export function previewNode(source, id) {
	const db = new DatabaseSync(source.db, { readOnly: true });
	try {
		const get = db.prepare('select node_id as id, parent_id as parent, page_id as page, name, x, y, width, height from nodes where node_id = ?');
		const node = get.get(id);
		if (!node) return null;
		let layer = node;
		const seen = new Set([id]);
		while (layer.parent && layer.parent !== node.page && !seen.has(layer.parent)) {
			const parent = get.get(layer.parent);
			if (!parent) break;
			seen.add(parent.id);
			layer = parent;
		}
		return { node, layer };
	} finally {
		db.close();
	}
}

export function exactDesignNodes(source, names) {
	if (!names.length) return [];
	const db = new DatabaseSync(source.db, { readOnly: true });
	try {
		const select = db.prepare(`select n.node_id, n.name, p.name as page from nodes n
			left join nodes p on p.node_id = n.page_id where n.name = ? collate nocase
			and n.width > 0 and n.height > 0 and n.visible is not 0 limit 21`);
		return names.flatMap((name) => select.all(name));
	} finally {
		db.close();
	}
}

function indexFileIn(dir) {
	const found = [];
	const walk = (current, depth) => {
		if (depth > 8 || found.length > 2) return;
		let entries = [];
		try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name === 'compiled_ui.sqlite') found.push(full);
		}
	};
	walk(dir, 0);
	return found[0] || '';
}

export function layerPagesOfFile(db, sourceId) {
	const database = new DatabaseSync(db, { readOnly: true });
	try {
		const rows = database.prepare("select node_id as id, name from nodes where node_type = 'CANVAS' order by name").all();
		return rows.map((row) => ({
			id: row.id,
			name: row.name || row.id,
			source: sourceId,
			count: database.prepare('select count(*) as c from nodes where page_id = ?').get(row.id).c
		}));
	} finally {
		database.close();
	}
}

/** Build a node's subtree straight from a compiled index (offline, any .pix). */
export function layerDetailLocal(dataRoot, projectId, nodeId) {
	for (const source of layerSources(dataRoot, projectId)) {
		const db = new DatabaseSync(source.db, { readOnly: true });
		try {
			const root = db.prepare('select node_id as id, name, node_type as type, parent_id as parent, x, y, width, height, visible, page_id from nodes where node_id = ?').get(nodeId);
			if (!root) continue;
			const nodes = [];
			const stack = [{ node: root, depth: 0 }];
			while (stack.length > 0) {
				const { node, depth } = stack.shift();
				const text = db.prepare('select text, font_family, font_style, font_size from texts where node_id = ? limit 1').get(node.id) || {};
				nodes.push({
					id: node.id,
					parent: node.parent || '',
					depth,
					type: node.type,
					name: node.name || '',
					text: text.text || '',
					fontFamily: text.font_family || '',
					fontStyle: text.font_style || '',
					fontSize: text.font_size || 0,
					fontWeight: '',
					x: Math.round((node.x || 0) * 100) / 100,
					y: Math.round((node.y || 0) * 100) / 100,
					w: Math.round((node.width || 0) * 100) / 100,
					h: Math.round((node.height || 0) * 100) / 100,
					visible: Boolean(node.visible),
					color: '',
					path: ''
				});
				const children = db.prepare('select node_id as id, name, node_type as type, parent_id as parent, x, y, width, height, visible from nodes where parent_id = ? order by y, x').all(node.id);
				for (const child of children) stack.push({ node: child, depth: depth + 1 });
			}
			// Convert absolute coordinates to the root's origin and fill parent paths.
			const originX = nodes[0].x;
			const originY = nodes[0].y;
			const nameById = new Map(nodes.map((node) => [node.id, node.name || `(${String(node.type).toLowerCase()})`]));
			for (const node of nodes) {
				node.x = Math.round((node.x - originX) * 100) / 100;
				node.y = Math.round((node.y - originY) * 100) / 100;
				const parts = [];
				let cursor = node;
				let guard = 0;
				while (cursor && guard < 12) {
					parts.unshift(nameById.get(cursor.id) || '');
					cursor = cursor.parent ? nodes.find((entry) => entry.id === cursor.parent) : null;
					guard += 1;
				}
				node.path = parts.filter(Boolean).join(' / ');
			}
			const byParent = new Map();
			for (const node of nodes) {
				if (!byParent.has(node.parent)) byParent.set(node.parent, []);
				byParent.get(node.parent).push(node);
			}
			for (const group of byParent.values()) {
				group.forEach((node, index) => { node.siblingIndex = index + 1; node.siblingCount = group.length; });
			}
			return {
				nodeId,
				source: { id: source.id, name: source.name, file: source.file },
				name: root.name || '',
				w: Math.round((root.width || 0) * 100) / 100,
				h: Math.round((root.height || 0) * 100) / 100,
				count: nodes.length,
				depth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
				nodes,
				texts: nodes.filter((node) => node.text).map((node) => ({ id: node.id, text: node.text, fontSize: node.fontSize, x: node.x, y: node.y })),
				local: true,
				fetchedAt: new Date().toISOString()
			};
		} finally {
			db.close();
		}
	}
	return null;
}

/** One node's own fields plus its text and parent path. */
export function layerNodeInfo(dataRoot, projectId, nodeId, sourceId = '', sources = layerSources(dataRoot, projectId)) {
	const file = sourceId ? sources.find((source) => source.id === sourceId)?.db : sources[0]?.db;
	if (!file) return null;
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const node = db.prepare('select node_id as id, name, node_type as type, parent_id as parent, page_id, x, y, width, height, visible, image_hash_refs_json from nodes where node_id = ?').get(nodeId);
		if (!node) return null;
		const text = db.prepare('select text, font_family, font_style, font_size from texts where node_id = ? limit 1').get(nodeId) || {};
		const children = db.prepare('select count(*) as c from nodes where parent_id = ?').get(nodeId).c;
		const names = [];
		let cursor = node;
		let guard = 0;
		while (cursor && guard < 12) {
			names.unshift(cursor.name || `(${String(cursor.type).toLowerCase()})`);
			cursor = cursor.parent ? db.prepare('select node_id as id, name, node_type as type, parent_id as parent from nodes where node_id = ?').get(cursor.parent) : null;
			guard += 1;
		}
		return {
			id: node.id,
			name: node.name || '',
			type: node.type,
			pageId: node.page_id,
			children,
			path: names.join(' / '),
			x: Math.round((node.x || 0) * 100) / 100,
			y: Math.round((node.y || 0) * 100) / 100,
			w: Math.round((node.width || 0) * 100) / 100,
			h: Math.round((node.height || 0) * 100) / 100,
			visible: Boolean(node.visible),
			text: text.text || '',
			fontFamily: text.font_family || '',
			fontStyle: text.font_style || '',
			fontSize: text.font_size || 0,
			hasImage: Boolean(node.image_hash_refs_json && node.image_hash_refs_json !== '[]')
		};
	} finally {
		db.close();
	}
}
