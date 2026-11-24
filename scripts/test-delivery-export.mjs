/** 交付包要同时产出 Markdown 版本，便于归档/评审。node cts-agent/scripts/test-delivery-export.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportDelivery } from '../delivery-export.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-delivery-'));
const imagesDir = path.join(root, 'images');
await fs.mkdir(imagesDir);
const workbook = path.join(root, '草稿.xlsx');
await fs.writeFile(workbook, 'PK');
const snapshot = {
	project: 'P-test', moduleName: '审批流', status: 'candidate', design_evidence_applicable: false, imagesDir,
	cases: { source_points_digest: 'abcdef1234567890', items: [{
		case_id: 'C-0001', title: '草稿且正文不为空时提交成功', precondition: '文档处于草稿状态',
		prepare_items: [{ text: '记录【提交】按钮当前状态', read_back: '观察按钮可点击' }],
		step_items: [{ id: 's1', text: '在文档编辑页单击【提交】' }],
		expected_items: [{ id: 'e1', step_id: 's1', object: '文档状态', target: '变为待审批', text: '文档状态：变为待审批' }],
		restore_items: [{ text: '恢复到草稿状态' }], deferred_items: [], image_refs: []
	}] },
	points: { items: [] }, accounting: [], run: { run_id: 'R-test' }
};
const output = await exportDelivery(root, 'P-test', snapshot, workbook);
for (const key of ['xlsx', 'html', 'json', 'md']) {
	await fs.access(output[key]).catch(() => assert.fail(`缺少导出文件：${key}`));
}
const markdown = await fs.readFile(output.md, 'utf8');
assert.ok(markdown.startsWith('# 图文用例'), 'Markdown 标题异常');
assert.ok(markdown.includes('## C-0001 · 草稿且正文不为空时提交成功'), 'Markdown 缺少用例章节');
assert.ok(markdown.includes('文档状态：变为待审批'), 'Markdown 缺少步骤预期');
await fs.rm(root, { recursive: true, force: true });
console.log('交付包 Markdown 导出与用例内容通过');
