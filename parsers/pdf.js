/**
 * PDF → blocks.
 *
 * Primary path is macOS PDFKit through `osascript`: it handles embedded CID
 * fonts and CJK correctly. When that is unavailable (non-macOS, restricted
 * shell) we fall back to a small stream/CMap reader that works for text PDFs.
 */
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const PAGE_NOISE = /^\s*(\d+\s*\/\s*\d+|第\s*\d+\s*页.*|Page\s+\d+(\s+of\s+\d+)?)\s*$/i;
const HEADING = /^(\d+(?:\.\d+){0,4})[\s、.]+\S/;
const TOC_LINE = /(?:\.{4,}|…{2,}|·{4,})\s*\d+\s*$/;
const TOC_HEADER = /^(?:\d+(?:\.\d+){0,2}[、.]*)?(?:目录|TableofContents|Contents)$/i;
const REVISION_HEADER = /^(?:\d+(?:\.\d+){0,2}[、.]*)?(?:文档|文件)?(?:修订|修改|变更|更改|更新|版本)(?:记录|历史|履历|说明|日志|信息|控制)?(?:$|拟制|修订人|修改人|修订章节|修订内容|版本|日期)|^(?:Revision|Change|Version|Document)(?:History|Log|Record|Control)s?$/i;
const REVISION_ITEM = /(?:新增|修改|更新|删除|补充|调整|优化|修正|变更|修订|取消|增加|信号更新|定义修改|需求定|系统需求|V\d+\.\d+)/i;

function nativeText(filePath) {
	if (process.platform !== 'darwin') return null;
	const script = [
		'ObjC.import("PDFKit");',
		`var url = $.NSURL.fileURLWithPath(${JSON.stringify(filePath)});`,
		'var doc = $.PDFDocument.alloc.initWithURL(url);',
		'if (doc.isNil()) { throw new Error("cannot open pdf"); }',
		'ObjC.unwrap(doc.string);'
	].join('\n');
	try {
		const output = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
			encoding: 'utf8',
			timeout: 30000,
			maxBuffer: 32 * 1024 * 1024
		});
		return output.replace(/\r\n?/g, '\n');
	} catch {
		return null;
	}
}

function decodeLatin(buffer) {
	return buffer.toString('latin1');
}

/** Every Flate-decoded stream in the file, as UTF-16-ish Latin-1 text. */
function inflatedStreams(buffer) {
	const source = decodeLatin(buffer);
	const streams = [];
	const regex = /stream\r?\n/g;
	let match;
	while ((match = regex.exec(source)) !== null) {
		const start = match.index + match[0].length;
		const end = source.indexOf('endstream', start);
		if (end < 0) continue;
		const dict = source.slice(Math.max(0, match.index - 400), match.index);
		const raw = buffer.subarray(start, end);
		let text = null;
		if (/FlateDecode/.test(dict)) {
			try {
				text = zlib.inflateSync(raw).toString('latin1');
			} catch {
				try {
					text = zlib.inflateRawSync(raw).toString('latin1');
				} catch {
					text = null;
				}
			}
		} else if (/stream/.test(dict) && !/Image|DCTDecode|JPXDecode|CCITTFaxDecode/.test(dict)) {
			text = raw.toString('latin1');
		}
		if (text) streams.push(text);
		regex.lastIndex = end;
	}
	return streams;
}

/** Glyph code → unicode from every ToUnicode CMap found in the streams. */
function buildCMap(streams) {
	const map = new Map();
	const put = (code, value) => {
		if (!map.has(code)) map.set(code, value);
	};
	for (const stream of streams) {
		if (!stream.includes('beginbfchar') && !stream.includes('beginbfrange')) continue;
		for (const block of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
			for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
				put(parseInt(pair[1], 16).toString(), String.fromCharCode(...pair[2].match(/.{4}/g).map((hex) => parseInt(hex, 16))));
			}
		}
		for (const block of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
			for (const range of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
				const from = parseInt(range[1], 16);
				const to = parseInt(range[2], 16);
				const base = parseInt(range[3], 16);
				for (let code = from; code <= to && code - from < 65535; code += 1) put(String(code), String.fromCharCode(base + (code - from)));
			}
		}
	}
	return map;
}

function decodeLiteral(value) {
	return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (match, escape) => {
		const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
		if (escape in simple) return simple[escape];
		return String.fromCharCode(parseInt(escape, 8));
	});
}

/** Codes are 2-byte in Identity-H fonts, 1-byte otherwise; decide per string. */
function mapCodes(bytes, cmap) {
	if (bytes.length >= 2 && cmap.size > 0) {
		let mapped = 0;
		const twoByte = [];
		for (let index = 0; index + 1 < bytes.length; index += 2) {
			const code = String((bytes[index] << 8) | bytes[index + 1]);
			if (cmap.has(code)) mapped += 1;
			twoByte.push(cmap.get(code) ?? '');
		}
		if (mapped * 2 >= bytes.length / 2) return twoByte.join('');
	}
	return [...bytes].map((byte) => cmap.get(String(byte)) ?? (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '')).join('');
}

