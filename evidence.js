/**
 * Evidence layer: turn project files into citable chunks.
 *
 * An evidence item is the unit the agent may quote: it carries a stable id, the
 * file and section it came from, and a sha256 of its exact text. Later stages
 * refuse assertions that do not cite one of these ids.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocx } from './parsers/docx.js';
import { parseXlsxBlocks } from './parsers/xlsx.js';
import { parseDbc } from './parsers/dbc.js';
import { parseText } from './parsers/text.js';
import { state as designState, pages as designPages, removedDesigns } from './design.js';
import { parsePdf } from './parsers/pdf.js';

const PARSERS = {
	'.pdf': parsePdf,
	'.docx': parseDocx,
	'.xlsx': parseXlsxBlocks,
	'.dbc': parseDbc,
	'.md': parseText,
	'.markdown': parseText,
	'.txt': parseText,
	'.html': parseText,
	'.htm': parseText,
	'.csv': parseText
};

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'renders', 'store', 'exports', 'uploads']);
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const CHUNK_CHARS = 2600;

export function evidenceDir(config, projectId, dataRoot) {
	return path.join(dataRoot, 'evidence', projectId);
}

function sha256(text) {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function walk(dir, base, out) {
	let entries = [];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await walk(full, base, out);
			continue;
		}
		const extension = path.extname(entry.name).toLowerCase();
		if (!PARSERS[extension]) continue;
		const stat = await fs.stat(full).catch(() => null);
		if (!stat || stat.size > MAX_FILE_BYTES) continue;
		out.push({ full, relative: path.relative(base, full), extension, bytes: stat.size });
	}
}

function blocksToText(blocks) {
	const lines = [];
	for (const block of blocks) {
		if (block.kind === 'heading') {
			lines.push('', `${'#'.repeat(Math.min(6, block.level || 1))} ${block.text}`);
		} else if (block.kind === 'table' || block.kind === 'table-row') {
			const rows = block.rows || [];
			for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
		} else {
			lines.push(block.text);
		}
	}
	return lines.join('\n');
}

/** Blocks → chunked items, preserving a heading prefix so a chunk stands alone. */
function toItems(blocks, source, headingSplit = false) {
	const items = [];
	let buffer = [];
	let size = 0;
	let sectionLocation = '';
	let chunkLocation = '';
	let index = 0;

	const flush = () => {
		if (buffer.length === 0) return;
		const text = buffer.join('\n').trim();
		buffer = [];
		size = 0;
		if (text === '') return;
		index += 1;
		items.push({
			source,
			// 引用要能定位到块开始的位置；此前取的是块尾最后一个标题，长文引用会指错章节。
			location: chunkLocation || source,
			part: index,
			kind: 'text',
			chars: text.length,
			sha256: sha256(text),
			text
		});
	};

	for (const block of blocks) {
		const piece = blocksToText([block]);
		if (piece.trim() === '') continue;
		if (block.location) sectionLocation = block.location;
		const headingBoundary = headingSplit && block.kind === 'heading' && buffer.length > 0;
		if (headingBoundary || (size + piece.length > CHUNK_CHARS && buffer.length > 0)) flush();
		if (buffer.length === 0) chunkLocation = sectionLocation || source;
		buffer.push(piece);
		size += piece.length;
	}
	flush();
	return items;
}

