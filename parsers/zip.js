/**
 * Minimal ZIP reader: enough for .docx and .xlsx, which are plain ZIP archives.
 *
 * Reads the end-of-central-directory record, walks the central directory, then
 * inflates only the entries asked for. Supports stored (0) and deflate (8).
 */
import zlib from 'node:zlib';

function findEocd(buffer) {
	const min = Math.max(0, buffer.length - 66000);
	for (let i = buffer.length - 22; i >= min; i -= 1) {
		if (buffer.readUInt32LE(i) === 0x06054b50) return i;
	}
	return -1;
}

/** @returns {Map<string, {method:number, offset:number, compressedSize:number, size:number}>} */
export function listEntries(buffer) {
	const eocd = findEocd(buffer);
	if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）');
	const count = buffer.readUInt16LE(eocd + 10);
	let pointer = buffer.readUInt32LE(eocd + 16);
	const entries = new Map();
	for (let index = 0; index < count; index += 1) {
		if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
		const method = buffer.readUInt16LE(pointer + 10);
		const compressedSize = buffer.readUInt32LE(pointer + 20);
		const size = buffer.readUInt32LE(pointer + 24);
		const nameLength = buffer.readUInt16LE(pointer + 28);
		const extraLength = buffer.readUInt16LE(pointer + 30);
		const commentLength = buffer.readUInt16LE(pointer + 32);
		const offset = buffer.readUInt32LE(pointer + 42);
		const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
		entries.set(name, { method, offset, compressedSize, size });
		pointer += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

export function readEntry(buffer, entry) {
	const nameLength = buffer.readUInt16LE(entry.offset + 26);
	const extraLength = buffer.readUInt16LE(entry.offset + 28);
	const start = entry.offset + 30 + nameLength + extraLength;
	const data = buffer.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) return data;
	if (entry.method === 8) return zlib.inflateRawSync(data);
	throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
}

export function readText(buffer, entries, name) {
	const entry = entries.get(name);
	if (!entry) return null;
	return readEntry(buffer, entry).toString('utf8');
}