function textFromContent(content, cmap) {
	const out = [];
	// (literal) Tj / [ (a) -120 (b) ] TJ / <hex> Tj
	for (const match of content.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g)) {
		const token = match[0];
		if (token.startsWith('(')) {
			const raw = decodeLiteral(token.slice(1, -1));
			out.push(mapCodes(Buffer.from(raw, 'latin1'), cmap));
		} else {
			const hex = token.slice(1, -1).replace(/\s+/g, '');
			if (hex.length % 2 !== 0) continue;
			const bytes = Buffer.from(hex, 'hex');
			out.push(mapCodes(bytes, cmap));
		}
		if (/\b(T\*|Td|TD|ET)$/.test(content.slice(match.index + token.length, match.index + token.length + 12))) out.push('\n');
	}
	return out.join('');
}

function jsText(buffer) {
	const streams = inflatedStreams(buffer);
	const cmap = buildCMap(streams);
	const pieces = [];
	for (const stream of streams) {
		if (!stream.includes('BT') || (!stream.includes('Tj') && !stream.includes('TJ'))) continue;
		const text = textFromContent(stream, cmap);
		if (text.trim() !== '') pieces.push(text);
	}
	return pieces.join('\n');
}

/** Plain text → blocks. PDFs carry no heading marks, so numbering is the signal. */
export function textToBlocks(raw) {
	// 缝合 PDF 窄列表格中跨行断裂的 ASCII 标识符（如 Prefix\n_\nSuffix 或 Prefix_\nSuffix），不做任何领域硬编码
	const stitched = String(raw || '')
		.replace(/\r\n?/g, '\n')
		.replace(/\b([A-Za-z][A-Za-z0-9]{1,24})\s*\n\s*_\s*\n\s*([A-Za-z0-9_]{2,40})\b/g, '$1_$2')
		.replace(/\b([A-Za-z][A-Za-z0-9_]{1,24}_)\s*\n\s*([A-Za-z0-9_]{2,40})\b/g, '$1$2')
		.replace(/\b([A-Za-z][A-Za-z0-9]{1,20})\s*\n\s*([A-Za-z0-9]{1,24}_[A-Za-z0-9_]{2,32})\b/g, '$1$2')
		.replace(/\b([A-Za-z][A-Za-z0-9_]{3,32})\s*\n\s*([a-z][A-Za-z0-9_]{1,24})\b/g, (m, a, b) => (a.includes('_') ? `${a}${b}` : m));
	const lines = stitched.split('\n');
	const blocks = [];
	const stack = [];
	let pending = '';
	const location = () => stack.filter(Boolean).join(' / ');
	const flush = () => {
		if (pending !== '') blocks.push({ kind: 'para', text: pending, location: location() });
		pending = '';
	};
	// A line that ends mid-sentence is usually a wrapped continuation.
	const continues = (previous, next) => previous !== ''
		&& !/[。；：！？…）】」』:;.!?]$/.test(previous)
		&& previous.length < 60
		&& !/^[0-9（(【\-*•第]/.test(next);

	let skipSection = ''; // 'revision' | 'toc' | ''
	for (const raw of lines) {
		const line = raw.replace(/\u0000/g, '').trim();
		if (line === '' || PAGE_NOISE.test(line)) {
			flush();
			continue;
		}
		// 跳过散落的目录条目行（如 "1.2 功能说明 ........ 15"），避免污染章节栈与正文事实
		if (TOC_LINE.test(line)) {
			flush();
			continue;
		}
		const compact = line.replace(/\s+/g, '').replace(/[：:]$/, '');
		if (TOC_HEADER.test(compact)) {
			flush();
			skipSection = 'toc';
			continue;
		}
		if (compact.length <= 60 && REVISION_HEADER.test(compact)) {
			flush();
			skipSection = 'revision';
			continue;
		}
		const heading = HEADING.exec(line);
		const looksHeading = heading && line.length <= 60 && !/[。；;]$/.test(line);
		if (looksHeading) {
			const level = Math.min(6, heading[1].split('.').length);
			// 目录页里偶发不带点线的子标题行（末尾纯页码），留在 toc 跳过态
			if (skipSection === 'toc' && /\s+\d{1,4}$/.test(line)) {
				continue;
			}
			// 遇到非元信息的正式编号章节标题即退出修订记录/目录跳过态
			if (skipSection) {
				const headingBody = line.slice(heading[1].length).replace(/^[\s、.]+/, '');
				const isRevision = skipSection === 'revision';
				const realSection = (isRevision ? level === 1 : level <= 2)
					&& headingBody.length <= 24
					&& /[A-Za-z\u4e00-\u9fa5]{2,}/.test(headingBody)
					&& !(isRevision && REVISION_ITEM.test(headingBody));
				if (realSection) skipSection = '';
				else continue;
			}
			flush();
			stack.length = Math.max(0, level - 1);
			stack[level - 1] = line;
			blocks.push({ kind: 'heading', level, text: line, location: location() });
			continue;
		}
		if (skipSection) continue;
		if (continues(pending, line)) pending += line;
		else {
			flush();
			pending = line;
		}
	}
	flush();
	return blocks;
}

export function parsePdf(buffer, extension, filePath) {
	const native = filePath ? nativeText(filePath) : null;
	const text = native && native.trim().length > 40 ? native : jsText(buffer);
	if (text.trim().length === 0) {
		throw new Error('PDF 里没有可抽取的文字（可能是扫描件）；请提供文字版 PDF 或转成 docx');
	}
	return textToBlocks(text);
}
