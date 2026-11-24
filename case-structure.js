import { stepKey, stepDigest } from './steps.js';
import { surfaces, termsPattern, hasCapability } from './scope.js';

/**
 * Structured cases: preparation, one action per step, and assertions that name
 * both the step that causes the result and the step that observes it. Anchors
 * are explicit and survive insertion/reordering because ids follow content.
 * The legacy strings (steps/expected/prepare_detail/restore_steps) are rendered
 * from these items so existing callers keep working.
 */
const text = (value) => String(value ?? '').trim();
const list = (value) => (Array.isArray(value) ? value : []).filter((item) => item && typeof item === 'object');

function allocateIds(items, prior, prefix) {
	const priorByKey = new Map();
	for (const entry of prior || []) {
		if (!entry?.text) continue;
		const key = stepKey(entry.text);
		if (!priorByKey.has(key)) priorByKey.set(key, []);
		priorByKey.get(key).push(entry);
	}
	const seen = new Map();
	const used = new Set();
	return items.map((item) => {
		const key = stepKey(item.text);
		const occurrence = seen.get(key) || 0;
		seen.set(key, occurrence + 1);
		const match = priorByKey.get(key)?.[occurrence];
		let id = match?.id && !used.has(match.id) ? match.id : `${prefix}${stepDigest(item.text)}`;
		let n = 2;
		while (used.has(id)) { id = `${prefix}${stepDigest(item.text)}-${n}`; n += 1; }
		used.add(id);
		return { ...item, id };
	});
}

/**
 * @param raw model output for one case. Steps may be {key,text} or plain strings;
 *        assertions may reference step keys (`trigger`/`observe`) or stable ids.
 * @param point the source point, used for evidence and for the observation fallback.
 */
