/**
 * File-backed store for the cockpit test agent.
 *
 * Nothing here talks to a model: this module only owns paths, project discovery
 * and the append-only run log the page replays after a refresh.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Kept next to the user's other documents; overridable through plugin config. */
export function dataDir(config) {
	const configured = typeof config?.dataDir === 'string' && config.dataDir.trim() !== '' ? config.dataDir.trim() : '';
	return configured || path.join(os.homedir(), 'Documents', 'CTS');
}

/** Roots scanned for projects. The legacy workbench is read-only ground truth. */
export function sourceRoots(config) {
	const roots = [{ dir: path.join(dataDir(config), 'projects'), readonly: false }];
	const extra = Array.isArray(config?.sourceRoots) ? config.sourceRoots : [];
	if (config?.legacyRoot !== false) {
		// The old workbench stays mounted read-only: it is the regression baseline.
		const legacy = path.join(os.homedir(), 'Documents', 'ChatGPT', 'crewai', 'data', 'projects');
		if (fsSync.existsSync(legacy)) roots.push({ dir: legacy, readonly: true });
	}
	for (const entry of extra) {
		if (typeof entry !== 'string' || entry.trim() === '') continue;
		roots.push({ dir: entry.trim(), readonly: true });
	}
	return roots;
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8'));
	} catch {
		return fallback;
	}
}

async function exists(target) {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/** Every project is a directory holding project.json; missing metadata is still listed. */
export async function listProjects(config) {
	const seen = new Map();
	for (const root of sourceRoots(config)) {
		let entries = [];
		try {
			entries = await fs.readdir(root.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			const dir = path.join(root.dir, entry.name);
			const meta = await readJson(path.join(dir, 'project.json'), null);
			if (meta === null && !(await exists(path.join(dir, 'prd')))) continue;
			const id = typeof meta?.id === 'string' ? meta.id : entry.name;
			if (seen.has(id)) continue;
			const stat = await fs.stat(dir).catch(() => null);
			seen.set(id, {
				id,
				name: typeof meta?.name === 'string' && meta.name.trim() !== '' ? meta.name : entry.name,
				modules: Array.isArray(meta?.modules) ? meta.modules.map((m) => ({ id: m.id, name: m.name })) : [],
				quality: meta?.quality && typeof meta.quality === 'object' ? meta.quality : null,
				dir,
				readonly: root.readonly,
				updatedAt: stat ? stat.mtime.toISOString() : null
			});
		}
	}
	return [...seen.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function project(config, id) {
	const all = await listProjects(config);
	return all.find((item) => item.id === id) || null;
}

/** Shallow inventory: enough for the page's left column and for the agent's first turn. */
export async function inventory(dir, maxDepth = 3) {
	const files = [];
	async function walk(current, depth) {
		if (depth > maxDepth || files.length >= 400) return;
		let entries = [];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full, depth + 1);
			} else {
				const stat = await fs.stat(full).catch(() => null);
				files.push({
					path: path.relative(dir, full),
					bytes: stat ? stat.size : 0,
					ext: path.extname(entry.name).toLowerCase()
				});
			}
		}
	}
	await walk(dir, 0);
	const byExt = {};
	for (const file of files) {
		const key = file.ext || '(none)';
		byExt[key] = (byExt[key] || 0) + 1;
	}
	return { files, byExt, total: files.length };
}

/** Files the agent will eventually read; grouped so the summary reads like a workbench. */
export function groupFiles(files) {
	const groups = { prd: [], signals: [], design: [], other: [] };
	for (const file of files) {
		const lower = file.path.toLowerCase();
		if (/\.(docx?|pdf|md|txt)$/.test(lower)) groups.prd.push(file);
		else if (/\.(dbc|xlsx|csv|arxml)$/.test(lower)) groups.signals.push(file);
		else if (/\.(pix|png|jpe?g|svg|html)$/.test(lower)) groups.design.push(file);
		else groups.other.push(file);
	}
	return groups;
}

export async function summary(config, id) {
	const item = await project(config, id);
	if (!item) throw new Error(`项目不存在：${id}`);
	const inv = await inventory(item.dir);
	const groups = groupFiles(inv.files);
	const moduleNames = item.modules.map((m) => m.name).filter(Boolean);
	return {
		id: item.id,
		name: item.name,
		readonly: item.readonly,
		dir: item.dir,
		modules: moduleNames,
		counts: {
			prd: groups.prd.length,
			signals: groups.signals.length,
			design: groups.design.length,
			other: groups.other.length,
			total: inv.total
		},
		files: {
			prd: groups.prd.slice(0, 12).map((f) => f.path),
			signals: groups.signals.slice(0, 12).map((f) => f.path),
			design: groups.design.slice(0, 12).map((f) => f.path)
		}
	};
}

export function runsDir(config, projectId) {
	return path.join(dataDir(config), 'runs', projectId);
}

const runFile = (config, projectId, runId) => path.join(runsDir(config, projectId), `${runId}.jsonl`);

export async function appendEvent(config, projectId, runId, event) {
	const file = runFile(config, projectId, runId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

export async function readEvents(config, projectId, runId) {
	try {
		const text = await fs.readFile(runFile(config, projectId, runId), 'utf8');
		return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

export async function latestRun(config, projectId) {
	let entries = [];
	try {
		entries = await fs.readdir(runsDir(config, projectId));
	} catch {
		return null;
	}
	const jsonl = entries.filter((name) => name.endsWith('.jsonl')).sort();
	return jsonl.length === 0 ? null : jsonl[jsonl.length - 1].replace(/\.jsonl$/, '');
}

export async function ensureDataDir(config) {
	await fs.mkdir(path.join(dataDir(config), 'projects'), { recursive: true });
	return dataDir(config);
}
