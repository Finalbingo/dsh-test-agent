#!/usr/bin/env node
/**
 * 薄 CLI：只委托 DSH 现有入口，不另建一套实现。
 * inspect 只读，直接读产物；写入类命令走服务入口，沿用同一把锁与同一套批准条件。
 *
 *   node cts-agent/scripts/quality-cli.mjs inspect --data-root <dir> --project <id> --module <id> [--out <dir>]
 *   CTS_BASE=... CTS_SERVER_LOG=... CTS_PROJECT=... CTS_MODULE=... \
 *     node cts-agent/scripts/quality-cli.mjs design|pilot|review|generate|export [--kind ...] [...]
 *
 * registry-verify / select 在 B1 落地，repair 在 C 落地；未接线时明确报错，不静默跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { enterModule, enterProjectConfig } from '../scope.js';
import { enterSkillScope, skillDigests } from '../skills.js';

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => {
	const at = argv.indexOf('--' + name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const sha = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

const KINDS = ['evidence', 'facts', 'features', 'states', 'contracts', 'outline', 'points', 'cases', 'branches', 'bindings', 'review', 'source-scope', 'ui-links', 'ui-index'];

function inspect() {
	const root = flag('data-root') || process.env.CTS_DATA_ROOT;
	const project = flag('project') || process.env.CTS_PROJECT;
	const module = flag('module') || process.env.CTS_MODULE;
	if (!root || !project || !module) throw new Error('inspect 需要 --data-root --project --module');
	const projectDir = path.join(root, 'projects', project);
	const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
	const config = meta.quality || {};
	enterModule(module);
	enterProjectConfig(config);
	enterSkillScope(root);
	const dir = path.join(root, 'artifacts', project, module);
	const artifacts = {};
	for (const kind of KINDS) {
		try {
			const doc = JSON.parse(fs.readFileSync(path.join(dir, kind + '.json'), 'utf8'));
			artifacts[kind] = { version: doc.version, count: (doc.items || []).length, digest: doc.digest || sha(doc.items || []), updatedAt: doc.updatedAt };
		} catch { artifacts[kind] = null; }
	}
	const ecsmPath = path.join(dir, 'ecsm-current.json');
	const ecsm = fs.existsSync(ecsmPath) ? JSON.parse(fs.readFileSync(ecsmPath, 'utf8')) : null;

	// 耦合扫描：通用引擎里的业务名、适配器引用、脚本里的项目默认值。
	const engineDir = fileURLToPath(new URL('..', import.meta.url));
	const banned = ['空调', '除霜', '除雾', '吹面', '吹脚', '中控屏', 'HVAC', 'IVI_', 'Dock'];
	const coupling = { engine_business_names: [], engine_imports_adapter: [], script_project_defaults: [] };
	for (const name of fs.readdirSync(engineDir).filter((n) => n.endsWith('.js'))) {
		const text = fs.readFileSync(path.join(engineDir, name), 'utf8');
		// 注释里的举例不算行为耦合，只扫非注释行。
		const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
		const hits = banned.filter((word) => code.includes(word));
		if (hits.length) coupling.engine_business_names.push({ file: name, words: hits });
		if (/from '\.\/adapters\//.test(text)) coupling.engine_imports_adapter.push(name);
	}
	for (const name of fs.readdirSync(path.join(engineDir, 'scripts')).filter((n) => n.endsWith('.mjs'))) {
		const text = fs.readFileSync(path.join(engineDir, 'scripts', name), 'utf8');
		const hits = [...text.matchAll(/\|\|\s*'(P-[0-9a-f]{10}|M-main|http:\/\/127\.0\.0\.1:\d+)'/g)].map((m) => m[1]);
		if (hits.length) coupling.script_project_defaults.push({ file: name, defaults: hits });
	}

	const report = {
		schema: 'quality-inspect/v1',
		generated_at: new Date().toISOString(),
		project, module, project_name: meta.name,
		capabilities: config.capabilities || [],
		declared_sources: config.sources || {},
		vocabulary_keys: Object.keys(config).filter((k) => !['capabilities', 'sources'].includes(k)),
		ecsm: ecsm ? { digest: ecsm.digest, frozen_at: ecsm.frozen_at } : null,
		artifacts,
		skills: skillDigests(),
		adapters: fs.existsSync(path.join(engineDir, 'adapters')) ? fs.readdirSync(path.join(engineDir, 'adapters')) : [],
		coupling,
		coupling_clean: coupling.engine_business_names.length === 0 && coupling.engine_imports_adapter.length === 0 && coupling.script_project_defaults.length === 0
	};
	const out = flag('out');
	if (out) {
		fs.mkdirSync(out, { recursive: true });
		fs.writeFileSync(path.join(out, 'inspect.json'), JSON.stringify(report, null, 1));
	}
	console.log(JSON.stringify(report, null, 1));
	return report;
}

/** 写入类命令：委托服务入口，参数由调用方给全。 */
const REMOTE = {
	design: () => import('./dsh-client.mjs').then((c) => c.generate('points', { from_branches: true })),
	pilot: () => import('./dsh-client.mjs').then((c) => c.generate('cases', {})),
	generate: () => import('./dsh-client.mjs').then((c) => c.generate(flag('kind') || 'cases', {})),
	review: () => import('./dsh-client.mjs').then((c) => c.api('cases.reviewPreview', {})),
	export: () => import('./dsh-client.mjs').then((c) => c.api('package.export', { package_id: flag('package-id'), bundle: true })),
	'registry-verify': () => import('./dsh-client.mjs').then((c) => c.api('tkr.verify', { pack: flag('pack') })),
	select: () => import('./dsh-client.mjs').then((c) => c.api('tkr.select', { pack: flag('pack') }))
};
const PENDING = { repair: 'C' };

if (command === 'inspect') {
	inspect();
} else if (REMOTE[command]) {
	const events = await REMOTE[command]();
	const out = flag('out');
	if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, command + '.json'), JSON.stringify(events, null, 1)); }
	console.log(JSON.stringify(events, null, 1));
} else if (PENDING[command]) {
	throw new Error(`${command} 尚未接线，属 ${PENDING[command]} 阶段；不静默跳过`);
} else {
	throw new Error(`未知命令 ${command || '(空)'}；可用：inspect ${Object.keys(REMOTE).join(' ')}（${Object.keys(PENDING).join(' ')} 待后续阶段）`);
}