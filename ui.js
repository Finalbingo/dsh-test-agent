/**
 * UI correlation: one index of everything a test can point at, plus links
 * that carry page / control / state context from evidence all the way down
 * to a case step.
 *
 * The index is built from the compiled design database, the imported
 * component library (PNG names carry node ids) and the preview cache. The
 * link store is deliberately small: every record says which subject (fact,
 * contract, point, step, expected item) points at which UI object, why, and
 * whether a human confirmed it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { currentModule } from './scope.js';
import { layerSources, previewFile } from './design.js';
import { structureCase } from './artifacts.js';
import { queryVariants } from './bindings.js';

export const ROLES = ['button', 'switch', 'icon', 'slider', 'input', 'dialog', 'list_item', 'tab', 'text', 'container', 'board'];
const ROLE_WORDS = [
	['dialog', /(弹窗|弹层|提示框|对话框|toast|dialog|popup)/i],
	['input', /(输入框|输入框|键盘|文本框|input)/i],
	['slider', /(滑块|滑条|调节条|进度条|slider)/i],
	['tab', /(页签|标签页|tab)/i],
	['list_item', /(列表项|卡片|条目|item)/i],
	['icon', /(图标|icon)/i],
	['button', /(按钮|按键|开关|button|switch)/i],
	['text', /(文本|文字|label)/i]
];
/**
 * 状态词按长度倒序组合，保证“未激活/未开启/未选中”先于“激活/开启/选中”匹配；
 * 否定状态不能被当成肯定状态。
 */
// `/off` 是设计稿标注未选中变体的写法（`B-吹脚/off`）。带斜杠匹配，避免命中散文里的 offset 之类。
export const STATE_WORD_LIST = ['未选中', '未激活', '未开启', '不可用', '加载中', '选中', '默认', '禁用', '置灰', '变灰', '开启', '关闭', '打开', '成功', '失败', '错误', '正常', '异常', '高亮', '激活', '灰', '/off']
	.sort((a, b) => b.length - a.length);
export const STATE_WORDS = new RegExp(`(${STATE_WORD_LIST.join('|')})`);
/** 设计稿原始状态词 → 规范状态；原始定义保留在 state_raw，对应关系不静默改写。 */
const STATE_CANON = { 灰: '置灰', 变灰: '置灰', '/off': '未选中' };
const CONTROL_HINT = /(按钮|按键|开关|图标|滑块|滑条|输入|弹窗|提示|列表|页签|选项|菜单|卡片|调节|入口|开关按键|tab|button|icon|switch)/i;
// 设计稿的修改批注是文字层，内容里提到控件名就会被当成定位图。「1.… 2.…」两条以上编号即批注；
// 小数点不算编号，否则「1.5 2.5」这类温度文本会被误判。
const NUMBERED_ITEM = /(?:^|[\s\n])\d+[.、](?!\d)/g;
const isAnnotation = (object) => object.t === 'TEXT' &&
	(String(object.name || '') + '\n' + (object.texts || []).join('\n')).match(NUMBERED_ITEM)?.length >= 2;

/** 按出现顺序取出状态词；先解析 key=value 变体属性，剥离 =off 否定对后再做词表最长匹配，避免「置灰=off」被误判为「置灰」。 */
export function stateTokens(text) {
	const found = [];
	const push = (val) => {
		if (val && val !== '变体' && val !== 'state_variant' && !found.includes(val)) found.push(val);
	};
	const raw = String(text || '');
	for (const m of raw.matchAll(/([^,=，\s/]+)\s*=\s*(on|off|true|false|是|否|1|0)\b/gi)) {
		const k = m[1].trim();
		const v = /^(?:on|true|是|1)$/i.test(m[2]);
		if (/(?:置灰|变灰|灰)/.test(k)) { if (v) push('置灰'); }
		else if (/禁用/.test(k)) { if (v) push('禁用'); }
		else if (/不可用/.test(k)) { if (v) push('不可用'); }
		else if (/高亮/.test(k)) { if (v) push('高亮'); }
		else if (/选中/.test(k)) push(v ? '选中' : '未选中');
		else if (/激活/.test(k)) push(v ? '激活' : '未激活');
		else if (/(?:开关|开启|状态|打开)/.test(k)) push(v ? '开启' : '关闭');
	}
	const rest = raw.replace(/[^,=，\s/]+\s*=\s*(?:on|off|true|false|是|否|1|0)\b/gi, ' ');
	for (const hit of rest.matchAll(new RegExp(STATE_WORDS.source, 'g'))) {
		const value = STATE_CANON[hit[1]] || hit[1];
		push(value);
	}
	return found;
}

const norm = (value) => String(value || '')
	.replace(/[\s_\-·、，,。.:：;；()（）【】\[\]"'“”‘’]/g, '')
	.toLowerCase();

const idOf = (scope, ...parts) => `${scope}:` + crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);

export function indexFile(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule(), 'ui-index.json');
}

export function loadIndex(dataRoot, projectId) {
	try {
		return JSON.parse(fs.readFileSync(indexFile(dataRoot, projectId), 'utf8'));
	} catch {
		return { version: 0, updatedAt: null, digest: null, sources: [], pages: [], objects: [], stats: {} };
	}
}

function saveIndex(dataRoot, projectId, index) {
	const file = indexFile(dataRoot, projectId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(index), 'utf8');
	return index;
}

function relativeTo(projectDir, file) {
	const rel = path.relative(projectDir, file);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
	return rel.split(path.sep).join('/');
}

/** 组件库 PNG 文件名 `<page>__<name>__<nodeid>.png`；有 index.json 时以其为准。 */
function readLibraryFolders(projectDir) {
	const root = path.join(projectDir, 'design', 'library');
	const folders = [];
	if (!fs.existsSync(root)) return folders;
	for (const folder of fs.readdirSync(root)) {
		const dir = path.join(root, folder);
		let entries = [];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		const components = new Map();
		let fileKey = folder;
		try {
			const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
			fileKey = index.fileKey || folder;
			for (const [nodeId, entry] of Object.entries(index.components || {})) {
				if (!entry?.file) continue;
				const file = path.resolve(projectDir, entry.file);
				if (!file.startsWith(root + path.sep)) continue;
				components.set(nodeId, { file: relativeTo(projectDir, file), name: entry.name || '', page: entry.page || '' });
			}
		} catch {
			// 没有 index.json 的旧图库只按文件名恢复 nodeId，来源留待映射。
		}
		if (components.size === 0) {
			for (const name of entries) {
				if (!name.toLowerCase().endsWith('.png')) continue;
				const match = /__([0-9]+)[_:]([0-9]+)\.png$/i.exec(name);
				if (!match) continue;
				components.set(`${match[1]}:${match[2]}`, { file: relativeTo(projectDir, path.join(dir, name)), name: '', page: '' });
			}
		}
		if (components.size > 0) folders.push({ folder, fileKey, components, mapped: '' });
	}
	return folders;
}

/**
 * 组件库截图必须绑定到所属设计源：同名 nodeId 在多个文档里可能完全不同。
 * 先按 fileKey 精确匹配；旧库没有 fileKey 时按节点重叠率映射，低于一半不猜。
 */
function qualifyLibraryShots(projectDir, sources, nodeIdsBySource) {
	const folders = readLibraryFolders(projectDir);
	const shots = new Map();
	const unmapped = [];
	for (const entry of folders) {
		let sourceId = sources.find((source) => source.fileKey && source.fileKey === entry.fileKey)?.id || '';
		if (!sourceId) {
			let best = { id: '', hits: 0, ratio: 0 };
			for (const source of sources) {
				const known = nodeIdsBySource.get(source.id);
				if (!known?.size) continue;
				let hits = 0;
				for (const nodeId of entry.components.keys()) if (known.has(nodeId)) hits += 1;
				const ratio = hits / entry.components.size;
				if (ratio > best.ratio) best = { id: source.id, hits, ratio };
			}
			if (best.hits >= 3 && best.ratio >= 0.5) sourceId = best.id;
		}
		if (!sourceId) {
			unmapped.push({ folder: entry.folder, fileKey: entry.fileKey, components: entry.components.size });
			continue;
		}
		for (const [nodeId, item] of entry.components) shots.set(`${sourceId}::${nodeId}`, item.file);
	}
	return { shots, unmapped, folders: folders.length };
}

function previewShot(projectDir, source, nodeId) {
	try {
		const { file, cached } = previewFile(projectDir, source, nodeId, true);
		return cached ? relativeTo(projectDir, file) : '';
	} catch {
		return '';
	}
}

const coord = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

/** 节点框；坐标未知或不合法时返回 null，不把未知原点当成 0。 */
function boxOf(row) {
	if (!row) return null;
	const box = { x: coord(row.x), y: coord(row.y), w: coord(row.width ?? row.w), h: coord(row.height ?? row.h) };
	return box.x !== null && box.y !== null && box.w !== null && box.h !== null && box.w > 0 && box.h > 0 ? box : null;
}

/** 目标在截图范围内的归一化框；只露出部分时记录 partial，不靠 clamp 假装完整。 */
function normalizeInside(target, scope) {
	const raw = [(target.x - scope.x) / scope.w, (target.y - scope.y) / scope.h, target.w / scope.w, target.h / scope.h];
	if (!raw.every(Number.isFinite)) return null;
	const left = Math.max(0, raw[0]);
	const top = Math.max(0, raw[1]);
	const right = Math.min(1, raw[0] + raw[2]);
	const bottom = Math.min(1, raw[1] + raw[3]);
	if (!(right > left && bottom > top)) return null;
	const full = raw[0] >= 0 && raw[1] >= 0 && raw[0] + raw[2] <= 1 && raw[1] + raw[3] <= 1;
	return { bounds: [left, top, right - left, bottom - top], visibility: full ? 'full' : 'partial' };
}

/** 组件库里属于该来源（fileKey 一致）的节点截图；fileKey 不明时不猜来源。 */
function libraryShotForNode(projectDir, source, nodeId) {
	if (!source?.fileKey) return '';
	const folder = readLibraryFolders(projectDir).find((entry) => entry.fileKey === source.fileKey);
	return folder?.components.get(nodeId)?.file || '';
}

function roleOf(name, type) {
	for (const [role, pattern] of ROLE_WORDS) if (pattern.test(name)) return role;
	if (type === 'INSTANCE') return 'container';
	if (type === 'TEXT') return 'text';
	return 'container';
}

/** 旧 MCP 导入把节点类型存进了 board_kind；读时归一成语义分类。 */
const BOARD_KIND_ALIAS = { COMPONENT_SET: 'state_variant', COMPONENT: 'component', FRAME: 'runtime_screen', GROUP: 'runtime_screen', SECTION: 'runtime_screen' };
const kindOf = (kind) => BOARD_KIND_ALIAS[kind] || kind || 'runtime_screen';

/** 深浅主题从画板名识别；识别不出留空，不猜。 */
function themeOf(boardName) {
	const name = String(boardName || '');
	if (/(深色|暗色|夜间|dark)/i.test(name)) return 'dark';
	if (/(浅色|亮色|日间|light)/i.test(name)) return 'light';
	return '';
}

/** component_key 可能携带属性（key||props:JSON）；拆开保留原始定义。 */
function componentOf(raw) {
	const value = String(raw || '');
	const at = value.indexOf('||props:');
	if (at < 0) return { key: value, props: null };
	try {
		return { key: value.slice(0, at), props: JSON.parse(value.slice(at + 8)) };
	} catch {
		return { key: value.slice(0, at), props: null };
	}
}

function stateOf(name, boardName, boardKind) {
	const fromName = stateTokens(name || '');
	if (fromName.length) return fromName[0];
	if (boardKind === 'state_variant') {
		const fromBoard = stateTokens(boardName || '');
		return fromBoard.length ? fromBoard[0] : '';
	}
	return '';
}

function stateRawOf(name) {
	const found = STATE_WORDS.exec(name || '');
	return found ? found[1] : '';
}

function textsByNode(db) {
	const map = new Map();
	for (const row of db.prepare('select node_id, text, font_size from texts').all()) {
		const entry = map.get(row.node_id) || { text: [], sizes: [] };
		if (row.text) entry.text.push(String(row.text).slice(0, 200));
		if (row.font_size) entry.sizes.push(row.font_size);
		map.set(row.node_id, entry);
	}
	return map;
}

/**
 * Build the project's UI index: pages, boards, and the objects a test can
 * point at. Rows without a name, text, control-shaped name or instance are
 * decorative and skipped so the index stays queryable.
 */
