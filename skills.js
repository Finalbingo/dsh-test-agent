import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const DIR = path.join(import.meta.dirname, 'skills');
const scope = new AsyncLocalStorage();
const MAX_SKILL_BYTES = 100 * 1024;
export const SKILLS = ['cts-facts', 'cts-test-design', 'cts-case-authoring', 'cts-review'];

const overridesPath = (dataRoot) => path.join(dataRoot, 'skills-overrides.json');

function readOverrides(dataRoot) {
	try {
		return JSON.parse(fs.readFileSync(overridesPath(dataRoot), 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') return {};
		throw error;
	}
}

export function enterSkillScope(dataRoot) {
	scope.enterWith({ dataRoot, overrides: null });
}

function builtin(name) {
	return fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8').trim();
}

export function skill(name) {
	if (!SKILLS.includes(name)) throw new Error('未知 Skill');
	const request = scope.getStore();
	// Every batch of an active generation uses the same instructions.
	if (request) request.overrides ??= readOverrides(request.dataRoot);
	return request?.overrides[name]?.current?.content ?? builtin(name);
}

export function compose(name, ...parts) {
	return [skill(name), '', ...parts.filter(Boolean)].join('\n');
}

/** What the model actually received, including a user override — not just the built-in file. */
export function skillDigests() {
	const overrides = scope.getStore()?.overrides || {};
	return Object.fromEntries(SKILLS.map((name) => [name, {
		sha256: createHash('sha256').update(skill(name)).digest('hex'),
		source: overrides[name]?.current ? 'override' : 'builtin'
	}]));
}

export function listSkills(dataRoot) {
	const overrides = readOverrides(dataRoot);
	return SKILLS.map((name) => {
		const entry = overrides[name];
		return {
			name,
			content: entry?.current?.content ?? builtin(name),
			filename: entry?.current?.filename ?? `${name}.md`,
			updatedAt: entry?.current?.updatedAt ?? null,
			canRestore: Boolean(entry && Object.hasOwn(entry, 'previous'))
		};
	});
}

export function updateSkill(dataRoot, name, upload = null) {
	if (!SKILLS.includes(name)) throw new Error('请选择要替换的 Skill');
	const overrides = readOverrides(dataRoot);
	const entry = overrides[name];
	if (upload) {
		const { filename, content } = upload;
		if (typeof filename !== 'string' || filename.length > 255 || !/\.(md|markdown)$/i.test(filename)) throw new Error('请选择 Markdown 文件');
		if (typeof content !== 'string' || !content.trim()) throw new Error('Skill 文件不能为空');
		if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) throw new Error('Skill 文件不能超过 100 KB');
		if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(content)) throw new Error('请选择有效的 UTF-8 Markdown 文件');
		const current = { filename: path.basename(filename), content: content.trim(), updatedAt: new Date().toISOString() };
		if (current.content === (entry?.current?.content ?? builtin(name))) return listSkills(dataRoot);
		overrides[name] = { current, previous: entry?.current ?? null };
	} else {
		if (!entry || !Object.hasOwn(entry, 'previous')) throw new Error('没有可恢复的上一版本');
		overrides[name] = { current: entry.previous, previous: entry.current };
	}

	fs.mkdirSync(dataRoot, { recursive: true });
	const file = overridesPath(dataRoot);
	const staging = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(staging, JSON.stringify(overrides), { mode: 0o600 });
		fs.renameSync(staging, file);
	} finally {
		fs.rmSync(staging, { force: true });
	}
	return listSkills(dataRoot);
}