/** @returns {Promise<{projectId:string, builtAt:string, stats:object, items:Array}>} */
export async function build(config, project, dataRoot, { designSource = '' } = {}) {
	const dir = evidenceDir(config, project.id, dataRoot);
	const previous = await readAll(config, project.id, dataRoot).catch((error) => {
		if (error.code !== 'ENOENT') throw error;
		return null;
	});
	const refreshDesignOnly = Boolean(designSource && previous);
	const designPath = `design/${designSource}`;
	const files = [];
	if (!refreshDesignOnly) {
		await walk(project.dir, project.dir, files);
		files.sort((a, b) => a.relative.localeCompare(b.relative));
	}
	const items = refreshDesignOnly ? previous.items.filter((item) => item.source !== designPath) : [];
	const sources = refreshDesignOnly ? previous.stats.sources.filter((source) => source.path !== designPath) : [];
	// 新项目按标题切块（更适合引用定位）；已有证据默认沿用块内聚合，避免重建时
	// 把下游 facts 引用的 E-xxxx 全部重排。项目可用 quality.evidence_chunk 显式覆盖。
	const configuredChunk = project.quality?.evidence_chunk;
	const previousChunking = previous?.stats?.chunking;
	const chunkByHeading = configuredChunk === 'heading' ? true : configuredChunk === 'size' ? false
		: previous ? previousChunking === 'heading' : true;
	for (const file of files) {
		let blocks;
		try {
			const buffer = await fs.readFile(file.full);
			blocks = PARSERS[file.extension](buffer, file.extension, file.full);
		} catch (error) {
			sources.push({ path: file.relative, kind: file.extension, items: 0, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const fileItems = toItems(blocks, file.relative, chunkByHeading);
		items.push(...fileItems);
		sources.push({ path: file.relative, kind: file.extension, items: fileItems.length, bytes: file.bytes });
	}

	// Design pages and boards are evidence too: they give the agent something to
	// cite ("设计稿：空调 / 快速除霜"), while individual nodes stay binding targets
	// rather than evidence rows (3.5k of them would swamp the index).
	const design = designState(project.dir, project.id, dataRoot);
	const previousDesignText = new Map((previous?.items || []).filter((item) => item.kind === 'design')
		.map((item) => [JSON.stringify([item.source, item.location]), item.text]));
	if (design.available) {
		const sourcesToRead = designSource
			? design.sources.filter((source) => source.logical_file_id === designSource)
			: design.sources.slice(0, 3);
		for (const source of sourcesToRead) {
			let pageList;
			try {
				pageList = designPages(design.store, source.logical_file_id);
			} catch {
				continue;
			}
			for (const page of pageList.pages || []) {
				const boards = page.boards || [];
				const sourcePath = `design/${source.logical_file_id}`;
				const heading = `页面 ${page.name}（${boards.length} 个画板）\n`;
				const rows = (kind) => boards.map((board) => `- ${board.name}｜${board.width}×${board.height}｜${kind(board)}`).join('\n');
				const classified = heading + rows((board) => board.board_kind);
				const legacy = heading + rows((board) => board.node_type || board.board_kind);
				// A previous .pix projection used the native node type. Preserve its quote only if it still matches exactly.
				const prior = previousDesignText.get(JSON.stringify([sourcePath, page.name]));
				const text = prior === legacy ? legacy : classified;
				items.push({
					source: sourcePath,
					location: page.name,
					part: 1,
					kind: 'design',
					chars: text.length,
					sha256: sha256(text),
					text
				});
			}
			sources.push({ path: `design/${source.logical_file_id}`, kind: source.kind || '.pix', items: (pageList.pages || []).length,
				...(source.kind === 'pixso-mcp' ? { design_revision: source.sha256 } : {}) });
		}
	}
	if (designSource && !sources.some((source) => source.path === designPath)) {
		throw new Error('未读取到本次导入的设计稿证据，请重试解析');
	}

	const key = (item) => JSON.stringify([item.source, item.location, item.part, item.sha256]);
	const priorIds = new Map((previous?.items || []).map((item) => [key(item), item.id]));
	// 位置修正不应导致证据编号漂移：先按原文摘要认领旧编号，找不到才分配新号。
	const priorBySha = new Map();
	for (const item of previous?.items || []) {
		const shaKey = JSON.stringify([item.source, item.sha256]);
		if (!priorBySha.has(shaKey)) priorBySha.set(shaKey, []);
		priorBySha.get(shaKey).push(item.id);
	}
	const usedIds = new Set();
	let serial = Math.max(previous?.nextEvidenceId || 1, ...(previous?.items || []).map((item) => Number(item.id.slice(2)) + 1).filter(Number.isSafeInteger));
	const revisions = new Map(sources.map((source) => [source.path, []]));
	for (const item of items) revisions.get(item.source)?.push(item.sha256);
	for (const source of sources) {
		if (!refreshDesignOnly || source.path === designPath) {
			source.version = sha256(JSON.stringify(revisions.get(source.path))).slice(0, 16);
		}
	}
	const sourceVersions = new Map(sources.map((source) => [source.path, source.version]));
	const idFor = (item) => {
		const direct = priorIds.get(key(item));
		if (direct && !usedIds.has(direct)) { usedIds.add(direct); return direct; }
		const reusable = (priorBySha.get(JSON.stringify([item.source, item.sha256])) || []).find((id) => !usedIds.has(id));
		if (reusable) { usedIds.add(reusable); return reusable; }
		return `E-${String(serial++).padStart(4, '0')}`;
	};
	const withIds = items.map((item) => ({
		id: idFor(item),
		source_id: sha256(item.source).slice(0, 16), source_version: sourceVersions.get(item.source), ...item
	}));
	const document = {
		projectId: project.id,
		projectName: project.name,
		projectDir: project.dir,
		builtAt: new Date().toISOString(),
		nextEvidenceId: serial,
		stats: {
			files: refreshDesignOnly ? previous.stats.files : files.length,
			parsed: sources.filter((source) => !source.error).length,
			items: withIds.length,
			chars: withIds.reduce((sum, item) => sum + item.chars, 0),
			chunking: refreshDesignOnly ? previousChunking : chunkByHeading ? 'heading' : 'size',
			sources
		},
		items: withIds
	};

	await fs.mkdir(dir, { recursive: true });
	const archive = path.join(dir, 'history');
	await fs.mkdir(archive, { recursive: true });
	for (const source of previous?.stats.sources || []) {
		if (!source.design_revision || sources.some((entry) => entry.path === source.path && entry.design_revision === source.design_revision)) continue;
		const snapshot = { source, items: previous.items.filter((item) => item.source === source.path) };
		const file = designEvidenceFile(dir, source.path, source.design_revision);
		await fs.writeFile(file + '.tmp', JSON.stringify(snapshot));
		await fs.rename(file + '.tmp', file);
	}
	const activeIds = new Set(withIds.map((item) => item.id));
	for (const item of previous?.items || []) {
		if (!activeIds.has(item.id) && /^E-\d+$/.test(item.id)) {
			await fs.writeFile(path.join(archive, item.id + '.json'), JSON.stringify(item));
		}
	}
	await fs.writeFile(path.join(dir, 'items.tmp'), JSON.stringify(document), 'utf8');
	await fs.rename(path.join(dir, 'items.tmp'), path.join(dir, 'items.json'));
	const index = {
		projectId: document.projectId,
		projectName: document.projectName,
		builtAt: document.builtAt,
		stats: document.stats,
		items: withIds.map(({ text, ...item }) => item)
	};
	await fs.writeFile(path.join(dir, 'index.tmp'), JSON.stringify(index), 'utf8');
	await fs.rename(path.join(dir, 'index.tmp'), path.join(dir, 'index.json'));
	return { document, dir };
}

function designEvidenceFile(dir, source, revision) {
	return path.join(dir, 'history', `design-${sha256(JSON.stringify([source, revision]))}.json`);
}

export async function loadDesignEvidence(config, projectId, dataRoot, source, revision) {
	const file = designEvidenceFile(evidenceDir(config, projectId, dataRoot), source, revision);
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

function activeEvidence(document, dataRoot, projectId) {
	const removed = removedDesigns(dataRoot, projectId);
	if (!removed.size) return document;
	const paths = new Set([...removed.keys()].map((id) => `design/${id}`));
	const items = document.items.filter((item) => !paths.has(item.source));
	const sources = document.stats.sources.filter((source) => !paths.has(source.path));
	return { ...document, items, stats: { ...document.stats, sources,
		items: items.length, chars: items.reduce((sum, item) => sum + item.chars, 0),
		parsed: sources.filter((source) => !source.error).length } };
}

export async function load(config, projectId, dataRoot) {
	try {
		const raw = await fs.readFile(path.join(evidenceDir(config, projectId, dataRoot), 'index.json'), 'utf8');
		return activeEvidence(JSON.parse(raw), dataRoot, projectId);
	} catch {
		return null;
	}
}

async function readAll(config, projectId, dataRoot) {
	const raw = await fs.readFile(path.join(evidenceDir(config, projectId, dataRoot), 'items.json'), 'utf8');
	return JSON.parse(raw);
}

export async function loadAll(config, projectId, dataRoot) {
	return activeEvidence(await readAll(config, projectId, dataRoot), dataRoot, projectId);
}

/** CJK needs n-gram matching; latin words need word boundaries. */
function tokensOf(query) {
	const lower = String(query || '').toLowerCase();
	const tokens = new Set();
	for (const word of lower.match(/[a-z0-9_.$/-]{2,}/g) || []) tokens.add(word);
	for (const run of lower.match(/[\u4e00-\u9fff]+/g) || []) {
		if (run.length <= 2) tokens.add(run);
		for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
	}
	return [...tokens].slice(0, 24);
}

function count(haystack, needle) {
	let hits = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1 && hits < 12) {
		hits += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return hits;
}

export async function search(config, projectId, dataRoot, query, options = {}) {
	const document = options.document ?? await loadAll(config, projectId, dataRoot);
	const tokens = tokensOf(query);
	const limit = Math.min(20, Math.max(1, Number(options.limit) || 8));
	const kind = typeof options.kind === 'string' ? options.kind : '';
	if (tokens.length === 0) return { query, tokens, hits: [] };

	const scored = [];
	for (const item of document.items) {
		if (kind && !item.source.toLowerCase().endsWith(kind)) continue;
		const text = item.text.toLowerCase();
		const location = item.location.toLowerCase();
		let score = 0;
		for (const token of tokens) {
			const inText = count(text, token);
			if (inText === 0 && !location.includes(token) && !item.source.toLowerCase().includes(token)) continue;
			score += inText * 2 + count(location, token) * 5 + (item.source.toLowerCase().includes(token) ? 3 : 0);
		}
		if (score === 0) continue;
		const first = tokens.map((token) => text.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
		const snippet = item.text.slice(Math.max(0, first - 80), first + 260).replace(/\s+/g, ' ').trim();
		scored.push({ id: item.id, source: item.source, location: item.location, score, snippet });
	}

	scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	return { query, tokens, total: scored.length, hits: scored.slice(0, limit) };
}

export async function read(config, projectId, dataRoot, evidenceId, options = {}) {
	const document = options.document ?? await loadAll(config, projectId, dataRoot);
	const current = document.items.find((entry) => entry.id === evidenceId);
	const item = current || (!options.document && /^E-\d+$/.test(evidenceId) ? await fs.readFile(
		path.join(evidenceDir(config, projectId, dataRoot), 'history', evidenceId + '.json'), 'utf8').then(JSON.parse).catch(() => null) : null);
	if (!item) throw new Error(`证据不存在：${evidenceId}`);
	const offset = Math.max(0, Number(options.offset) || 0);
	const limit = Math.min(8000, Math.max(200, Number(options.limit) || 4000));
	return {
		id: item.id,
		source: item.source,
		source_id: item.source_id,
		source_version: item.source_version,
		historical: !current,
		location: item.location,
		sha256: item.sha256,
		chars: item.chars,
		offset,
		text: item.text.slice(offset, offset + limit),
		truncated: offset + limit < item.chars
	};
}

const DESIGN_STATE_WORDS = ['未选中', '未激活', '未开启', '不可用', '加载中', '选中', '默认', '禁用', '置灰', '变灰', '开启', '关闭', '打开', '成功', '失败', '错误', '正常', '异常', '高亮', '激活', '灰', '/off']
	.sort((a, b) => b.length - a.length);
const DESIGN_STATE_RE = new RegExp(`(${DESIGN_STATE_WORDS.join('|')})`, 'g');
const DESIGN_STATE_CANON = { 灰: '置灰', 变灰: '置灰', '/off': '未选中' };
const DESIGN_PREFIX_RE = /^[A-Za-z][-_]+(?:(?:按钮|图标|开关|组件)[-_]+)?/;
const VECTOR_NOISE_RE = /^(?:矢量|Vector|矩形|椭圆|直线|路径|Polygon|Star|Line)\s*\d*$/i;
const DESIGN_NORM = (v) => String(v || '').replace(/[\s_\-·、，,。.:：;；()（）【】\[\]"'“”‘’/]/g, '').toLowerCase();

/** Extract real state variant values from design node/board names or key=value variant strings, never returning 'state_variant' or '变体'. */
export function extractConcreteVariantStates(textValue) {
	const found = [];
	const push = (val) => {
		if (val && val !== '变体' && val !== 'state_variant' && !found.includes(val)) found.push(val);
	};
	const raw = String(textValue || '');
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
	for (const hit of rest.matchAll(DESIGN_STATE_RE)) {
		push(DESIGN_STATE_CANON[hit[1]] || hit[1]);
	}
	return found;
}

export function stripDesignComponentPrefix(name) {
	return String(name || '')
		.replace(DESIGN_PREFIX_RE, '')
		.replace(/\/off$/i, '')
		.trim() || String(name || '').trim();
}

/**
 * Shared design semantic summary builder for functional generation (facts, page summary) and independent review.
 * - Preserves non-design (PRD, signal matrix) items verbatim (including explicit PRD dimension requirements).
 * - Strips design node geometric dimensions (width×height) and internal board_kind tokens ('state_variant', 'runtime_screen', etc.).
 * - Extracts page, board, visible control texts, component names, and concrete state variants.
 * - Maps component names to PRD-traceable business names and explicitly preserves same-name candidate ambiguity.
 */
export function formatSemanticDesignEvidence(item, options = {}) {
	if (!item || typeof item !== 'object') return item;
	const isDesign = item.kind === 'design' || String(item.source || '').startsWith('design/');
	if (!isDesign) return item;
	if (item.semantic_formatted === true) return item;

	const uiIndex = options.uiIndex || null;
	const prdText = String(options.prdText || '');
	const aliases = Array.isArray(options.aliases) ? options.aliases : [];
	const pageName = String(item.location || '').trim();

	// Index structured UI boards and objects on this page if uiIndex is available
	const pageBoards = (uiIndex?.boards || []).filter((b) => !pageName || b.page_name === pageName);
	const pageObjects = (uiIndex?.objects || []).filter((o) => !pageName || o.page_name === pageName);
	const objectsByBoardId = new Map();
	const objectsByBoardName = new Map();
	for (const obj of pageObjects) {
		if (obj.board) {
			const list = objectsByBoardId.get(obj.board) || [];
			list.push(obj);
			objectsByBoardId.set(obj.board, list);
		}
		if (obj.board_name) {
			const list = objectsByBoardName.get(obj.board_name) || [];
			list.push(obj);
			objectsByBoardName.set(obj.board_name, list);
		}
	}

	const resolvePrdBusinessName = (coreName, texts = []) => {
		const candidate = String(coreName || '').trim();
		if (!candidate) return '';
		// Prefer visible text with symbol separator (e.g. 'A/C' over 'AC') when present in PRD
		for (const t of texts) {
			const cleanText = String(t || '').trim();
			if (!cleanText || cleanText.length < 2 || cleanText.length > 12) continue;
			if (DESIGN_NORM(cleanText) === DESIGN_NORM(candidate) && cleanText !== candidate && prdText && prdText.includes(cleanText)) {
				return cleanText;
			}
		}
		// Check prefix/suffix permutation in PRD (e.g. 'X+MAX' <-> '最大+X' when PRD contains '最大X')
		const maxMatch = /^([\u4e00-\u9fa5]{2,6})MAX$/i.exec(candidate);
		if (maxMatch && prdText && prdText.includes(`最大${maxMatch[1]}`)) {
			return `最大${maxMatch[1]}`;
		}
		if (prdText && (!/^[A-Za-z]+$/.test(candidate) ? prdText.includes(candidate) : new RegExp(`\\b${candidate}\\b`).test(prdText))) {
			return candidate;
		}
		// Check project-declared or evidence-derived aliases
		for (const [from, to] of aliases) {
			if (!from || !to) continue;
			if (candidate.includes(from)) {
				const swapped = candidate.split(from).join(to);
				if (!prdText || prdText.includes(swapped)) return swapped;
			}
			if (candidate.includes(to)) {
				const swapped = candidate.split(to).join(from);
				if (!prdText || prdText.includes(swapped)) return swapped;
			}
		}
		return candidate;
	};

	const rawLines = String(item.text || '').split('\n');
	const parsedRows = [];
	for (const line of rawLines) {
		const trimmed = line.trim();
		if (!trimmed || /^页面\s+/.test(trimmed)) continue;
		const bullet = /^-\s*(.+)$/.exec(trimmed);
		if (!bullet) {
			// Generic fallback: strip any ｜width×height｜kind pattern on free lines
			const cleaned = trimmed
				.replace(/｜\d+(?:\.\d+)?\s*[×xX*]\s*\d+(?:\.\d+)?/g, '')
				.replace(/｜(?:state_variant|runtime_screen|component|COMPONENT_SET|COMPONENT|INSTANCE|FRAME|GROUP|SECTION|VECTOR)\b/g, '');
			if (cleaned) parsedRows.push({ rawLine: cleaned });
			continue;
		}
		const parts = bullet[1].split('｜').map((s) => s.trim());
		const boardName = parts[0] || '';
		if (!boardName || VECTOR_NOISE_RE.test(boardName)) continue;
		// Identify if parts[1] is width×height geometry; parts.at(-1) may be board_kind
		const hasGeom = parts.length >= 2 && /^\d+(?:\.\d+)?\s*[×xX*]\s*\d+(?:\.\d+)?$/.test(parts[1]);
		const rawKind = (hasGeom ? parts[2] : parts[1]) || '';
		if (/^VECTOR$/i.test(rawKind)) continue;
		parsedRows.push({ boardName, rawKind });
	}

	// Enrich each parsed board row with structured uiIndex objects (texts, real variants, child containment)
	const enriched = [];
	const usedUiBoardIds = new Set();
	for (const row of parsedRows) {
		if (row.rawLine) {
			enriched.push(row);
			continue;
		}
		const uiBoard = pageBoards.find((b) => b.name === row.boardName && !usedUiBoardIds.has(b.id))
			|| pageBoards.find((b) => b.name === row.boardName);
		if (uiBoard?.id) usedUiBoardIds.add(uiBoard.id);
		const childObjs = uiBoard?.id
			? (objectsByBoardId.get(uiBoard.id) || [])
			: (objectsByBoardName.get(row.boardName) || []);
		const texts = [];
		const states = [];
		const childNames = new Set();
		const pushState = (s) => {
			if (s && s !== '变体' && s !== 'state_variant' && !states.includes(s)) states.push(s);
		};
		for (const s of extractConcreteVariantStates(row.boardName)) pushState(s);
		if (uiBoard?.state) {
			for (const s of extractConcreteVariantStates(uiBoard.state)) pushState(s);
		}
		for (const obj of childObjs) {
			if (obj.name && obj.name !== row.boardName) childNames.add(obj.name);
			for (const s of extractConcreteVariantStates(obj.name || '')) pushState(s);
			if (obj.state && obj.state !== '变体' && obj.state !== 'state_variant') {
				for (const s of extractConcreteVariantStates(obj.state)) pushState(s);
			}
			for (const t of obj.texts || []) {
				const cleanT = String(t || '').replace(/\s+/g, ' ').trim();
				if (cleanT && !texts.includes(cleanT) && cleanT.length <= 40) texts.push(cleanT);
			}
		}
		const kind = uiBoard?.kind || row.rawKind || '';
		const isScreen = /^(?:runtime_screen|FRAME|GROUP|SECTION)$/i.test(kind)
			&& !DESIGN_PREFIX_RE.test(row.boardName);
		const coreName = stripDesignComponentPrefix(row.boardName);
		const bizName = resolvePrdBusinessName(coreName, texts);
		enriched.push({
			boardId: uiBoard?.id || '',
			boardName: row.boardName,
			kind,
			isScreen,
			coreName,
			bizName,
			texts: texts.slice(0, 10),
			states: states.slice(0, 8),
			childNames
		});
	}

	// Group controls by canonical business/core name to detect same-name ambiguity vs atomic wrapper containment
	const screens = enriched.filter((e) => e.isScreen);
	const controls = enriched.filter((e) => !e.isScreen && !e.rawLine);
	const freeLines = enriched.filter((e) => e.rawLine);

	const byCore = new Map();
	for (const ctrl of controls) {
		const key = DESIGN_NORM(ctrl.coreName || ctrl.boardName);
		if (!key) continue;
		const list = byCore.get(key) || [];
		list.push(ctrl);
		byCore.set(key, list);
	}

	const summaryLines = [
		`页面 ${pageName || '设计页'}（设计语义摘要：仅含界面画板、业务控件映射、组件名、可见文本与真实状态变体，不含节点几何尺寸）`
	];

	const seenScreenNames = new Map();
	for (const scr of screens) {
		if (/^组合\s*\d+$/i.test(scr.boardName)) continue;
		const existing = seenScreenNames.get(scr.boardName);
		if (existing) {
			for (const t of scr.texts) if (!existing.texts.includes(t)) existing.texts.push(t);
			for (const s of scr.states) if (!existing.states.includes(s)) existing.states.push(s);
		} else {
			seenScreenNames.set(scr.boardName, { ...scr, texts: [...scr.texts], states: [...scr.states] });
		}
	}
	for (const scr of seenScreenNames.values()) {
		const meta = [
			scr.texts.length ? `可见文本：${scr.texts.slice(0, 10).join('、')}` : '',
			scr.states.length ? `状态变体：${scr.states.slice(0, 8).join('、')}` : ''
		].filter(Boolean).join('｜');
		summaryLines.push(`- 界面画板「${scr.boardName}」${meta ? `｜${meta}` : ''}`);
	}

	for (const [, group] of byCore.entries()) {
		// Collapse duplicate instances of the exact same component name only when one is an INSTANCE copy
		const distinctByName = new Map();
		group.forEach((entry, idx) => {
			const sameName = [...distinctByName.values()].find((x) => x.boardName === entry.boardName);
			if (sameName && (/^INSTANCE$/i.test(entry.kind) || /^INSTANCE$/i.test(sameName.kind))) {
				for (const t of entry.texts) if (!sameName.texts.includes(t)) sameName.texts.push(t);
				for (const s of entry.states) if (!sameName.states.includes(s)) sameName.states.push(s);
				return;
			}
			const nKey = `${entry.boardName}::${entry.boardId || idx}`;
			distinctByName.set(nKey, { ...entry, texts: [...entry.texts], states: [...entry.states] });
		});
		const candidates = [...distinctByName.values()];
		// Check if candidates form a single parent-child button wrapper hierarchy (e.g. A-按钮-X contains child A-X with same tier prefix)
		let isSingleHierarchy = candidates.length === 1;
		if (candidates.length === 2 && candidates[0].boardName !== candidates[1].boardName) {
			const [a, b] = candidates;
			const sameTier = a.boardName[0] === b.boardName[0] && (/^[A-Za-z][-_]+按钮[-_]/.test(a.boardName) || /^[A-Za-z][-_]+按钮[-_]/.test(b.boardName));
			const aContainsB = sameTier && (a.childNames?.has(b.boardName) || a.coreName === b.coreName);
			const bContainsA = sameTier && (b.childNames?.has(a.boardName) || b.coreName === a.coreName);
			if (aContainsB || bContainsA) isSingleHierarchy = true;
		}
		const mergedTexts = [...new Set(candidates.flatMap((c) => c.texts))].slice(0, 10);
		const mergedStates = [...new Set(candidates.flatMap((c) => c.states))].slice(0, 8);
		const bizLabel = candidates[0].bizName || candidates[0].coreName || candidates[0].boardName;
		if (isSingleHierarchy) {
			const compNames = [...new Set(candidates.map((c) => c.boardName))];
			const meta = [
				`组件名：${compNames.join(' / ')}`,
				mergedTexts.length ? `可见文本：${mergedTexts.join('、')}` : '',
				mergedStates.length ? `状态变体：${mergedStates.join('、')}` : ''
			].filter(Boolean).join('｜');
			summaryLines.push(`- 控件「${bizLabel}」｜${meta}`);
		} else {
			const candLabels = candidates.map((c) => `${c.boardName}${c.boardId ? `(${c.boardId})` : ''}`);
			const meta = [
				`同名候选待核：${candLabels.join(' vs ')}（名称映射存在歧义，保留待核，不得自动消解）`,
				mergedTexts.length ? `可见文本：${mergedTexts.join('、')}` : '',
				mergedStates.length ? `状态变体：${mergedStates.join('、')}` : ''
			].filter(Boolean).join('｜');
			summaryLines.push(`- 控件「${bizLabel}」｜${meta}`);
		}
	}

	for (const f of freeLines) summaryLines.push(`- ${f.rawLine}`);

	const semanticText = summaryLines.join('\n');
	return {
		...item,
		raw_text: item.raw_text || item.text,
		text: semanticText,
		chars: semanticText.length,
		semantic_formatted: true
	};
}

export function semanticEvidenceDocument(document, options = {}) {
	if (!document || !Array.isArray(document.items)) return document;
	return {
		...document,
		items: document.items.map((item) => formatSemanticDesignEvidence(item, options))
	};
}

export function buildDesignPageSemanticSummaries(evidenceItems, options = {}) {
	return (evidenceItems || [])
		.filter((item) => item?.kind === 'design' || String(item?.source || '').startsWith('design/'))
		.slice(0, 8)
		.map((item) => {
			const formatted = formatSemanticDesignEvidence(item, options);
			const bodyLines = String(formatted.text || '').split('\n').slice(1, 7).map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean);
			return `[${item.id}] ${item.location}：${bodyLines.join('；')}`;
		});
}
