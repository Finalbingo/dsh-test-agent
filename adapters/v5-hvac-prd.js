import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * V5 PRD branch splitter. The source writes one DOCX block per interaction and
 * packs several "当…" clauses into it: opposite initial states, button vs voice
 * entry, and the resulting display/CAN consequences. Each clause becomes its own
 * branch; a clause that only states a display is a state observation, not an
 * action. Quotes are kept verbatim so every assertion can be traced back.
 */
const hash = (seed) => crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10).toUpperCase();

const HEADER_CELL = /^(?:列\d+|行|序号|条件|执行动作[^|]*|预期结果[^|]*|逻辑状态\d+|报文名称|信号名称|信号定义|信号值|数值|含义|备注|说明|功能|状态|版本号|版本|变更日期|日期|变更内容|修改说明|更新说明|编制人|审核人|批准人|作者|项目|模块)$/;
const VERSION_ROW = /^V\d+(?:\.\d+)*$/i;
const DATE_CELL = /^\d{4}[-/年.]\d{1,2}/;

export function parsePrd(file) {
	const text = fs.readFileSync(file, 'utf8');
	const sha256 = crypto.createHash('sha256').update(text).digest('hex');
	const sections = [];
	let parent = '前言';
	let current = { heading: '前言', parent: '前言', block: null, line: 0, blocks: [] };
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();
		const table = /^###\s*(原文表格\d+)\s*·\s*DOCX块(\d+)\s*$/.exec(trimmed);
		if (table) {
			sections.push(current);
			current = { heading: table[1], parent, block: Number(table[2]), line: index + 1, blocks: [], table: true };
			continue;
		}
		const heading = /^##\s*(.+?)\s*·\s*DOCX块(\d+)\s*$/.exec(trimmed);
		if (heading) {
			sections.push(current);
			parent = heading[1];
			current = { heading: heading[1], parent, block: Number(heading[2]), line: index + 1, blocks: [] };
			continue;
		}
		const block = /^\[DOCX块(\d+)\]\s*(.*)$/.exec(trimmed);
		if (block) { current.blocks.push({ block: Number(block[1]), text: block[2], line: index + 1 }); continue; }
		const row = /^\|\s*(\d+)\s*\|(.+)\|\s*$/.exec(trimmed);
		if (row && current.table) {
			const cells = row[2].split('|').map((cell) => cell.trim());
			if (cells.every((cell) => HEADER_CELL.test(cell))
				|| (cells.includes('条件') && cells.some((cell) => /预期结果/.test(cell)))) { current.header = cells; continue; }
			current.blocks.push({ block: null, row: Number(row[1]), cells, text: cells.join(' | '), line: index + 1 });
			continue;
		}
		if (/^\|[\s\-|]+\|$/.test(trimmed)) continue;
		if (trimmed && !current.table) current.blocks.push({ block: null, text: trimmed, line: index + 1 });
	}
	sections.push(current);
	return { file, sha256, sections: sections.filter((section) => section.blocks.length || section.heading) };
}

/** Split a block into "当…" clauses; leading text without 当 stays its own clause. */
export function splitClauses(text) {
	const parts = String(text).split(/(?=当[^，。]{0,40}(?:，|,))/).map((part) => part.trim()).filter(Boolean);
	return parts.length ? parts : [String(text).trim()];
}