export function buildIndex(projectDir, projectId, dataRoot, options = {}) {
	const sources = options.sources ?? layerSources(dataRoot, projectId);
	if (sources.length === 0) throw new Error('还没有可用的设计稿索引，请先导入设计稿');
	const failures = [];
	const loaded = [];
	const nodeIdsBySource = new Map();
	for (const source of sources) {
		let db;
		try {
			db = new DatabaseSync(source.db, { readOnly: true });
		} catch (error) {
			failures.push({ source: source.name, reason: String(error.message || error) });
			continue;
		}
		try {
			const pageRows = db.prepare('select page_id as id, name from pages').all();
			const boardRows = db.prepare('select board_id as id, page_id as page, name, width, height, board_kind as kind from boards').all();
			const texts = textsByNode(db);
			const rows = db.prepare(`select node_id as id, name, node_type as type, parent_id as parent, page_id as page,
				board_id as board, semantic_class as semantic, visible, x, y, width, height, component_key as component from nodes`).all();
			loaded.push({ source, pageRows, boardRows, texts, rows });
			nodeIdsBySource.set(source.id, new Set(rows.map((row) => row.id)));
		} catch (error) {
			failures.push({ source: source.name, reason: String(error.message || error) });
		} finally {
			db.close();
		}
	}
	// 组件库按 fileKey / 节点重叠率归属设计源；同 nodeId 跨文档时不再拿第一张。
	const library = qualifyLibraryShots(projectDir, loaded.map((entry) => entry.source), nodeIdsBySource);
	const pages = [];
	const boards = [];
	const objects = [];
	let cached = 0;
	for (const { source, pageRows, boardRows, texts, rows } of loaded) {
		const boardById = new Map(boardRows.map((board) => [board.id, board]));
		const rowById = new Map(rows.map((row) => [row.id, row]));
		const shotCache = new Map();
		const shotOf = (nodeId) => {
			if (!shotCache.has(nodeId)) shotCache.set(nodeId, library.shots.get(`${source.id}::${nodeId}`) || previewShot(projectDir, source, nodeId));
			return shotCache.get(nodeId);
		};
		// 截图依据只有三种：节点自身、能证明包含目标的祖先、包含目标的画板。
		// 兄弟节点或无关同板截图一律不用，缺图保持缺图。
		const basisCache = new Map();
		const basisOf = (row) => {
			if (!row) return null;
			if (basisCache.has(row.id)) return basisCache.get(row.id);
			const own = shotOf(row.id);
			if (own) {
				const basis = { file: own, node: row.id, scope: null, visibility: 'full' };
				basisCache.set(row.id, basis);
				return basis;
			}
			const target = boxOf(row);
			let basis = null;
			if (target) {
				let current = rowById.get(row.parent);
				for (let depth = 0; current && depth < 24; depth += 1) {
					const file = shotOf(current.id);
					const box = file ? boxOf(current) : null;
					const scope = box ? normalizeInside(target, box) : null;
					if (scope) {
						basis = { file, node: current.id, scope: scope.bounds, visibility: scope.visibility };
						break;
					}
					current = rowById.get(current.parent);
				}
			}
			basisCache.set(row.id, basis);
			return basis;
		};
		for (const page of pageRows) {
			pages.push({ id: page.id, source: source.id, name: page.name || page.id });
		}
		for (const board of boardRows) {
			const page = pageRows.find((entry) => entry.id === board.page);
			const box = boardById.has(board.id) ? rowById.get(board.id) : null;
			// 没有 nodes 行时，画板自己的截图仍然可用（截图就是画板本身），但坐标留空。
			const basis = basisOf(box) || (shotOf(board.id) ? { file: shotOf(board.id), node: board.id, scope: null, visibility: 'unknown' } : null);
			const geo = boxOf(box);
			boards.push({
				id: board.id, source: source.id, page: board.page,
				page_name: page?.name || '', name: board.name || '', kind: kindOf(board.kind),
				theme: themeOf(board.name),
				// 画板名里的状态词就是该画板代表的状态；不写它，状态图检索永远找不到画板级状态。
				state: stateOf(board.name || '', board.name || '', kindOf(board.kind)),
				state_raw: stateRawOf(board.name || ''),
				// 画板原点来自 nodes 表（绝对坐标），boards 表本身没有 x/y；未知就留 null，不当作 0。
				x: geo ? geo.x : null, y: geo ? geo.y : null,
				width: geo ? geo.w : (Number(board.width) || null),
				height: geo ? geo.h : (Number(board.height) || null),
				shot: basis?.file || '',
				shot_node: basis?.node || '',
				shot_scope: basis?.scope || null,
				shot_visibility: basis?.visibility || ''
			});
		}
		for (const row of rows) {
			const text = texts.get(row.id);
			const board = boardById.get(row.board) || null;
			const isBoard = row.id === row.board;
			const controlish = CONTROL_HINT.test(row.name || '');
			const meaningful = isBoard || row.type === 'INSTANCE' || (text && text.text.length > 0) ||
				controlish || row.semantic === 'semantic' || row.semantic === 'semantic_candidate';
			if (!meaningful) continue;
			const page = pageRows.find((entry) => entry.id === row.page);
			const basis = basisOf(row);
			if (basis?.file) cached += 1;
			const component = componentOf(row.component);
			objects.push({
				id: `${source.id}::${row.id}`,
				s: source.id,
				n: row.id,
				rev: source.revision,
				page: row.page,
				page_name: page?.name || '',
				board: row.board || '',
				board_name: board?.name || '',
				board_kind: kindOf(board?.kind),
				theme: themeOf(board?.name),
				t: row.type,
				parent: row.parent || '',
				name: row.name || '',
				role: isBoard ? 'board' : roleOf(row.name || '', row.type),
				texts: text ? text.text : [],
				x: coord(row.x), y: coord(row.y), w: coord(row.width), h: coord(row.height),
				vis: Boolean(row.visible),
				component: component.key,
				component_props: component.props,
				state: stateOf(row.name || '', board?.name || '', kindOf(board?.kind)),
				state_raw: stateRawOf(row.name || ''),
				shot: basis?.file || '',
				shot_node: basis?.node || '',
				shot_scope: basis?.scope || null,
				shot_visibility: basis?.visibility || ''
			});
		}
	}
	const byRole = {};
	for (const object of objects) byRole[object.role] = (byRole[object.role] || 0) + 1;
	// 逐源缓存进度：已发现 / 已缓存 / 尚未处理，不把部分完成报成全部完成。
	const cacheBySource = sources.map((source) => {
		const own = objects.filter((object) => object.s === source.id);
		const ownBoards = boards.filter((board) => board.source === source.id);
		return {
			id: source.id, name: source.name,
			discovered: own.length,
			cached: own.filter((object) => object.shot).length,
			pending: own.filter((object) => !object.shot).length,
			boards: ownBoards.length,
			boardsCached: ownBoards.filter((board) => board.shot).length
		};
	});
	const index = {
		version: 3,
		builtAt: new Date().toISOString(),
		sources: sources.map((source) => ({ id: source.id, name: source.name, file: source.file, fileKey: source.fileKey || '', db: source.db, revision: source.revision, pages: pages.filter((page) => page.source === source.id).length })),
		pages,
		boards,
		objects,
		stats: {
			sources: sources.length,
			pages: pages.length,
			boards: boards.length,
			objects: objects.length,
			withScreenshot: objects.filter((object) => object.shot).length,
			boardsWithScreenshot: boards.filter((board) => board.shot).length,
			stateVariants: objects.filter((object) => object.board_kind === 'state_variant' || object.state).length,
			library: { folders: library.folders, unmapped: library.unmapped },
			byRole,
			cacheBySource,
			failures
		}
	};
	index.digest = crypto.createHash('sha256').update(JSON.stringify({ sources: index.sources, pages, boards, objects: objects.map((object) => [object.n, object.name, object.shot, object.parent]) })).digest('hex');
	return saveIndex(dataRoot, projectId, index);
}

export function state(dataRoot, projectId) {
	const index = loadIndex(dataRoot, projectId);
	return {
		available: Boolean(index.digest),
		version: index.version,
		builtAt: index.builtAt,
		digest: index.digest,
		sources: index.sources || [],
		stats: index.stats || {}
	};
}

/** Query objects by text, page, role, source, board, state or theme. */
export function query(index, options = {}) {
	const text = String(options.q || '').trim().toLowerCase();
	const page = String(options.page || '').trim();
	const role = String(options.role || '').trim();
	const source = String(options.source || '').trim();
	const state = String(options.state || '').trim();
	const theme = String(options.theme || '').trim();
	const kind = String(options.kind || '').trim();
	const limit = Math.max(1, Math.min(500, Number(options.limit) || 50));
	const hits = (index.objects || []).filter((object) => {
		if (role && object.role !== role) return false;
		if (source && object.s !== source) return false;
		if (page && object.page_name !== page && object.page !== page) return false;
		if (state && object.state !== state) return false;
		if (theme && object.theme !== theme) return false;
		if (kind && object.board_kind !== kind) return false;
		if (!text) return true;
		return object.name.toLowerCase().includes(text) || object.texts.some((value) => value.toLowerCase().includes(text));
	});
	return { total: hits.length, items: hits.slice(0, limit) };
}

/** 同一对象的状态变体：同组件集或同页同名前缀的兄弟节点；按名称+状态去重。 */
export function variants(index, objectId) {
	const object = (index.objects || []).find((entry) => entry.id === objectId);
	if (!object) return { object: null, items: [] };
	const suffix = new RegExp('[-－—_\\s]*(' + STATE_WORD_LIST.join('|') + ')$');
	const base = object.name.replace(suffix, '');
	const hits = (index.objects || []).filter((entry) => entry.id !== object.id && entry.s === object.s && (
		(object.board_kind === 'state_variant' && entry.board === object.board) ||
		(entry.page === object.page && base.length >= 2 && entry.name.startsWith(base) && entry.name !== object.name &&
			(entry.state || STATE_WORDS.test(entry.name)))
	));
	const seen = new Map();
	for (const entry of hits) {
		const key = entry.name + '|' + entry.state;
		const prior = seen.get(key);
		// 同名同状态保留有截图的那份，供配图直接用。
		if (!prior || (!prior.shot && entry.shot)) seen.set(key, entry);
	}
	return { object: compact(object), items: [...seen.values()].slice(0, 24).map(compact) };
}

const PAGES_IN_TEXT = (index, text) => (index.pages || [])
	.filter((page) => {
		if (!page.name || page.name.length < 2) return false;
		const value = String(text);
		if (!value.includes(page.name)) return false;
		// 「空调」裸名多指设备/功能；只有带界面语境（空调界面/进入空调页）才算点名页面。
		const escaped = page.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(escaped + '(界面|页面|页|屏|App)|进入' + escaped).test(value);
	});

/**
 * 上下文页名：用例标题/前置条件/前序步骤里的页名不需要再写“界面”才算。
 * 这里只提供页面约束，不能单独把泛名控件抬成自动关联。
 */
export function pageHintsIn(index, texts) {
	const value = texts.filter(Boolean).join(' ');
	const names = PAGES_IN_TEXT(index, value).map((page) => page.name);
	for (const page of index.pages || []) {
		if (!page.name || page.name.length < 3) continue;
		if (value.includes(page.name) && !names.includes(page.name)) names.push(page.name);
	}
	return [...new Set(names)];
}

export function roleHintFor(text) {
	const value = String(text || '');
	for (const [role, pattern] of ROLE_WORDS) if (pattern.test(value)) return role;
	if (/(画面|整屏|整页|页面|界面)/.test(value)) return 'board';
	return '';
}

/** 显式命名控件：只取【】/点击短语/控件后缀，不把“观察状态”这类动词当对象。 */
export function namedObjectsIn(text) {
	const value = String(text || '');
	const names = [];
	for (const hit of value.matchAll(/[【\[「“]([^】\]」”]{2,40})[】\]」”]/g)) names.push(hit[1].trim());
	for (const hit of value.matchAll(/(?:点击|单击|按下|长按|轻触|滑动|拖动|选择|进入)\s*[【\[]?([\u4e00-\u9fffA-Za-z0-9]{2,16})/g)) names.push(hit[1].trim());
	for (const hit of value.matchAll(/([\u4e00-\u9fff]{2,12})(?:按钮|按键|开关|图标|滑条|滑块|弹窗|页签)/g)) names.push(hit[1].trim());
	return [...new Set(names.filter((name) => name.length >= 2))];
}

const hasNamedObject = (text) => namedObjectsIn(text).length > 0 || /(按钮|按键|开关|图标|滑块|滑条|弹窗|页签|列表|入口)/.test(String(text || ''));
const pronounStep = (text) => /(?:点击|单击|按下|长按|轻触|滑动|拖动)\s*(?:它|其|该控件|该按钮|此按钮|这个按钮|该开关|此开关|图标)|(?:该|此|上述)(?:按钮|控件|开关|图标|入口)/.test(String(text || ''));

/**
 * 从多个上游关联中挑兼容项。兼容不等于相同目标：必须用途一致、来源可用、
 * 页面/主题/状态不冲突；仍有多个不同目标时返回 conflicted，不允许取第一条。
 */
