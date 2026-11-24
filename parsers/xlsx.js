/**
 * .xlsx → sheets of rows, plus adaptive block & signal-matrix extractors.
 * Shared strings plus per-sheet cell XML; works for any communication matrix
 * (CAN/J1939/LIN/Ethernet) or generic spreadsheet without domain hardcoding.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { listEntries, readEntry, readText } from './zip.js';

function unescapeXml(value) {
	return value
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name]));
}

function columnIndex(reference) {
	const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? 'A';
	let value = 0;
	for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64);
	return value - 1;
}

function sharedStrings(buffer, entries) {
	const xml = readText(buffer, entries, 'xl/sharedStrings.xml');
	if (xml === null) return [];
	const items = [];
	for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
		const texts = [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => unescapeXml(item[1]));
		items.push(texts.join(''));
	}
	return items;
}

/** r:id → worksheets/sheetN.xml, in workbook order. */
function sheetPaths(buffer, entries) {
	const workbook = readText(buffer, entries, 'xl/workbook.xml');
	const rels = readText(buffer, entries, 'xl/_rels/workbook.xml.rels');
	const relationMap = new Map();
	if (rels) {
		for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
			const id = /Id="([^"]+)"/.exec(match[0])?.[1];
			const target = /Target="([^"]+)"/.exec(match[0])?.[1];
			if (id && target) relationMap.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
		}
	}
	const sheets = [];
	if (workbook) {
		for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
			const name = /name="([^"]*)"/.exec(match[0])?.[1] ?? 'Sheet';
			const rid = /r:id="([^"]+)"/.exec(match[0])?.[1];
			const target = rid ? relationMap.get(rid) : undefined;
			sheets.push({ name: unescapeXml(name), path: target ? `xl/${target}` : null });
		}
	}
	if (sheets.length === 0) {
		for (const [name] of entries) {
			if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) sheets.push({ name, path: name });
		}
	}
	return sheets;
}

function readSheet(buffer, entries, path, strings) {
	const entry = entries.get(path);
	if (!entry) return [];
	const xml = readEntry(buffer, entry).toString('utf8');
	const rows = [];
	for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
		const cells = [];
		for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
			const attrs = cellMatch[1] ?? cellMatch[2] ?? '';
			const body = cellMatch[3] ?? '';
			const reference = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
			const type = /t="([^"]+)"/.exec(attrs)?.[1];
			let value = '';
			if (type === 's') {
				const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1]);
				value = strings[index] ?? '';
			} else if (type === 'inlineStr') {
				value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => unescapeXml(item[1])).join('');
			} else {
				value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
			}
			const index = reference ? columnIndex(reference) : cells.length;
			while (cells.length < index) cells.push('');
			cells[index] = value.replace(/\s*\n\s*/g, ' ').trim();
		}
		if (cells.some((cell) => cell !== '')) rows.push(cells);
	}
	return rows;
}

/** @returns {Array<{name:string, rows:string[][]}>} */
export function parseXlsx(buffer) {
	const entries = listEntries(buffer);
	const strings = sharedStrings(buffer, entries);
	const sheets = [];
	for (const sheet of sheetPaths(buffer, entries)) {
		if (!sheet.path) continue;
		const rows = readSheet(buffer, entries, sheet.path, strings);
		if (rows.length > 0) sheets.push({ name: sheet.name, rows });
	}
	return sheets;
}

