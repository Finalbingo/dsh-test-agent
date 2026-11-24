/**
 * Bindings: connect product-model subjects to the artefacts that can be observed.
 *
 * A control in the PRD has to resolve to a node in the design file; a signal name
 * has to resolve to a DBC signal. Anything ambiguous stays ambiguous — a wrong
 * binding is worse than a missing one.
 */
import fs from 'node:fs';
import { currentModule, surfaces, configTerms, termsPattern } from './scope.js';
import path from 'node:path';
import { search as designSearch, state as designState, node as designNode, pages as designPages } from './design.js';
import { extractSignalMatrix } from './parsers/xlsx.js';

const norm = (value) => String(value || '').replace(/[\s_\-·、，,。.:：;；()（）【】\[\]"'“”]/g, '').toLowerCase();

function walkFiles(dir, extension, out, depth = 0) {
	if (depth > 4 || out.length > 40) return;
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, extension, out, depth + 1);
		else if (entry.name.toLowerCase().endsWith(extension)) out.push(full);
	}
}

/** Unified protocol signal index across both .dbc and Excel (.xlsx) communication matrices. */
export function buildSignalIndex(projectDir) {
	const dbcFiles = [];
	const xlsxFiles = [];
	walkFiles(projectDir, '.dbc', dbcFiles);
	walkFiles(projectDir, '.xlsx', xlsxFiles);
	const index = new Map();
	const sources = [];
	for (const file of dbcFiles) {
		let text;
		try {
			const buffer = fs.readFileSync(file);
			try {
				text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
			} catch {
				text = new TextDecoder('gb18030').decode(buffer);
			}
		} catch {
			continue;
		}
		sources.push(path.basename(file));
		let message = null;
		const values = new Map();
		const pending = [];
		for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
			const line = rawLine.trim();
			const bo = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\S+)/.exec(line);
			if (bo) {
				message = { name: bo[2], rawId: Number(bo[1]), dlc: Number(bo[3]), transmitter: bo[4] };
				continue;
			}
			const sg = /^SG_\s+(\w+)\s*(?:\w+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]*)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*)$/.exec(line);
			if (sg && message) {
				const entry = {
					name: sg[1],
					message: message.name,
					rawId: message.rawId,
					message_id: `0x${message.rawId.toString(16).toUpperCase()}`,
					transmitter: message.transmitter || '',
					receivers: sg[11].split(',').map((v) => v.trim()).filter(Boolean),
					min: sg[8],
					max: sg[9],
					unit: sg[10],
					source: path.basename(file)
				};
				pending.push(entry);
				index.set(norm(sg[1]), entry);
				continue;
			}
			const val = /^VAL_\s+(\d+)\s+([A-Za-z0-9_]+)\s+(.*)\s*;$/.exec(line);
			if (val) {
				const pairs = [...val[3].matchAll(/(-?\d+)\s+"([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
				if (pairs.length) values.set(`${val[1]}.${val[2]}`, pairs.join(' / '));
			}
		}
		for (const entry of pending) {
			const valueDesc = values.get(`${entry.rawId}.${entry.name}`);
			if (valueDesc) entry.valueDesc = valueDesc;
			delete entry.rawId;
		}
	}
	for (const file of xlsxFiles) {
		let matrix;
		try {
			matrix = extractSignalMatrix(fs.readFileSync(file), file);
		} catch {
			continue;
		}
		if (!matrix.isMatrix) continue;
		sources.push(path.basename(file));
		for (const message of matrix.messages.values()) {
			for (const sig of message.signals) {
				if (index.has(norm(sig.name))) continue;
				index.set(norm(sig.name), {
					name: sig.name,
					description: sig.description || '',
					message: message.name,
					message_id: message.id,
					transmitter: message.transmitter || '',
					receivers: sig.receivers || message.receivers || [],
					cycle: message.cycle || '',
					min: sig.min,
					max: sig.max,
					unit: sig.unit,
					initial: sig.initial || '',
					invalid: sig.invalid || '',
					valueDesc: sig.valueDesc || '',
					source: path.basename(file)
				});
			}
		}
	}
	return { index, sources };
}

/** Chinese UI subjects live inside 【】 or follow an explicit click verb.
 * 同名控件按页面上下文拆分：不同页面的「确认」不再合并成一个对象。
 * 不截断：全量对象都进候选流程，未完成部分由调用方分批。 */
