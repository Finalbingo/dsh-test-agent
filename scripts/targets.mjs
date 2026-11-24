/** Shared CLI helpers for the repair scripts: explicit data/project/module/out. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function parseArgs(argv = process.argv.slice(2)) {
	const values = {};
	const flags = new Set();
	for (const item of argv) {
		if (!item.startsWith('--')) continue;
		const name = item.slice(2);
		if (!name) continue;
		flags.add(name);
		const index = argv.indexOf(item);
		const next = argv[index + 1];
		if (next && !next.startsWith('--')) values[name] = next;
	}
	return { values, flags };
}

export function dataRootOf(values) {
	return values.data || path.join(os.homedir(), 'Documents', 'CTS');
}

/** Scan artifact modules when --project/--module is omitted; never hardcode projects. */
export function resolveTargets(dataRoot, { project = '', module = '' } = {}) {
	const artifacts = path.join(dataRoot, 'artifacts');
	const projects = project ? [project] : (() => {
		try { return fs.readdirSync(artifacts).sort(); } catch { return []; }
	})();
	const targets = [];
	for (const projectId of projects) {
		let modules = [];
		if (module) modules = [module];
		else {
			try { modules = fs.readdirSync(path.join(artifacts, projectId)).sort(); } catch { continue; }
		}
		for (const moduleId of modules) {
			const dir = path.join(artifacts, projectId, moduleId);
			if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
			if (!['cases.json', 'ui-index.json'].some((file) => fs.existsSync(path.join(dir, file)))) continue;
			targets.push({ project: projectId, module: moduleId });
		}
	}
	return targets;
}
