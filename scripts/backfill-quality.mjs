import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * 迁移项目生成配置回填：
 * - 只处理“有 PRD、但没有 surfaces”的项目；
 * - 有同名 PRD 的既有完整项目时，复制它的 surfaces/词表/协议扩展；
 * - 按实际存在的 DBC/设计稿调整 capabilities；
 * - 默认只打印，传 --apply 才写 project.json。
 *
 * 用法：
 *   node scripts/backfill-quality.mjs <dataRoot> [--apply]
 */
const root = process.argv[2];
const apply = process.argv.includes('--apply');
if (!root) throw new Error('请传入 dataRoot');
const projectsDir = path.join(root, 'projects');
const files = async (dir) => (await fs.readdir(path.join(dir)).catch(() => [])).filter((name) => !name.startsWith('.'));

const projects = [];
for (const id of await files(projectsDir)) {
	const dir = path.join(projectsDir, id);
	const file = path.join(dir, 'project.json');
	if (!fsSync.existsSync(file)) continue;
	const meta = JSON.parse(await fs.readFile(file, 'utf8'));
	const assets = {};
	for (const bucket of ['prd', 'signals', 'design', 'other']) {
		const entries = await files(path.join(dir, bucket));
		assets[bucket] = entries.map((name) => ({ name, path: `${bucket}/${name}` })).filter((item) => item.name && !/^(case-images|images|vision-images|vision-cache|library|details)$/.test(item.name));
	}
	projects.push({ id, dir, file, meta, assets });
}

const hasSurface = (project) => Array.isArray(project.meta.quality?.surfaces) && project.meta.quality.surfaces.length > 0;
const prd = (project) => project.assets.prd.find((item) => /\.(md|markdown|docx?|pdf|html?)$/i.test(item.name));
const dbc = (project) => project.assets.signals.find((item) => /\.dbc$/i.test(item.name));
const design = (project) => project.assets.design.find((item) => /\.(pix|png|jpe?g|webp)$/i.test(item.name));

const templateFor = (project) => {
	const own = prd(project)?.name;
	if (!own) return null;
	return projects
		.filter((item) => item.id !== project.id && hasSurface(item) && item.meta.quality)
		.map((item) => ({ item, samePrd: prd(item)?.name === own, sameDbc: Boolean(dbc(item) && dbc(project)) }))
		.filter((item) => item.samePrd || item.sameDbc)
		.sort((a, b) => Number(b.samePrd) - Number(a.samePrd))[0]?.item || null;
};

const plans = [];
for (const project of projects) {
	if (!prd(project) || hasSurface(project)) continue;
	const template = templateFor(project);
	const base = template?.meta.quality || null;
	const capabilities = new Set(base?.capabilities || ['text']);
	capabilities.add('text');
	if (dbc(project)) capabilities.add('protocol');
	else capabilities.delete('protocol');
	if (design(project)) capabilities.add('design');
	else capabilities.delete('design');
	const quality = {
		...(base || {}),
		capabilities: [...capabilities],
		sources: {
			...Object.fromEntries(Object.entries(base?.sources || {}).filter(([, value]) => typeof value === 'string' && value.trim())),
			prd: prd(project).path
		},
		surfaces: (base?.surfaces?.length ? [...base.surfaces] : ['页面']),
		default_surface: base?.default_surface && (base.surfaces || []).includes(base.default_surface) ? base.default_surface : (base?.surfaces?.[0] || '页面')
	};
	if (dbc(project)) quality.sources.dbc = dbc(project).path;
	if (!design(project)) delete quality.sources.design;
	plans.push({ project, template: template?.id || '', quality });
}

for (const plan of plans) {
	console.log(JSON.stringify({
		project: plan.project.id,
		name: plan.project.meta.name,
		template: plan.template,
		capabilities: plan.quality.capabilities,
		sources: plan.quality.sources,
		surfaces: plan.quality.surfaces
	}));
	if (apply) {
		const meta = { ...plan.project.meta, quality: plan.quality };
		await fs.writeFile(plan.project.file, JSON.stringify(meta, null, 2), 'utf8');
	}
}
console.log(`\n${plans.length} 个项目${apply ? '已回填' : '待回填（加 --apply 写入）'}`);
