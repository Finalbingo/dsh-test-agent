#!/usr/bin/env node
/**
 * Portability check: the cell builder must not know anything about air conditioning.
 * Feed it facts from three unrelated domains and print the cells it yields.
 */
import { buildCells, extractObjects } from '../artifacts.js';

const cases = [
	{
		name: '空调（V5）',
		feature: { feature_id: 'AC_001', name: '快速除霜', fact_refs: ['F-1'] },
		facts: [{
			fact_id: 'F-1',
			type: 'rule',
			statement: '空调关闭时单击dock栏【快速除雾】按键，发送 IVI_DefrostButton 请求开启，30s 后刷新图标；报文丢失超过 10 帧时按键置灰'
		}]
	},
	{
		name: '车窗（另一个项目）',
		feature: { feature_id: 'WIN_01', name: '主驾车窗升降', fact_refs: ['F-2'] },
		facts: [{
			fact_id: 'F-2',
			type: 'rule',
			statement: '车窗处于关闭状态时，按住主驾【车窗升降按键】向下，向防夹模块发送 Window_Down 请求，接收 Window_Status 反馈后刷新图标；报文丢失时按键置灰'
		}]
	},
	{
		name: '座椅（另一个项目）',
		feature: { feature_id: 'SEAT_01', name: '座椅加热', fact_refs: ['F-3'] },
		facts: [{
			fact_id: 'F-3',
			type: 'rule',
			statement: '语音打开座椅加热后，单击【座椅加热开关】在三档之间切换，发送 Seat_Heat_Level 请求，接收 Seat_Heat_Status 后更新指示灯；异常超过 30 秒置灰'
		}]
	}
];

let failed = 0;
for (const item of cases) {
	const objects = extractObjects(item.facts[0].statement);
	const cells = buildCells(item.feature, item.facts, 12);
	const hasEntry = new Set(cells.map((cell) => cell.entry));
	const hasObject = new Set(cells.map((cell) => cell.object).filter(Boolean));
	console.log(`\n## ${item.name}`);
	console.log('对象:', objects.join(' / ') || '(none)');
	console.log('入口:', [...hasEntry].join(' / '));
	console.log('格子样例:');
	for (const cell of cells.slice(0, 4)) {
		console.log(`  - 入口=${cell.entry} 状态=${cell.state} 验证=${cell.verify} 对象=${cell.object || '-'}`);
	}
	if (CellsEmpty(cells)) failed += 1;
}

function CellsEmpty(cells) {
	return !Array.isArray(cells) || cells.length === 0;
}

// The builder must not contain domain vocabulary from any single project.
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../artifacts.js', import.meta.url), 'utf8');
const banned = ['空调', '除霜', '除雾', 'PTC', 'HVAC'];
const matrix = source.match(/const entryRules = [\s\S]+?(?=export function matrixPrompt)/)?.[0];
if (!matrix) throw new Error('找不到矩阵构建代码');
const hits = banned.filter((word) => matrix.includes(word));
console.log('\n## 硬编码检查');
console.log(hits.length === 0 ? '✅ 矩阵代码里没有空调领域词' : `❌ 发现领域词: ${hits.join(', ')}`);
if (hits.length > 0) failed += 1;

console.log(failed === 0 ? '\n✅ 通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