export function buildStructuredCase(raw, point, prior = null) {
	const rawSteps = Array.isArray(raw?.steps) ? raw.steps : [];
	const clean = (value) => stepKey(value);
	const stepInputs = rawSteps.map((step, index) => typeof step === 'string'
		? { key: `step${index + 1}`, text: clean(step), role: 'action' }
		: { key: text(step.key) || `step${index + 1}`, text: clean(step.text), role: text(step.role) || 'action' });
	const stepItems = allocateIds(stepInputs.filter((step) => step.text), prior?.step_items, 's-');
	const byKey = new Map(stepItems.map((step) => [step.key, step]));
	const byId = new Map(stepItems.map((step) => [step.id, step]));
	const resolve = (value) => byKey.get(text(value)) || byId.get(text(value)) || null;
	const findAssertion = (entry) => {
		const ref = text(entry.assertion_ref);
		const matches = (point?.expected_items || []).filter((candidate) => ref
			? candidate.id === ref
			: candidate.object === text(entry.object) && (!entry.kind || candidate.kind === entry.kind));
		return matches.length === 1 ? matches[0] : null;
	};
	const evidenceFor = (entry, origin) => origin?.quote
		? [point?.source?.evidence_id, point?.source?.location, origin.quote].filter(Boolean).join(' · ')
		: text(entry.evidence_ref) || point?.source?.quote || '';

	const rawExpected = list(raw?.expected_items);
	const expectedInputs = rawExpected.map((entry, index) => {
		const origin = findAssertion(entry);
		const trigger = resolve(entry.trigger ?? entry.trigger_step_id ?? entry.trigger_step);
		const observe = resolve(entry.observe ?? entry.step_id ?? entry.observe_step);
		const composed = `${text(entry.object)}：${text(entry.target)}`;
		const inferredSince = (!origin && (Number(entry.delay_s) || 0) > 0 && !text(entry.since))
			? (/(?:自|从)([^\n，,。；;]{2,14}?)(?:起|后)/.exec(`${entry.target || ''} ${point?.expected || ''} ${point?.action || ''}`)?.[1]?.trim() || '状态改变')
			: '';
		return {
			key: text(entry.key) || `e${index + 1}`,
			assertion_ref: text(entry.assertion_ref) || origin?.id || '',
			text: entry.text ? stepKey(entry.text) : composed,
			object: text(entry.object),
			target: text(entry.target),
			kind: text(entry.kind) || 'ui_immediate',
			trigger_key: trigger?.key || text(entry.trigger ?? entry.trigger_step_id),
			observe_key: observe?.key || text(entry.observe ?? entry.step_id),
			evidence_ref: evidenceFor(entry, origin),
			frames: Number(entry.frames) || 0,
			since: origin ? text(origin.since) : (text(entry.since) || inferredSince),
			delay_s: Number(entry.delay_s) || 0,
			signal: text(entry.signal),
			gap: text(entry.unresolved)
		};
	});
	const expectedItems = allocateIds(expectedInputs.filter((entry) => entry.text), prior?.expected_items, 'e-').map((entry) => {
		const observe = byKey.get(entry.observe_key);
		const trigger = byKey.get(entry.trigger_key);
		const readOnly = entry.kind === 'state_observation' || entry.kind === 'static';
		const anchorGap = !observe ? `观察锚点未解析：observe=${entry.observe_key || '空'}`
			: !trigger && !readOnly ? `触发锚点未解析：trigger=${entry.trigger_key || '空'}` : '';
		return {
			id: entry.id, assertion_ref: entry.assertion_ref, text: entry.text, object: entry.object, target: entry.target, kind: entry.kind,
			trigger_step_id: trigger?.id || '', trigger_step_index: trigger ? stepItems.indexOf(trigger) + 1 : 0,
			step_id: observe?.id || '', step_index: observe ? stepItems.indexOf(observe) + 1 : 0,
			evidence_ref: entry.evidence_ref, frames: entry.frames, since: entry.since, delay_s: entry.delay_s, signal: entry.signal,
			unresolved: [entry.gap, anchorGap].filter(Boolean).join('；')
		};
	}).map(withSourceGaps);

	const prepareItems = allocateIds(list(raw?.prepare_items).map((entry, index) => {
		const object = text(entry.object);
		const channel = point?.protocol_readbacks?.[object];
		const readBack = text(entry.read_back);
		const reference = channel && readBack.includes(object) && STEP_READ.test(readBack)
			&& !/0x[0-9a-f]+|报文|无法读回|不执行/i.test(readBack) ? `在原始采集记录中读取报文 ${channel.message}(${channel.message_id})。 ` : '';
		return {
			key: text(entry.key) || `p${index + 1}`, text: text(entry.text), object,
			target: text(entry.target), establish: text(entry.establish), read_back: reference + readBack,
			on_failure: text(entry.on_failure) || '无法建立或读回则停止本例'
		};
	}).filter((entry) => entry.text), prior?.prepare_items, 'p-');
	const restoreItems = allocateIds(list(raw?.restore_items).map((entry, index) => ({
		key: text(entry.key) || `r${index + 1}`, text: text(entry.text),
		baseline: text(entry.baseline), read_back: text(entry.read_back), on_failure: text(entry.on_failure) || '记录未恢复项并停止后续依赖该基线的用例'
	})).filter((entry) => entry.text), prior?.restore_items, 'r-');

	const firstProtocolRead = prepareItems.findIndex((entry) => {
		const channel = point?.protocol_readbacks?.[entry.object];
		return channel && entry.read_back.includes(channel.message_id) && readsCapture(entry.read_back);
	});
	if (firstProtocolRead >= 0 && ![...prepareItems.map((entry) => entry.establish || entry.text), ...stepItems.map((step) => step.text)]
		.some((operation) => START_CAPTURE.test(operation) || STOP_CAPTURE.test(operation))) {
		const prepareText = '在采集工具中启动被动采集';
		prepareItems.splice(firstProtocolRead, 0, {
			id: `p-${stepDigest(prepareText)}`, key: 'capture-session', object: '被动采集会话', text: prepareText,
			target: '正在记录', establish: prepareText,
			read_back: '在采集工具状态栏确认会话正在记录，记录会话标识。', on_failure: '无法确认采集已开始则停止本例'
		});
		if (!restoreItems.some((entry) => STOP_CAPTURE.test(entry.text))) {
			const restoreText = '在采集工具中停止本例采集并保存记录';
			restoreItems.push({
				id: `r-${stepDigest(restoreText)}`, key: 'capture-session', text: restoreText, baseline: '恢复到启动采集前',
				read_back: '确认本例会话已停止，并核对保存的记录可打开。', on_failure: '记录失败，保留可用记录供复核'
			});
		}
	}

	const item = {
		step_items: stepItems.map((step, index) => ({ id: step.id, key: step.key, text: step.text, index: index + 1, role: step.role, anchor: `S${String(index + 1).padStart(2, '0')}` })),
		expected_items: expectedItems,
		prepare_items: prepareItems,
		restore_items: restoreItems,
		// 阻断缺口项：保留原文与理由，但不冒充可执行判据，也不占观察步骤。
		deferred_items: allocateIds(list(raw?.deferred_items).map((entry, index) => {
			const assertionRef = text(entry.assertion_ref);
			const origin = findAssertion(entry);
			return {
				key: text(entry.key) || `d${index + 1}`,
				assertion_ref: assertionRef || origin?.id || '',
				text: `${text(entry.object)}：${text(entry.target)}`,
				object: text(entry.object), target: text(entry.target), kind: text(entry.kind) || origin?.kind || 'ui_feedback',
				evidence_ref: evidenceFor(entry, origin),
				frames: Number(entry.frames) || origin?.frames || 0,
				since: origin ? text(origin.since) : text(entry.since),
				delay_s: Number(entry.delay_s) || origin?.delay_s || 0,
				unresolved: text(entry.unresolved) || origin?.unresolved || '原文未给出可判定的观察对象或门限'
			};
		}).filter((entry) => entry.object), prior?.deferred_items, 'd-')
	};
	renderLegacyFields(item, raw, point);
	return item;
}