const MATRIX_COLUMNS = {
	msgName: /(?:msg|message)\s*name|报文名称|报文名|帧名称/i,
	msgId: /(?:msg|message)\s*id|报文\s*id|报文标识符|帧\s*id/i,
	msgType: /(?:msg|message)\s*type|报文类型/i,
	sendType: /(?:msg|message)\s*send\s*type|报文发送类型/i,
	cycle: /(?:msg|message)\s*cycle\s*time|报文周期时间|报文周期/i,
	dlc: /(?:msg|message)\s*length|报文长度|\bdlc\b/i,
	sigName: /signal\s*name|信号名称|信号名/i,
	sigDesc: /signal\s*desc|信号描述|信号说明/i,
	byteOrder: /byte\s*order|排列格式/i,
	startByte: /start\s*byte|起始字节/i,
	startBit: /start\s*bit|起始位/i,
	bitLen: /(?:bit|signal)\s*length|信号长度|位长/i,
	dataType: /dat[ae]\s*type|数据类型/i,
	resolution: /resolution|factor|精度|比例因子/i,
	offset: /\boffset\b|偏移量/i,
	minPhys: /(?:min\.?\s*value\s*\(phys\)|物理最小值)/i,
	maxPhys: /(?:max\.?\s*value\s*\(phys\)|物理最大值)/i,
	initVal: /initial\s*value|初始值/i,
	invalidVal: /invalid\s*value|无效值/i,
	errorVal: /error\s*value|错误值/i,
	unit: /\bunit\b|单位/i,
	valueDesc: /signal\s*value\s*desc|value\s*table|信号值描述|取值描述|枚举/i,
	transmitter: /transmitter|sender|发送节点|发送方|\btx\s*node\b/i,
	receiver: /receiver|接收节点|接收方|\brx\s*node\b/i
};

const DIR_CELL = /^(?:s|r|t|tx|rx|s\/r|r\/s|t\/r|r\/t|tx\/rx|rx\/tx)$/i;

/** Parse `0x18F32221x`, `0x2F0`, `18F32221x`, `2F0` into normalized `{ rawId, id }`. */
export function parseMessageId(raw) {
	const text = String(raw || '').trim();
	if (!text) return null;
	const hex = /^(?:0x)?([0-9a-f]+)x?$/i.exec(text);
	if (!hex) return null;
	const rawId = parseInt(hex[1], 16);
	if (!Number.isFinite(rawId)) return null;
	return { rawId, id: '0x' + rawId.toString(16).toUpperCase() };
}

/** Parse OEM value descriptions (`0x0: Off 0x1: On`, `0=Off; 1=On`) into a map. */
export function parseValueDescription(raw) {
	const text = String(raw || '').trim();
	if (!text) return null;
	const table = {};
	const matches = [...text.matchAll(/(0x[0-9a-f]+(?:\s*[~～-]\s*0x[0-9a-f]+)?|\b\d+(?:\s*[~～-]\s*\d+)?)\s*[:：=]\s*/gi)];
	if (matches.length === 0) return null;
	for (let index = 0; index < matches.length; index += 1) {
		const start = matches[index].index + matches[index][0].length;
		const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
		const key = matches[index][1].replace(/\s+/g, '');
		const label = text.slice(start, end).replace(/[;；,\s]+$/, '').trim();
		if (key && label) table[key] = label;
	}
	return Object.keys(table).length > 0 ? table : null;
}

function detectMatrixHeader(rows) {
	for (let rowIndex = 0; rowIndex < Math.min(10, rows.length); rowIndex += 1) {
		const row = rows[rowIndex] || [];
		const cols = {};
		const matchedIndices = new Set();
		for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
			const header = String(row[colIndex] || '').trim();
			if (!header) continue;
			for (const [key, pattern] of Object.entries(MATRIX_COLUMNS)) {
				if (cols[key] !== undefined) continue;
				if (key === 'cycle' && /fast|快速/i.test(header)) continue;
				if (pattern.test(header)) {
					cols[key] = colIndex;
					matchedIndices.add(colIndex);
					break;
				}
			}
		}
		if (cols.sigName !== undefined && (cols.msgName !== undefined || cols.msgId !== undefined)) {
			// Detect ECU matrix columns (short node headers whose values are s/r/tx/rx).
			const ecuCols = [];
			for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
				if (matchedIndices.has(colIndex)) continue;
				const header = String(row[colIndex] || '').trim();
				if (!header || header.length > 24 || /[\s()（）]/.test(header)) continue;
				let dirHits = 0;
				let nonEmpty = 0;
				for (let probe = rowIndex + 1; probe < Math.min(rows.length, rowIndex + 80); probe += 1) {
					const cell = String(rows[probe]?.[colIndex] || '').trim();
					if (!cell) continue;
					nonEmpty += 1;
					if (DIR_CELL.test(cell)) dirHits += 1;
				}
				if (dirHits > 0 && dirHits >= nonEmpty * 0.7) ecuCols.push({ index: colIndex, name: header });
			}
			return { headerRow: rowIndex, cols, ecuCols };
		}
	}
	return null;
}

