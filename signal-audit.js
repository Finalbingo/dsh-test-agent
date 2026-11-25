import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dutNode, dutLabel } from './scope.js';
import { extractSignalMatrix, parseMessageId } from './parsers/xlsx.js';

/** 请求还是反馈由项目声明的被测节点决定；没声明就写待核，不猜方向。 */
export const directionOf = (transmitter) => {
	if (!transmitter) return '发送方未声明（方向待核）';
	const node = dutNode();
	if (!node) return `${transmitter} 发送（方向待核：项目未声明被测节点）`;
	return transmitter === node ? `${dutLabel()} 发送（请求）` : `${transmitter} 发送（${dutLabel()} 接收反馈）`;
};

/**
 * Technical dependencies are checked against the current protocol source (.dbc or .xlsx),
 * field by field. A near-miss name is reported with the message's real field list — never
 * substituted, because a request signal and its feedback share a stem and
 * swapping them turns a send test into a listen test.
 */
export function parseDbc(file) {
	const buffer = fs.readFileSync(file);
	if (String(file).toLowerCase().endsWith('.xlsx')) {
		const matrix = extractSignalMatrix(buffer, file);
		return {
			file: matrix.file || path.basename(file),
			sha256: matrix.sha256,
			messages: matrix.messages,
			byName: matrix.byName,
			signalCount: matrix.signalCount
		};
	}
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
	} catch {
		text = new TextDecoder('gb18030').decode(buffer);
	}
	const messages = new Map();
	const byName = new Map();
	const values = new Map();
	const comments = new Map();
	let current = null;
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		const bo = /^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s+(\S+)/.exec(line);
		if (bo) {
			current = {
				rawId: Number(bo[1]), id: '0x' + Number(bo[1]).toString(16).toUpperCase(),
				name: bo[2], dlc: Number(bo[3]), transmitter: bo[4], signals: [], line: index + 1
			};
			messages.set(current.rawId, current);
			byName.set(current.name.toLowerCase(), current);
			continue;
		}
		const sg = /^SG_\s+([A-Za-z0-9_]+)\s*(?:[A-Za-z0-9_]+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]*)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*)$/.exec(line);
		if (sg && current) {
			current.signals.push({
				name: sg[1], start: Number(sg[2]), length: Number(sg[3]), byteOrder: sg[4] === '0' ? 'motorola' : 'intel',
				sign: sg[5], factor: Number(sg[6]), offset: Number(sg[7]), min: sg[8], max: sg[9], unit: sg[10],
				receivers: sg[11].split(',').map((value) => value.trim()).filter(Boolean), line: index + 1
			});
			continue;
		}
		const val = /^VAL_\s+(\d+)\s+([A-Za-z0-9_]+)\s+(.*)\s*;$/.exec(line);
		if (val) {
			const table = {};
			for (const match of val[3].matchAll(/(-?\d+)\s+"([^"]*)"/g)) table[match[1]] = match[2];
			values.set(`${val[1]}.${val[2]}`, table);
			continue;
		}
		const cmSg = /^CM_\s+SG_\s+(\d+)\s+([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*;$/.exec(line);
		if (cmSg) {
			comments.set(`${cmSg[1]}.${cmSg[2]}`, cmSg[3].replace(/\\"/g, '"'));
		}
	}
	for (const message of messages.values()) {
		for (const signal of message.signals) {
			signal.valueTable = values.get(`${message.rawId}.${signal.name}`) || null;
			signal.comment = comments.get(`${message.rawId}.${signal.name}`) || '';
		}
	}
	return {
		file: path.basename(file), sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
		messages, byName, signalCount: [...messages.values()].reduce((sum, message) => sum + message.signals.length, 0)
	};
}

export const parseSignalSource = parseDbc;

export function findMessage(dbc, token) {
	const raw = String(token || '').trim();
	const parsed = /^0x[0-9a-f]+x?$/i.test(raw) ? parseMessageId(raw) : null;
	if (parsed) return dbc.messages.get(parsed.rawId) || null;
	if (/^\d+$/.test(raw)) return dbc.messages.get(Number(raw)) || null;
	return dbc.byName.get(raw.toLowerCase()) || null;
}

/** `AC(0x2F0).HVAC_TempSet`, `IVI_AC_6(0x3A6) 的 IVI_Air_Button`, `AC1(0x18F32221x).CCM_AC_AutoModeSt`, bare `HVAC_Defrost`. */
const COMBO = /([A-Za-z][A-Za-z0-9_ /]*)\s*\(\s*(0x[0-9A-Fa-f]+x?)\s*\)\s*[.．的]?\s*([A-Za-z][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*){0,3})/g;
// The PRD writes some signals with spaces ("HVAC_Air volume level"); the DBC
// uses underscores. Capture the whole written form so the difference is reported.
const TOKEN = /\b([A-Z][A-Za-z0-9]{2,}_[A-Za-z0-9_]+(?: [A-Za-z_][A-Za-z0-9_]*){0,3})\b/g;
// 原文常写「<信号> 报文（ID 0x…）」。写死的报文号必须一起校验，否则按信号名解析后就把错号丢了。
const ID_AFTER = /^\s*(?:报文|消息)?\s*[（(]\s*(?:ID\s*)?(0x[0-9A-Fa-f]+x?)\s*[)）]/;

export function dependenciesOf(text) {
	const found = [];
	const source = String(text || '');
	for (const match of source.matchAll(COMBO)) {
		found.push({ written: match[0].trim(), message: match[1].trim(), message_id: match[2], signal: match[3], kind: 'combo' });
	}
	const covered = new Set(found.map((entry) => entry.signal));
	for (const match of source.matchAll(TOKEN)) {
		if (covered.has(match[1])) continue;
		covered.add(match[1]);
		const after = source.slice(match.index + match[0].length).match(ID_AFTER);
		found.push({ written: after ? `${match[1]}${after[0]}`.trim() : match[1], message: '', message_id: after?.[1] || '', signal: match[1], kind: 'bare' });
	}
	return found;
}

/** Where does this signal actually live? A stem shared by request and feedback is not a match. */
export function locateSignal(dbc, name) {
	const hits = [];
	for (const message of dbc.messages.values()) {
		const signal = message.signals.find((entry) => entry.name === name);
		if (signal) hits.push({ message, signal });
	}
	return hits;
}

export function similarNames(dbc, name) {
	const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
	const all = [...dbc.messages.values()].flatMap((message) => message.signals.map((signal) => signal.name));
	return all.filter((candidate) => {
		const other = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
		if (other === key) return false;
		let hit = 0;
		for (let index = 0; index < Math.min(key.length, other.length); index += 1) if (key[index] === other[index]) hit += 1;
		return hit / Math.max(key.length, other.length) >= 0.8;
	}).slice(0, 6);
}

/**
 * @returns rows for signal-dependencies.tsv: one per dependency occurrence.
 * `status` is ok | unknown_message | unknown_signal | direction_conflict | value_undefined.
 */
export function auditCase(item, dbc, { purpose = '' } = {}) {
	const rows = [];
	const places = [
		...(item.step_items || []).map((step) => ({ field: 'step', id: step.id, text: step.text })),
		...(item.steps || []).map((step, index) => ({ field: 'steps', id: `S${String(index + 1).padStart(2, '0')}`, text: step })),
		...(item.expected_items || []).map((entry) => ({ field: 'expected', id: entry.id, text: entry.text })),
		{ field: 'expected', id: '', text: item.expected || '' },
		{ field: 'precondition', id: '', text: item.precondition || '' },
		{ field: 'prepare_detail', id: '', text: item.prepare_detail || '' },
		// 准备项与延期项同样引用信号：不扫它们，延期就等于把依赖悄悄移出 DBC 校验。
		// 逐子字段扫：拼成一段时信号名先出现，后面读回里写的报文号就关联不上。
		...(item.prepare_items || []).flatMap((entry) => ['object', 'target', 'establish', 'read_back', 'on_failure']
			.filter((sub) => entry[sub]).map((sub) => ({ field: 'prepare', id: `${entry.id}#${sub}`, text: String(entry[sub]) }))),
		...(item.deferred_items || []).flatMap((entry) => ['object', 'target', 'unresolved', 'text']
			.filter((sub) => entry[sub]).map((sub) => ({ field: 'deferred', id: `${entry.id}#${sub}`, text: String(entry[sub]) })))
	];
	const seen = new Set();
	for (const place of places) {
		for (const dependency of dependenciesOf(place.text)) {
			const key = `${place.field}:${place.id}:${dependency.written}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const message = dependency.message_id ? findMessage(dbc, dependency.message_id) : findMessage(dbc, dependency.message);
			const row = {
				case_id: item.case_id, field: place.field, ref_id: place.id,
				written: dependency.written, message_token: dependency.message || dependency.message_id,
				signal: dependency.signal, purpose,
				dbc_file: dbc.file, dbc_sha256: dbc.sha256,
				status: 'ok', detail: '', available: '', evidence: ''
			};
			const describe = (target, signal) => {
				row.message_name = target.name;
				row.message_id = target.id;
				row.transmitter = target.transmitter;
				row.signal_line = signal.line;
				row.direction = directionOf(target.transmitter);
				row.range = `${signal.min}~${signal.max}${signal.unit ? ' ' + signal.unit : ''}`;
				row.value_table = signal.valueTable ? JSON.stringify(signal.valueTable) : '';
				row.evidence = `${dbc.file}:${signal.line}`;
				if (!signal.valueTable && /=\s*0x[0-9a-f]+/i.test(place.text)) {
					row.status = 'value_undefined';
					row.detail = `DBC 未给出 ${signal.name} 的取值表，写死的值需由 PRD 或产品裁决确认`;
				}
			};
			// 本身就是报文名的仍按报文-only 处理；写死报文号的裸信号改走「报文+字段」校验，错号才报得出来。
			const named = dependency.kind === 'bare' ? findMessage(dbc, dependency.signal) : null;
			if (dependency.kind === 'bare' && (!dependency.message_id || named)) {
				const asMessage = named;
				if (asMessage) {
					row.message_name = asMessage.name;
					row.message_id = asMessage.id;
					row.transmitter = asMessage.transmitter;
					row.direction = directionOf(asMessage.transmitter);
					row.detail = '只写了报文名，未指定字段';
					row.available = asMessage.signals.map((entry) => entry.name).join('、');
					row.evidence = `${dbc.file}:${asMessage.line}`;
					row.status = 'message_only';
					const normalizedDepId = dependency.message_id ? (parseMessageId(dependency.message_id)?.id || dependency.message_id) : '';
					if (normalizedDepId && normalizedDepId.toLowerCase() !== asMessage.id.toLowerCase()) {
						row.status = 'unknown_message';
						row.detail = `写死的报文号 ${dependency.message_id} 与 ${asMessage.name} 的实际 ID ${asMessage.id} 不符`;
					}
					rows.push(row);
					continue;
				}
				const hits = locateSignal(dbc, dependency.signal);
				if (hits.length === 1) describe(hits[0].message, hits[0].signal);
				else if (hits.length > 1) {
					row.status = 'ambiguous_message';
					row.detail = `信号 ${dependency.signal} 出现在多个报文，须写明报文与方向`;
					row.available = hits.map((hit) => `${hit.message.name}(${hit.message.id})/${hit.message.transmitter}`).join('、');
					row.evidence = hits.map((hit) => `${dbc.file}:${hit.signal.line}`).join('；');
				} else {
					const normalized = dependency.signal.replace(/\s+(?=_)/g, '').replace(/\s+/g, '_');
					const alt = normalized !== dependency.signal ? locateSignal(dbc, normalized) : [];
					if (alt.length === 1) {
						describe(alt[0].message, alt[0].signal);
						row.status = 'name_format_differs';
						row.detail = `原文写「${dependency.signal}」，DBC 字段为「${normalized}」（分隔符不同）。须由产品/通信确认是同一信号后才能用，不自动替换`;
						row.available = normalized;
					} else {
						row.status = 'unknown_signal';
						row.detail = `当前 DBC 没有信号 ${dependency.signal}`;
						row.available = similarNames(dbc, dependency.signal).join('、');
						row.evidence = dbc.file;
					}
				}
				rows.push(row);
				continue;
			}
			if (!message) {
				row.status = 'unknown_message';
				row.detail = `当前 DBC 找不到报文 ${dependency.message || dependency.message_id}`;
				row.evidence = `${dbc.file}`;
			} else {
				row.message_name = message.name;
				row.message_id = message.id;
				row.transmitter = message.transmitter;
				row.evidence = `${dbc.file}:${message.line}`;
				const signal = message.signals.find((entry) => entry.name === dependency.signal);
				const normalized = dependency.signal.replace(/\s+(?=_)/g, '').replace(/\s+/g, '_');
				const alt = signal || normalized === dependency.signal ? null : message.signals.find((entry) => entry.name === normalized);
				if (signal) describe(message, signal);
				else if (alt) {
					// PRD 用空格分词、DBC 用下划线：两种写法都报出来等人工确认，不自动替换。
					describe(message, alt);
					row.status = 'name_format_differs';
					row.detail = `原文写作 ${dependency.signal}，DBC 字段为 ${alt.name}，须确认是同一字段`;
					row.evidence = `${dbc.file}:${alt.line}`;
				} else {
					row.status = 'unknown_signal';
					row.detail = `报文 ${message.name}(${message.id}) 无字段 ${dependency.signal}`;
					row.available = message.signals.map((entry) => entry.name).join('、');
					row.evidence = `${dbc.file}:${message.line}`;
				}
			}
			rows.push(row);
		}
	}
	return rows;
}

export function auditCases(cases, dbc, purposes = new Map()) {
	return cases.flatMap((item) => auditCase(item, dbc, { purpose: purposes.get(item.case_id) || '' }));
}

export const DEPENDENCY_COLUMNS = ['case_id', 'field', 'ref_id', 'written', 'message_token', 'signal', 'message_name', 'message_id', 'transmitter', 'direction', 'range', 'value_table', 'purpose', 'status', 'detail', 'available', 'dbc_file', 'dbc_sha256', 'evidence'];

export function dependencyTsv(rows) {
	return [DEPENDENCY_COLUMNS.join('\t'), ...rows.map((row) => DEPENDENCY_COLUMNS.map((key) => String(row[key] ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n';
}