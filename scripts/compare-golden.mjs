#!/usr/bin/env node
/**
 * Compare our generated points/cases against the delivered workbooks.
 *
 * Gold data: 空调-module-workbook-V2.0原生链路.xlsx (772 测试点 / 772 用例).
 * Usage: node scripts/compare-golden.mjs --project P-v5-test --gold <xlsx>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseXlsx } from '../parsers/xlsx.js';

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataRoot = arg('data', path.join(os.homedir(), 'Documents', 'CTS'));
const project = arg('project', 'P-v5-test');
const goldPath = arg('gold');
if (!goldPath) {
	console.error('用法: node scripts/compare-golden.mjs --project <id> --gold <xlsx>');
	process.exit(2);
}

const readArtifact = (name) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')).items || [];
	} catch {
		return [];
	}
};

const tokens = (text) => {
	const set = new Set();
	const value = String(text || '').toLowerCase();
	for (const word of value.match(/[a-z0-9_]{2,}/g) || []) set.add(word);
	for (const run of value.match(/[\u4e00-\u9fff]+/g) || []) {
		if (run.length === 1) set.add(run);
		for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2));
	}
	return set;
};

// Recall-oriented: how much of the gold entry's content appears in our best match.
// Dividing by min() made verbose points score lower even when they contained everything.
const overlap = (gold, ours) => {
	let hit = 0;
	for (const token of gold) if (ours.has(token)) hit += 1;
	return hit;
};
// recall: how much of the gold entry our best match contains
const scoreRecall = (gold, ours) => (gold.size === 0 || ours.size === 0 ? 0 : overlap(gold, ours) / gold.size);
// symmetric: avoids rewarding verbose points
const scoreMin = (gold, ours) => (gold.size === 0 || ours.size === 0 ? 0 : overlap(gold, ours) / Math.min(gold.size, ours.size));

const score = scoreRecall;

const sheets = parseXlsx(fs.readFileSync(goldPath));
const find = (name) => sheets.find((sheet) => sheet.name === name);
const table = (sheet) => {
	if (!sheet) return [];
	const [header, ...rows] = sheet.rows;
	return rows.map((row) => Object.fromEntries(header.map((key, index) => [key.trim(), row[index] || ''])));
};

const goldPoints = table(find('测试点'));
const goldCases = table(find('测试用例'));
const oursPoints = readArtifact('points');
const oursCases = readArtifact('cases');

const goldPointTokens = goldPoints.map((row) => tokens(`${row['测试点标题']} ${row['前置条件']} ${row['触发/操作']} ${row['期望规则']}`));
const ourPointTokens = oursPoints.map((row) => tokens(`${row.requirement || row.title || ''} ${row.condition} ${row.action} ${row.expected}`));
const goldCaseTokens = goldCases.map((row) => tokens(`${row['用例标题']} ${row['预期结果']}`));
const ourCaseTokens = oursCases.map((row) => tokens(`${row.title} ${row.expected}`));

function evaluate(goldTok, ourTok, goldRows, label) {
	const best = goldTok.map((target, index) => {
		let top = { score: 0, min: 0, at: -1 };
		ourTok.forEach((candidate, j) => {
			const s = score(target, candidate);
			if (s > top.score) top = { score: s, min: scoreMin(target, candidate), at: j };
		});
		return { index, score: top.score, min: top.min, at: top.at };
	});
	const at = (threshold) => Math.round((best.filter((row) => row.score >= threshold).length / Math.max(1, best.length)) * 100);
	const atMin = (threshold) => Math.round((best.filter((row) => row.min >= threshold).length / Math.max(1, best.length)) * 100);
	const covered = new Set(best.filter((row) => row.score >= 0.4).map((row) => row.at));
	const precision = Math.round((covered.size / Math.max(1, ourTok.length)) * 100);
	return {
		label,
		gold: goldTok.length,
		ours: ourTok.length,
		coverage: { at70: at(0.7), at50: at(0.5), at40: at(0.4) },
		symmetric: { at70: atMin(0.7), at50: atMin(0.5), at40: atMin(0.4) },
		precision,
		uncovered: best
			.filter((row) => row.score < 0.4)
			.sort((a, b) => a.score - b.score)
			.slice(0, 25)
			.map((row) => ({
				score: Number(row.score.toFixed(2)),
				feature: goldRows[row.index]['功能点ID'] || '',
				title: goldRows[row.index]['测试点标题'] || goldRows[row.index]['用例标题'] || ''
			}))
	};
}

const pointsResult = evaluate(goldPointTokens, ourPointTokens, goldPoints, '测试点');
const casesResult = evaluate(goldCaseTokens, ourCaseTokens, goldCases, '用例');

const featureStats = {};
for (const [index, row] of goldPoints.entries()) {
	const feature = row['功能点ID'] || '(none)';
	featureStats[feature] = featureStats[feature] || { total: 0, covered: 0 };
	featureStats[feature].total += 1;
	const target = goldPointTokens[index];
	const hit = ourPointTokens.some((candidate) => score(target, candidate) >= 0.4);
	if (hit) featureStats[feature].covered += 1;
}

const lines = [
	`# 与交付基线对拍 · ${project}`,
	'',
	`基线文件：\`${goldPath}\``,
	`基线规模：测试点 ${goldPoints.length} 条、用例 ${goldCases.length} 条`,
	`我们的规模：测试点 ${oursPoints.length} 条、用例 ${oursCases.length} 条`,
	'',
	'## 覆盖率',
	'',
	'| 层 | ≥0.70 | ≥0.50 | ≥0.40 | 我方命中占比 |',
	'| --- | --- | --- | --- | --- |',
	`| 测试点（召回口径） | ${pointsResult.coverage.at70}% | ${pointsResult.coverage.at50}% | ${pointsResult.coverage.at40}% | ${pointsResult.precision}% |`,
	`| 测试点（对称口径） | ${pointsResult.symmetric.at70}% | ${pointsResult.symmetric.at50}% | ${pointsResult.symmetric.at40}% | — |`,
	`| 用例（召回口径） | ${casesResult.coverage.at70}% | ${casesResult.coverage.at50}% | ${casesResult.coverage.at40}% | ${casesResult.precision}% |`,
	`| 用例（对称口径） | ${casesResult.symmetric.at70}% | ${casesResult.symmetric.at50}% | ${casesResult.symmetric.at40}% | — |`,
	'',
	'## 按功能点的覆盖（测试点）',
	'',
	'| 功能点 | 基线条数 | 已覆盖 | 覆盖率 |',
	'| --- | --- | --- | --- |',
	...Object.entries(featureStats).sort((a, b) => a[1].covered / a[1].total - b[1].covered / b[1].total)
		.slice(0, 15)
		.map(([feature, stat]) => `| ${feature} | ${stat.total} | ${stat.covered} | ${Math.round((stat.covered / stat.total) * 100)}% |`),
	'',
	`## 基线里我们没覆盖到的测试点（前 ${pointsResult.uncovered.length} 条）`,
	'',
	...pointsResult.uncovered.map((row) => `- [${row.score}] ${row.feature} ${row.title}`),
	'',
	`## 基线里我们没覆盖到的用例（前 ${casesResult.uncovered.length} 条）`,
	'',
	...casesResult.uncovered.map((row) => `- [${row.score}] ${row.feature} ${row.title}`)
];

const reportDir = path.join(dataRoot, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const file = path.join(reportDir, `golden-${project}-${new Date().toISOString().slice(0, 10)}.md`);
fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
console.log(`\n写入：${file}`);