function rowRoles(row, cols, ecuCols) {
	const senders = [];
	const receivers = [];
	const explicitTx = cols.transmitter !== undefined ? String(row[cols.transmitter] || '').trim() : '';
	const explicitRx = cols.receiver !== undefined ? String(row[cols.receiver] || '').trim() : '';
	if (explicitTx) senders.push(...explicitTx.split(/[,;/、\s]+/).filter(Boolean));
	if (explicitRx) receivers.push(...explicitRx.split(/[,;/、\s]+/).filter(Boolean));
	for (const ecu of ecuCols) {
		const mark = String(row[ecu.index] || '').trim().toLowerCase();
		if (!mark) continue;
		if (mark === 's' || mark === 't' || mark === 'tx' || mark.includes('s/') || mark.includes('/s') || mark.includes('tx')) {
			if (!senders.includes(ecu.name)) senders.push(ecu.name);
		}
		if (mark === 'r' || mark === 'rx' || mark.includes('/r') || mark.includes('r/') || mark.includes('rx')) {
			if (!receivers.includes(ecu.name)) receivers.push(ecu.name);
		}
	}
	return { senders, receivers };
}

/**
 * Dynamically detect and extract a communication signal matrix from an Excel workbook.
 * Returns the same `{ messages, byName, signalCount }` structure as `parseDbc` so
 * signal binding, lookup and auditing work identically for `.dbc` and `.xlsx`.
 */
export function extractSignalMatrix(buffer, filePath = '') {
	const sheets = parseXlsx(buffer);
	const messages = new Map();
	const byName = new Map();
	const matrixSheets = new Set();

	for (const sheet of sheets) {
		const detected = detectMatrixHeader(sheet.rows);
		if (!detected) continue;
		matrixSheets.add(sheet.name);
		const { headerRow, cols, ecuCols } = detected;
		const cell = (row, key) => (cols[key] !== undefined ? String(row[cols[key]] || '').trim() : '');
		let current = null;

		for (let rowIndex = headerRow + 1; rowIndex < sheet.rows.length; rowIndex += 1) {
			const row = sheet.rows[rowIndex] || [];
			const msgName = cell(row, 'msgName');
			const msgIdRaw = cell(row, 'msgId');
			const sigName = cell(row, 'sigName');
			const parsedId = parseMessageId(msgIdRaw);

			if (msgName || parsedId) {
				const rawId = parsedId ? parsedId.rawId : -1 * (messages.size + 1);
				const id = parsedId ? parsedId.id : msgIdRaw;
				const name = msgName || id;
				const key = `${rawId}:${name.toLowerCase()}`;
				const existing = (parsedId && messages.get(rawId)) || byName.get(name.toLowerCase()) || null;
				if (existing && (!parsedId || existing.rawId === rawId) && existing.name.toLowerCase() === name.toLowerCase()) {
					current = existing;
				} else {
					const { senders, receivers } = rowRoles(row, cols, ecuCols);
					current = {
						rawId,
						id,
						name,
						dlc: Number(cell(row, 'dlc')) || 8,
						cycle: cell(row, 'cycle'),
						sendType: cell(row, 'sendType'),
						transmitter: senders[0] || '',
						receivers,
						signals: [],
						sheet: sheet.name,
						line: rowIndex + 1,
						_key: key
					};
					messages.set(rawId, current);
					byName.set(name.toLowerCase(), current);
				}
			}

			if (sigName && current) {
				const { senders, receivers } = rowRoles(row, cols, ecuCols);
				if (!current.transmitter && senders[0]) current.transmitter = senders[0];
				const sigReceivers = receivers.length ? receivers : current.receivers || [];
				const valueDesc = cell(row, 'valueDesc');
				const byteOrderRaw = cell(row, 'byteOrder').toLowerCase();
				const dataTypeRaw = cell(row, 'dataType').toLowerCase();
				current.signals.push({
					name: sigName,
					description: cell(row, 'sigDesc'),
					start: Number(cell(row, 'startBit')) || 0,
					startByte: cell(row, 'startByte'),
					length: Number(cell(row, 'bitLen')) || 0,
					byteOrder: byteOrderRaw.includes('intel') ? 'intel' : byteOrderRaw.includes('motorola') ? 'motorola' : byteOrderRaw,
					sign: dataTypeRaw.includes('signed') && !dataTypeRaw.includes('unsigned') ? '-' : '+',
					factor: Number(cell(row, 'resolution')) || 1,
					offset: Number(cell(row, 'offset')) || 0,
					min: cell(row, 'minPhys'),
					max: cell(row, 'maxPhys'),
					initial: cell(row, 'initVal'),
					invalid: cell(row, 'invalidVal'),
					errorValue: cell(row, 'errorVal'),
					unit: cell(row, 'unit'),
					receivers: sigReceivers,
					valueDesc,
					valueTable: parseValueDescription(valueDesc),
					line: rowIndex + 1
				});
			}
		}
	}

	const signalCount = [...messages.values()].reduce((sum, message) => sum + message.signals.length, 0);
	return {
		isMatrix: signalCount > 0,
		file: filePath ? path.basename(filePath) : '',
		sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
		messages,
		byName,
		signalCount,
		matrixSheets,
		sheets
	};
}

