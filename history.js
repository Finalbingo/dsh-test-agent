/**
 * History index: the old workbench holds 40+ sessions of requirements and test
 * designs. Indexing them lets the agent say "this was already designed before",
 * which is the cheapest kind of test knowledge there is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function historyDir(dataRoot) {
	return path.join(dataRoot, 'history');
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

function walk(dir, depth, out) {
	if (depth > 6 || out.length > 5000) return;
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, depth + 1, out);
		else if (entry.name === 'model.json') out.push(full);
	}
}

export function build(dataRoot, legacyRoot = path.join(os.homedir(), 'Documents', 'ChatGPT', 'crewai')) {
	const files = [];
	walk(path.join(legacyRoot, '.ecsm', 'sessions'), 0, files);
	const items = [];
	for (const file of files) {
		const model = readJson(file, null);
		if (!model || !Array.isArray(model.requirements)) continue;
		const session = path.basename(path.dirname(path.dirname(path.dirname(file))));
		for (const requirement of model.requirements) {
			const statement = String(requirement.statement || '').trim();
			if (statement === '') continue;
			items.push({
				id: requirement.id || '',
				session,
				capability: requirement.capability || '',
				title: requirement.title || '',
				statement: statement.slice(0, 400)
			});
		}
	}
	const document = { builtAt: new Date().toISOString(), legacyRoot, count: items.length, items };
	fs.mkdirSync(historyDir(dataRoot), { recursive: true });
	fs.writeFileSync(path.join(historyDir(dataRoot), 'index.json'), JSON.stringify(document), 'utf8');
	return { count: items.length, sessions: new Set(items.map((item) => item.session)).size, builtAt: document.builtAt };
}

export function load(dataRoot) {
	return readJson(path.join(historyDir(dataRoot), 'index.json'), { count: 0, items: [] });
}

function tokens(text) {
	const value = String(text || '').toLowerCase();
	const set = new Set();
	for (const word of value.match(/[a-z0-9_]{2,}/g) || []) set.add(word);
	for (const run of value.match(/[\u4e00-\u9fff]+/g) || []) {
		if (run.length === 1) set.add(run);
		for (let index = 0; index < run.length - 1; index += 1) set.add(run.slice(index, index + 2));
	}
	return set;
}

export function search(dataRoot, query, limit = 8) {
	const document = load(dataRoot);
	const wanted = tokens(query);
	if (wanted.size === 0) return { query, hits: [] };
	const scored = [];
	for (const item of document.items) {
		const have = tokens(`${item.title} ${item.statement}`);
		let hit = 0;
		for (const token of wanted) if (have.has(token)) hit += 1;
		if (hit === 0) continue;
		scored.push({ ...item, score: hit });
	}
	scored.sort((a, b) => b.score - a.score);
	return { query, total: scored.length, hits: scored.slice(0, Math.min(20, Number(limit) || 8)) };
}