function compatibleLinks(list, { index, purpose, text = '', context = '', states = [], requireShot = false }) {
	const pageHints = pageHintsIn(index, [text, context]);
	const themes = [/(深色|暗色|夜间|dark)/i.test(text) ? 'dark' : '', /(浅色|亮色|日间|light)/i.test(text) ? 'light' : ''].filter(Boolean);
	const wanted = states.length ? states : stateTokens(text);
	const names = namedObjectsIn(text).map(norm);
	const accepted = [];
	for (const link of list || []) {
		if (!link?.ui_id || !link?.target || link.purpose !== purpose) continue;
		if (!['auto', 'confirmed', 'missing_asset'].includes(link.status) || link.needs_review) continue;
		const check = linkValidity(link, { index, requireShot });
		if (check.status === 'stale' || check.status === 'unknown_source' || check.status === 'missing_subject') continue;
		const target = { ...link.target };
		const current = (index.objects || []).find((object) => object.id === link.ui_id);
		if (current) Object.assign(target, compact(current), { ui_id: link.ui_id, source: current.s, node_id: current.n, revision: current.rev });
		// 人工确认的关联是权威依据：页面/名称/主题以人工决定为准，不再被自动推断的上下文推翻。
		// 状态仍要核对，防止把成功分支带到失败预期。
		const authoritative = link.status === 'confirmed';
		if (!authoritative && pageHints.length && target.page_name && !pageHints.includes(target.page_name)) continue;
		if (!authoritative && themes.length && target.theme && !themes.includes(target.theme)) continue;
		if (!authoritative && names.length && target.name && !names.some((name) => norm(target.name).includes(name) || name.includes(norm(target.name)))) {
			// 上下文点名了另一个具体对象时，不拿同名泛对象顶替。
			if (!names.some((name) => norm(target.name) === name)) continue;
		}
		if (purpose === 'expected' && wanted.length) {
			if (!target.state || !wanted.includes(target.state)) continue;
		}
		accepted.push({ link, target });
	}
	const byUi = new Map();
	for (const item of accepted) {
		const key = [item.target.ui_id, item.target.state || '', item.target.page_name || ''].join('|');
		if (!byUi.has(key)) byUi.set(key, item);
	}
	return [...byUi.values()];
}

function chooseInherited(list, options) {
	const accepted = compatibleLinks(list, options);
	if (accepted.length === 1) return { item: accepted[0] };
	if (accepted.length === 0) return { item: null, reason: list?.length ? '上游关联与当前对象/状态/页面不兼容' : '' };
	const names = namedObjectsIn(options.text || '').map(norm);
	const named = accepted.filter((entry) => names.some((name) => norm(entry.target.name).includes(name) || name.includes(norm(entry.target.name))));
	if (named.length === 1) return { item: named[0] };
	const pages = pageHintsIn(options.index, [options.text, options.context]);
	const paged = accepted.filter((entry) => pages.includes(entry.target.page_name));
	if (paged.length === 1) return { item: paged[0] };
	return { item: null, conflicted: accepted, reason: `上游有 ${accepted.length} 个不同候选，需按当前页面/状态确认` };
}

/** 整页容器：与所在页面同名的实例（如「空调」页里的空调整屏实例），可作页面级答案。 */
const isPageContainer = (object) => object.role === 'container' && norm(object.name) === norm(object.page_name);

/** 显式节点回设计库查祖先/画板截图；只有坐标能证明包含关系时才采用。 */
function explicitShotBasis(projectDir, source, board, row) {
	const own = libraryShotForNode(projectDir, source, row.id) || previewShot(projectDir, source, row.id);
	if (own) return { file: own, node: row.id, scope: null, visibility: 'full' };
	const target = boxOf(row);
	if (!target) return null;
	let db = null;
	try {
		db = new DatabaseSync(source.db, { readOnly: true });
	} catch {
		db = null;
	}
	try {
		let current = row;
		for (let depth = 0; db && current?.parent && depth < 24; depth += 1) {
			const parent = db.prepare('select node_id as id, name, node_type as type, parent_id as parent, page_id as page, board_id as board, x, y, width, height from nodes where node_id = ?').get(current.parent);
			if (!parent) break;
			const file = libraryShotForNode(projectDir, source, parent.id) || previewShot(projectDir, source, parent.id);
			const box = file ? boxOf(parent) : null;
			const scope = box ? normalizeInside(target, box) : null;
			if (scope) return { file, node: parent.id, scope: scope.bounds, visibility: scope.visibility };
			current = parent;
		}
	} catch {
		// 库不可读时继续尝试画板截图。
	} finally {
		db?.close();
	}
	const boardFile = board && (!board.shot_node || board.shot_node === board.id) && board.shot
		? board.shot
		: libraryShotForNode(projectDir, source, board?.id) || previewShot(projectDir, source, board?.id);
	const boardBox = boxOf(board);
	const scope = boardFile && boardBox ? normalizeInside(target, boardBox) : null;
	return scope ? { file: boardFile, node: board.id, scope: scope.bounds, visibility: scope.visibility } : null;
}

/** 显式节点唯一身份：收集所有来源的同一 nodeId 候选，不按数组顺序定案。 */
function explicitNodeCandidates(index, nodeId, options = {}) {
	const exclude = options.exclude instanceof Set ? options.exclude : new Set();
	const hits = new Map();
	for (const object of index.objects || []) {
		if (object.n !== nodeId || exclude.has(object.id)) continue;
		hits.set(object.id, {
			...object,
			rev: object.rev || (index.sources || []).find((source) => source.id === object.s)?.revision || '',
			shot_node: object.shot_node || (object.shot ? object.n : '')
		});
	}
	for (const source of index.sources || []) {
		const id = `${source.id}::${nodeId}`;
		if (hits.has(id) || exclude.has(id) || !source.db) continue;
		let row;
		try {
			const db = new DatabaseSync(source.db, { readOnly: true });
			row = db.prepare('select node_id as id, name, node_type as type, parent_id as parent, page_id as page, board_id as board, x, y, width, height from nodes where node_id = ?').get(nodeId);
			db.close();
		} catch {
			continue;
		}
		if (!row) continue;
		const page = (index.pages || []).find((entry) => entry.id === row.page && entry.source === source.id);
		const board = (index.boards || []).find((entry) => entry.id === row.board && entry.source === source.id);
		const basis = options.projectDir ? explicitShotBasis(options.projectDir, source, board, row) : null;
		hits.set(id, {
			id, s: source.id, n: nodeId, rev: source.revision || '',
			page: row.page, page_name: page?.name || '', board: row.board || '', board_name: board?.name || '',
			board_kind: board?.kind || 'runtime_screen', theme: board?.theme || '', t: row.type,
			parent: row.parent || '', name: row.name || '', role: roleOf(row.name || '', row.type), texts: [],
			x: coord(row.x), y: coord(row.y), w: coord(row.width), h: coord(row.height), vis: true,
			state: stateOf(row.name || '', board?.name || '', board?.kind || ''), state_raw: stateRawOf(row.name || ''),
			shot: basis?.file || '', shot_node: basis?.node || '', shot_scope: basis?.scope || null,
			shot_visibility: basis?.visibility || ''
		});
	}
	return [...hits.values()];
}