/** Old callers read strings; render them from the structured items, never the reverse. */
export function renderLegacyFields(item, raw = {}, point = null) {
	const stepPositions = new Map();
	item.steps = (item.step_items || []).map((step, index) => {
		step.index = index + 1;
		step.anchor = `S${String(step.index).padStart(2, '0')}`;
		stepPositions.set(step.id, step.index);
		return `${step.anchor}. ${step.text}`;
	});
	item.expected = (item.expected_items || []).map((entry) => {
		entry.step_index = stepPositions.get(entry.step_id) || 0;
		entry.trigger_step_index = stepPositions.get(entry.trigger_step_id) || 0;
		const anchor = entry.step_index ? `S${String(entry.step_index).padStart(2, '0')}` : 'S00';
		return `${anchor}-1. ${entry.text}`;
	}).join('\n');
	item.prepare_detail = (item.prepare_items || []).map((entry, index) => `${index + 1}. ${entry.text}`).join('\n') || text(raw.prepare_detail) || text(point?.condition);
	item.restore_steps = (item.restore_items || []).map((entry) => entry.text);
	if (!item.restore_steps.length && Array.isArray(raw.restore_steps)) item.restore_steps = raw.restore_steps.map(text).filter(Boolean);
	item.precondition = text(raw.precondition) || text(item.precondition) || text(point?.condition);
	return item;
}

/**
 * Hard anchor rules. A result judged before its cause, an anchor that points at
 * a missing step, or an assertion without an object/target is a defect, not a
 * warning: it is exactly what made the previous batch unexecutable.
 */
/** 来源没写帧数就是缺口，由系统按原文落章，不依赖模型自觉，也不编一个帧数。 */
export function withSourceGaps(entry) {
	if (entry.kind !== 'can_request' || entry.frames || /帧/.test(entry.unresolved || '')) return entry;
	return { ...entry, unresolved: [entry.unresolved, '原文未给出连续帧数要求'].filter(Boolean).join('；') };
}

/** 步骤必须自带地点：换一个人拿到用例不需要再问「在哪做」。 */
const STEP_READ = /(观察|读取|检查|确认|核对|识别|记录|查看|比对|对比)/;
const START_CAPTURE = /(?:启动|开启|开始).{0,12}(?:采集|录制|记录)|确认.{0,16}(?:采集|会话).{0,14}(?:记录中|正在记录)|使用.{0,12}(?:现有|已有)采集会话/;
const STOP_CAPTURE = /(?:停止|关闭|结束).{0,10}(?:采集|录制)/;
const readsCapture = (value) => /(?:原始采集记录|实时采集|实时报文列表).{0,14}(?:读取|读回|复核|确认)/.test(value)
	&& !/无法读回|不执行/.test(value);
