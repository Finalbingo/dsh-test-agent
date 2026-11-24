/**
 * Sub-agents: narrow jobs with read-only tools and their own context.
 *
 * They exist because the main loop is optimistic — it writes facts and cases and
 * then moves on. These agents go back and check the work against the evidence.
 */
import { runWorker } from './worker.js';

const pick = (args, names) => {
	for (const name of names) {
		const value = args?.[name];
		if (Array.isArray(value)) {
			const first = value.find((item) => typeof item === 'string' && item.trim() !== '');
			if (first) return first.trim();
			continue;
		}
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	return '';
};

const REVIEW_SKILL = `你是独立复核员。你的唯一职责是拿着证据核对别人写的东西，不重写、不补充、不评价文风。

规则：
- 先读证据，再下结论。没有读到的内容不能当作"已核对"。
- 只报你能指到具体句子的错误。
- 一条问题只报一次，不要重复。
- 没有问题时返回空数组。`;

const FACT_SKILL = `你是事实核对员。给你若干条"产品事实"及其证据编号，你要回到证据原文核对它是否被支持。

判断三档：
- supported：证据明确写了
- overreach：证据写了，但事实扩大了范围（比如证据说"部分场景"，事实写成"所有场景"；证据没给数值，事实补了数值）
- unsupported：证据里找不到，或证据与事实矛盾

规则：
- 必须调用 evidence.read 读取对应证据再判断，不许凭事实原文猜。
- 只输出 overreach 和 unsupported 两类。
- 指出具体差在哪，不要只说"证据不足"。`;

const CASE_SKILL = `你是用例复核员。拿着 PRD 证据核对测试用例的预期是否成立。

重点看四类：
1. expected_unsupported：预期里的行为/信号/时限在证据里找不到
2. expected_weakened：证据有明确取值（如 =0x1、3 帧、30s），用例写成"有变化""及时刷新"
3. step_unverifiable：步骤要求观察的东西，证据或设计里没有对应可观测对象
4. contradiction：前置条件与步骤互相矛盾

规则：
- 必须调用 evidence.search / evidence.read 找到依据再判断。
- 每条必须引用证据编号或原文片段。
- 没有把握不要报。`;

function parseFindings(text) {
	const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	const start = trimmed.indexOf('{');
	const end = trimmed.lastIndexOf('}');
	if (start < 0 || end <= start) return [];
	try {
		const value = JSON.parse(trimmed.slice(start, end + 1));
		const list = Array.isArray(value?.findings) ? value.findings : [];
		return list.filter((item) => item && typeof item.message === 'string');
	} catch {
		return [];
	}
}

/** Verify a batch of facts against the evidence they cite. */
export async function checkFacts({ model, facts, readEvidence, limit = 8, onEvent }) {
	const sample = facts.slice(0, limit).map((fact) => ({
		fact_id: fact.fact_id,
		type: fact.type,
		statement: fact.statement,
		evidence_refs: fact.evidence_refs || []
	}));
	const task = [
		`核对下面 ${sample.length} 条事实。逐条调用 evidence.read 读取它的证据编号。`,
		'输出 JSON：{"findings":[{"ref":"F-0001","verdict":"overreach|unsupported","message":"证据 X 只写了…，事实写成了…","evidence_refs":["E-0012"],"quote":"从证据里逐字复制的一句原文，至少 10 个字"}]}',
		'quote 必须逐字来自你读过的证据，程序会校验；对不上的发现会被丢弃。',
		'',
		JSON.stringify(sample, null, 1)
	].join('\n');
	const text = await runWorker({
		model,
		system: FACT_SKILL,
		task,
		tools: ['evidence.read'],
		maxRounds: 3,
		maxTokens: 6000,
		onEvent,
		runTool: async (name, args) => {
			if (name === 'evidence.read') return readEvidence(pick(args, ['id', 'evidence_id', 'ref', 'refs', 'evidence_ids', 'ids', 'value']), { limit: 2500 });
			throw new Error(`未知工具：${name}`);
		}
	});
	return { checked: sample.length, findings: parseFindings(text), raw: text.slice(0, 600) };
}

/** Verify case expectations against the evidence. */
export async function checkCases({ model, cases, searchEvidence, readEvidence, limit = 6, onEvent }) {
	const sample = cases.slice(0, limit).map((item) => ({
		case_id: item.case_id,
		title: item.title,
		steps: item.steps,
		expected: item.expected,
		signals: item.signals || []
	}));
	const task = [
		`核对下面 ${sample.length} 条用例。用 evidence.search 找依据，必要时 evidence.read 读全文。`,
		'输出 JSON：{"findings":[{"ref":"C-0001","code":"expected_unsupported|expected_weakened|step_unverifiable|contradiction","message":"…","evidence_refs":["E-0012"],"quote":"从证据里逐字复制的一句原文，至少 10 个字"}]}',
		'quote 必须逐字来自你读过的证据，程序会校验；对不上的发现会被丢弃。',
		'',
		JSON.stringify(sample, null, 1)
	].join('\n');
	const text = await runWorker({
		model,
		system: CASE_SKILL,
		task,
		tools: ['evidence.search', 'evidence.read'],
		maxRounds: 4,
		maxTokens: 6000,
		requireTool: true,
		onEvent,
		runTool: async (name, args) => {
			if (name === 'evidence.search') return searchEvidence(pick(args, ['query', 'q', 'text', 'queries', 'value']), { limit: 6 });
			if (name === 'evidence.read') return readEvidence(pick(args, ['id', 'evidence_id', 'ref', 'refs', 'evidence_ids', 'ids', 'value']), { limit: 2500 });
			throw new Error(`未知工具：${name}`);
		}
	});
	return { checked: sample.length, findings: parseFindings(text) };
}

export { REVIEW_SKILL };