/** The five steps of matching, each recording why it kept or dropped a candidate. */
export function match(index, subject = {}, options = {}) {
	const exclude = options.exclude instanceof Set ? options.exclude : new Set(options.exclude || []);
	const text = String(subject.text || '').trim();
	const name = String(subject.name || '').trim();
	const contextText = String(subject.contextText || options.contextText || '').trim();
	const context = { pages: [], states: [], themes: [] };
	for (const page of PAGES_IN_TEXT(index, `${text} ${contextText}`)) context.pages.push(page.name);
	for (const page of Array.isArray(subject.pageHints) ? subject.pageHints : []) {
		if (page && !context.pages.includes(page)) context.pages.push(page);
	}
	context.states = stateTokens(text);
	if (/(深色|暗色|夜间|dark)/i.test(`${text} ${contextText}`)) context.themes.push('dark');
	if (/(浅色|亮色|日间|light)/i.test(`${text} ${contextText}`)) context.themes.push('light');
	const stateHint = subject.stateHint || context.states[0] || '';
	const themeHint = subject.themeHint || context.themes[0] || '';
	// 角色来自当前文字；当前文字没有对象词时，才用关联上下文推断。未知就不限定。
	const roleHint = subject.roleHint || roleHintFor(text) || (contextText ? roleHintFor(contextText) : '');

	// 原文明确给出的设计节点优先：收集全部候选，按来源/页面证据消歧，不按顺序取第一条。
	const explicitNode = /设计节点\s*([0-9]+[:_][0-9]+)/.exec(text);
	if (explicitNode) {
		const nodeId = explicitNode[1].replace('_', ':');
		const raw = explicitNodeCandidates(index, nodeId, { exclude, projectDir: options.projectDir });
		const sourceHints = [subject.source, options.source,
			...(index.sources || []).filter((source) => source.name && source.name.length >= 2 && text.includes(source.name)).map((source) => source.id)]
			.filter(Boolean);
		let candidates = raw;
		if (sourceHints.length) candidates = candidates.filter((object) => sourceHints.includes(object.s));
		if (candidates.length > 1 && context.pages.length) {
			const onPage = candidates.filter((object) => context.pages.includes(object.page_name));
			if (onPage.length) candidates = onPage;
		}
		if (candidates.length > 1) {
			return {
				status: 'ambiguous', explicit: true,
				reason: `设计节点 ${nodeId} 在 ${candidates.length} 个来源/页面存在，需指明来源或页面`,
				context, stateHint, themeHint, target: null,
				candidates: candidates.slice(0, 8).map((object) => ({ ...compact(object), score: 0, reasons: ['原文明确指定设计节点，但候选不唯一'] }))
			};
		}
		if (!candidates.length && raw.length) {
			return {
				status: 'ambiguous', explicit: true,
				reason: `设计节点 ${nodeId} 不在指定来源/页面内，候选在其他来源`,
				context, stateHint, themeHint, target: null,
				candidates: raw.slice(0, 8).map((object) => ({ ...compact(object), score: 0, reasons: ['来源或页面与原文不符'] }))
			};
		}
		const direct = candidates[0];
		if (direct) {
			// 显式节点只负责定位；状态、主题、可见性仍要按关联证据核对。
			const problems = [];
			if (stateHint && direct.state && direct.state !== stateHint) problems.push(`节点状态为「${direct.state_raw || direct.state}」，与预期「${stateHint}」不符`);
			if (themeHint && direct.theme && direct.theme !== themeHint) problems.push(`节点主题为「${direct.theme}」，与预期「${themeHint}」不符`);
			if (direct.vis === false) problems.push('节点在设计稿中不可见');
			if (problems.length) {
				return {
					status: 'ambiguous', explicit: true,
					reason: '原文明确指定设计节点，但' + problems.join('；'),
					context, stateHint, themeHint, target: null,
					candidates: [{ ...compact(direct), score: 1, reasons: ['原文明确指定设计节点', ...problems] }]
				};
			}
			return {
				status: direct.shot ? 'auto' : 'missing_asset',
				explicit: true,
				reason: direct.shot ? '原文明确指定设计节点' : '原文明确指定设计节点；尚无自身/祖先/画板截图，缺图保持缺图',
				context, stateHint, themeHint,
				target: compact(direct),
				candidates: [{ ...compact(direct), score: 1, reasons: ['原文明确指定设计节点'] }]
			};
		}
	}

	const tokens = new Set();
	const bracketTokens = new Set();
	// 信号/报文名（IVI_FrDefButton、IVI_AC _Button 等）里的 Button/Switch 不是控件名，先剔除再提词；
	// 必须含下划线才算信号名，不吞普通英文短语。
	const cleanText = String(text).replace(/[A-Za-z][A-Za-z0-9]*(?:[ _][A-Za-z0-9]+)*_[A-Za-z0-9_ ]*[A-Za-z0-9]/g, ' ');
	if (name) tokens.add(norm(name));
	for (const hit of cleanText.matchAll(/[【\[]([^】\]]{2,20})[】\]]/g)) { tokens.add(norm(hit[1])); bracketTokens.add(norm(hit[1])); }
	for (const hit of cleanText.matchAll(/(?:点击|单击|按下|长按|轻触|滑动|拖动|选择|进入)\s*[【\[]?([\u4e00-\u9fffA-Za-z0-9]{2,12})/g)) tokens.add(norm(hit[1]));
	for (const hit of cleanText.matchAll(/([\u4e00-\u9fff]{2,10})(?:按钮|按键|开关|图标|滑条|滑块|弹窗|列表|页签)/g)) tokens.add(norm(hit[1] + (hit[0].endsWith('按钮') ? '按钮' : hit[0].endsWith('按键') ? '按键' : hit[0].endsWith('开关') ? '开关' : hit[0].endsWith('图标') ? '图标' : '')));
	// “点击它/该按钮”本身没有对象名：调用方明确允许时才从关联上下文补显式命名。
	// 预期句也可能没有对象词（“显示提交成功提示”），不能拿操作控件名冒充预期对象。
	if (tokens.size === 0 && contextText && subject.useContextTokens === true) {
		for (const objectName of namedObjectsIn(contextText)) {
			const token = norm(objectName);
			if (token.length >= 2) { tokens.add(token); bracketTokens.add(token); }
		}
	}
	// 项目别名：需求写「快速除雾」、设计稿叫「前除雾/除霜」。只对显式命名展开变体，
	// 简化名只用于找候选，完全一致的原名仍然得分最高。
	for (const token of [...bracketTokens]) {
		for (const variant of queryVariants(token)) {
			const value = norm(variant);
			if (value.length >= 2) { tokens.add(value); bracketTokens.add(value); }
		}
	}

	if (tokens.size === 0) {
		const haystack = norm(cleanText);
		for (const object of index.objects || []) {
			const name = norm(object.name);
			// 兜底只认控件形状的名称；「空调」「开关」这类泛名靠包含命中会大量同分，不引入。
			if (name.length >= 2 && name.length <= 12 && CONTROL_HINT.test(object.name) && haystack.includes(name)) tokens.add(name);
			if (tokens.size >= 24) break;
		}
	}
	const pool = index.objects || [];
	const scored = [];
	for (const object of pool) {
		if (exclude.has(object.id) || isAnnotation(object)) continue;
		const objectName = norm(object.name);
		const objectText = object.texts.map(norm).join(' ');
		let score = 0;
		const reasons = [];
		const nameHits = [];
		for (const token of tokens) {
			if (!token || token.length < 2) continue;
			if (objectName === token) { score = Math.max(score, 0.95); reasons.push('名称完全一致'); nameHits.push(token); continue; }
			if (objectName && (objectName.includes(token) || token.includes(objectName))) {
				// 泛名（空调/开关/弹窗…）只认显式命名，靠包含命中会拿整页冒充控件。
				const generic = objectName.length <= 3 && !CONTROL_HINT.test(object.name);
				if (generic && !bracketTokens.has(token)) continue;
				// 短名被长 token 反向包含（【内循环/外循环】命中「开关」）同样不算证据。
				if (objectName.length <= 3 && token.includes(objectName) && objectName !== token && !bracketTokens.has(objectName)) continue;
				score = Math.max(score, 0.7); reasons.push('名称包含'); nameHits.push(token);
			}
			if (objectText && objectText.includes(token)) { score = Math.max(score, 0.6); reasons.push('可见文本一致'); }
		}
		if (score === 0) {
			// 原文点名了页面：与页面同名的画板/整页容器就是页面本身，可作页面级候选。
			if (context.pages.includes(object.page_name) && norm(object.name) === norm(object.page_name) &&
				(object.role === 'board' || isPageContainer(object))) { score = 0.7; reasons.push('页面点名'); }
			else continue;
		}
		// 【】内是需求显式命名的对象，比区域/泛名更可信。
		if ([...bracketTokens].some((token) => token.length >= 2 && (objectName === token || objectName.includes(token)))) { score += 0.15; reasons.push('显式命名一致'); }
		if (/(栏|区域)$/.test(object.name)) { score -= 0.1; reasons.push('区域非控件'); }
		if (roleHint && object.role === roleHint) { score += 0.06; reasons.push('控件角色一致'); }
		if (modifierSuffix(object.name, tokens)) { score += 0.08; reasons.push('名称尾部一致'); }
		if (/^模式[=＝]/.test(object.name)) score -= 0.08;
		if (stateHint && object.state === stateHint) { score += 0.16; reasons.push('状态一致'); }
		if (stateHint && object.state && object.state !== stateHint) { score -= 0.12; reasons.push('状态不符'); }
		if (themeHint && object.theme === themeHint) { score += 0.08; reasons.push('主题一致'); }
		if (themeHint && object.theme && object.theme !== themeHint) { score -= 0.2; reasons.push('主题不符'); }
		const pageHit = context.pages.find((pageName) => object.page_name === pageName);
		if (pageHit) { score += 0.12; reasons.push('页面一致'); }
		if (object.vis) { score += 0.02; reasons.push('可见'); }
		// 预期句点名了状态：没有该状态的画板/页面不能冒充状态图。
		if (options.purpose === 'expected' && stateHint && object.state !== stateHint) continue;
		if (object.role === 'button' || object.role === 'switch' || object.role === 'icon') score += 0.02;
		// 原文显式命名了控件、候选却一个都没对上：多半是区域/页面兜底，降权；画板/整页容器除外。
		if (object.role !== 'board' && !isPageContainer(object) && bracketTokens.size && ![...bracketTokens].some((token) => objectName.includes(token) || objectText.includes(token))) { score -= 0.2; reasons.push('显式命名未命中'); }
		// 同分时优先有本地截图的实例，让配图能直接落地；差异极小，不改变排序语义。
		if (object.shot) score += 0.005;
		// 不封顶：页面/状态/主题的差异要能拉开同分候选，否则上下文白算了。
		scored.push({ object, score: Number(score.toFixed(3)), reasons: [...new Set(reasons)], nameHits });
	}
	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, 8);
	const usable = top.filter((entry) => entry.score >= 0.6);
	// 同族候选：只有同页同名（含 A-/B- 变体）才是同一对象的不同实例；
	// 跨页同名只在“资料参考”用途允许复用，操作位置/预期必须落在当前页面实例。
	const familyOf = (object) => norm(object.name.replace(/^[AB][-－—_]/, '')) + '@' + object.page;
	if (usable[0] && usable[1] && !usable[0].object.shot && familyOf(usable[0].object) === familyOf(usable[1].object)) {
		const at = usable.findIndex((entry) => entry.object.shot && familyOf(entry.object) === familyOf(usable[0].object));
		if (at > 0) usable.unshift(usable.splice(at, 1)[0]);
	}
	// 组件库同名组件散布在多页：仅资料参考可按名称复用有截图实例，不能给控件位置定案。
	if (options.purpose === 'reference' && usable[0] && !usable[0].object.shot && norm(usable[0].object.name).length >= 4) {
		const baseName = norm(usable[0].object.name.replace(/^[AB][-－—_]/, ''));
		const at = usable.findIndex((entry) => entry.object.shot && norm(entry.object.name.replace(/^[AB][-－—_]/, '')) === baseName);
		if (at > 0) usable.unshift(usable.splice(at, 1)[0]);
	}
	const best = usable[0];
	const second = usable[1];

	let status = 'unmatched';
	let target = null;
	let reason = '没有名称、文本或页面能对上';
	if (best) {
		const gap = best.score - (second?.score || 0);
		// 名称证据只有泛名（空调/打开/时间…）且非原文显式命名：上下文加分不能把它抬成自动关联；
		// 但需求参考/页面用途指向画板或整页容器（与页面同名的实例）是合理答案，不受此限。
		const pageContainer = isPageContainer(best.object);
		const boardAnswer = (best.object.role === 'board' || pageContainer) && ['reference', 'page'].includes(options.purpose);
		const shortGeneric = norm(best.object.name).length <= 3 && !CONTROL_HINT.test(best.object.name);
		// 名字整体就是角色词时没有控件辨识度。泛名判定不能只数字数：`button` 有 6 个字母，和「按钮」一样泛指。
		const bareRoleName = ROLES.map(norm).includes(norm(best.object.name));
		// 短泛名（按钮/菜单/时间…）没被原文【】点名时，文本命中也不足以定案。
		const genericOnly = !boardAnswer && shortGeneric && !bracketTokens.has(norm(best.object.name)) &&
			(best.nameHits.length === 0 || best.nameHits.every((token) => token.length <= 3 && !bracketTokens.has(token)));
		// 短泛名控件（开关/输入…）同名跨页到处都是：原文带页面语境时，候选必须就在该页；
		// 组件库描述（「车辆设置组件库中存在…」）里的页面名只是出处，不约束组件所在页。
		const libraryFact = /组件库|组件中存在/.test(text);
		const noPageProof = !boardAnswer && !libraryFact && shortGeneric && context.pages.length > 0 && !context.pages.includes(best.object.page_name);
		// 泛名控件连页面语境都没有（如 Dock栏【开关】）：同名对象遍布多页，不自动定案。
		const noPageContext = !boardAnswer && !libraryFact && shortGeneric && context.pages.length === 0;
		// 具体控件也一样：原文说「空调界面提供温度调节条」，不能拿桌面上的同名组件定案。
		const crossPage = !boardAnswer && !libraryFact && !shortGeneric && context.pages.length > 0 &&
			!context.pages.includes(best.object.page_name) && best.nameHits.length > 0;
		// 同族同分不算歧义：同页同名；跨页同名只对资料参考算同族。
		const baseNameOf = (object) => norm(object.name.replace(/^[AB][-－—_]/, ''));
		const sameFamily = second && (familyOf(best.object) === familyOf(second.object) ||
			(options.purpose === 'reference' && baseNameOf(best.object).length >= 4 &&
				baseNameOf(best.object) === baseNameOf(second.object)));
		// 原文显式命名了控件，最优候选却一个都没命中：不能拿区域/入口兜底当答案；
		// 画板/整页容器本身就是页面答案（page 用途），不受此限。
		const bestName = norm(best.object.name);
		const bestText = best.object.texts.map(norm).join(' ');
		const explicitMiss = best.object.role !== 'board' && !pageContainer && bracketTokens.size > 0 && ![...bracketTokens].some((token) => bestName.includes(token) || bestText.includes(token));
		if (best.score >= 0.75 && (gap >= 0.1 || !second || sameFamily) && !genericOnly && !bareRoleName && !explicitMiss && !noPageProof && !crossPage && !noPageContext) {
			status = 'auto';
			target = best.object;
			reason = best.reasons.join('、') + (sameFamily && gap < 0.1 ? '（同组件变体，取有截图实例）' : '');
		} else {
			status = 'ambiguous';
			reason = genericOnly || bareRoleName ? '仅命中泛名节点，需要更具体的控件名或页面' : (noPageProof || crossPage) ? '候选控件不在原文点名的页面，需人工确认' : noPageContext ? '泛名控件缺少页面语境，需人工确认' : explicitMiss ? '原文点名的控件未命中，候选只是区域/入口' : second ? `候选接近（${best.score} / ${second.score}）` : '仅一个候选但证据不足';
		}
	}
	if (target && !target.shot) {
		status = 'missing_asset';
		reason = '已找到控件，但没有本地截图';
	}
	return {
		status,
		reason,
		context,
		stateHint,
		themeHint,
		target: target ? compact(target) : null,
		candidates: top.map((entry) => ({ ...compact(entry.object), score: entry.score, reasons: entry.reasons }))
	};
}

function modifierSuffix(name, tokens) {
	const value = norm(name);
	for (const token of tokens) {
		if (token.length >= 3 && value.endsWith(token) && value.length <= token.length + 2) return true;
	}
	return false;
}

export function compact(object) {
	return {
		ui_id: object.id, source: object.s, node_id: object.n, revision: object.rev || object.revision || '',
		name: object.name,
		page: object.page, page_name: object.page_name, board: object.board, board_name: object.board_name,
		board_kind: object.board_kind, role: object.role, state: object.state, state_raw: object.state_raw || '',
		theme: object.theme || '', shot: object.shot || '',
		// 截图依据：shot_node 是图片所属节点（自身/祖先/画板），shot_scope 为归一化标框。
		shot_node: object.shot_node || (object.shot ? object.n : ''),
		shot_scope: object.shot_scope || null,
		shot_visibility: object.shot_visibility || (object.shot ? 'full' : ''),
		x: object.x, y: object.y, w: object.w, h: object.h,
		texts: (object.texts || []).slice(0, 4)
	};
}

/* ------------------------------------------------------------- validity */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const pngChecks = new Map();

function crc32(buffer) {
	let value = 0xffffffff;
	for (const byte of buffer) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
	}
	return (value ^ 0xffffffff) >>> 0;
}

/**
 * 实际解码校验：校验签名、块边界与 CRC、IHDR/IDAT/IEND，并解压 IDAT，
 * 非隔行图再核对解压后的每行长度与过滤字节。只改文件头、截断或伪 PNG 都会失败。
 * 结果按路径+尺寸+修改时间缓存，避免同一截图在 derive/覆盖/挂图中反复解压。
 */
function projectFilePath(projectDir, relative) {
	const base = path.resolve(projectDir);
	const file = path.resolve(base, String(relative || ''));
	if (!relative || path.isAbsolute(String(relative)) || !file.startsWith(base + path.sep)) return '';
	return file;
}

