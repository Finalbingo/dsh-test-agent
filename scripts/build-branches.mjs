import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parsePrd, buildBranches } from '../adapters/v5-hvac-prd.js';
import { parseDbc } from '../signal-audit.js';

/**
 * P1 output: the branch list the next stages generate from, the clause
 * accountability table, and the adjudication queue. Nothing here approves a
 * case; it only says what the source actually states and what is still open.
 *
 * usage: node scripts/build-branches.mjs <project> <module> <acceptanceDir>
 */
const [project, module, out] = process.argv.slice(2);
if (!project || !module || !out) throw new Error('usage: build-branches.mjs <project> <module> <acceptanceDir>');
const root = process.env.CTS_DATA_ROOT || path.join(os.homedir(), 'Documents', 'CTS');
const projectDir = path.join(root, 'projects', project);
// 资料位置来自项目声明，脚本不认任何具体产品文件名。
const declared = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf8')).quality?.sources || {};
if (!declared.prd || !declared.dbc) throw new Error('项目未声明 quality.sources.prd / .dbc');
const prdFile = path.join(projectDir, declared.prd);
const prd = parsePrd(prdFile);
const branches = buildBranches(prd);
const evidence = JSON.parse(await fs.readFile(path.join(root, 'evidence', project, 'items.json'), 'utf8'));
const prdEvidence = evidence.items.filter((item) => item.source.startsWith('prd/'));
const version = prdEvidence[0]?.source_version || '';
const sourceId = prdEvidence[0]?.source_id || '';

// Link each branch to the evidence part that carries its DOCX block.
const byBlock = new Map();
for (const item of prdEvidence) {
	for (const match of item.text.matchAll(/\[DOCX块(\d+)\]/g)) {
		if (!byBlock.has(Number(match[1]))) byBlock.set(Number(match[1]), item);
	}
}
for (const branch of branches) {
	const item = byBlock.get(branch.docx_block) || prdEvidence.find((entry) => entry.text.includes(branch.quote.slice(0, 40)));
	branch.evidence_id = item?.id || '';
	branch.source_id = item?.source_id || sourceId;
	branch.version = item?.source_version || version;
	branch.source = item?.source || declared.prd;
	branch.location = `${item?.location || 'V5 空调 V1.13'} · 行${branch.line}${branch.docx_block ? ' · DOCX块' + branch.docx_block : ''}${branch.table_row ? ' · 表行' + branch.table_row : ''}`;
	branch.prd_sha256 = prd.sha256;
}

const dbcFile = path.join(projectDir, declared.dbc);
const dbc = parseDbc(dbcFile);
for (const branch of branches) {
	branch.signal_deps = [];
	for (const assertion of branch.expected) {
		const name = assertion.signal || (assertion.kind === 'can_request' ? assertion.object : '');
		if (!name || !/^[A-Za-z]/.test(name)) continue;
		const hits = [];
		for (const message of dbc.messages.values()) {
			const signal = message.signals.find((entry) => entry.name === name.replace(/\s+/g, '_'));
			if (signal) hits.push({ message: message.name, id: message.id, transmitter: message.transmitter, line: signal.line, range: `${signal.min}~${signal.max}` });
		}
		branch.signal_deps.push({ written: name, found: hits.length > 0, hits, dbc_sha256: dbc.sha256 });
	}
}

await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'branches.json'), JSON.stringify({
	at: new Date().toISOString(), project, module,
	prd: { file: declared.prd, sha256: prd.sha256, version, source_id: sourceId },
	dbc: { file: dbc.file, sha256: dbc.sha256, messages: dbc.messages.size, signals: dbc.signalCount },
	counts: {
		total: branches.length,
		byMode: Object.fromEntries(Object.entries(Object.groupBy(branches, (b) => b.mode)).map(([k, v]) => [k, v.length])),
		byStatus: Object.fromEntries(Object.entries(Object.groupBy(branches, (b) => b.status)).map(([k, v]) => [k, v.length]))
	},
	items: branches
}, null, 1));