export function extractControls(facts) {
	const found = new Map();
	const VERB = /(更新|请求|等于|切换|进入|退出|表示|作为|判断|如果|表示|状态|模式|时|后)/;
	// 抽取噪音闸门：整句/动作短语不能当控件名（ISSUES A3）。
	const NOISE = /(点击|单击|按下|长按|拖动|滑动|拨动|提供|上报|发送|接收|显示|刷新|请求|界面|页面|屏幕|状态|模式|的)/;
	const LEAD_VERB = /^(上报|发送|接收|点击|单击|按下|长按|拖动|滑动|拨动|显示|刷新|更新|请求|进入|退出|切换|打开|关闭|调节|操作|触发|执行|通过|供|在|当|后|时|的)+/;
	const STOP = new Set(['界面', '屏幕', '页面', '控件', ...surfaces(), ...configTerms('generic_names')].map((word) => word.toLowerCase()));
	const pageHintOf = (statement) => {
		const hints = new Set();
		const text = String(statement);
		const keep = (name) => {
			const clean = name.replace(/^(当|在|于|的)+/, '');
			if (clean.length >= 2 && !VERB.test(clean) && !NOISE.test(clean)) hints.add(clean);
		};
		// 带介词边界的优先（懒匹配拿全名）：在审批详情页 → 审批详情。
		for (const match of text.matchAll(/(?:在|于|进入|打开|返回|切换到|当前)([\u4e00-\u9fa5A-Za-z0-9]{2,10}?)(?:页面|界面|页)/g)) keep(match[1]);
		for (const match of text.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:页面|界面)/g)) {
			keep(match[1].replace(/^(在|于|的|当前|该|本|进入|打开|返回|切换到|主|子)+/, ''));
		}
		return [...hints];
	};
	const add = (name, fact, pages) => {
		const key = norm(name);
		if (key.length < 2 || key.length > 16) return;
		if (STOP.has(name) || STOP.has(name.replace(/(按键|开关|图标|按钮)$/, ''))) return;
		// 页面上下文参与对象身份；无页面信息的归入无上下文组。
		const contexts = pages.length ? pages : [''];
		for (const page of contexts) {
			const fullKey = key + '@' + norm(page);
			if (!found.has(fullKey)) found.set(fullKey, { name: name.trim(), page: page || '', fact_ids: [] });
			const entry = found.get(fullKey);
			if (!entry.fact_ids.includes(fact.fact_id)) entry.fact_ids.push(fact.fact_id);
		}
	};
	for (const fact of facts) {
		if (!['control', 'feature', 'rule'].includes(fact.type)) continue;
		const statement = String(fact.statement || '');
		const pages = pageHintOf(statement);
		for (const match of statement.matchAll(/[【\[]([^】\]]{2,16})[】\]]/g)) add(match[1], fact, pages);
		if (fact.type === 'control') {
			for (const match of statement.matchAll(/「([^「」]{2,16})」/g)) {
				const cand = match[1].trim();
				if (!/^(?:界面画板|同名候选|待裁决|置灰|高亮|开启|关闭|选中|未选中)/.test(cand)) add(cand, fact, pages);
			}
		}
		for (const match of statement.matchAll(/(?:单击|点击|按下|长按|拖动|滑动|拨动)\s*(?:[【\[「]([^】\]」]{2,16})[】\]」]|([\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:按键|开关|图标|按钮|调节条)))/g)) {
			const name = (match[1] || match[2] || '').replace(namePrefixes(), '').replace(LEAD_VERB, '');
			if (name.length >= 2 && !VERB.test(name) && !NOISE.test(name) && !/(?:瞬间|信号|抵达|变化|无效|模块)/.test(name)) add(name, fact, pages);
		}
		for (const match of statement.matchAll(/([A-Za-z]*[\u4e00-\u9fa5]{2,8})(按键|开关|图标|按钮)/g)) {
			const prefix = match[1]
				.replace(/^.*?(?:界面|页面|面板|栏|屏|通过|关联|控制|包含|提供|设有|点按|短按|按下|点击|单击|操作|触发)/, '')
				.replace(namePrefixes(), '')
				.replace(LEAD_VERB, '');
			if (prefix !== '' && !VERB.test(prefix) && !NOISE.test(prefix) && !/(?:瞬间|信号|抵达|变化|无效|模块|所有|任意)/.test(prefix)) add(prefix + match[2], fact, pages);
		}
	}
	return [...found.values()];
}