export function decodePng(file) {
	let stat;
	try {
		stat = fs.statSync(file);
	} catch {
		return false;
	}
	if (!stat.isFile() || stat.size <= 0) return false;
	const key = `${file}|${stat.size}|${stat.mtimeMs}`;
	if (pngChecks.has(key)) return pngChecks.get(key);
	let ok = false;
	let buffer = null;
	try {
		buffer = fs.readFileSync(file);
		ok = buffer.length > 33 && buffer.subarray(0, 8).equals(PNG_MAGIC);
		let offset = 8;
		let width = 0;
		let height = 0;
		let depth = 0;
		let color = -1;
		let interlace = 0;
		let sawHeader = false;
		let sawEnd = false;
		const idat = [];
		while (ok && offset + 12 <= buffer.length) {
			const length = buffer.readUInt32BE(offset);
			const type = buffer.toString('ascii', offset + 4, offset + 8);
			const end = offset + 12 + length;
			if (end > buffer.length) { ok = false; break; }
			const data = buffer.subarray(offset + 8, offset + 8 + length);
			const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
			if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) { ok = false; break; }
			if (!sawHeader) {
				if (type !== 'IHDR' || length !== 13) { ok = false; break; }
				sawHeader = true;
				width = data.readUInt32BE(0);
				height = data.readUInt32BE(4);
				depth = data[8];
				color = data[9];
				interlace = data[12];
				if (!width || !height || !PNG_CHANNELS[color] || ![1, 2, 4, 8, 16].includes(depth)) { ok = false; break; }
			} else if (type === 'IDAT') {
				idat.push(data);
			} else if (type === 'IEND') {
				sawEnd = true;
				break;
			}
			offset = end;
		}
		if (ok && sawHeader && sawEnd && idat.length) {
			const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 512 * 1024 * 1024 });
			if (interlace === 0) {
				const channels = PNG_CHANNELS[color];
				const rowBytes = Math.ceil(width * channels * depth / 8) + 1;
				ok = raw.length === rowBytes * height;
				for (let row = 0; ok && row < height; row += 1) ok = raw[row * rowBytes] <= 4;
				// PNG 不能只有文件头：至少要有可解压的像素数据。
				ok = ok && raw.length > 0;
			}
		} else {
			ok = false;
		}
	} catch {
		ok = false;
	} finally {
		buffer = null;
	}
	if (pngChecks.size > 4096) pngChecks.clear();
	pngChecks.set(key, ok);
	return ok;
}

/**
 * 共享有效性：derive / coverage / 配图 / 交付都按同一套规则判断。
 * 返回 usable（是否可自动挂图并计覆盖）、located、hasShot 与具体原因。
 */
export function linkValidity(link, options = {}) {
	const index = options.index;
	const reasons = [];
	const result = { usable: false, located: Boolean(link?.ui_id && link?.target), hasShot: false, status: 'unlocated', reasons };
	if (options.subjectExists === false) {
		result.status = 'missing_subject';
		reasons.push('业务对象、步骤或预期项已不存在');
		return result;
	}
	if (!link?.ui_id || !link?.target) {
		reasons.push(link?.reason || '没有已定位的界面对象');
		return result;
	}
	const bad = ['rejected', 'stale', 'review', 'ambiguous'].includes(link.status);
	if (bad || link.needs_review) {
		result.status = link.needs_review ? 'review' : link.status;
		reasons.push(link.reason || (link.status === 'rejected' ? '已被人工否定' : '关联需要复核'));
		return result;
	}
	if (!['auto', 'confirmed'].includes(link.status)) {
		result.status = link.status || 'unverified';
		reasons.push(link.reason || '关联状态不是当前有效');
		return result;
	}
	const target = link.target;
	const sourceId = target.source || String(link.ui_id || '').split('::')[0];
	const source = (index?.sources || []).find((entry) => entry.id === sourceId || entry.name === sourceId);
	if (!source) {
		result.status = 'unknown_source';
		reasons.push('关联来源不在当前项目索引中');
		return result;
	}
	if (target.revision && source.revision && target.revision !== source.revision) {
		result.status = 'stale';
		reasons.push('设计来源版本已变化，需要重新关联');
		return result;
	}
	const object = (index?.objects || []).find((entry) => entry.id === link.ui_id);
	// 索引对象比关联快照新：用途按当前索引判断，避免旧截图/旧状态继续生效。
	const current = object ? { ...target, ...compact(object) } : target;
	const shot = current.shot || '';
	const needShot = options.requireShot !== false;
	result.hasShot = Boolean(shot);
	if (!shot) {
		result.status = needShot ? 'missing_asset' : 'located';
		result.usable = !needShot;
		reasons.push('已定位对象，但没有自身/祖先/画板截图');
		return result;
	}
	if (options.projectDir && !(projectFilePath(options.projectDir, shot) && decodePng(projectFilePath(options.projectDir, shot)))) {
		result.hasShot = false;
		result.status = needShot ? 'missing_asset' : 'located';
		result.usable = !needShot;
		reasons.push('截图文件不存在或不是可解码的 PNG');
		return result;
	}
	const visibility = current.shot_visibility || 'full';
	if (needShot && visibility === 'partial') {
		result.status = 'partial';
		reasons.push('截图只包含目标的一部分，不能算完整覆盖');
		return result;
	}
	if (options.text && index) {
		const pages = PAGES_IN_TEXT(index, options.text).map((page) => page.name);
		if (pages.length && current.page_name && !pages.includes(current.page_name) && link.purpose !== 'reference') {
			result.status = 'page_mismatch';
			reasons.push(`截图对象位于「${current.page_name}」，不在原文点名的页面`);
			return result;
		}
	}
	if (link.purpose === 'expected') {
		const wanted = options.states || stateTokens(options.text || '');
		if (wanted.length) {
			if (!current.state) {
				result.status = 'state_unverified';
				reasons.push(`预期要求「${wanted.join('/')}」，但对象没有可核实的状态`);
				return result;
			}
			if (!wanted.includes(current.state)) {
				result.status = 'state_mismatch';
				reasons.push(`截图状态「${current.state}」与预期「${wanted.join('/')}」不符`);
				return result;
			}
		}
	}
	result.usable = true;
	result.status = 'valid';
	return result;
}

/**
 * 视觉关联是否仍可复用：节点/状态/来源版本/原图摘要任一变化即失效。
 * 只判断依据是否过期；是否满足当前文本约束仍交给 linkValidity。
 */
export function visionLinkFresh(link, options = {}) {
	const evidence = link?.vision_evidence;
	if (link?.method !== 'vision' || link?.status !== 'auto' || !evidence?.candidate || !link.ui_id) return false;
	const index = options.index;
	const object = (index?.objects || []).find((entry) => entry.id === link.ui_id);
	if (!object) return false;
	const candidate = evidence.candidate;
	if (candidate.revision && (object.rev || object.revision) && candidate.revision !== (object.rev || object.revision)) return false;
	if (candidate.state !== undefined && (object.state || '') !== (candidate.state || '')) return false;
	if (options.projectDir && candidate.shot) {
		const file = projectFilePath(options.projectDir, candidate.shot);
		if (!file || !fs.existsSync(file) || !decodePng(file)) return false;
		if (candidate.shot_sha256) {
			try {
				if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== candidate.shot_sha256) return false;
			} catch {
				return false;
			}
		}
	}
	return true;
}

/* ---------------------------------------------------------------- links */

export function linksFile(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule(), 'ui-links.json');
}

export function loadLinks(dataRoot, projectId) {
	try {
		return JSON.parse(fs.readFileSync(linksFile(dataRoot, projectId), 'utf8'));
	} catch {
		return { version: 0, updatedAt: null, items: [] };
	}
}

