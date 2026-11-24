/**
 * Frozen packages: once a set of artefacts is approved, edits must fork a new
 * version instead of silently changing what was signed off.
 */
import crypto from 'node:crypto';
import { currentModule } from './scope.js';
import fs from 'node:fs';
import path from 'node:path';
import { caseFigurePath } from './case-visuals.js';

const ARTIFACTS = ['facts', 'features', 'states', 'points', 'cases', 'bindings', 'review', 'contracts', 'outline', 'deferrals', 'source-scope', 'conflicts', 'ui-links', 'tkr-selection'];

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

function digestOf(value) {
	return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

export function artifactsRoot(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule());
}

export function packagesDir(dataRoot, projectId) {
	return path.join(artifactsRoot(dataRoot, projectId), 'packages');
}

export function currentPackage(dataRoot, projectId) {
	return readJson(path.join(artifactsRoot(dataRoot, projectId), 'current-package.json'), null);
}

export function isFrozen(dataRoot, projectId) {
	const current = currentPackage(dataRoot, projectId);
	return Boolean(current && current.status === 'frozen');
}

/** Current on-disk digests, also used to compare a draft against a frozen package. */
export function snapshotArtifacts(dataRoot, projectId) {
	const root = artifactsRoot(dataRoot, projectId);
	const artifacts = {};
	for (const name of ARTIFACTS) {
		const document = readJson(path.join(root, `${name}.json`), null);
		if (document === null) continue;
		artifacts[name] = { digest: digestOf(document.items || []), count: (document.items || []).length };
	}
	return artifacts;
}

export function freeze(dataRoot, projectId, note = '', snapshot) {
	const root = artifactsRoot(dataRoot, projectId);
	const artifacts = snapshotArtifacts(dataRoot, projectId);
	if (isFrozen(dataRoot, projectId)) return currentPackage(dataRoot, projectId);
	if (snapshot && artifacts.cases) {
		artifacts.cases = { digest: digestOf(snapshot.cases.items), count: snapshot.cases.items.length };
	}
	const digest = digestOf(artifacts);
	const previous = currentPackage(dataRoot, projectId);
	const version = previous?.status === 'draft' ? previous.version : (previous?.version || 0) + 1;
	const packageId = `PKG-${String(version).padStart(3, '0')}-${digest.slice(0, 8)}`;
	const record = {
		package_id: packageId,
		version,
		status: 'frozen',
		frozen_at: new Date().toISOString(),
		digest,
		note,
		ecsm: snapshot ? { version: snapshot.model.version, digest: snapshot.model.digest } : null,
		artifacts
	};
	fs.mkdirSync(packagesDir(dataRoot, projectId), { recursive: true });
	const dir = packagesDir(dataRoot, projectId);
	if (snapshot) {
		const staging = fs.mkdtempSync(path.join(dir, '.snapshot-'));
		try {
			const figures = [];
			for (const item of snapshot.cases.items) {
				for (const figure of item.image_refs || []) {
					const source = caseFigurePath(dataRoot, projectId, figure);
					if (!source) throw new Error(`无效的配图引用：${item.case_id}`);
					const sha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
					if (figure.sha256 && figure.sha256 !== sha256) throw new Error(`配图内容与记录不一致，请重新挂图：${item.case_id} · ${figure.name || figure.file}`);
					figure.sha256 = sha256;
					figure.revision = figure.revision || '';
					figures.push({
						case_id: item.case_id, file: figure.file, role: figure.role || '', purpose: figure.purpose || '',
						step_id: figure.step_id || '', expected_id: figure.expected_id || '',
						ui_id: figure.ui_id || '', revision: figure.revision, sha256
					});
					const target = path.join(staging, path.basename(source));
					if (!fs.existsSync(target)) fs.copyFileSync(source, target);
				}
			}
			snapshot.figures = figures;
			fs.writeFileSync(path.join(staging, 'snapshot.json'), JSON.stringify(snapshot), 'utf8');
			const target = path.join(dir, packageId);
			if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
			fs.renameSync(staging, target);
		} finally {
			fs.rmSync(staging, { recursive: true, force: true });
		}
	}
	for (const file of [path.join(dir, `${packageId}.json`), path.join(root, 'current-package.json')]) {
		fs.writeFileSync(file + '.tmp', JSON.stringify(record, null, 1), 'utf8');
		fs.renameSync(file + '.tmp', file);
	}
	return record;
}

/** Reopen editing under a new version; the frozen package stays on disk. */
export function fork(dataRoot, projectId, note = '') {
	const current = currentPackage(dataRoot, projectId);
	const root = artifactsRoot(dataRoot, projectId);
	const next = {
		package_id: `PKG-${String((current?.version || 0) + 1).padStart(3, '0')}-draft`,
		version: (current?.version || 0) + 1,
		status: 'draft',
		forked_at: new Date().toISOString(),
		from: current?.package_id || null,
		note
	};
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, 'current-package.json'), JSON.stringify(next, null, 1), 'utf8');
	return next;
}

export function list(dataRoot, projectId) {
	const dir = packagesDir(dataRoot, projectId);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.map((name) => readJson(path.join(dir, name), null))
		.filter(Boolean)
		.sort((a, b) => String(a.frozen_at).localeCompare(String(b.frozen_at)));
}

export function readSnapshot(dataRoot, projectId, packageId) {
	if (!/^PKG-\d+-[a-f0-9]{8}$/.test(packageId)) return null;
	const dir = path.join(packagesDir(dataRoot, projectId), packageId);
	const snapshot = readJson(path.join(dir, 'snapshot.json'), null);
	return snapshot ? { ...snapshot, imagesDir: dir } : null;
}