/** 剥掉入口限定词只用于找候选；前缀由项目声明，通用代码不认识任何具体入口。 */
const namePrefixes = () => new RegExp('^(?:' + termsPattern(['界面', '页面', ...surfaces(), ...configTerms('name_prefixes')]).source + ')', 'i');

/** The design file and the PRD rarely use identical wording; compose the variants.
 * 简化名只用于找候选；原始名称（含入口语义）始终保留在首位。 */
export function queryVariants(name) {
	const raw = String(name);
	const suffixes = new RegExp('(?:' + termsPattern(['按键', '开关', '图标', '按钮', ...surfaces()]).source + ')$', 'i');
	const clean = raw.replace(suffixes, '');
	const set = new Set([raw, clean]);
	let stripped = clean;
	for (let round = 0; round < 5; round += 1) {
		const next = stripped.replace(namePrefixes(), '');
		if (next === stripped) break;
		stripped = next;
		// 每一层简化都进候选集，而不是只留剥到底的那个。
		set.add(stripped);
	}
	// 需求与设计稿的用字差异由项目声明；通用代码不认识任何具体别名。
	for (const value of [...set]) {
		if (/[/／]/.test(value)) set.add(value.replace(/[/／]/g, ''));
		const modSuffix = /^([\u4e00-\u9fa5]{2,6}?)(?:调节|加|减|开机|关机|控制|设置|状态|模式|功能)$/.exec(value);
		if (modSuffix) set.add(modSuffix[1]);
		const maxPrefix = /^最大([\u4e00-\u9fa5]{2,6})$/.exec(value);
		if (maxPrefix) set.add(`${maxPrefix[1]}MAX`);
		const maxSuffix = /^([\u4e00-\u9fa5]{2,6})MAX$/i.exec(value);
		if (maxSuffix) set.add(`最大${maxSuffix[1]}`);
		for (const [from, to] of configTerms('aliases')) {
			if (!from || !to) continue;
			if (value.includes(from)) set.add(value.split(from).join(to));
			if (value.includes(to)) set.add(value.split(to).join(from));
		}
	}
	return [...set].filter((value) => norm(value).length >= 2);
}

/** Candidate signal names are validated against the DBC index, not guessed. */
export function extractSignals(facts, signalIndex) {
	const found = new Map();
	const lookupSignal = (key) => {
		if (signalIndex.has(key)) return { key, hit: signalIndex.get(key) };
		const prefixHits = [];
		const suffixHits = [];
		const multisetHits = [];
		const charsetHits = [];
		const keyMs = key.length >= 9 ? key.split('').sort().join('') : '';
		for (const [k, v] of signalIndex.entries()) {
			if (k.length >= 8 && key.startsWith(k) && key.length - k.length <= 6) {
				prefixHits.push({ key: k, hit: v });
			}
			if (key.length >= 8 && k.endsWith(key) && k.length - key.length <= 6) {
				suffixHits.push({ key: k, hit: v });
			}
			if (keyMs && k.length === key.length && k.split('').sort().join('') === keyMs) {
				multisetHits.push({ key: k, hit: v });
			}
			if (k.length >= 10 && key.length >= 10 && Math.abs(k.length - key.length) <= 2
				&& [...key].every((ch) => k.includes(ch)) && [...k].every((ch) => key.includes(ch))) {
				charsetHits.push({ key: k, hit: v });
			}
		}
		if (prefixHits.length === 1) return prefixHits[0];
		if (suffixHits.length === 1) return suffixHits[0];
		if (multisetHits.length === 1) return multisetHits[0];
		if (charsetHits.length === 1) return charsetHits[0];
		return null;
	};
	for (const fact of facts) {
		const statement = String(fact.statement || '');
		for (const match of statement.matchAll(/[A-Za-z][A-Za-z0-9_ ]{3,40}/g)) {
			const raw = match[0].trim();
			const rawKey = norm(raw);
			if (rawKey.length < 5) continue;
			const resolved = lookupSignal(rawKey);
			if (!resolved) continue;
			const { key, hit } = resolved;
			if (!found.has(key)) found.set(key, { name: hit.name, fact_ids: [], target: hit });
			if (!found.get(key).fact_ids.includes(fact.fact_id)) {
				found.get(key).fact_ids.push(fact.fact_id);
			}
		}
	}
	return [...found.values()];
}

export function bindingsPath(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule(), 'bindings.json');
}

