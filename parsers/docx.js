/**
 * .docx → blocks. A .docx is a ZIP with word/document.xml; we walk that XML
 * sequentially instead of building a DOM, which keeps this dependency-free.
 */
import { listEntries, readText } from './zip.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(value) {
	return value
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name] ?? match);
}

function textOf(fragment) {
	const pieces = [];
	const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
	let match;
	while ((match = regex.exec(fragment)) !== null) {
		if (match[0] === '<w:tab/>' || match[0] === '<w:tab />') pieces.push('\t');
		else if (match[0].startsWith('<w:br')) pieces.push('\n');
		else pieces.push(unescapeXml(match[1]));
	}
	return pieces.join('').replace(/[ \t]+\n/g, '\n').trim();
}

/** styleId → { name, outlineLevel }, read from word/styles.xml. */
function styleMap(buffer, entries) {
	const xml = readText(buffer, entries, 'word/styles.xml');
	const map = new Map();
	if (!xml) return map;
	for (const match of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
		const name = /<w:name\s+w:val="([^"]+)"/.exec(match[2])?.[1] ?? '';
		const outline = /<w:outlineLvl\s+w:val="(\d+)"/.exec(match[2])?.[1];
		map.set(match[1], { name, outline: outline === undefined ? undefined : Number(outline) });
	}
	return map;
}

/** 0 = body text; 1..6 = heading depth; -1 = skip (table of contents). */
function headingLevel(paragraphXml, styles) {
	const styleId = /<w:pStyle\s+w:val="([^"]+)"/.exec(paragraphXml)?.[1];
	if (styleId !== undefined) {
		const style = styles.get(styleId);
		if (style) {
			if (/^toc\b/i.test(style.name) || /^toc\s*\d/i.test(style.name) || /目录/.test(style.name)) return -1;
			const named = /^heading\s*(\d)/i.exec(style.name);
			if (named) return Number(named[1]);
			if (style.outline !== undefined) return style.outline >= 9 ? 0 : Math.min(6, style.outline + 1);
		}
	}
	// Word writes outlineLvl 9 for ordinary body text.
	const outline = /<w:outlineLvl\s+w:val="(\d+)"/.exec(paragraphXml);
	if (outline) return Number(outline[1]) >= 9 ? 0 : Math.min(6, Number(outline[1]) + 1);
	return 0;
}

function tableBlocks(tableXml) {
	const rows = [];
	for (const rowMatch of tableXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
		const cells = [];
		for (const cellMatch of rowMatch[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
			cells.push(textOf(cellMatch[1]).replace(/\n/g, ' '));
		}
		if (cells.some((cell) => cell !== '')) rows.push(cells);
	}
	return rows;
}

/** @returns {Array<{kind:string, level?:number, text?:string, rows?:string[][], location:string}>} */
export function parseDocx(buffer) {
	const entries = listEntries(buffer);
	const xml = readText(buffer, entries, 'word/document.xml');
	if (xml === null) throw new Error('docx 里找不到 word/document.xml');
	const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
	const body = bodyMatch ? bodyMatch[1] : xml;

	const styles = styleMap(buffer, entries);
	const blocks = [];
	const stack = [];
	// Split around tables so paragraphs inside cells are not read twice.
	const segments = body.split(/<w:tbl\b[^>]*>/);
	const leading = segments.shift() ?? '';
	const flushParagraphs = (fragment) => {
		for (const match of fragment.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
			const paragraphXml = match[1];
			const text = textOf(paragraphXml);
			if (text === '') continue;
			const level = headingLevel(paragraphXml, styles);
			if (level < 0) continue;
			if (level > 0) {
				stack.length = Math.max(0, level - 1);
				stack[level - 1] = text;
				blocks.push({ kind: 'heading', level, text, location: stack.filter(Boolean).join(' / ') });
			} else {
				blocks.push({ kind: 'para', text, location: stack.filter(Boolean).join(' / ') });
			}
		}
	};
	flushParagraphs(leading);
	for (const segment of segments) {
		const end = segment.indexOf('</w:tbl>');
		if (end < 0) {
			flushParagraphs(segment);
			continue;
		}
		const rows = tableBlocks(segment.slice(0, end));
		if (rows.length > 0) blocks.push({ kind: 'table', rows, location: stack.filter(Boolean).join(' / ') });
		flushParagraphs(segment.slice(end + '</w:tbl>'.length));
	}
	return blocks;
}