const COLUMNS = ['branch_id', 'source_id', 'version', 'evidence_id', 'location', 'quote', 'initial', 'event', 'entry', 'expected', 'mode', 'status', 'reason', 'scenario_id', 'point_id'];
const tsv = (rows, columns) => [columns.join('\t'), ...rows.map((row) => columns.map((key) => String(row[key] ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'))].join('\n') + '\n';
await fs.writeFile(path.join(out, 'coverage.tsv'), tsv(branches.map((branch) => ({
	...branch,
	expected: branch.expected.map((assertion) => `${assertion.kind}:${assertion.object}→${assertion.target}`).join(' || '),
	reason: branch.status === 'needs_decision' ? '原文含 TBD，门限或结果未裁决'
		: branch.mode === 'static_signal' ? '信号/资料核对，不计运行覆盖'
		: branch.mode === 'reference' ? '原文指向另一节，按被引用分支覆盖'
		: branch.mode === 'meta' ? '版本/文档元信息'
		: branch.status === 'needs_design' ? '原文未给出可观察结果，需补设计' : ''
})), COLUMNS));

// Adjudication queue: every TBD plus the source conflicts found while reading.
const decisions = branches.filter((branch) => branch.status === 'needs_decision').map((branch) => ({
	decision_id: 'D-' + branch.branch_id.slice(3),
	branch_id: branch.branch_id, kind: branch.open_question ? 'boundary_gap' : 'tbd', location: branch.location, quote: branch.quote,
	question: branch.open_question || '原文把门限或结果标为 TBD，是否可作为运行判据？适用于哪些功能？',
	status: 'open', owner: '产品（空调）', evidence: branch.evidence_id,
	blocked_branches: branch.branch_id, resolution: '', resolved_at: ''
}));
decisions.push({
	decision_id: 'D-CONFLICT-636', branch_id: '', kind: 'conflict',
	location: '6.1.7 策略 · DOCX块636', quote: '空调此时状态：开启、吹面、4档、AC开 … 空调状态应回到“快速除霜”模式打开前的上一状态（吹面、6档、AC开）',
	question: '初态写 4 档，恢复目标写 6 档，同一句自相矛盾。恢复判据应取哪一个？',
	status: 'open', owner: '产品（空调）', evidence: byBlock.get(636)?.id || '', blocked_branches: '快速除霜退出恢复分支', resolution: '', resolved_at: ''
});
decisions.push({
	decision_id: 'D-CONFLICT-101', branch_id: '', kind: 'conflict',
	location: '5.1 功能概述 · DOCX块101 / 4.1.2 · DOCX块25', quote: '默认为3挡（TBD） / 默认挡以空调反馈为主',
	question: '温度默认挡一处写 3 挡（TBD），一处写以控制器反馈为主。首次上电判据取哪个？',
	status: 'open', owner: '产品（空调）', evidence: byBlock.get(101)?.id || '', blocked_branches: '首次上电温度默认分支', resolution: '', resolved_at: ''
});
decisions.push({
	decision_id: 'D-SIGNAL-TEMPSET', branch_id: '', kind: 'signal_missing',
	location: 'V5-V7.dbc:296 AC(0x2F0)', quote: 'C-0113 写 AC(0x2F0).HVAC_TempSet；该报文实际字段为 HVAC_Set_temperature（反馈），IVI 请求为 IVI_AC_6(0x3A6).IVI_Set_temperature_Driver',
	question: '温度请求验证应监听 IVI 发出的 IVI_Set_temperature_Driver，还是核对 AC 反馈 HVAC_Set_temperature？两者方向不同，不能互换。',
	status: 'open', owner: '产品/通信（空调）', evidence: dbc.file, blocked_branches: '温度调节发送请求分支', resolution: '', resolved_at: ''
});
decisions.push({
	decision_id: 'D-SIGNAL-HVAV', branch_id: '', kind: 'signal_typo',
	location: 'V5-V7.dbc:296 AC(0x2F0)', quote: 'C-0034 准备写 HVAV_Mode_change；DBC 只有 HVAC_Mode_change',
	question: '确认为拼写错误后按 HVAC_Mode_change 核对方向与取值；不自动替换。',
	status: 'open', owner: '产品/通信（空调）', evidence: dbc.file, blocked_branches: '语音吹脚除霜显示分支', resolution: '', resolved_at: ''
});
const DCOLUMNS = ['decision_id', 'branch_id', 'kind', 'location', 'quote', 'question', 'status', 'owner', 'evidence', 'blocked_branches', 'resolution', 'resolved_at'];
await fs.writeFile(path.join(out, 'source-decisions.tsv'), tsv(decisions, DCOLUMNS));

const needsDesign = branches.filter((branch) => branch.status === 'needs_design');
await fs.writeFile(path.join(out, 'needs-design.json'), JSON.stringify(needsDesign.map((branch) => ({ branch_id: branch.branch_id, section: branch.section, location: branch.location, quote: branch.quote })), null, 1));
console.log(JSON.stringify({
	branches: branches.length,
	byStatus: Object.fromEntries(Object.entries(Object.groupBy(branches, (b) => b.status)).map(([k, v]) => [k, v.length])),
	decisions: decisions.length, needsDesign: needsDesign.length,
	prdSha: prd.sha256.slice(0, 12), dbcSha: dbc.sha256.slice(0, 12)
}));