export function loadBindings(dataRoot, projectId) {
	try {
		return JSON.parse(fs.readFileSync(bindingsPath(dataRoot, projectId), 'utf8'));
	} catch {
		return { version: 0, updatedAt: null, items: [] };
	}
}

export function saveBindings(dataRoot, projectId, items, meta = {}) {
	const file = bindingsPath(dataRoot, projectId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const next = { version: 1, updatedAt: new Date().toISOString(), ...meta, items };
	fs.writeFileSync(file, JSON.stringify(next, null, 1), 'utf8');
	return next;
}

/** page/board names let a fact's wording disambiguate same-named nodes. */
function pageIndex(store, source) {
	const pages = new Map();
	const boards = new Map();
	try {
		for (const page of designPages(store, source).pages || []) {
			pages.set(page.page_id, page.name);
			for (const board of page.boards || []) boards.set(board.board_id, board.name);
		}
	} catch {
		// ids remain usable without names
	}
	return { pages, boards };
}

const stripDesignPrefix = (s) => String(s || '').replace(/^[A-Za-z][-_]+(?:(?:按钮|图标|开关|组件)[-_]+)?/, '');

/** Suggest bindings for every extracted subject; nothing is auto-confirmed.
 * 重跑保护：人工确认/手填的目标与否定过的候选都会保留。 */
export function suggest(projectDir, projectId, dataRoot, facts, meta = {}) {
	const { index, sources } = buildSignalIndex(projectDir);
	const design = designState(projectDir, projectId, dataRoot);
	const controls = extractControls(facts.items || facts);
	const signals = extractSignals(facts.items || facts, index);
	const items = [];
	const allFacts = facts.items || facts;
	const namesBySource = new Map();
	const prior = loadBindings(dataRoot, projectId);
	const priorKey = (subject) => norm(subject.name) + '@' + norm(subject.page || '');
	const priorBySubject = new Map(prior.items.filter((item) => item.kind === 'control').map((item) => [priorKey(item.subject), item]));
	const priorSignalByName = new Map(prior.items.filter((item) => item.kind === 'signal').map((item) => [norm(item.subject.name), item]));
	// 负面记忆：人工否定过的候选，后续匹配继续排除。
	const rejectedTargets = new Set(prior.items.filter((item) => item.status === 'rejected' && item.rejected_target)
		.map((item) => `${item.rejected_target.source_id || ''}/${item.rejected_target.node_id || ''}`));

	for (const control of controls) {
		const item = {
			binding_id: '',
			kind: 'control',
			subject: { name: control.name, page: control.page || '', fact_ids: control.fact_ids },
			target: null,
			candidates: [],
			method: 'none',
			confidence: 0,
			status: design.available ? 'unmatched' : 'no_source'
		};
		const before = priorBySubject.get(priorKey(item.subject));
		if (before?.binding_id) item.binding_id = before.binding_id;
		if (before?.decided_by === 'human' && before.target) {
			items.push({ ...item, target: before.target, candidates: before.candidates || [], method: before.method, confidence: 1, status: 'bound', decided_by: 'human', decided_at: before.decided_at });
			continue;
		}
		if (before?.status === 'rejected') {
			items.push({ ...item, status: 'rejected', rejected_target: before.rejected_target || null });
			continue;
		}
		if (design.available) {
			try {
				const variants = queryVariants(control.name).map(norm);
				const collected = new Map();
				for (const variant of queryVariants(control.name)) {
					const result = designSearch(design.store, variant, { limit: 12 });
					for (const hit of result.results || []) {
						if (collected.has(hit.entity_id) || hit.entity_type === 'page') continue;
						const node = norm(hit.name);
						const strippedNode = norm(stripDesignPrefix(hit.name));
						const score = variants.includes(node) ? 1
							: (strippedNode.length >= 2 && variants.includes(strippedNode)) ? 0.9
							: variants.some((value) => value.includes(node) || node.includes(value)
								|| (strippedNode.length >= 2 && (value.includes(strippedNode) || strippedNode.includes(value)))) ? 0.7
							: 0.3;
						collected.set(hit.entity_id, { source_id: hit.logical_file_id, node_id: hit.entity_id.split('::').at(-1), name: hit.name || '', page: hit.page || '', score });
					}
				}
				const preHits = [...collected.values()].sort((a, b) => b.score - a.score).slice(0, 12);
				// Attach geometry and text: same-named nodes are told apart by shape,
				// not by name.
				for (const hit of preHits) {
					try {
						const detail = designNode(design.store, hit.source_id, hit.node_id);
						if (!detail) continue;
						if (!namesBySource.has(hit.source_id)) namesBySource.set(hit.source_id, pageIndex(design.store, hit.source_id));
						const names = namesBySource.get(hit.source_id);
						hit.page_id = detail.page_id;
						hit.page = names.pages.get(detail.page_id) || '';
						hit.board = names.boards.get(detail.board_id) || '';
						hit.node_id = detail.node_id || hit.node_id;
						hit.type = detail.node_type;
						hit.x = detail.x;
						hit.y = detail.y;
						hit.width = detail.width;
						hit.height = detail.height;
						hit.visible = detail.visible !== false;
						hit.hasText = Array.isArray(detail.texts) && detail.texts.length > 0;
					} catch {
						// keep ids only
					}
				}
				const TYPE_RANK = { COMPONENT_SET: 0, COMPONENT: 1, FRAME: 2, GROUP: 3, INSTANCE: 4 };
				const rankOf = (hit) => TYPE_RANK[hit.type] ?? 5;
				const hasComponentTop = preHits.some((h) => h.score >= 0.9 && (h.type === 'COMPONENT_SET' || h.type === 'COMPONENT'));
				const hits = preHits
					.filter((h) => !(hasComponentTop && h.type === 'TEXT'))
					.sort((a, b) => b.score - a.score || rankOf(a) - rankOf(b))
					.slice(0, 6);
				// Overlapping duplicates (same name, same rect) are one clickable
				// surface: collapse them so the human sees two choices, not four.
				const byGeometry = new Map();
				for (const hit of hits) {
					const key = Number.isFinite(hit.width) ? `${hit.source_id}/${hit.page_id}/${Math.round(hit.x)},${Math.round(hit.y)},${Math.round(hit.width)},${Math.round(hit.height)}` : `${hit.source_id}/${hit.node_id}`;
					const existing = byGeometry.get(key);
					if (existing) existing.duplicates = (existing.duplicates || 1) + 1;
					else byGeometry.set(key, hit);
				}
				const unique = [...byGeometry.values()]
					.filter((hit) => !rejectedTargets.has(`${hit.source_id || ''}/${hit.node_id || ''}`));
				item.candidates = unique;
				const statements = control.fact_ids
					.map((id) => allFacts.find((fact) => fact.fact_id === id)?.statement || '')
					.join(' ');
				// 页面上下文优先：需求里写明的页面能对上时，只在该页内消歧。
				const onPage = control.page ? unique.filter((hit) => hit.page && (hit.page.includes(control.page) || control.page.includes(hit.page))) : [];
				const scope = onPage.length ? onPage : unique;
				const contextual = scope.filter((hit) => hit.score >= 0.7
					&& ((hit.board && statements.includes(hit.board)) || (hit.page && statements.includes(hit.page))));
				if (contextual.length === 1) {
					item.target = contextual[0];
					item.method = 'context';
					item.confidence = 0.9;
					item.status = 'bound';
					items.push(item);
					continue;
				}
				// A control is a clickable surface: it must be visible, big enough to hit,
				// and not a 1×1 spacer.
				const usable = scope.filter((hit) => hit.score >= 0.7
					&& hit.visible !== false
					&& Number.isFinite(hit.width) && Number.isFinite(hit.height)
					&& hit.width >= 24 && hit.height >= 16
					&& hit.width < 1600 && hit.height < 1200);
				if (usable.length === 1) {
					item.target = usable[0];
					item.method = 'shape';
					item.confidence = 0.8;
					item.status = 'bound';
					items.push(item);
					continue;
				}
				const exact = scope.filter((hit) => hit.score === 1);
				const top = scope.filter((hit) => hit.score >= 0.9);
				if (exact.length === 1) {
					item.target = exact[0];
					item.method = 'exact_name';
					item.confidence = 1;
					item.status = 'bound';
				} else if (top.length === 1) {
					item.target = top[0];
					item.method = 'canonical_name';
					item.confidence = 0.9;
					item.status = 'bound';
				} else if (top.length > 1) {
					const canon = top.filter((hit) => hit.type === 'COMPONENT_SET' || hit.type === 'COMPONENT');
					const samePageAsCanon = canon.length === 1
						&& top.every((hit) => hit === canon[0] || hit.type === 'INSTANCE' || (canon[0].page && hit.page === canon[0].page));
					const pagesSet = new Set(top.map((hit) => hit.page || ''));
					const coreSet = new Set(top.map((hit) => norm(stripDesignPrefix(hit.name))));
					if (samePageAsCanon) {
						item.target = canon[0];
						item.method = 'component_set';
						item.confidence = 0.9;
						item.status = 'bound';
					} else if (pagesSet.size === 1 && !pagesSet.has('') && coreSet.size === 1) {
						const ranked = [...top].sort((a, b) => rankOf(a) - rankOf(b)
							|| Number(b.visible !== false) - Number(a.visible !== false));
						item.target = ranked[0];
						item.method = 'same_page_component';
						item.confidence = 0.85;
						item.status = 'bound';
					} else {
						item.status = 'ambiguous';
						item.method = 'candidates';
					}
				} else if (hits.length > 0) {
					item.status = 'ambiguous';
					item.method = 'candidates';
				}
			} catch {
				item.status = 'unmatched';
			}
		}
		items.push(item);
	}

	for (const signal of signals) {
		items.push({
			binding_id: priorSignalByName.get(norm(signal.name))?.binding_id || '',
			kind: 'signal',
			subject: { name: signal.name, fact_ids: signal.fact_ids },
			target: { type: 'dbc_signal', ...signal.target, sources },
			candidates: [],
			method: 'exact_name',
			confidence: 1,
			status: 'bound'
		});
	}

	// ID 稳定：重跑保留旧编号，新对象从最大号往后排，不复用已发出的 ID。
	let nextId = prior.items.reduce((max, item) => Math.max(max, Number(String(item.binding_id || '').replace(/^B-/, '')) || 0), 0);
	for (const item of items) {
		if (!item.binding_id) {
			nextId += 1;
			item.binding_id = `B-${String(nextId).padStart(4, '0')}`;
		}
	}
	return saveBindings(dataRoot, projectId, items, meta);
}

export function confirm(dataRoot, projectId, bindingId, candidateIndex) {
	const document = loadBindings(dataRoot, projectId);
	const item = document.items.find((entry) => entry.binding_id === bindingId);
	if (!item) throw new Error(`绑定不存在：${bindingId}`);
	const candidate = item.candidates?.[Number(candidateIndex)];
	if (!candidate) throw new Error('候选不存在');
	item.target = candidate;
	item.method = 'manual';
	item.confidence = 1;
	item.status = 'bound';
	item.decided_by = 'human';
	item.decided_at = new Date().toISOString();
	return saveBindings(dataRoot, projectId, document.items);
}

export function manual(dataRoot, projectId, bindingId, target) {
	const document = loadBindings(dataRoot, projectId);
	const item = document.items.find((entry) => entry.binding_id === bindingId);
	if (!item) throw new Error(`绑定不存在：${bindingId}`);
	item.target = target;
	item.method = 'manual';
	item.confidence = 1;
	item.status = 'bound';
	item.decided_by = 'human';
	item.decided_at = new Date().toISOString();
	return saveBindings(dataRoot, projectId, document.items);
}

export function reject(dataRoot, projectId, bindingId, rejectedTarget = null) {
	const document = loadBindings(dataRoot, projectId);
	const item = document.items.find((entry) => entry.binding_id === bindingId);
	if (!item) throw new Error(`绑定不存在：${bindingId}`);
	item.status = 'rejected';
	// 记住被否定的具体候选，重跑时继续排除；未指定时保留原目标供追溯。
	item.rejected_target = rejectedTarget || item.target || null;
	item.target = null;
	item.decided_by = 'human';
	item.decided_at = new Date().toISOString();
	return saveBindings(dataRoot, projectId, document.items);
}

export function stats(document) {
	const by = (status) => document.items.filter((item) => item.status === status).length;
	const controls = document.items.filter((item) => item.kind === 'control');
	const signals = document.items.filter((item) => item.kind === 'signal');
	const rate = (list) => (list.length === 0 ? 0 : Math.round((list.filter((item) => item.status === 'bound').length / list.length) * 100));
	return {
		total: document.items.length,
		bound: by('bound'),
		ambiguous: by('ambiguous'),
		unmatched: by('unmatched'),
		no_source: by('no_source'),
		rejected: by('rejected'),
		controlRate: rate(controls),
		signalRate: rate(signals),
		controls: controls.length,
		signals: signals.length
	};
}