/**
 * Convert any .xlsx workbook into evidence blocks consumable by evidence.js.
 * - Signal matrix sheets emit one self-contained `message` block per message (like parseDbc).
 * - Other sheets emit header-preserving `table` blocks so generic Excel specs/docs work too.
 */
export function parseXlsxBlocks(buffer, _ext = '.xlsx', filePath = '') {
	const matrix = extractSignalMatrix(buffer, filePath);
	const blocks = [];

	const MATRIX_META_SHEET = /^(?:cover|history|legend|checkresult|check\s*result|封面|修订记录|版本记录|图例|参数说明|说明)$/i;
	for (const sheet of matrix.sheets) {
		if (matrix.matrixSheets.has(sheet.name)) continue;
		if (matrix.isMatrix && MATRIX_META_SHEET.test(sheet.name.trim())) continue;
		const rows = sheet.rows.filter((row) => row.some((cell) => cell !== ''));
		if (rows.length === 0) continue;
		const header = rows[0];
		const chunkSize = 25;
		if (rows.length <= chunkSize + 1) {
			blocks.push({ kind: 'table', location: sheet.name, rows });
		} else {
			for (let offset = 1; offset < rows.length; offset += chunkSize) {
				blocks.push({ kind: 'table', location: `${sheet.name} (rows ${offset + 1}-${Math.min(rows.length, offset + chunkSize)})`, rows: [header, ...rows.slice(offset, offset + chunkSize)] });
			}
		}
	}

	if (matrix.isMatrix) {
		for (const message of matrix.messages.values()) {
			if (message.signals.length === 0) continue;
			const meta = [
				`ID ${message.id}`,
				message.cycle ? `周期 ${message.cycle}ms` : '',
				message.sendType ? `类型 ${message.sendType}` : '',
				`DLC ${message.dlc}`,
				message.transmitter ? `发送方 ${message.transmitter}` : '',
				message.receivers?.length ? `接收方 ${message.receivers.join(',')}` : ''
			].filter(Boolean).join('，');
			const lines = [`报文 ${message.name}（${meta}）`, `信号 ${message.signals.length} 条：`];
			for (const sig of message.signals) {
				const parts = [];
				if (sig.length) parts.push(`${sig.length}bit`);
				if (sig.min !== '' || sig.max !== '') parts.push(`范围 ${sig.min}~${sig.max}${sig.unit ? ` ${sig.unit}` : ''}`);
				if (sig.initial) parts.push(`初始值 ${sig.initial}`);
				if (sig.invalid) parts.push(`无效值 ${sig.invalid}`);
				if (sig.receivers?.length) parts.push(`接收方 ${sig.receivers.join(',')}`);
				if (sig.valueDesc) parts.push(`取值 ${sig.valueDesc}`);
				const label = sig.description ? `${sig.name}（${sig.description}）` : sig.name;
				lines.push(`- ${label}：${parts.join('；')}`);
			}
			blocks.push({ kind: 'message', location: `${message.sheet} / ${message.name}`, text: lines.join('\n') });
		}
	}

	return blocks;
}
