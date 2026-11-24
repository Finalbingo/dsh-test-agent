import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE = 'agent-activity.jsonl';
const PAGE_SIZE = 60;
const BLOCK_SIZE = 128 * 1024;
const short = (value, limit = 100) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, limit);

export function recordActivity(root, { project, module, action, stage, detail, run, role, artifact }) {
	const row = {
		id: randomUUID(), at: new Date().toISOString(), project: short(project),
		module: short(module), action: short(action), stage: short(stage), detail: short(detail, 180), run: short(run),
		...(role ? { role: short(role) } : {}), ...(artifact ? { artifact: short(artifact) } : {})
	};
	fs.mkdirSync(root, { recursive: true });
	fs.appendFileSync(path.join(root, FILE), JSON.stringify(row) + '\n', { mode: 0o600 });
}

export function listActivity(root, cursor, filter = {}) {
	const filterProject = typeof filter?.project === 'string' ? filter.project.trim() : '';
	const filterModule = typeof filter?.module === 'string' ? filter.module.trim() : '';
	const matches = (item) => {
		if (filterProject && item.project !== filterProject) return false;
		if (filterModule && item.module !== filterModule) return false;
		return true;
	};
	let fd;
	try {
		fd = fs.openSync(path.join(root, FILE), 'r');
	} catch (error) {
		if (error.code === 'ENOENT') return { items: [], next: null };
		throw error;
	}
	try {
		const size = fs.fstatSync(fd).size;
		let end = Number.isSafeInteger(cursor) && cursor >= 0 ? Math.min(cursor, size) : size;
		const collected = [];
		let moreOlder = false;
		// 按块倒序扫描，确保切换回历史模块时仍能完整翻出属于该模块的记录。
		while (end > 0 && collected.length < PAGE_SIZE) {
			const from = Math.max(0, end - BLOCK_SIZE);
			const bytes = Buffer.alloc(end - from);
			const read = fs.readSync(fd, bytes, 0, bytes.length, from);
			let position = from ? bytes.indexOf(10) + 1 : 0;
			const blockItems = [];
			while (position < read) {
				const delimiter = bytes.indexOf(10, position);
				if (delimiter < 0 || delimiter >= read) break;
				try {
					const item = JSON.parse(bytes.toString('utf8', position, delimiter));
					if (matches(item)) blockItems.push({ item, offset: from + position });
				} catch {
					// A partial write can leave one malformed line.
				}
				position = delimiter + 1;
			}
			for (let idx = blockItems.length - 1; idx >= 0; idx -= 1) {
				if (collected.length < PAGE_SIZE) {
					collected.push(blockItems[idx]);
				} else {
					moreOlder = true;
					break;
				}
			}
			if (from === 0) break;
			if (collected.length >= PAGE_SIZE) {
				moreOlder = true;
				break;
			}
			// 下一轮从本块首条完整行起点之前继续向前读，避免跨块丢行。
			const firstNewline = bytes.indexOf(10);
			end = firstNewline >= 0 ? from + firstNewline + 1 : from;
		}
		const next = moreOlder && collected.length ? collected[collected.length - 1].offset : null;
		return { items: collected.map(({ item }) => item), next };
	} finally {
		fs.closeSync(fd);
	}
}
