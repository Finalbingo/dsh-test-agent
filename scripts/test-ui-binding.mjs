#!/usr/bin/env node
/**
 * UI 绑定改造回归：同名拆分 / 不截断 / 原始语义保留 / 人工决定与负面记忆 / ID 稳定。
 * 全部在临时目录里造数据，不碰真实项目。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractControls, queryVariants, suggest, loadBindings, saveBindings, confirm, reject, stats } from '../bindings.js';
import { enterModule, enterProjectConfig } from '../scope.js';

// 夹具自带项目词表：通用代码不再内置任何入口名、别名或控件后缀。
enterProjectConfig({
	capabilities: ['text', 'design'],
	surfaces: ['空调界面', '中控屏', 'Dock', '调节条'],
	default_surface: '空调界面',
	generic_names: ['空调', '中控'],
	name_prefixes: ['dock栏', '仪表', '快速'],
	aliases: [['雾', '霜']]
});

let failed = 0;
const check = (name, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`);
	if (!ok) failed += 1;
};

// 1. 同名控件按页面拆分
const facts = [
	{ fact_id: 'F-1', type: 'rule', statement: '在审批详情页点击【提交】按钮，提交审批申请' },
	{ fact_id: 'F-2', type: 'rule', statement: '在申请列表页点击【提交】按钮，批量提交所选条目' },
	{ fact_id: 'F-3', type: 'rule', statement: '点击【取消】按钮关闭弹窗' }
];
const controls = extractControls(facts);
const submits = controls.filter((control) => control.name === '提交');
check('同名控件按页面拆成两个对象', submits.length === 2, JSON.stringify(submits.map((s) => s.page)));
check('页面上下文正确', submits.some((s) => s.page === '审批详情') && submits.some((s) => s.page === '申请列表'));
check('无页面信息的控件保留', controls.some((c) => c.name === '取消' && c.page === ''));
check('fact_ids 不重复', submits.every((s) => new Set(s.fact_ids).size === s.fact_ids.length));

// 2. 不截断：造 150 个不同控件
const many = Array.from({ length: 150 }, (_, index) => ({
	fact_id: `F-${index}`, type: 'control', statement: `点击【控件${String(index).padStart(3, '0')}】执行操作`
}));
check('超过 60 个控件不再被截断', extractControls(many).length === 150, String(extractControls(many).length));

// 3. 原始语义保留：Dock栏/快速 不再从名称里丢
const dock = extractControls([{ fact_id: 'F-9', type: 'rule', statement: '空调关闭时单击dock栏【快速除雾】按键' }]);
check('dock栏入口控件不再被 STOP 丢弃', dock.some((c) => c.name === '快速除雾'), JSON.stringify(dock.map((c) => c.name)));
const variants = queryVariants('Dock栏快速除霜按键');
check('简化名只用于找候选，原始名保留', variants[0] === 'Dock栏快速除霜按键' && variants.includes('快速除霜'));
check('雾/霜互换仍在', variants.some((v) => v.includes('除雾')));

// 4. 人工决定保护 + 负面记忆 + ID 稳定（无设计稿环境）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-bind-'));
const projectId = 'P-test';
const projectDir = path.join(tmp, 'projects', projectId);
fs.mkdirSync(projectDir, { recursive: true });
enterModule('M-test');
const doc1 = suggest(projectDir, projectId, tmp, { items: facts });
const first = doc1.items.find((item) => item.subject.name === '提交' && item.subject.page === '审批详情');
check('首轮生成 binding_id', Boolean(first?.binding_id));
// 人工手填一个目标
const manualTarget = { node_id: '9:99', source_id: 'fake', name: '提交审批' };
saveBindings(tmp, projectId, doc1.items.map((item) => item.binding_id === first.binding_id
	? { ...item, target: manualTarget, method: 'manual', status: 'bound', decided_by: 'human', decided_at: new Date().toISOString() } : item));
const cancel = doc1.items.find((item) => item.subject.name === '取消');
reject(tmp, projectId, cancel.binding_id, { node_id: '1:1', source_id: 'fake' });
const doc2 = suggest(projectDir, projectId, tmp, { items: facts });
const again = doc2.items.find((item) => item.subject.name === '提交' && item.subject.page === '审批详情');
check('重跑保留人工目标', again?.target?.node_id === '9:99' && again?.decided_by === 'human');
check('重跑保留 binding_id', again?.binding_id === first.binding_id);
const cancelAgain = doc2.items.find((item) => item.subject.name === '取消');
check('重跑保留否定状态与负面记录', cancelAgain?.status === 'rejected' && cancelAgain?.rejected_target?.node_id === '1:1');
// 新增事实 → 新对象拿新 ID，不复用
const doc3 = suggest(projectDir, projectId, tmp, { items: [...facts, { fact_id: 'F-4', type: 'rule', statement: '在详情页点击【撤回】按钮' }] });
const ids = doc3.items.map((item) => item.binding_id);
check('ID 无重复', new Set(ids).size === ids.length);
check('旧 ID 全部保留', doc2.items.every((item) => ids.includes(item.binding_id)));
const withdraw = doc3.items.find((item) => item.subject.name === '撤回');
check('新对象编号往后排', Number(withdraw.binding_id.slice(2)) > Math.max(...doc2.items.map((item) => Number(item.binding_id.slice(2)))));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);