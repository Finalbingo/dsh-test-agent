import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	assessToolConfirmation,
	saveCopilotSnapshot,
	popLatestCopilotSnapshot,
	loadModuleChat,
	saveModuleChat
} from '../copilot-tools.js';

// 1. L0 / L1 / L2 三级安全门禁验证
assert.equal(assessToolConfirmation('workbench.inspect', {}), null, 'L0 只读查询应直接放行');
assert.equal(assessToolConfirmation('artifact.patch', { kind: 'cases', op: 'update', items: [{ id: 'C-1' }, { id: 'C-2' }, { id: 'C-3' }] }), null, 'L1 <=3 条修改应直接放行');
const batchPatchGate = assessToolConfirmation('artifact.patch', { kind: 'cases', op: 'update', items: [{ id: 'C-1' }, { id: 'C-2' }, { id: 'C-3' }, { id: 'C-4' }] });
assert.equal(batchPatchGate?.level, 'L2', '>3 条批量修改必须触发 L2 确认');

const autopilotGate = assessToolConfirmation('pipeline.autopilot', { coverage_mode: 'exhaustive', include_review: false });
assert.equal(autopilotGate?.level, 'L2', '端到端 autopilot 必须触发 L2 执行计划确认');

const overwriteGate = assessToolConfirmation('pipeline.generate', { kind: 'cases', replace: true }, { counts: { cases: 50 } });
assert.equal(overwriteGate?.level, 'L2', '覆盖重跑已有用例必须触发 L2 确认');
assert.equal(assessToolConfirmation('pipeline.generate', { kind: 'cases', replace: true, point_ids: ['T-1'] }, { counts: { cases: 50 } }), null, '局部指定 point_ids 重跑应放行');

const bigReviewGate = assessToolConfirmation('pipeline.review', { stage: 'cases' }, { counts: { cases: 120 } });
assert.equal(bigReviewGate?.level, 'L2', '>60 条大批量独立审查必须触发 L2 确认');
assert.equal(assessToolConfirmation('pipeline.review', { stage: 'cases', case_ids: ['C-1', 'C-2'] }, { counts: { cases: 120 } }), null, '小批量指定用例审查应放行');

// 2. 模块级快照保存、LIFO 撤销与上限裁剪
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-copilot-'));
try {
	for (let i = 1; i <= 7; i += 1) {
		await saveCopilotSnapshot(tmpRoot, 'P-1', 'M-A', {
			label: `修改 #${i}`,
			kinds: ['cases'],
			files: { cases: { items: [{ case_id: `C-${i}` }] } }
		});
		await new Promise((r) => setTimeout(r, 5));
	}
	await saveCopilotSnapshot(tmpRoot, 'P-1', 'M-B', {
		label: '模块 B 修改',
		kinds: ['points'],
		files: { points: { items: [{ point_id: 'T-9' }] } }
	});

	const snapA1 = await popLatestCopilotSnapshot(tmpRoot, 'P-1', 'M-A');
	assert.equal(snapA1?.label, '修改 #7', '应按 LIFO 弹出最近一次快照');
	assert.equal(snapA1?.files?.cases?.items?.[0]?.case_id, 'C-7');

	let countA = 1;
	while (await popLatestCopilotSnapshot(tmpRoot, 'P-1', 'M-A')) countA += 1;
	assert.equal(countA, 5, '每模块最多保留最近 5 份快照');

	const snapB = await popLatestCopilotSnapshot(tmpRoot, 'P-1', 'M-B');
	assert.equal(snapB?.label, '模块 B 修改', '模块 A 撤销不影响模块 B 快照');

	// 3. 模块级对话历史严格隔离
	await saveModuleChat(tmpRoot, 'P-1', 'M-A', [{ id: '1', role: 'user', text: '模块A问题' }]);
	await saveModuleChat(tmpRoot, 'P-1', 'M-B', [{ id: '2', role: 'user', text: '模块B问题' }]);
	const histA = await loadModuleChat(tmpRoot, 'P-1', 'M-A');
	const histB = await loadModuleChat(tmpRoot, 'P-1', 'M-B');
	const histNew = await loadModuleChat(tmpRoot, 'P-1', 'M-NEW');
	assert.equal(histA.messages[0].text, '模块A问题');
	assert.equal(histB.messages[0].text, '模块B问题');
	assert.equal(histNew.messages.length, 0, '新模块应为空对话历史');

	console.log('COPILOT_TOOLS_TESTS_PASS');
} finally {
	await fs.rm(tmpRoot, { recursive: true, force: true });
}
