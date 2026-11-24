#!/usr/bin/env node
/**
 * Baseline: compare our generated facts against a legacy ECSM model.
 *
 * The point is not to "win" — it is to make quality measurable, so every later
 * prompt or pipeline change can be judged instead of guessed.
 *
 * Usage:
 *   node scripts/baseline.mjs --project P-v5-test \
 *        --model <legacy session>/candidate/<rev>/model.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataRoot = arg('data', path.join(os.homedir(), 'Documents', 'CTS'));
const project = arg('project');
const modelPath = arg('model');
if (!project || !modelPath) {
	console.error('用法: node scripts/baseline.mjs --project <id> --model <legacy model.json>');
	process.exit(2);
}

const factsPath = path.join(dataRoot, 'artifacts', project, 'facts.json');
const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8')).items;
const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
const requirements = Array.isArray(model.requirements) ? model.requirements : [];

/** Latin words + CJK bigrams; containment is more useful than Jaccard here. */
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

function containment(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let hit = 0;
	for (const token of a) if (b.has(token)) hit += 1;
	return hit / Math.min(a.size, b.size);
}

const factTokens = facts.map((fact) => ({ fact, tokens: tokens(fact.statement) }));
const rows = [];
for (const requirement of requirements) {
	const target = tokens(requirement.statement || requirement.title || '');
	let best = { score: 0, fact: null };
	for (const entry of factTokens) {
		const score = containment(target, entry.tokens);
		if (score > best.score) best = { score, fact: entry.fact };
	}
	rows.push({
		id: requirement.id,
		statement: (requirement.statement || '').slice(0, 90),
		score: Number(best.score.toFixed(3)),
		fact_id: best.fact?.fact_id || null
	});
}

const at = (threshold) => Math.round((rows.filter((row) => row.score >= threshold).length / Math.max(1, rows.length)) * 100);
const covered = rows.filter((row) => row.score >= 0.5);
const uncovered = rows.filter((row) => row.score < 0.3).sort((a, b) => a.score - b.score);

const summary = {
	project,
	modelPath,
	facts: facts.length,
	requirements: requirements.length,
	coverage: { at70: at(0.7), at50: at(0.5), at30: at(0.3) },
	meanBest: Number((rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length)).toFixed(3)),
	uncovered: uncovered.slice(0, 10)
};

const reportDir = path.join(dataRoot, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const jsonPath = path.join(reportDir, `baseline-${project}-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 1), 'utf8');

const lines = [
	`# 基线对拍 · ${project}`,
	'',
	`- 旧模型：\`${modelPath}\``,
	`- 旧需求：${summary.requirements} 条`,
	`- 新事实：${summary.facts} 条`,
	`- 平均最佳匹配：**${summary.meanBest}**`,
	'',
	'| 阈值 | 覆盖率 |',
	'| --- | --- |',
	`| ≥0.70 | ${summary.coverage.at70}% |`,
	`| ≥0.50 | ${summary.coverage.at50}% |`,
	`| ≥0.30 | ${summary.coverage.at30}% |`,
	'',
	`## 未覆盖（前 ${summary.uncovered.length} 条）`,
	'',
	...summary.uncovered.map((row) => `- \`${row.id}\` (${row.score}) ${row.statement}`),
	'',
	`> 明细：${jsonPath}`
];
const mdPath = path.join(reportDir, `baseline-${project}-${stamp}.md`);
fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
