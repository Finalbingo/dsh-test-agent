/**
 * Minimal .xlsx writer: one sheet, inline strings, wrapped cells, frozen header.
 * Deliberately dependency-free — the export is a projection of JSON, not a report engine.
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export function zip(files) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, 'utf8');
		const raw = Buffer.from(file.content, 'utf8');
		const deflated = zlib.deflateRawSync(raw);
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(deflated.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, deflated);

		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt16LE(0, 12);
		entry.writeUInt16LE(0, 14);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(deflated.length, 20);
		entry.writeUInt32LE(raw.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt16LE(0, 30);
		entry.writeUInt16LE(0, 32);
		entry.writeUInt16LE(0, 34);
		entry.writeUInt16LE(0, 36);
		entry.writeUInt32LE(0, 38);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, name);

		offset += local.length + name.length + deflated.length;
	}
	const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...locals, ...central, end]);
}

function escapeXml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function columnName(index) {
	let value = index + 1;
	let name = '';
	while (value > 0) {
		const rest = (value - 1) % 26;
		name = String.fromCharCode(65 + rest) + name;
		value = Math.floor((value - 1) / 26);
	}
	return name;
}

/** Multi-sheet workbook: [{ name, headers, rows, widths }] */
export function buildWorkbook(sheets) {
	if (sheets.length === 1) {
		return buildXlsx(sheets[0].headers, sheets[0].rows, { sheetName: sheets[0].name, widths: sheets[0].widths });
	}
	const sheetXml = sheets.map((sheet) => {
		const widths = sheet.widths || sheet.headers.map(() => 20);
		const cols = `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`;
		const headerCells = sheet.headers.map((header, index) => `<c r="${columnName(index)}1" t="inlineStr" s="1"><is><t>${escapeXml(header)}</t></is></c>`).join('');
		const bodyRows = sheet.rows.map((row, rowIndex) => {
			const cells = row.map((cell, index) => {
				if (cell === null || cell === undefined || cell === '') return '';
				const ref = `${columnName(index)}${rowIndex + 2}`;
				if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}" s="2"><v>${cell}</v></c>`;
				return `<c r="${ref}" t="inlineStr" s="2"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
			}).join('');
			return `<row r="${rowIndex + 2}">${cells}</row>`;
		}).join('');
		return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData></worksheet>`;
	});
	const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="PingFang SC"/></font><font><b/><sz val="11"/><name val="PingFang SC"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
	const overrides = sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
	const sheetTags = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
	const sheetRels = sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
	const files = [
		{ name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
		{ name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
		{ name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>` },
		{ name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
		{ name: 'xl/styles.xml', content: styles },
		...sheetXml.map((xml, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: xml }))
	];
	return zip(files);
}

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @param {{sheetName?:string, widths?:number[]}} options
 */
export function buildXlsx(headers, rows, options = {}) {
	const sheetName = escapeXml(options.sheetName || 'Sheet1');
	const widths = options.widths || headers.map(() => 20);
	const cols = `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`;
	const headerCells = headers.map((header, index) => `<c r="${columnName(index)}1" t="inlineStr" s="1"><is><t>${escapeXml(header)}</t></is></c>`).join('');
	const bodyRows = rows.map((row, rowIndex) => {
		const cells = row.map((cell, index) => {
			if (cell === null || cell === undefined || cell === '') return '';
			const ref = `${columnName(index)}${rowIndex + 2}`;
			if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}" s="2"><v>${cell}</v></c>`;
			return `<c r="${ref}" t="inlineStr" s="2"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
		}).join('');
		return `<row r="${rowIndex + 2}">${cells}</row>`;
	}).join('');
	const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData></worksheet>`;
	const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="PingFang SC"/></font><font><b/><sz val="11"/><name val="PingFang SC"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
	return zip([
		{ name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
		{ name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
		{ name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
		{ name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
		{ name: 'xl/styles.xml', content: styles },
		{ name: 'xl/worksheets/sheet1.xml', content: sheet }
	]);
}