const DISPLAY = /(?:空调界面|界面)?([一-龥A-Za-z0-9【】]{2,12}?)(?:按键|开关|图标)?(?:即时)?(?:会)?(?:切换到|切换为|保持|显示为|变为|为)[“"]([^”"]{2,20})[”"](?:显示)?/g;
const SEND = /IVI\s*发送信号\s*([A-Za-z_][A-Za-z0-9_]*(?:(?:\/|[ \t]+)[A-Za-z0-9_]+)*)(\s*[（(][A-Za-z][A-Za-z0-9_ ]*[）)])?(?:\s*[（(]连续\s*(\d+)\s*帧[）)])?/g;
const FEEDBACK = /接收信号\s*([A-Za-z0-9_ ]+?)\s*[，,]/g;
const GROUPED_FEEDBACK = /接收信号\s*([A-Za-z][A-Za-z0-9_ ]*(?:、\s*[A-Za-z][A-Za-z0-9_ ]*)+)\s*[，,。；]/g;

const STRUCTURE = /^(?:\d+(?:\.\d+)*\s*[一-龥A-Za-z_·]+|空调App|规则[:：]?|状态同步[:：]?|功能概述|操作规则|空调开启方式[:：]?|空调关闭方式[:：]?|空调状态记忆[:：]?|快速除霜[:：]?|注[:：].*|前言|#.*|原件 SHA256.*|提取方式.*|V5项目产品需求文档.*)$/;
const RANGE = /支持\s*(\d+)\s*挡调节[（(]([^）)]+)[）)]/;

export function classify(clause, section, inheritedInitial = '') {
	if (STRUCTURE.test(clause.trim())) return { initial: '', entry: '', action: '', expected: [], mode: 'meta', tbd: false, reference: false };
	const lead = (/^当([^，。]{2,60})[，,]/.exec(clause) || [])[1] || '';
	const leadIsAction = /被按下|单击|点击|语音|滑动|调节|上电|下电|丢失/.test(lead);
	const isState = /^当空调处于[^，。]*[，,]/.test(clause) && !leadIsAction;
	const entry = /语音/.test(clause) ? 'voice' : /被按下|单击|点击/.test(clause) ? 'button' : /滑动|调节/.test(clause) ? 'slider' : /上电|下电/.test(clause) ? 'power' : /丢失/.test(clause) ? 'signal_loss' : '';
	const reference = /请参考|参考\d/.test(clause);
	// "X时，Y" carries the same condition→trigger shape as "当X，Y".
	const when = lead ? null : /^([^，。]{4,60}?)时[，,]/.exec(clause);
	const initial = leadIsAction ? inheritedInitial : lead || (when ? when[1] + '时' : '');
	const action = leadIsAction ? lead : ((/((?:中控屏空调界面|空调界面|dock栏|Dock栏)?[^，。]{0,30}?(?:按键被按下|开关按键被按下|单击[^，。]{2,30}|点击[^，。]{2,30}|语音请求[^，。]{2,20}|语音控制[^，。]{2,20}|滑动[^，。]{2,30}|调节[^，。]{2,20}))/.exec(clause) || [])[1] || '');
	const expected = [];
	for (const match of clause.matchAll(DISPLAY)) {
		const acSwitch = /(?:A\/C|AC)开关$/.exec(clause.slice(0, match.index + match[1].length));
		const object = acSwitch?.[0]
			|| match[1].replace(/^(空调|界面)/, '');
		// Signal names are not UI objects; they belong to the CAN assertions below.
		if (/[A-Za-z]{3,}|_/.test(object)) continue;
		const quote = acSwitch && acSwitch.index < match.index ? clause.slice(acSwitch.index, match.index + match[0].length) : match[0];
		expected.push({ kind: 'ui_immediate', object, target: match[2], quote });
	}
	for (const send of clause.matchAll(SEND)) {
		const object = send[1];
		const frames = Number(send[3]) || 0;
		const qualifier = send[2]?.trim();
		expected.push({
			kind: 'can_request', object, signal: object, target: frames ? `发送该请求，连续${frames}帧` : '发送该请求',
			...(frames ? { frames } : {}), quote: send[0],
			...(qualifier ? { blocking: true, unresolved: `确认原文限定 ${qualifier} 所指字段及取值` } : {})
		});
	}
	for (const match of clause.matchAll(/(空调风量调节条)即时(?:会)?切换到([^“"，。；]+)/g)) {
		const conflictingDisplay = /温度/.test(match[2]);
		expected.push({
			kind: 'ui_immediate', object: match[1], target: match[2], quote: match[0],
			...(conflictingDisplay ? { blocking: true, unresolved: '原文将风量调节条与温度显示并列，需确认显示对象及目标' } : {})
		});
	}
	const feedbackSignals = [...clause.matchAll(FEEDBACK)].map((match) => match[1].trim()).filter((name) => /^[A-Za-z]/.test(name));
	const parsedWindows = [];
	for (const feedback30 of clause.matchAll(/(?:根据|按)信号\s*([A-Za-z0-9_ 、]+?)\s*变化[^。；]*?30\s*s\s*后更新([^，。；]*)/gi)) {
		const object = feedback30[2].trim() || '显示';
		const sentenceStart = Math.max(clause.lastIndexOf('。', feedback30.index), clause.lastIndexOf('；', feedback30.index)) + 1;
		const sentence = clause.slice(sentenceStart, feedback30.index + feedback30[0].length);
		const since = /(?:发出请求|发送请求)\s*(?:后\s*)?30\s*s/i.test(sentence) ? '发出请求'
			: /(?:收到反馈|反馈变化|信号变化)\s*(?:后\s*)?30\s*s/i.test(sentence) ? '反馈变化' : '';
		const unresolved = [!since && '原文未明确30秒计时起点', object === '显示' && '原文未点名显示对象'].filter(Boolean).join('；');
		parsedWindows.push([feedback30.index, feedback30.index + feedback30[0].length]);
		expected.push({
			kind: 'ui_feedback_30s', object, target: since ? `${since}后30秒更新${object}` : `按原文要求在30秒后更新${object}`,
			since, delay_s: 30, signals: feedback30[1].split('、').map((name) => name.trim()), quote: sentence,
			...(unresolved ? { unresolved, blocking: true } : {})
		});
	}
	for (const timing of clause.matchAll(/30\s*s\s*后更新显示/gi)) {
		if (parsedWindows.some(([from, to]) => timing.index >= from && timing.index < to)) continue;
		const from = Math.max(clause.lastIndexOf('。', timing.index), clause.lastIndexOf('；', timing.index)) + 1;
		const quote = clause.slice(from, timing.index + timing[0].length);
		const since = /发出请求|发送请求/.test(quote) ? '发出请求' : '';
		expected.push({
			kind: 'ui_feedback_30s', object: '显示', target: '按原文要求在30秒后更新显示',
			since, delay_s: 30, quote, blocking: true,
			unresolved: since ? '原文未点名显示对象' : '确认计时起点及具体显示对象'
		});
	}
	for (const signal of feedbackSignals) {
		const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const receive = new RegExp(`接收信号\\s*${escaped}[^。；]*`).exec(clause);
		// 反馈值本身是一项判据（读报文），界面跟随显示是另一项（看界面）：各自能单独失败。
		// 「相对基线发生变化」是可观察的；取值与界面的映射表原文没给，属范围缺口，不阻断本项判定。
		expected.push({
			kind: 'can_feedback', object: signal, target: 'IVI 收到该信号并记录反馈值',
			signal, quote: receive ? receive[0] : `接收信号${signal}`,
			unresolved: '原文未给出该反馈取值与界面状态的映射表'
		});
		const display = new RegExp(`接收信号\\s*${escaped}\\s*[，,]?\\s*(?:并)?根据信号[^。]*?进行([^。]{2,20})`).exec(clause);
		if (display) expected.push({ kind: 'ui_feedback', object: display[1].replace(/[“”]/g, ''), target: `按 ${signal} 反馈变化显示`, signal, quote: display[0] });
		const switchDisplay = new RegExp(`接收信号\\s*${escaped}\\s*[，,]\\s*根据信号\\s*${escaped}\\s*变化切换到[“"]([^”"]+)[”"]显示`).exec(clause);
		if (switchDisplay) expected.push({
			kind: 'ui_feedback', object: '显示', target: switchDisplay[1], signal, quote: switchDisplay[0],
			blocking: true, unresolved: '原文未点名该反馈对应的显示对象'
		});
	}
	const received = new Set(feedbackSignals);
	for (const match of clause.matchAll(GROUPED_FEEDBACK)) {
		for (const signal of match[1].split('、').map((name) => name.trim())) {
			if (received.has(signal)) continue;
			received.add(signal);
			expected.push({ kind: 'can_feedback', object: signal, signal, target: 'IVI 收到该信号并记录反馈值', quote: match[0] });
		}
	}
	let mode = 'run';
	if (reference) mode = 'reference';
	else if (isState && !entry) mode = 'state_observation';
	else if (/信号定义|通信矩阵/.test(section.heading)) mode = 'static_signal';
	// 只读状态条款没有触发动作：判据是状态观察，不是点击后的即时变化。
	if (mode === 'state_observation') for (const assertion of expected) {
		if (assertion.kind === 'ui_immediate') assertion.kind = 'state_observation';
	}
	const tbd = /TBD|待定|待确认/.test(clause);
	// 同一条原文里初态挡位与「回到上一状态」的挡位不一致，是资料自相矛盾，必须裁决。
	const statedGear = /(?:此时状态|初态|当前)[：:][^。]*?(\d+)\s*档/.exec(clause);
	const restoreGear = /回到[^。]*?[（(][^）)]*?(\d+)\s*档/.exec(clause);
	const gearConflict = statedGear && restoreGear && statedGear[1] !== restoreGear[1]
		? `原文初态写「${statedGear[0]}」，恢复目标写「${restoreGear[0]}」，同一控件挡位不一致，须裁决` : '';
	const range = RANGE.exec(clause);
	if (range) {
		const endpoints = [...range[2].matchAll(/(\d+)\s*(?:℃|挡)/g)].map((match) => Number(match[1]));
		const unit = /℃/.test(range[2]) ? '℃' : '挡';
		const segments = [...clause.matchAll(/(\d+)\s*℃[—\-~]+(\d+)\s*℃为([^，。；]{2,8})/g)]
			.map((match) => ({ from: Number(match[1]), to: Number(match[2]), behaviour: match[3] }));
		return {
			initial, entry: entry || 'slider', action: action || '调节到来源给出的端点挡位',
			expected: [
				...segments.map((segment) => ({ kind: 'boundary', object: '温度调节条', target: `${segment.from}℃—${segment.to}℃ 为${segment.behaviour}`, quote: `${segment.from}℃——${segment.to}℃为${segment.behaviour}`, from: segment.from, to: segment.to })),
				{ kind: 'boundary', object: '温度挡位', target: `支持${range[1]}挡，端点 ${endpoints.join('/')}${unit}`, quote: range[0], endpoints, unit }
			],
			mode: 'boundary', tbd, reference: false,
			// The source defines two segments; whether the gap value is a legal
			// gear is not stated, so it stays an open question instead of a pass.
			open_question: segments.length === 2 && segments[0].to + 1 < segments[1].from
				? `${segments[0].to + 1}℃—${segments[1].from - 1}℃ 是否为合法挡位，原文未定义` : ''
		};
	}
	return { initial, entry, action, expected, mode, tbd, reference, open_question: gearConflict };
}

export function buildBranches(prd, { scope = null } = {}) {
	const branches = [];
	for (const section of prd.sections) {
		if (scope && !scope(section)) continue;
		const precondition = /前置条件/.test(section.heading) ? section.blocks.map((block) => block.text).join('；') : '';
		if (precondition) { branches.precondition = precondition; continue; }
		for (const block of section.blocks) {
			if (block.cells) {
				const [condition, action, ...results] = block.cells;
				const tbd = /TBD|待定/.test(block.text);
				const context = section.parent || section.heading;
				const isSignalTable = /信号定义|信号规则|通信矩阵/.test(context);
				const isMeta = /版本信息|文档说明|模块架构|版本记录|修订记录/.test(context) || /版本号|变更日期|编制人/.test(block.text)
					|| (VERSION_ROW.test(String(condition).trim()) && DATE_CELL.test(String(action).trim()));
				const isException = /异常处理/.test(context);
				const header = section.header || [];
				const looksLikeRule = /条件/.test(header[1] || '') || isException;
				// 异常表的动作列常常写的是系统自己的处理逻辑，不是测试员能执行的动作。
				const systemLogic = /^(?:重新执行|按[^，。]*逻辑|根据[^，。]*(?:切换|执行)|自行执行|自动执行)/.test(String(action || '').trim());
				branches.push({
					branch_id: 'BR-' + hash(`${section.heading}:${block.line}:${block.text}`),
					section: section.heading, parent: context, docx_block: block.block, table_row: block.row, line: block.line,
					quote: block.text, initial: condition || '', entry: 'table',
					// 系统处理逻辑不是测试员动作：可执行的是构造原文条件，处理逻辑本身是预期。
					event: systemLogic ? `构造原文所述条件：${condition}` : (action || ''),
					expected: (systemLogic ? [action, ...results] : results).filter(Boolean).map((target) => ({ kind: /置灰|显示|切换|变化/.test(target) ? 'ui_immediate' : 'outcome', object: condition || '', target, quote: target })),
					mode: isMeta ? 'meta' : isSignalTable ? 'static_signal' : looksLikeRule ? 'run' : 'static_signal',
					status: isMeta ? 'excluded' : tbd && looksLikeRule ? 'needs_decision' : looksLikeRule ? 'ready' : 'static_check',
					open_question: '',
					tbd, precondition: branches.precondition || ''
				});
				continue;
			}
			let lastState = '';
			for (const clause of splitClauses(block.text)) {
				if (clause.length < 8) continue;
				const info = classify(clause, section, lastState);
				if (info.mode === 'state_observation' && info.initial) lastState = info.initial;
				const blocked = info.expected.filter((entry) => entry.blocking);
				branches.push({
					branch_id: 'BR-' + hash(`${section.heading}:${block.line}:${clause}`),
					section: section.heading, parent: section.parent || section.heading, docx_block: block.block, line: block.line,
					quote: clause, initial: info.initial, entry: info.entry, event: info.action,
					expected: info.expected, mode: info.mode,
					status: info.mode === 'meta' ? 'excluded'
						: info.tbd ? 'needs_decision'
						: info.open_question ? 'needs_decision'
						: info.mode === 'reference' ? 'reference'
						: info.expected.length ? 'ready' : 'needs_design',
					tbd: info.tbd,
					open_question: info.open_question || '',
					deferred_reason: blocked.map((entry) => entry.unresolved).join('；'),
					precondition: branches.precondition || ''
				});
			}
		}
	}
	return branches.filter((branch) => branch.branch_id);
}