export function saveLinks(dataRoot, projectId, items, meta = {}) {
	const file = linksFile(dataRoot, projectId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const document = { version: 1, updatedAt: new Date().toISOString(), ...meta, items };
	fs.writeFileSync(file, JSON.stringify(document, null, 1), 'utf8');
	return document;
}

export function linkKey(subject, purpose) {
	return [subject.kind, subject.id, subject.step_id || '', subject.expected_id || '', purpose].join('|');
}

/**
 * Derive links for facts, contracts, points and case steps. Existing human
 * decisions win; rejected candidates stay rejected (negative memory).
 */
export function derive(dataRoot, projectId, documents, options = {}) {
	const index = loadIndex(dataRoot, projectId);
	if (!index.digest) throw new Error('还没有 UI 索引，请先建立');
	const projectDir = path.join(dataRoot, 'projects', projectId);
	const previous = options.links || loadLinks(dataRoot, projectId);
	const byKey = new Map(previous.items.map((item) => [linkKey(item.subject, item.purpose), item]));
	const byLinkId = new Map(previous.items.map((item) => [item.link_id, item]));
	const factById = new Map((documents.facts?.items || []).map((fact) => [fact.fact_id, fact]));
	const contractById = new Map((documents.contracts?.items || []).map((contract) => [contract.contract_id, contract]));
	const pointById = new Map((documents.points?.items || []).map((point) => [point.point_id, point]));
	const pointContext = (point) => {
		if (!point) return { text: '', pageHints: [], controlName: '', roleHint: '' };
		const contracts = (point.contract_refs || []).map((id) => contractById.get(id)).filter(Boolean);
		const facts = (point.fact_refs || []).map((id) => factById.get(id)).filter(Boolean);
		const contractText = contracts.map((contract) => [contract.title, contract.condition, contract.trigger, contract.expected].join(' ')).join(' ');
		const factText = facts.map((fact) => fact.statement).join(' ');
		const text = [point.requirement, point.condition, point.action, point.expected, contractText, factText].filter(Boolean).join(' ');
		const actionNames = namedObjectsIn([point.action, ...contracts.map((contract) => contract.trigger)].filter(Boolean).join(' '));
		return {
			text,
			contracts, facts,
			pageHints: pageHintsIn(index, [point.requirement, point.condition, point.action, contractText, factText]),
			controlName: actionNames[0] || '',
			roleHint: roleHintFor(point.action || '') || roleHintFor(text)
		};
	};
	// 负面记忆按对象+用途限定：某对象拒绝过的节点不会在整个模块被禁用。
	const rejectedFor = (subject, purpose) => new Set(previous.items
		.filter((item) => item.status === 'rejected' && item.purpose === purpose &&
			item.subject.kind === subject.kind && item.subject.id === subject.id &&
			(item.subject.step_id || '') === (subject.step_id || '') &&
			(item.subject.expected_id || '') === (subject.expected_id || ''))
		.flatMap((item) => [item.ui_id, item.rejected_ui_id]).filter(Boolean));
	const matchOptionsFor = (subject, purpose) => ({ exclude: rejectedFor(subject, purpose), projectDir });
	const next = new Map();
	const add = (subject, outcome, purpose, targetOverride = null, inheritedFrom = null) => {
		const key = linkKey(subject, purpose);
		const existing = byKey.get(key);
		if (existing?.status === 'confirmed') { next.set(key, existing); return existing; }
		// 有效期内的视觉依据优先于规则重算；失效后交给下面的常规匹配标记过期/复核。
		if (existing?.method === 'vision' && existing.status === 'auto' &&
			(existing.subject?.name || '') === (subject.name || '') &&
			visionLinkFresh(existing, { index, projectDir })) {
			next.set(key, existing);
			return existing;
		}
		// 继承来的纠正只要源头没变就保留，不被重新匹配冲掉；
		// 源头看本轮新推导的关联（找不到才退回上一轮），避免继承更新慢一轮导致不幂等。
		if (!targetOverride && existing?.inherited_from && existing.status !== 'rejected') {
			const sourceId = inheritedFrom || existing.inherited_from;
			let sourceLink = null;
			for (const entry of next.values()) if (entry.link_id === sourceId) { sourceLink = entry; break; }
			if (!sourceLink) sourceLink = byLinkId.get(sourceId);
			if (sourceLink && sourceLink.ui_id === existing.ui_id && sourceLink.status !== 'rejected') { next.set(key, existing); return existing; }
		}
		const target = targetOverride || outcome.target;
		if (!target) {
			// 原来有目标但这次没匹配上：节点还在就保留待复核，节点没了才标过期，不静默丢关联。
			if (existing?.ui_id && existing.target && !targetOverride) {
				const stillThere = (existing.explicit && outcome.explicit) ||
					(index.objects || []).some((object) => object.id === existing.ui_id);
				const kept = { ...existing, status: stillThere ? 'review' : 'stale',
					reason: stillThere ? '本轮未再匹配上，保留原关联待复核' : '设计节点已不存在，请重新匹配', updated_at: new Date().toISOString() };
				next.set(key, kept);
				return kept;
			}
			next.set(key, { link_id: existing?.link_id || idOf('L', key), subject, purpose, target: null, status: outcome.status === 'ambiguous' ? 'ambiguous' : 'missing', method: 'auto', confidence: 0, reason: outcome.reason, candidates: outcome.candidates?.slice(0, 4) || [], updated_at: new Date().toISOString() });
			return null;
		}
		if (rejectedFor(subject, purpose).has(target.ui_id)) return null;
		const item = {
			link_id: existing?.link_id || idOf('L', key), subject, purpose,
			ui_id: target.ui_id, target,
			// 找到控件但没截图是部分匹配（缺素材），不能计为正确。
			status: outcome.status === 'missing_asset' ? 'missing_asset' : 'auto', method: inheritedFrom ? 'inherit' : 'auto', confidence: outcome.status === 'auto' ? 0.85 : 0.6,
			reason: outcome.reason, evidence: outcome.candidates?.slice(0, 3)?.map((entry) => ({ ui_id: entry.ui_id, score: entry.score, reasons: entry.reasons })) || [],
			updated_at: new Date().toISOString()
		};
		if (inheritedFrom) item.inherited_from = inheritedFrom;
		// 显式节点可能没进索引（回设计库查到的），标记出来供版本核对与配图识别。
		if (outcome.explicit) item.explicit = true;
		next.set(key, item);
		return item;
	};

	// Facts: the page/control they talk about; 纯接口/信号事实只保留资料追溯。
	for (const fact of documents.facts?.items || []) {
		if (uiApplicability(fact.statement).level !== 'required') continue;
		const subject = { kind: 'fact', id: fact.fact_id, name: fact.statement.slice(0, 40) };
		const outcome = match(index, { text: fact.statement, name: '', roleHint: '' }, { ...matchOptionsFor(subject, 'reference'), purpose: 'reference' });
		add(subject, outcome, 'reference');
	}
	// Contracts: precondition page, trigger control, expected state.
	for (const contract of documents.contracts?.items || []) {
		const factText = (contract.fact_refs || [])
			.map((id) => documents.facts?.items?.find((fact) => fact.fact_id === id)?.statement || '')
			.join(' ');
		const subject = { kind: 'contract', id: contract.contract_id, name: contract.title };
		if (uiApplicability(`${contract.trigger} ${contract.title}`, factText).level === 'required') {
			const operation = match(index, { text: `${contract.trigger} ${contract.title} ${factText}`, name: '', roleHint: 'button' }, { ...matchOptionsFor(subject, 'control'), purpose: 'control' });
			add(subject, operation, 'control');
		}
		if (uiApplicability(contract.expected, `${contract.condition} ${contract.trigger} ${factText}`).level === 'required') {
			const key = linkKey(subject, 'expected');
			const existing = byKey.get(key);
			if (existing?.method === 'vision' && existing.status === 'auto' &&
				(existing.subject?.name || '') === (subject.name || '') &&
				visionLinkFresh(existing, { index, projectDir }) &&
				linkValidity(existing, {
					index, projectDir, text: `${contract.condition || ''} ${contract.expected || ''}`,
					states: stateTokens(contract.expected), needShot: true
				}).usable) {
				next.set(key, existing);
			} else {
				const expected = match(index, { text: `${contract.expected} ${contract.title}`, name: '', stateHint: '' }, { ...matchOptionsFor(subject, 'expected'), purpose: 'expected' });
				add(subject, expected, 'expected');
			}
		}
		const conditionText = `${contract.condition} ${contract.trigger}`;
		const namesPage = (index.pages || []).some((page) => page.name && page.name.length >= 2 && conditionText.includes(page.name));
		if (namesPage || /(界面|页面|屏幕)/.test(conditionText)) {
			const page = match(index, { text: `${contract.condition} ${contract.trigger} ${contract.title}`, name: '', roleHint: 'board' }, { ...matchOptionsFor(subject, 'page'), purpose: 'page' });
			add(subject, page, 'page');
		}
	}
	// Points inherit their contracts. 多合同/多状态时收集全部上游关联逐项兼容，
	// 不能因为数组顺序取第一条；仍冲突就保留 ambiguous。
	if (documents.contracts?.items && documents.points?.items) {
		const linkByContract = new Map();
		for (const item of next.values()) {
			if (item.subject.kind !== 'contract' || !item.ui_id) continue;
			const list = linkByContract.get(item.subject.id) || [];
			list.push(item);
			linkByContract.set(item.subject.id, list);
		}
		for (const point of documents.points.items) {
			const sources = (point.contract_refs || []).flatMap((id) => linkByContract.get(id) || []);
			const context = pointContext(point);
			const subject = { kind: 'point', id: point.point_id, name: point.requirement };
			for (const purpose of ['page', 'control', 'expected']) {
				const text = purpose === 'control' ? point.action : purpose === 'expected' ? point.expected : `${point.condition} ${point.requirement}`;
				const picked = chooseInherited(sources, { index, purpose, text, context: context.text, states: purpose === 'expected' ? stateTokens(point.expected) : [], requireShot: false });
				if (picked.item) {
					add(subject, { status: 'auto', target: picked.item.target, reason: picked.item.link.reason || '继承合同关联', candidates: [] }, purpose, null, picked.item.link.link_id);
				} else if (picked.conflicted?.length) {
					add(subject, {
						status: 'ambiguous',
						reason: picked.reason,
						candidates: picked.conflicted.map((entry) => ({ ...compact(entry.target), score: 0, reasons: [entry.link.reason || '上游合同关联'] }))
					}, purpose);
				} else {
					// 视觉共识上提的测试点依据没有合同来源，仍需在原文/状态/截图仍成立时保留。
					const existing = byKey.get(linkKey(subject, purpose));
					if (existing?.method === 'vision' && existing.status === 'auto' &&
						(existing.subject?.name || '') === (subject.name || '') &&
						visionLinkFresh(existing, { index, projectDir }) &&
						linkValidity(existing, {
							index, projectDir,
							text: purpose === 'expected' ? `${point.condition || ''} ${point.expected || ''}` : text,
							states: purpose === 'expected' ? stateTokens(point.expected) : [], needShot: true
						}).usable) {
						next.set(linkKey(subject, purpose), existing);
					}
				}
			}
		}
	}
	// 测试点关联按用途供用例继承；状态图只传给状态一致的预期，不带错分支。
	const pointLinks = new Map();
	for (const item of next.values()) {
		if (item.subject.kind !== 'point' || !item.ui_id) continue;
		const list = pointLinks.get(item.subject.id) || {};
		if (!list[item.purpose]) list[item.purpose] = [];
		list[item.purpose].push(item);
		pointLinks.set(item.subject.id, list);
	}
	// Case steps and expected items: match the sentence plus the page / prerequisite /
	// point / contract context, so “点击它” knows what “它” is and同名控件不串页。
	for (const item of documents.cases?.items || []) {
		if (!item.step_items) structureCase(item);
		const structure = documents.structure || {};
		const steps = item.step_items || structure[item.case_id]?.steps || [];
		const point = pointById.get(item.point_id);
		const pctx = pointContext(point);
		const inherited = pointLinks.get(item.point_id) || {};
		const baseContext = [item.title, item.precondition, item.prepare_detail, pctx.text].filter(Boolean).join(' ');
		const casePages = pageHintsIn(index, [item.title, item.precondition, item.prepare_detail, ...(item.prepare_detail ? [] : []), pctx.text]);
		const priorText = [item.title || ''];
		for (const step of steps) {
			const applicability = uiApplicability(step.text, priorText.join(' '));
			const navigation = priorText.join(' ');
			priorText.push(step.text || '');
			if (applicability.level !== 'required') continue;
			const contextText = [baseContext, navigation].filter(Boolean).join(' ');
			const pronoun = pronounStep(step.text) || (!hasNamedObject(step.text) && /(?:点击|单击|按下|长按|轻触|滑动|拖动|选择)[^。；;]*$/.test(step.text));
			const contextName = pronoun ? pctx.controlName : '';
			const localPages = pageHintsIn(index, [item.title, item.precondition, navigation, pctx.text]);
			const pageHints = [...new Set([...localPages, ...casePages])];
			const subject = { kind: 'case_step', id: item.case_id, step_id: step.id, name: (step.text || '').slice(0, 40) };
			const outcome = match(index, {
				text: step.text, name: contextName, roleHint: roleHintFor(step.text) || (contextName ? pctx.roleHint : ''),
				pageHints: [...new Set(pageHints)], contextText, useContextTokens: pronoun
			}, { ...matchOptionsFor(subject, 'control'), purpose: 'control' });
			const link = add(subject, outcome, 'control');
			// 句子本身没对上时，只有当前步骤确实操作用户已确认的控件、或明确点名该控件，才继承。
			if (!link?.ui_id) {
				const picked = chooseInherited(inherited.control || [], {
					index, purpose: 'control', text: step.text, context: contextText, requireShot: false
				});
				const targetName = picked.item?.target?.name || '';
				const actsOnTarget = targetName && (
					pronounStep(step.text) ||
					namedObjectsIn(step.text).some((name) => norm(targetName).includes(norm(name)) || norm(name).includes(norm(targetName))) ||
					(!hasNamedObject(step.text) && /(点击|单击|按下|长按|轻触|滑动|拖动|操作|选择)/.test(step.text))
				);
				if (picked.item && actsOnTarget) {
					add(subject, { status: 'auto', target: picked.item.target, reason: '继承测试点操作关联（当前步骤作用于该控件）', candidates: [] }, 'control', null, picked.item.link.link_id);
				} else if (picked.conflicted?.length && /(点击|单击|按下|长按|轻触|滑动|拖动|操作|选择)/.test(step.text)) {
					add(subject, {
						status: 'ambiguous', reason: picked.reason,
						candidates: picked.conflicted.map((entry) => ({ ...compact(entry.target), score: 0, reasons: ['上游测试点有多个操作关联'] }))
					}, 'control');
				}
			}
			if (!link?.ui_id) {
				const pickedPage = chooseInherited(inherited.page || [], { index, purpose: 'page', text: step.text, context: contextText, requireShot: false });
				const pageTarget = pickedPage.item?.target?.page_name || '';
				if (pickedPage.item && pageTarget && String(step.text).includes(pageTarget)) {
					add(subject, { status: 'auto', target: pickedPage.item.target, reason: '继承测试点页面关联', candidates: [] }, 'page', null, pickedPage.item.link.link_id);
				}
			}
		}
		const stepText = steps.map((step) => step.text || '').join(' ');
		for (const entry of item.expected_items || structure[item.case_id]?.expected || []) {
			const contextText = `${baseContext} ${stepText}`;
			if (uiApplicability(entry.text, `${item.title || ''} ${stepText}`).level !== 'required') continue;
			const subject = { kind: 'case_expected', id: item.case_id, expected_id: entry.id, name: (entry.text || '').slice(0, 40) };
			const outcome = match(index, {
				text: entry.text, name: '', roleHint: roleHintFor(entry.text),
				pageHints: pageHintsIn(index, [item.title, item.precondition, stepText, pctx.text]),
				contextText, useContextTokens: false
			}, { ...matchOptionsFor(subject, 'expected'), purpose: 'expected' });
			const link = add(subject, outcome, 'expected');
			if (!link?.ui_id) {
				const picked = chooseInherited(inherited.expected || [], {
					index, purpose: 'expected', text: entry.text, context: contextText,
					states: stateTokens(entry.text), requireShot: false
				});
				if (picked.item) {
					add(subject, { status: 'auto', target: picked.item.target, reason: '继承测试点预期关联（对象/状态/页面一致）', candidates: [] }, 'expected', null, picked.item.link.link_id);
				} else if (picked.conflicted?.length) {
					add(subject, {
						status: 'ambiguous', reason: picked.reason,
						candidates: picked.conflicted.map((entryTarget) => ({ ...compact(entryTarget.target), score: 0, reasons: ['上游测试点有多个兼容预期'] }))
					}, 'expected');
				}
			}
		}
	}
	// 版本影响：设计节点消失标过期；名称/状态/来源版本变化时待复核。
	// explicit 不再豁免，每轮按来源与版本回库核实。
	const objectById = new Map((index.objects || []).map((object) => [object.id, object]));
	const sourceById = new Map((index.sources || []).map((source) => [source.id, source]));
	const liveNodes = new Map();
	const liveNode = (source, nodeId) => {
		if (!source?.db || !nodeId) return null;
		const key = source.id + '::' + nodeId;
		if (liveNodes.has(key)) return liveNodes.get(key);
		let row = null;
		try {
			const db = new DatabaseSync(source.db, { readOnly: true });
			row = db.prepare('select node_id as id, name from nodes where node_id = ?').get(nodeId) || null;
			db.close();
		} catch {
			row = null;
		}
		liveNodes.set(key, row);
		return row;
	};
	let stale = 0;
	let review = 0;
	const markReview = (item, reason, stateChanged) => {
		if (item.status === 'confirmed') {
			if (stateChanged) item.needs_review = true;
		} else if (item.status !== 'review') {
			item.status = 'review';
		}
		item.needs_review = true;
		item.reason = reason;
		review += 1;
	};
	for (const item of next.values()) {
		if (!item.ui_id || !item.target) continue;
		const object = objectById.get(item.ui_id);
		if (!object) {
			if (item.explicit) {
				const source = sourceById.get(item.target.source);
				const row = liveNode(source, item.target.node_id);
				if (!row) {
					if (item.status !== 'stale') { item.status = 'stale'; item.reason = '原文指定的设计节点已从设计库消失，请重新匹配'; stale += 1; }
					continue;
				}
				const versionChanged = Boolean(item.target.revision && source?.revision && item.target.revision !== source.revision);
				const nameChanged = Boolean(item.target.name && row.name && item.target.name !== row.name);
				if (versionChanged) markReview(item, '设计来源版本已变化，待复核', false);
				else if (nameChanged && item.purpose === 'expected') markReview(item, '设计节点名称或状态已变化，待复核', true);
				continue;
			}
			if (item.status !== 'stale') { item.status = 'stale'; item.reason = '设计节点已不存在，请重新匹配'; stale += 1; }
			continue;
		}
		const nameChanged = item.target.name !== object.name;
		const stateChanged = item.target.state !== object.state;
		const versionChanged = Boolean(item.target.revision && object.rev && item.target.revision !== object.rev);
		if (versionChanged) markReview(item, '设计来源版本已变化，待复核', false);
		else if ((nameChanged || stateChanged) && item.purpose === 'expected') markReview(item, '设计状态或名称已变化，待复核', true);
		item.target = compact(object);
	}
	const items = [...next.values()];
	const staleCount = items.filter((item) => item.status === 'stale').length;
	const reviewCount = items.filter((item) => item.status === 'review' || item.needs_review).length;
	if (options.save === false) {
		return {
			document: { version: previous.version || 0, updatedAt: new Date().toISOString(), digest: index.digest, items },
			index, stats: { links: items.length, stale: staleCount, review: reviewCount }
		};
	}
	const saved = saveLinks(dataRoot, projectId, items, { digest: index.digest, sources: index.sources, stale, review });
	return { document: saved, index, stats: { links: items.length, stale: staleCount, review: reviewCount } };
}

export function recordDecision(dataRoot, projectId, payload) {
	const document = loadLinks(dataRoot, projectId);
	const key = linkKey(payload.subject, payload.purpose);
	const existing = document.items.find((item) => linkKey(item.subject, item.purpose) === key);
	const item = existing || { link_id: idOf('L', key), subject: payload.subject, purpose: payload.purpose };
	Object.assign(item, {
		status: payload.status,
		method: 'manual',
		confidence: 1,
		ui_id: payload.target?.ui_id || '',
		target: payload.target || null,
		decided_by: payload.decided_by || 'human',
		decided_at: new Date().toISOString()
	});
	if (payload.status === 'rejected' && payload.rejected_ui_id) item.rejected_ui_id = payload.rejected_ui_id;
	const items = existing ? document.items.map((entry) => entry === existing ? item : entry) : [...document.items, item];
	return saveLinks(dataRoot, projectId, items, { digest: document.digest, sources: document.sources });
}

/** Server-side gate for manual link decisions: ownership, revision, subject existence. */
export function validateDecision(dataRoot, projectId, projectDir, payload, documents = {}) {
	const subject = payload?.subject || {};
	const kinds = new Set(['fact', 'contract', 'point', 'case_step', 'case_expected']);
	if (!kinds.has(subject.kind) || typeof subject.id !== 'string' || !subject.id) throw new Error('无效的关联对象');
	const purposes = new Set(['reference', 'control', 'expected', 'page', 'zoom', 'recovery']);
	if (!purposes.has(payload.purpose)) throw new Error('无效的图片用途');
	if (!['confirmed', 'rejected'].includes(payload.status || 'confirmed')) throw new Error('无效的关联状态');
	if (payload.status === 'rejected') return;
	if (subject.kind === 'fact' || subject.kind === 'contract' || subject.kind === 'point') {
		const key = subject.kind === 'fact' ? 'facts' : subject.kind === 'contract' ? 'contracts' : 'points';
		const idField = subject.kind === 'fact' ? 'fact_id' : subject.kind === 'contract' ? 'contract_id' : 'point_id';
		if (!(documents[key]?.items || []).some((item) => item[idField] === subject.id)) throw new Error('关联对象不存在');
	} else {
		const item = (documents.cases?.items || []).find((entry) => entry.case_id === subject.id);
		if (!item) throw new Error('关联对象不存在');
		if (!item.step_items?.length) structureCase(item);
		const id = subject.kind === 'case_step' ? subject.step_id : subject.expected_id;
		const list = subject.kind === 'case_step' ? item.step_items : item.expected_items;
		if (!id || !(list || []).some((entry) => entry.id === id)) throw new Error('关联的步骤或预期已变化，请刷新后重试');
	}
	const target = payload.target;
	if (!target || typeof target.ui_id !== 'string' || !target.ui_id) throw new Error('请选择有效的 UI 对象');
	const index = loadIndex(dataRoot, projectId);
	if (!index.digest) throw new Error('还没有 UI 索引');
	const sourceId = String(target.source || target.ui_id.split('::')[0] || '');
	const source = (index.sources || []).find((entry) => entry.id === sourceId || entry.name === sourceId);
	if (!source) throw new Error('目标不属于本项目的设计来源');
	if (target.source && target.source !== source.id && target.source !== source.name) throw new Error('目标来源与索引不一致');
	if (target.revision && source.revision && target.revision !== source.revision) throw new Error('设计稿版本已更新，请重新匹配');
	const object = (index.objects || []).find((entry) => entry.id === target.ui_id)
		|| (index.boards || []).find((entry) => entry.id === target.ui_id);
	if (object) {
		const objectSource = object.s || object.source;
		if (objectSource && objectSource !== source.id) throw new Error('目标对象与来源不一致');
		if (target.node_id && object.n && target.node_id !== object.n && target.ui_id !== object.id) throw new Error('目标节点与索引不一致');
		if (target.shot && object.shot && target.shot !== object.shot) throw new Error('截图与索引不一致，请重新匹配');
		if (target.revision && (object.rev || object.revision) && target.revision !== (object.rev || object.revision)) throw new Error('目标对象版本已更新');
	} else if (!source.db || target.ui_id !== `${source.id}::${target.node_id || ''}` || !target.node_id) {
		throw new Error('目标不在当前 UI 索引中，请重新匹配');
	}
	if (target.shot) {
		const file = path.resolve(projectDir, String(target.shot));
		const base = path.resolve(projectDir);
		if (!file.startsWith(base + path.sep) || path.isAbsolute(String(target.shot))) throw new Error('目标截图路径不属于本项目');
	}
}

/** 真实下游：合同 → 引用它的测试点 → 这些测试点下的用例步骤/预期；测试点 → 其用例。 */
function descendantSubjects(documents, from) {
	const subjects = new Set();
	if (!documents || !from) return subjects;
	const contracts = documents.contracts?.items || [];
	const points = documents.points?.items || [];
	const cases = documents.cases?.items || [];
	let pointIds = new Set();
	if (from.kind === 'contract') {
		for (const point of points) if ((point.contract_refs || []).includes(from.id)) pointIds.add(point.point_id);
	} else if (from.kind === 'point') {
		pointIds.add(from.id);
	} else if (from.kind === 'fact') {
		const contractIds = contracts.filter((contract) => (contract.fact_refs || []).includes(from.id)).map((contract) => contract.contract_id);
		for (const point of points) if ((point.contract_refs || []).some((id) => contractIds.includes(id))) pointIds.add(point.point_id);
	}
	for (const pointId of pointIds) subjects.add('point|' + pointId);
	for (const item of cases) {
		if (!pointIds.has(item.point_id)) continue;
		if (!item.step_items) structureCase(item);
		for (const step of item.step_items || []) subjects.add('case_step|' + item.case_id + '|' + step.id);
		for (const entry of item.expected_items || []) subjects.add('case_expected|' + item.case_id + '|' + entry.id);
	}
	return subjects;
}

const subjectKey = (subject) => subject?.kind === 'case_step' || subject?.kind === 'case_expected'
	? `${subject.kind}|${subject.id}|${subject.step_id || subject.expected_id || ''}`
	: `${subject?.kind}|${subject?.id}`;
const itemsDigest = (items) => crypto.createHash('sha256').update(JSON.stringify(items.map((item) => [
	item.link_id, item.ui_id, item.status, item.method || '', item.inherited_from || '', item.purpose,
	item.subject?.kind, item.subject?.id, item.subject?.step_id || item.subject?.expected_id || '',
	item.target?.ui_id || '', item.target?.revision || '', Boolean(item.needs_review)
]))).digest('hex').slice(0, 16);

/**
 * Apply one correction to its real downstream only: explicit inherited_from
 * chains plus the contract/point/case relation, and only links still sitting on
 * the corrected old target. A requirement that merely happens to use the same
 * UI is not touched. `preview` returns the affected rows without saving;
 * `baseline` rejects stale previews instead of overwriting newer edits.
 */
export function propagate(dataRoot, projectId, { from_subject, purpose, target, old_ui_id = '', documents = null, preview = false, baseline = '' }) {
	const document = loadLinks(dataRoot, projectId);
	const source = document.items.find((item) => item.subject.kind === from_subject.kind && item.subject.id === from_subject.id && item.purpose === purpose);
	if (!source) throw new Error('原关联不存在');
	// 基线忽略源自身的决定字段：预览后正式应用会先确认源关联，不应判成冲突。
	const baselineItems = document.items.filter((item) => item.link_id !== source.link_id);
	if (baseline && baseline !== itemsDigest(baselineItems)) {
		return { ...document, affected: 0, conflict: '关联已在预览后发生变化，请刷新预览再应用', affected_items: [] };
	}
	const oldTarget = old_ui_id || source.target?.ui_id || '';
	const descended = descendantSubjects(documents, from_subject);
	// 有证据的继承链：源 → 直接继承者 → 再下一层，避免循环，也不靠候选证据猜合同。
	const chain = new Set([source.link_id]);
	const queue = [source.link_id];
	while (queue.length) {
		const parent = queue.shift();
		for (const item of document.items) {
			if (chain.has(item.link_id) || item.inherited_from !== parent) continue;
			if (item.purpose !== purpose || item.status === 'confirmed' || item.method === 'manual') continue;
			chain.add(item.link_id);
			queue.push(item.link_id);
		}
	}
	const affected = [];
	const items = document.items.map((item) => {
		if (item === source || item.purpose !== purpose) return item;
		if (item.status === 'confirmed' || item.method === 'manual') return item;
		const viaChain = item.inherited_from && chain.has(item.inherited_from);
		const sameOld = item.ui_id === oldTarget && descended.has(subjectKey(item.subject));
		if (!viaChain && !sameOld) return item;
		affected.push({ link_id: item.link_id, subject: item.subject, purpose: item.purpose, from_ui: item.ui_id, to_ui: target.ui_id });
		return { ...item, ui_id: target.ui_id, target, status: 'auto', method: 'inherit', inherited_from: source.link_id, updated_at: new Date().toISOString() };
	});
	if (preview) return { ...document, affected: affected.length, preview: true, baseline: itemsDigest(baselineItems), affected_items: affected };
	const saved = saveLinks(dataRoot, projectId, items, { digest: document.digest, sources: document.sources });
	return { ...saved, affected: affected.length, affected_items: affected };
}

/* ------------------------------------------------------------- applicability */

const STRONG_UI = /(界面|页面|弹窗|弹层|屏幕|图标|按钮|按键|开关|控件|列表|页签|菜单)/;
const UI_WORDS = /(界面|页面|弹窗|弹层|屏幕|图标|按钮|按键|开关|控件|列表|页签|提示|显示|菜单|点击|单击|按下|长按|轻触|滑动|拖动|进入|返回|选择|切换|高亮|变灰|置灰)/;
const VISUAL_STATE = /(未选中|未激活|选中|默认|禁用|置灰|变灰|高亮|激活)/;
const NON_UI_WORDS = /(CAN|报文|信号|日志|数据库|接口|API|HTTP|POST|GET|PUT|DELETE|后台|服务端|服务进程|线程|帧|重试|请求返回)/i;
const STATE_OBSERVE = /(确认|检查|观察|验证).*(状态|正常|异常|禁用|置灰|选中|未选中|开启|关闭|显示)/;

/**
 * UI 适用性：required / not_applicable / unknown，附依据。
 * 纯接口、信号、日志、后台规则不强制配 UI；仅“确认状态正常”没有上下文的记 unknown。
 * 先认强界面对象，再排除技术词，避免“POST 请求返回成功”因“返回”被当成界面操作。
 */
export function uiApplicability(text, context = '') {
	const value = String(text || '').trim();
	const around = String(context || '');
	if (!value) return { level: 'not_applicable', reason: '没有文字内容' };
	if (STRONG_UI.test(value)) return { level: 'required', reason: '文字点名界面对象' };
	if (NON_UI_WORDS.test(value)) return { level: 'not_applicable', reason: '接口/信号/日志/后台验证，没有需要展示的界面' };
	if (UI_WORDS.test(value)) return { level: 'required', reason: '文字包含界面操作或界面观察' };
	const aroundUI = UI_WORDS.test(around) || STRONG_UI.test(around);
	if (STATE_OBSERVE.test(value) && aroundUI) return { level: 'required', inherited: true, reason: '继承前序界面上下文核对状态' };
	if (VISUAL_STATE.test(value)) {
		return aroundUI
			? { level: 'required', inherited: true, reason: '继承界面上下文核对控件视觉状态' }
			: { level: 'unknown', reason: '只有视觉状态描述，缺少界面或信号上下文' };
	}
	if (STATE_OBSERVE.test(value)) return { level: 'unknown', reason: '只有状态描述，缺少界面或信号上下文' };
	if (/(成功|失败|错误|正常|异常)/.test(value)) return { level: 'unknown', reason: '只有结果状态，需要界面或接口上下文' };
	return { level: 'not_applicable', reason: '没有可观察的界面对象' };
}

/* ------------------------------------------------------------- coverage */

function figureFileUsable(projectDir, figure) {
	const file = projectFilePath(projectDir, figure?.file);
	return Boolean(file && decodePng(file));
}

export function coverage(dataRoot, projectId, documents) {
	const index = loadIndex(dataRoot, projectId);
	const links = documents.links || loadLinks(dataRoot, projectId);
	const projectDir = path.join(dataRoot, 'projects', projectId);
	const bySubject = new Map();
	for (const item of links.items) {
		const key = item.subject.kind + '|' + item.subject.id + '|' + (item.subject.step_id || '') + '|' + (item.subject.expected_id || '');
		if (!bySubject.has(key)) bySubject.set(key, []);
		bySubject.get(key).push(item);
	}
	const check = (link, text, requireShot = true) =>
		linkValidity(link, { index, projectDir, text, states: stateTokens(text), requireShot });
	const figureUsable = (figure, text, subjectLinks) => figureFileUsable(projectDir, figure) &&
		(figure.manual || subjectLinks.some((link) => link.ui_id === figure.ui_id &&
			link.purpose === figure.purpose && check(link, text).usable));
	const UI_ROLES = ['页面定位', '操作定位', '控件局部', '预期界面参考', '恢复入口', '界面参考'];
	const figureStep = (figure, step, order) => figure.step_id
		? figure.step_id === step.id
		: !figure.expected_id && Number(figure.step) === order;
	const cases = [];
	const stats = {
		cases: 0, uiSteps: 0, stepsCovered: 0, expectedNeeded: 0, expectedCovered: 0, expectedPartial: 0,
		missingAssets: 0, ambiguous: 0
	};
	const stepRows = [];
	const expectedRows = [];
	for (const item of documents.cases?.items || []) {
		if (!item.step_items || !item.expected_items) structureCase(item);
		const prior = [item.title || ''];
		const steps = (item.step_items || []).map((step, order) => {
			const applicability = uiApplicability(step.text, prior.join(' '));
			prior.push(step.text || '');
			const needsUI = applicability.level === 'required';
			const key = 'case_step|' + item.case_id + '|' + step.id + '|';
			const subjectLinks = bySubject.get(key) || [];
			const located = subjectLinks.filter((link) => link.ui_id).map((link) => ({ link, v: check(link, step.text) }))
				.find((entry) => entry.v.usable) || null;
			const figures = (item.image_refs || []).filter((figure) => UI_ROLES.includes(figure.role) &&
				figure.role !== '预期界面参考' && figureStep(figure, step, order + 1));
			const usableFigures = figures.filter((figure) => figureUsable(figure, step.text, subjectLinks));
			const covered = needsUI && usableFigures.length > 0;
			if (needsUI) stats.uiSteps += 1;
			if (covered) stats.stepsCovered += 1;
			const ambiguous = !located && subjectLinks.some((link) => link.status === 'ambiguous');
			if (needsUI && !covered) stats.missingAssets += 1;
			if (needsUI && ambiguous) stats.ambiguous += 1;
			const row = {
				case_id: item.case_id, step_id: step.id, text: step.text, applicability,
				needs_ui: needsUI, has_link: Boolean(located), link_status: located?.v.status || '',
				ui_id: located?.link.ui_id || '', shot: located?.link.target?.shot || '',
				figures: figures.map((figure) => figure.file), usable_figures: usableFigures.length, covered,
				reason: needsUI ? (covered ? '' : located ? (located.v.usable ? '关联有效但图片未挂入' : located.v.reasons.join('；')) : subjectLinks.find((link) => link.reason)?.reason || '未定位到界面对象') : ''
			};
			stepRows.push(row);
			return row;
		});
		const stepText = steps.map((step) => step.text || '').join(' ');
		const expected = (item.expected_items || []).map((entry) => {
			const applicability = uiApplicability(entry.text, `${item.title || ''} ${stepText}`);
			const needsUI = applicability.level === 'required';
			const key = 'case_expected|' + item.case_id + '||' + entry.id;
			const subjectLinks = bySubject.get(key) || [];
			const located = subjectLinks.filter((link) => link.ui_id).map((link) => ({ link, v: check(link, entry.text) }))
				.find((entryCheck) => entryCheck.v.usable) || null;
			const figures = (item.image_refs || []).filter((figure) => figure.expected_id === entry.id &&
				(figure.role === '预期界面参考' || figure.purpose === 'expected'));
			const usableFigures = figures.filter((figure) => figureUsable(figure, entry.text, subjectLinks));
			const wanted = stateTokens(entry.text);
			const coveredStates = [...new Set(usableFigures.map((figure) => figure.state).filter(Boolean))];
			const satisfied = needsUI && (wanted.length ? wanted.every((state) => coveredStates.includes(state)) : usableFigures.length > 0);
			const partial = needsUI && !satisfied && figures.length > 0;
			if (needsUI) stats.expectedNeeded += 1;
			if (satisfied) stats.expectedCovered += 1;
			if (partial) stats.expectedPartial += 1;
			const missingStates = wanted.filter((state) => !coveredStates.includes(state));
			const row = {
				expected_id: entry.id, text: entry.text, applicability, needs_ui: needsUI,
				has_link: Boolean(located), link_status: located?.v.status || '',
				ui_id: located?.link.ui_id || '', states: wanted, figure_states: coveredStates,
				figures: figures.map((figure) => figure.file), usable_figures: usableFigures.length, covered: satisfied, partial,
				reason: needsUI ? (satisfied ? '' : usableFigures.length ? (missingStates.length ? `缺少状态图：${missingStates.join('、')}` : '图片未满足预期用途') : figures.length ? '配图文件无效或关联已失效' : located ? (located.v.reasons.join('；') || '关联有效但状态图未挂入') : '没有对应的状态图或控件状态') : ''
			};
			expectedRows.push(row);
			return row;
		});
		const missing = steps.filter((step) => step.needs_ui && !step.covered).length;
		stats.cases += 1;
		cases.push({ case_id: item.case_id, title: item.title, steps, expected, missing });
	}

	// 需求层：合同优先（原子需求），没有合同时退回测试点。
	const requirements = [];
	const statusCounts = { appliedValid: 0, locatedNoShot: 0, pending: 0, review: 0, unlocated: 0, checkedMissingAsset: 0, expired: 0 };
	const contractItems = documents.contracts?.items || [];
	const pointItems = documents.points?.items || [];
	const pointCaseText = new Map();
	for (const item of documents.cases?.items || []) {
		if (!item.point_id) continue;
		pointCaseText.set(item.point_id, `${pointCaseText.get(item.point_id) || ''} ${item.title || ''} ${(item.step_items || []).map((step) => step.text).join(' ')}`);
	}
	const requirementUnits = contractItems.length
		? contractItems.map((contract) => ({
			id: contract.contract_id, kind: 'contract',
			text: `${contract.condition || ''} ${contract.trigger || ''} ${contract.expected || ''}`,
			context: contract.condition || ''
		}))
		: pointItems.map((point) => ({
			id: point.point_id, kind: 'point',
			text: `${point.requirement || ''} ${pointCaseText.get(point.point_id) || ''}`,
			context: point.contract_refs?.length ? '合同已引用' : ''
		}));
	for (const unit of requirementUnits) {
		const unitLinks = links.items.filter((link) => link.subject.kind === unit.kind && link.subject.id === unit.id && link.ui_id);
		const applicability = uiApplicability(unit.text, unit.context);
		const required = applicability.level === 'required' || unitLinks.some((link) => ['auto', 'confirmed'].includes(link.status) && !link.needs_review);
		if (!required) {
			if (applicability.level === 'unknown') statusCounts.pending += 1;
			requirements.push({ id: unit.id, kind: unit.kind, applicability, required: false, status: applicability.level === 'unknown' ? 'pending' : 'not_applicable' });
			continue;
		}
		const checks = unitLinks.map((link) => ({ link, v: check(link, unit.text) }));
		const withShot = checks.find((entry) => entry.v.usable && entry.v.hasShot);
		const located = withShot || checks.find((entry) => entry.v.usable);
		const review = checks.find((entry) => ['review', 'stale'].includes(entry.v.status) || entry.link.needs_review);
		const expired = checks.find((entry) => entry.v.status === 'stale');
		const status = withShot ? 'applied_valid' : located ? 'located_no_shot' : expired ? 'expired' : review ? 'review' : 'unlocated';
		if (status === 'applied_valid') statusCounts.appliedValid += 1;
		else if (status === 'located_no_shot') statusCounts.locatedNoShot += 1;
		else if (status === 'review') statusCounts.review += 1;
		else if (status === 'expired') statusCounts.expired += 1;
		else statusCounts.unlocated += 1;
		requirements.push({
			id: unit.id, kind: unit.kind, applicability, required: true, status,
			ui_id: (withShot || located)?.link.ui_id || '',
			purpose: (withShot || located)?.link.purpose || '',
			reasons: checks.flatMap((entry) => entry.v.reasons)
		});
	}
	const requiredRequirements = requirements.filter((entry) => entry.required);
	const locatedRequirements = requiredRequirements.filter((entry) => ['applied_valid', 'located_no_shot'].includes(entry.status));
	const shotRequirements = requiredRequirements.filter((entry) => entry.status === 'applied_valid');
	const neededSteps = stepRows.filter((row) => row.needs_ui);
	const coveredSteps = neededSteps.filter((row) => row.covered);
	const neededExpected = expectedRows.filter((row) => row.needs_ui);
	const coveredExpected = neededExpected.filter((row) => row.covered);
	const metrics = [
		{ key: 'object', label: '对象定位覆盖率', numerator: locatedRequirements.length, denominator: requiredRequirements.length, formula: '有有效对象关联的适用需求 / 已确定需要 UI 的需求', unmet: requiredRequirements.filter((entry) => !locatedRequirements.includes(entry)).map((entry) => ({ id: entry.id, status: entry.status, reasons: entry.reasons })) },
		{ key: 'shot', label: '截图就绪率', numerator: shotRequirements.length, denominator: locatedRequirements.length, formula: '有可解码截图的已定位需求 / 有有效对象关联的需求', unmet: locatedRequirements.filter((entry) => entry.status !== 'applied_valid').map((entry) => ({ id: entry.id, reasons: entry.reasons })) },
		{ key: 'steps', label: '步骤配图完成率', numerator: coveredSteps.length, denominator: neededSteps.length, formula: '已挂入且用途正确的步骤 / 需要 UI 配图的步骤', unmet: neededSteps.filter((row) => !row.covered).map((row) => ({ case_id: row.case_id, step_id: row.step_id, reason: row.reason })) },
		{ key: 'expected', label: '预期配图完成率', numerator: coveredExpected.length, denominator: neededExpected.length, formula: '全部必需 UI 验证项已满足的预期 / 需要 UI 配图的预期', partial: neededExpected.filter((row) => row.partial).length, unmet: neededExpected.filter((row) => !row.covered).map((row) => ({ case_id: row.case_id, expected_id: row.expected_id, reason: row.reason })) },
		{ key: 'asset', label: '有素材匹配覆盖率', numerator: null, denominator: null, formula: '正确匹配的有素材对象 / 经独立核实存在适用素材的对象', status: '未测', reason: '没有独立素材清单，不能把截图就绪率当作本项' },
		{ key: 'sampling', label: '抽样准确率', numerator: null, denominator: null, formula: '独立核验正确的自动匹配 / 实际核验的自动匹配', status: '未测', reason: '独立样本核验在验收阶段执行，当前未测' }
	];
	stats.requirements = requiredRequirements.length;
	stats.requirementsUnknown = requirements.filter((entry) => entry.status === 'pending').length;
	stats.indexFailures = index.stats?.failures?.length || 0;
	return { stats, cases, requirements, metrics, statusCounts: { ...statusCounts, checkedMissingAsset: '未独立核查' }, sampling: '未测' };
}