const GENERIC_PLACE = ['页面', '界面', '面板', '屏幕', '栏', '弹窗', '弹层', '桌面', '文档', '表格', '原文', 'PRD', '设计稿', '配图', '采集', '工具', '设备', '台架', '整车'];
const PROTOCOL_PLACE = ['CAN', 'CANoe', 'DBC', '诊断'];
const stepPlace = () => termsPattern([...GENERIC_PLACE, ...surfaces(), ...(hasCapability('protocol') ? PROTOCOL_PLACE : []), ...(hasCapability('bench') ? ['台架'] : [])]);

export function validateAnchors(item) {
	const errors = [];
	const steps = item.step_items || [];
	const ids = new Set(steps.map((step) => step.id));
	const indexOf = (id) => steps.findIndex((step) => step.id === id);
	let recording = false;
	const checkCapture = (operation, readBack, at) => {
		if (START_CAPTURE.test(operation)) recording = true;
		if (STOP_CAPTURE.test(operation)) recording = false;
		if (!recording && readsCapture(readBack)) {
			errors.push({ at, code: 'CAPTURE_NOT_RECORDING', message: `在「${readBack}」前须确认采集已开始，恢复读回须在停止采集前完成`, severity: 'error' });
		}
	};
	for (const entry of item.prepare_items || []) checkCapture(entry.establish || entry.text || '', entry.read_back || '', `prepare_items[${entry.id}]`);
	for (const step of steps) checkCapture(step.text || '', step.text || '', `step_items[${step.id}]`);
	for (const entry of item.restore_items || []) checkCapture(entry.text || '', entry.read_back || '', `restore_items[${entry.id}]`);
	for (const entry of item.expected_items || []) {
		const at = `expected_items[${entry.id}]`;
		if (!entry.object) errors.push({ at, code: 'ASSERTION_NO_OBJECT', message: '判据没有观察对象', severity: 'error' });
		if (!entry.target) errors.push({ at, code: 'ASSERTION_NO_TARGET', message: '判据没有应有状态或目标值', severity: 'error' });
		if (!entry.evidence_ref) errors.push({ at, code: 'ASSERTION_NO_EVIDENCE', message: '判据没有来源引用', severity: 'error' });
		// 一项判据只能有一个可观察对象：合并对象无法单独失败，也无法对位状态图。
		// 「A/C开关」是一个控件名，不算合并。
		if (entry.object && (/、|与|和/.test(entry.object) || /[一-龥]{2,}\/[一-龥]{2,}/.test(entry.object)) && !entry.unresolved) {
			errors.push({ at, code: 'ASSERTION_COMPOUND_OBJECT', message: `判据对象合并了多个观察对象：${entry.object}，请拆成独立判据`, severity: 'error' });
		}
		// 原文没点名显示对象时保留缺口，不许用光秃秃的「显示」充当观察对象。
		if (/^(?:IVI\s*)?(?:界面)?显示$/.test(entry.object || '') && !entry.unresolved) {
			errors.push({ at, code: 'ASSERTION_UNNAMED_DISPLAY', message: '原文未点名是哪个显示对象，应写入 unresolved 保留缺口', severity: 'error' });
		}
		if (!entry.trigger_step_id || !ids.has(entry.trigger_step_id)) {
			// 只读状态观察没有独立触发动作，触发留空是诚实表示，不编一个锚点。
			const readOnly = entry.kind === 'state_observation' || entry.kind === 'static';
			if (!readOnly || entry.trigger_step_id) {
				errors.push({ at, code: 'TRIGGER_MISSING', message: `触发步骤不存在：${entry.trigger_step_id || '空'}${entry.unresolved ? '（' + entry.unresolved + '）' : ''}`, severity: 'error' });
			}
		}
		if (!entry.step_id || !ids.has(entry.step_id)) {
			errors.push({ at, code: 'OBSERVATION_MISSING', message: `观察步骤不存在：${entry.step_id || '空'}`, severity: 'error' });
		}
		if (entry.trigger_step_id && entry.step_id && ids.has(entry.trigger_step_id) && ids.has(entry.step_id)) {
			const cause = indexOf(entry.trigger_step_id);
			const observe = indexOf(entry.step_id);
			if (/^ui_feedback(?:_30s)?$/.test(entry.kind) && steps[cause]?.role === 'observe' && /^在原始采集记录中(?:读取|读回|复核)/.test(steps[cause].text)) {
				errors.push({ at, code: 'PASSIVE_READBACK_AS_TRIGGER', message: '事后读取采集记录只是观察。请关联实际触发或原文明确要求的事件。', severity: 'error' });
			}
			// A read-only state observation legitimately has cause === observation.
			if (observe < cause) errors.push({ at, code: 'ANCHOR_BEFORE_CAUSE', message: `判据挂在触发之前的步骤（触发 S${cause + 1}，观察 S${observe + 1}）`, severity: 'error' });
			if (observe === cause && entry.kind !== 'state_observation' && entry.kind !== 'static') {
				errors.push({ at, code: 'NO_OBSERVATION_STEP', message: '点击后结果必须关联点击后的观察步骤，不能与触发同一步', severity: 'error' });
			}
		}
		if (entry.delay_s && !entry.since) errors.push({ at, code: 'TIMING_NO_ORIGIN', message: `写了 ${entry.delay_s}s 时限但没有计时起点`, severity: 'error' });
		if (entry.kind === 'can_request' && !entry.frames) errors.push({ at, code: 'REQUEST_NO_FRAMES', message: '发送类判据未写来源要求的连续帧数', severity: 'warning' });
		// 已登记帧数缺口，正文就不能再写一个具体帧数当门限。
		if (!entry.frames && /帧/.test(entry.unresolved || '') && /连续\s*\d+\s*帧/.test(entry.target || '')) {
			errors.push({ at, code: 'NUMBER_INVENTED_IN_GAP', message: `已登记帧数缺口却仍写死帧数：${entry.target}`, severity: 'error' });
		}
	}
	for (const step of steps) {
		// 启动/停止采集是动作，不是观察；标错会让「触发后才有结果」的判断失效。
		if (step.role === 'observe' && /(?:启动|停止|开始|结束|打开|关闭)[^。]{0,8}采集/.test(step.text || '')) {
			errors.push({ at: `step_items[${step.id}]`, code: 'STEP_ROLE_MISMATCH', message: `采集开关是动作步骤，role 应为 action：${step.text}`, severity: 'error' });
		}
		const body = String(step.text || '');
		if (body && !stepPlace().test(body)) {
			errors.push({ at: `step_items[${step.id}]`, code: 'STEP_NO_PLACE', message: `步骤未写明在哪个页面/工具执行：${body}`, severity: 'error' });
		}
		if (/对比[^。]{0,40}反馈[^。]{0,10}与/.test(body)) {
			errors.push({ at: `step_items[${step.id}]`, code: 'STEP_MERGED_OBSERVATION', message: `读报文与看界面合并成一步，须拆成两步：${body}`, severity: 'error' });
		}
		if (/目标温度|相应挡位|目标挡位|指定温度/.test(body)) {
			errors.push({ at: `step_items[${step.id}]`, code: 'STEP_UNSPECIFIED_VALUE', message: `步骤含未定值，须写原文给出的具体值或保留缺口：${body}`, severity: 'error' });
		}
		if (/相关报文|相关信号|对应报文|该报文|上述信号|所关注的报文|所关注的信号|所关注信号/.test(body) && !/0x[0-9A-Fa-f]{3}|[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+/.test(body)) {
			errors.push({ at: `step_items[${step.id}]`, code: 'STEP_UNNAMED_SIGNAL', message: `步骤只说「相关报文」未点名报文或信号：${body}`, severity: 'error' });
		}
		if (step.role === 'observe' && body && !STEP_READ.test(body)) {
			errors.push({ at: `step_items[${step.id}]`, code: 'STEP_NOT_OBSERVATION', message: `观察步骤没写读什么，定位/导航属于 action：${body}`, severity: 'error' });
		}
	}
	// 观察步骤必须真的读到该判据的对象；一步读多个界面对象无法逐项判定。
	for (const entry of item.expected_items || []) {
		const step = steps.find((candidate) => candidate.id === entry.step_id);
		if (!step || !entry.object) continue;
		const body = String(step.text || '');
		const signal = /([A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+|0x[0-9A-Fa-f]{3})/.exec(entry.object);
		// 报文类判据必须在采集里读到它点名的信号；界面类判据的对象里出现信号名只是上下文。
		if (signal && /^can_/.test(entry.kind || '') && !body.includes(signal[1])) {
			errors.push({ at: `expected_items[${entry.id}]`, code: 'OBSERVATION_OBJECT_MISMATCH', message: `观察步骤没有读取该判据的对象 ${signal[1]}：${body}`, severity: 'error' });
		}
		const named = [...body.matchAll(/【([^】]+)】/g)].map((hit) => hit[1]);
		// 界面判据同理：观察步骤必须真的看那个对象。挂到别的控件上就判不了（风量显示挂到空调开关观察步）。
		// 比对前两边都去掉【】与分隔符、并去掉「显示/状态」通用后缀：否则「【AC状态】」对不上「观察【AC状态】显示」，
		// 「AC状态显示」也对不上原文写法「【A/C】状态」。
		if (/^(ui_|state_observation)/.test(entry.kind || '') && !signal) {
			const stripNote = (value) => String(value).replace(/[（(][^）)]{1,20}[）)]/g, '');
			const flat = (value) => stripNote(value).replace(/[【】\s/\-_·:：]/g, '').toLowerCase();
			const rawCore = flat(String(entry.object).replace(/(?:显示|状态)+$/, '').replace(/(开关|按钮)按键$/, '$1'));
			const trimmedCore = rawCore.replace(/(?:提示文案|文案|提示|内容|信息|结果|数值|选中项|选项|列表|弹窗|页面|界面)+$/, '');
			const core = trimmedCore.length >= 2 ? trimmedCore : rawCore;
			const flatBody = flat(body);
			let matched = flatBody.includes(rawCore) || (core.length >= 2 && flatBody.includes(core));
			// Allow 1-2 inserted modifier characters inside a >=4-char compound noun (e.g. "当前界面" vs "当前所在界面")
			if (!matched && core.length >= 4) {
				const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const head = core.slice(0, 2);
				const tail = core.slice(-2);
				matched = new RegExp(`${esc(head)}[\\u4e00-\\u9fa5]{0,2}${esc(tail)}`).test(flatBody);
			}
			// If the observe step names a single 【...】 target, allow high character overlap (>=75%, >=2 shared chars)
			// to tolerate minor phrasing differences between assertion object and bracketed UI label while rejecting unrelated objects.
			if (!matched && named.length === 1 && core.length >= 2) {
				const label = flat(named[0]).replace(/(?:显示|状态|提示文案|文案|提示|内容|信息|结果|数值|选中项|选项|列表|弹窗|页面|界面)+$/, '') || flat(named[0]);
				if (label.length >= 2) {
					if (core.includes(label) || label.includes(core)) {
						matched = true;
					} else {
						const setA = new Set([...core]);
						const setB = new Set([...label]);
						let shared = 0;
						for (const ch of setA) if (setB.has(ch)) shared += 1;
						const ratio = shared / Math.min(setA.size, setB.size);
						if (shared >= 2 && ratio >= 0.75) matched = true;
					}
				}
			}
			if (core.length >= 2 && !matched) {
				errors.push({ at: `expected_items[${entry.id}]`, code: 'OBSERVATION_OBJECT_MISMATCH', message: `观察步骤没有观察该判据的对象「${entry.object}」：${body}`, severity: 'error' });
			}
		}
		if (named.length > 1) {
			errors.push({ at: `step_items[${step.id}]`, code: 'STEP_MULTIPLE_OBJECTS', message: `一步观察多个对象（${named.join('、')}），无法逐项判定，须拆步`, severity: 'error' });
		}
		// 界面判据要在界面上看，报文判据要在采集里读；挂错面就无法判定。
		const onScreen = termsPattern(['界面', '弹窗', '弹层', '桌面', ...surfaces()]).test(body);
		const onCapture = /原始采集|采集记录|报文中|CAN 采集/.test(body);
		if (/^ui_/.test(entry.kind || '') && onCapture && !onScreen) {
			errors.push({ at: `expected_items[${entry.id}]`, code: 'OBSERVATION_WRONG_SURFACE', message: `界面判据挂在读报文的步骤上，须另写界面观察步骤：${body}`, severity: 'error' });
		}
		if (/^can_/.test(entry.kind || '') && onScreen && !onCapture) {
			errors.push({ at: `expected_items[${entry.id}]`, code: 'OBSERVATION_WRONG_SURFACE', message: `报文判据挂在看界面的步骤上，须另写采集读取步骤：${body}`, severity: 'error' });
		}
	}
	for (const entry of item.deferred_items || []) {
		const at = `deferred_items[${entry.id}]`;
		if (!entry.object || !entry.target) errors.push({ at, code: 'DEFERRED_NO_OBJECT', message: '待裁决项缺少对象或目标', severity: 'error' });
		if (!entry.evidence_ref) errors.push({ at, code: 'DEFERRED_NO_EVIDENCE', message: '待裁决项缺少原文引用', severity: 'error' });
		if (!entry.unresolved) errors.push({ at, code: 'DEFERRED_NO_REASON', message: '待裁决项没写为什么判不了', severity: 'error' });
	}
	const deferredObjects = new Set((item.deferred_items || []).map((entry) => String(entry.object || '').trim()));
	const unbuildableObjects = new Set();
	const preparedKeys = new Set();
	for (const entry of item.prepare_items || []) {
		const namedInputs = [...String(entry.establish || '').matchAll(/准备项\s*([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((match) => match[1]);
		if (entry.key && namedInputs.some((key) => !preparedKeys.has(key))) {
			errors.push({ at: `prepare_items[${entry.id}]`, code: 'PREPARE_UNAVAILABLE_INPUT',
				message: `建立准备项「${entry.key}」时引用了尚未建立的数据：${namedInputs.filter((key) => !preparedKeys.has(key)).join('、')}`, severity: 'error' });
		}
		if (entry.key) preparedKeys.add(entry.key);
		if (!entry.read_back) errors.push({ at: `prepare_items[${entry.id}]`, code: 'PREPARE_NO_READBACK', message: '准备项没有读回方法', severity: 'error' });
		// 信号基线必须锚定报文，否则换人不知道去哪读这个值。
		const signal = /^[A-Z][A-Za-z0-9]*_[A-Za-z0-9_ ]+$/.test(String(entry.object || '').trim());
		// 报文或拼写未经确认时，写明「建不起来」并把依赖它的判据延期，比编一个报文号正确；
		// 但只声明建不起来、判据却还留在 expected_items 里，不算诚实缺口。
		const object = String(entry.object || '').trim();
		const unbuildable = /无法建立|无法读回/.test(`${entry.establish || ''}${entry.read_back || ''}`)
			&& /缺口|停止|不执行/.test(String(entry.on_failure || ''))
			&& deferredObjects.has(object);
		if (unbuildable) unbuildableObjects.add(object);
		if (signal && !unbuildable && !/0x[0-9A-Fa-f]{3}|报文/.test(String(entry.read_back || ''))) {
			errors.push({ at: `prepare_items[${entry.id}]`, code: 'BASELINE_NO_MESSAGE', message: `信号基线未写明从哪条报文读回：${entry.object}`, severity: 'error' });
		}
	}
	// 声明建不起来的基线，不能还有可执行判据挂在它上面：名字相近不算同一对象，逐字比对。
	for (const entry of item.expected_items || []) {
		const object = String(entry.object || '').trim();
		if (!unbuildableObjects.has(object)) continue;
		errors.push({ at: `expected_items[${entry.id}]`, code: 'EXECUTABLE_ON_UNBUILDABLE_BASELINE', message: `准备项已声明「${object}」基线建不起来，该判据须一并延期或改写依赖：${entry.target}`, severity: 'error' });
	}
	if (!(item.restore_items || []).length && !(item.restore_steps || []).length) {
		const readOnly = (item.step_items || []).every((step) => step.role === 'observe') && (item.expected_items || []).every((entry) => entry.kind === 'state_observation');
		if (!readOnly) errors.push({ at: 'restore_items', code: 'RESTORE_MISSING', message: '有副作用的用例缺少恢复项', severity: 'error' });
	}
	return errors;
}
