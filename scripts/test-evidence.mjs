/**
 * 证据切块与定位回归：
 *   node cts-agent/scripts/test-evidence.mjs
 * 新项目按标题切块，块位置取块首标题；重复构建时编号稳定（重建位置修正不漂移）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, formatSemanticDesignEvidence, semanticEvidenceDocument, buildDesignPageSemanticSummaries } from '../evidence.js';
import { factTask, mergeFacts } from '../artifacts.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-evidence-'));
const projectDir = path.join(root, 'projects', 'P-test');
await fs.mkdir(path.join(projectDir, 'prd'), { recursive: true });
await fs.writeFile(path.join(projectDir, 'prd', '需求.md'), [
	'# 审批流需求',
	'## 1. 范围',
	'本系统管理文档审批。',
	'## 2. 提交',
	'文档处于草稿状态时单击【提交】，状态变为待审批。',
	'## 3. 驳回',
	'审批人填写理由后驳回，文档回到已驳回。'
].join('\n'));
const project = { id: 'P-test', name: '证据测试', dir: projectDir, quality: { capabilities: ['text'] } };

const first = (await build({}, project, root)).document;
assert.equal(first.stats.chunking, 'heading');
assert.ok(first.stats.items > 1, '应按标题切出多块');
const section = first.items.find((item) => item.text.includes('单击【提交】'));
assert.ok(section, '缺少提交小节');
assert.equal(section.location, '审批流需求 / 2. 提交');
assert.ok(first.items.every((item) => item.location && item.location !== ''), '块缺少定位');
const ids = first.items.map((item) => item.id);

const second = (await build({}, project, root)).document;
assert.deepEqual(second.items.map((item) => item.id), ids, '重复构建后证据编号漂移');

// 旧数据只有块尾位置：重建时按原文摘要认领旧编号，避免下游引用全部失效。
const itemsFile = path.join(root, 'evidence', 'P-test', 'items.json');
const mutated = JSON.parse(await fs.readFile(itemsFile, 'utf8'));
for (const item of mutated.items) item.location = 'legacy / 最后标题';
await fs.writeFile(itemsFile, JSON.stringify(mutated, null, 1));
const third = (await build({}, project, root)).document;
assert.deepEqual(third.items.map((item) => item.id), ids, '位置修正导致编号漂移');
assert.ok(third.items.every((item) => !item.location.startsWith('legacy')), '位置未修正');

// 显式要求块内聚合时不再按标题切。
const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-evidence-size-'));
const project2Dir = path.join(root2, 'projects', 'P-size');
await fs.mkdir(path.join(project2Dir, 'prd'), { recursive: true });
await fs.copyFile(path.join(projectDir, 'prd', '需求.md'), path.join(project2Dir, 'prd', '需求.md'));
const sizeDoc = (await build({}, { id: 'P-size', name: '聚合', dir: project2Dir, quality: { capabilities: ['text'], evidence_chunk: 'size' } }, root2)).document;
assert.equal(sizeDoc.stats.chunking, 'size');
assert.equal(sizeDoc.items.length, 1);

await fs.rm(root, { recursive: true, force: true });
await fs.rm(root2, { recursive: true, force: true });

// 改造 1 验证：同一测试输入包含带几何尺寸的设计节点、PRD 明确尺寸要求、以及两个同名候选
const rawDesignItem = {
	id: 'E-0010',
	source: 'design/mcp.mock',
	location: '主控页',
	kind: 'design',
	text: [
		'页面 主控页（4 个画板）',
		'- 主控画板｜1920×1080｜runtime_screen',
		'- A-快速模式｜86×145｜state_variant',
		'- 提交按钮｜120×40｜component',
		'- 提交按钮｜160×48｜component'
	].join('\n')
};
const rawPrdDimensionItem = {
	id: 'E-0011',
	source: 'prd/规格书.md',
	location: '3. 弹窗尺寸要求',
	kind: 'text',
	text: '当点击【快速模式】后弹出确认框，确认框尺寸必须为 640×480 像素，且在 30s 内未操作自动关闭。'
};
const mockUiIndex = {
	boards: [
		{ id: '1:1', page_name: '主控页', name: '主控画板', kind: 'runtime_screen' },
		{ id: '2:1', page_name: '主控页', name: 'A-快速模式', kind: 'state_variant' },
		{ id: '3:1', page_name: '主控页', name: '提交按钮', kind: 'component' },
		{ id: '3:2', page_name: '主控页', name: '提交按钮', kind: 'component' }
	],
	objects: [
		{ board: '2:1', page_name: '主控页', name: '黑白=off, 开关=on, 置灰=off', texts: ['快速模式'] },
		{ board: '2:1', page_name: '主控页', name: '黑白=off, 开关=off, 置灰=off', texts: [] },
		{ board: '2:1', page_name: '主控页', name: '黑白=off, 开关=off, 置灰=on', texts: [] }
	]
};

const semDoc = semanticEvidenceDocument(
	{ items: [rawDesignItem, rawPrdDimensionItem] },
	{ uiIndex: mockUiIndex, prdText: rawPrdDimensionItem.text }
);
const semDesign = semDoc.items[0];
const semPrd = semDoc.items[1];

assert.ok(!/86×145|120×40|160×48|1920×1080/.test(semDesign.text), '设计语义摘要不应包含设计节点几何宽高');
assert.ok(!/\bstate_variant\b/.test(semDesign.text), '设计语义摘要不应把 state_variant 类型名当作变体值');
assert.match(semDesign.text, /控件「快速模式」｜组件名：A-快速模式｜可见文本：快速模式｜状态变体：开启、关闭、置灰/, '应提取 PRD 业务名、组件名、可见文本与真实状态变体');
assert.match(semDesign.text, /控件「提交按钮」｜同名候选待核：提交按钮\(3:1\) vs 提交按钮\(3:2\)/, '两个同名候选应保留歧义待核，不得自动消解');
assert.match(semPrd.text, /640×480 像素/, 'PRD 明文规定的尺寸要求必须完整保留');
assert.equal(semDesign.raw_text, rawDesignItem.text, '原始设计证据正文仍可复核');

const taskPrompt = factTask([rawDesignItem, rawPrdDimensionItem], '测试项目', [], {
	design: buildDesignPageSemanticSummaries([rawDesignItem], { uiIndex: mockUiIndex, prdText: rawPrdDimensionItem.text }),
	designMeta: { uiIndex: mockUiIndex, prdText: rawPrdDimensionItem.text }
});
assert.ok(!/86×145|state_variant/.test(taskPrompt), 'factTask 提示词不应暴露设计节点几何尺寸或 state_variant');
assert.match(taskPrompt, /640×480 像素/, 'factTask 提示词必须保留 PRD 明文尺寸要求');

const mergedFacts = mergeFacts([], {
	facts: [
		{ type: 'control', statement: '主控页提供【快速模式】（86×145，未激活对应的state_variant外观）', evidence_refs: ['E-0010'] },
		{ type: 'criterion', statement: '确认框尺寸必须为 640×480 像素，30s 内未操作自动关闭', evidence_refs: ['E-0011'] }
	]
}, new Set(['E-0010', 'E-0011']), { designEvidenceIds: new Set(['E-0010']) });

assert.ok(!/86×145|state_variant/.test(mergedFacts[0].statement), '仅引用设计证据的事实应剥离几何宽高与 state_variant');
assert.match(mergedFacts[1].statement, /640×480 像素/, '引用 PRD 证据的明文尺寸事实必须完整保留');

console.log('证据切块、块首定位与编号稳定性及设计语义摘要通过');
