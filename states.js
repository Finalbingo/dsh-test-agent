/**
 * State machine per feature: states, transitions, and the checks that keep the
 * model from inventing them. A transition that cannot be traced to a fact is not
 * knowledge, it is decoration.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { currentModule } from './scope.js';
import path from 'node:path';

/** Same stable-short-digest contract as the other artifacts (16 hex chars). */
const digestOf = (items) => crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);

export function statesPath(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule(), 'states.json');
}

export function loadStates(dataRoot, projectId) {
	try {
		return JSON.parse(fs.readFileSync(statesPath(dataRoot, projectId), 'utf8'));
	} catch {
		return { version: 0, updatedAt: null, items: [] };
	}
}

export function saveStates(dataRoot, projectId, items, meta = {}) {
	const file = statesPath(dataRoot, projectId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const next = { version: 1, updatedAt: new Date().toISOString(), digest: digestOf(items), ...meta, items };
	fs.writeFileSync(file, JSON.stringify(next, null, 1), 'utf8');
	return next;
}

export function statePrompt(feature, facts, bindings) {
	const relevant = facts.filter((fact) => (feature.fact_refs || []).includes(fact.fact_id));
	const block = relevant.map((fact) => `[${fact.fact_id}]（${fact.type}）${fact.statement}`).join('\n');
	const signals = (bindings || [])
		.filter((item) => item.kind === 'signal' && item.status === 'bound')
		.map((item) => item.subject.name)
		.slice(0, 30)
		.join('、');
	return [
		`功能点：${feature.feature_id} ${feature.name}（${feature.summary || ''}）`,
		'根据下面的事实，写出这个功能的状态与状态转移。只使用事实里出现过的状态与动作。',
		'输出 JSON，不要解释：',
		'{"states":[{"name":"关闭","entry":"进入条件","exit":"离开条件"}],',
		' "transitions":[{"from":"关闭","to":"开启","trigger":"单击【某开关】","conditions":["前置条件"],"actions":["发送 <信号名>=<取值>"]}]}',
		'规则：',
		'- 状态名用中文短语，2~6 个字；不要编造事实里没有的状态（故障态、未知态只在事实明确时写）。',
		'- transitions 中的 from 和 to 必须与 states 中的 name 逐字完全一致；每个声明的 state 必须至少参与一条 transition，禁止输出无转移的孤立状态。',
		'- 每条转移必须有 trigger；conditions 写前置条件。',
		'- actions 里如果发信号，写完整信号名。',
		signals ? `- 可用信号名：${signals}` : '- 本功能暂无已绑定信号。',
		'',
		block
	].join('\n');
}

const clean = (value) => String(value ?? '').trim();

const STATIC_ONLY_HINT_RE = /(?:页面|界面|画板|组件库|布局|列表|目录)(?:提供|包含|存在|展示|显示|设有).*?(?:画板|组件|按钮|软按键|图标|选项|区域)|仅有章节标题|正文内容(?:未给出|缺失)|同名候选待核/;
const TRIGGER_CUE_RE = /(?:当|若|如果|点击|单击|双击|短按|长按|按下|松开|滑动|拖动|调节|操作|触发|收到|接收|检测到|满足|发生|超时|未收到|来电|呼入|呼出|接通|挂断|上电|下电|启动|熄火)/;
const TRANSITION_VERB_RE = /(?:切换为|切换到|切换至|变为|变成|进入|退出|恢复到|恢复为|恢复|回弹|回退|还原|打开|开启|关闭|置为|设为|调整至|调整为|降为|升为|保持|维持|同步开机|同步开启|同步关闭|自动退出|自动切换|→|->)/;
const EXPLICIT_SINGLE_FACT_TRANSITION_RE = /(?:(?:处于|在|为|当).*?(?:状态|模式|关闭|开启|OFF|ON|待机|激活|未激活|档).*?(?:时|下|后).*?(?:点击|单击|短按|长按|滑动|操作|触发|收到|接收|满足|超时|发生).*?(?:切换|变为|进入|退出|恢复|回弹|回退|打开|开启|关闭|置为|设为|调整|保持))|(?:(?:点击|单击|短按|长按|操作|触发).*?(?:使|将|让)?.*?(?:状态|模式)?(?:从|由)?.*?(?:切换为|切换到|变为|进入|退出|打开|开启|关闭|回弹|恢复))|(?:前置条件.*?触发条件.*?执行)|(?:[\u4e00-\u9fa5A-Za-z0-9]{1,10}\s*(?:—|->|→)\s*[\u4e00-\u9fa5A-Za-z0-9]{1,10}\s*(?:—|->|→)?)/;
const STATE_VALUE_CUE_RE = /(?:状态(?:包含|为|有)|ON\s*[/／与和或]\s*OFF|开启\s*[/／与和或、]\s*关闭|开机\s*[/／与和或、]\s*关机|激活\s*[/／与和或、]\s*未激活|选中\s*[/／与和或、]\s*未选中|置灰|关闭状态|开启状态|运行状态|待机状态)/i;

/**
 * Evaluate whether a feature has sufficient state-transition evidence to derive a state machine.
 * Returns { status: 'eligible' | 'skipped_static' | 'insufficient_evidence', reason, feature_id, name, fact_refs }.
 */
export function evaluateStateEligibility(feature, allFacts = [], humanDecision = null) {
	const refs = Array.isArray(feature?.fact_refs) ? feature.fact_refs : [];
	const factMap = new Map((allFacts || []).map((f) => [f.fact_id, f]));
	const facts = refs.map((id) => factMap.get(id)).filter(Boolean);
	const base = {
		feature_id: feature?.feature_id || '',
		name: feature?.name || '',
		fact_refs: refs
	};

	if (humanDecision && String(humanDecision).trim() !== '') {
		return { ...base, status: 'eligible', reason: 'human_decision' };
	}
	if (facts.length === 0) {
		return { ...base, status: 'skipped_static', reason: 'no_referenced_facts' };
	}

	let explicitTransitionFacts = 0;
	let triggerFacts = 0;
	let outcomeFacts = 0;
	let stateFacts = 0;
	let staticFacts = 0;
	let pendingOnlyFacts = 0;

	for (const fact of facts) {
		const stmt = clean(fact.statement);
		if (!stmt) continue;
		const isMissingChapter = /仅有章节标题|正文内容(?:未给出|缺失)/.test(stmt);
		const isPendingQuestion = /^【待裁决】/.test(stmt);
		if (isMissingChapter) {
			staticFacts += 1;
			continue;
		}
		if (isPendingQuestion) {
			pendingOnlyFacts += 1;
			continue;
		}
		const hasExplicitSingle = EXPLICIT_SINGLE_FACT_TRANSITION_RE.test(stmt);
		const hasTrigger = TRIGGER_CUE_RE.test(stmt);
		const hasTransitionVerb = TRANSITION_VERB_RE.test(stmt);
		const hasStateValue = fact.type === 'state' || STATE_VALUE_CUE_RE.test(stmt);

		if (hasExplicitSingle || (fact.type === 'rule' && hasTrigger && hasTransitionVerb && (hasStateValue || /(?:打开|开启|关闭|进入|退出|回弹|恢复|切换)/.test(stmt)))) {
			explicitTransitionFacts += 1;
		}
		if (hasTrigger) triggerFacts += 1;
		if (hasTransitionVerb) outcomeFacts += 1;
		if (hasStateValue) stateFacts += 1;
		if (!hasTrigger && !hasTransitionVerb && (fact.type === 'control' || fact.type === 'feature' || fact.type === 'signal' || STATIC_ONLY_HINT_RE.test(stmt))) {
			staticFacts += 1;
		}
	}

	// 1. Single fact with explicit trigger + source/target state transition is eligible
	if (facts.length === 1) {
		if (explicitTransitionFacts >= 1) {
			return { ...base, status: 'eligible', reason: 'single_fact_explicit_transition' };
		}
		if (triggerFacts >= 1 || (stateFacts >= 1 && !staticFacts)) {
			return { ...base, status: 'insufficient_evidence', reason: 'single_fact_missing_transition_endpoints' };
		}
		return { ...base, status: 'skipped_static', reason: 'single_fact_static' };
	}

	// 2. Multiple facts: require genuine transition evidence (two static facts cannot qualify by count)
	if (explicitTransitionFacts >= 1 || (triggerFacts >= 1 && outcomeFacts >= 1 && stateFacts >= 1)) {
		return { ...base, status: 'eligible', reason: 'multi_fact_transition' };
	}

	// 3. Interactive clues exist (trigger or state mentioned), but missing transition endpoints/outcomes
	if (triggerFacts >= 1 || (outcomeFacts >= 1 && stateFacts >= 1) || (pendingOnlyFacts > 0 && triggerFacts + stateFacts > 0)) {
		return { ...base, status: 'insufficient_evidence', reason: 'interactive_clues_without_complete_transition' };
	}

	return { ...base, status: 'skipped_static', reason: 'static_layout_or_variant_only' };
}

export function filterEligibleStateFeatures(features = [], allFacts = [], decisions = new Map()) {
	const eligible = [];
	const skipped_static = [];
	const insufficient_evidence = [];
	for (const feature of features) {
		const decision = decisions instanceof Map ? decisions.get(feature.feature_id) : decisions?.[feature.feature_id];
		const res = evaluateStateEligibility(feature, allFacts, decision);
		if (res.status === 'eligible') eligible.push({ feature, diagnostic: res });
		else if (res.status === 'insufficient_evidence') insufficient_evidence.push(res);
		else skipped_static.push(res);
	}
	return { eligible, skipped_static, insufficient_evidence };
}

/** Names → ids; unknown states referenced by a transition are rejected. */
export function mergeStates(feature, raw, facts, bindings) {
	const stateNames = new Map();
	const states = [];
	for (const item of Array.isArray(raw?.states) ? raw.states : []) {
		const name = clean(item?.name);
		if (name === '' || stateNames.has(name)) continue;
		const stateId = `${feature.feature_id}.S${String(states.length + 1).padStart(2, '0')}`;
		stateNames.set(name, stateId);
		states.push({
			state_id: stateId,
			name,
			entry: clean(item.entry),
			exit: clean(item.exit),
			evidence_refs: (feature.fact_refs || []).slice(0, 3)
		});
	}
	const signalNames = new Set((bindings || []).filter((item) => item.status === 'bound').map((item) => item.subject.name));
	const resolveStateId = (rawName) => {
		const target = clean(rawName);
		if (!target) return undefined;
		if (stateNames.has(target)) return stateNames.get(target);
		// Allow matching when one side prefixes the feature name (e.g. "<功能名>关闭" vs "关闭"), only if unique
		const fName = clean(feature.name);
		const stripFeat = (s) => (fName && s.startsWith(fName) ? s.slice(fName.length).replace(/^[状态模式_\-\s]+/, '') : s).replace(/状态$/, '');
		const normTarget = stripFeat(target);
		if (!normTarget) return undefined;
		const hits = [...stateNames.entries()].filter(([k]) => stripFeat(k) === normTarget);
		return hits.length === 1 ? hits[0][1] : undefined;
	};
	const transitions = [];
	const rejected = [];
	for (const item of Array.isArray(raw?.transitions) ? raw.transitions : []) {
		const from = resolveStateId(item?.from);
		const to = resolveStateId(item?.to);
		const trigger = clean(item?.trigger);
		if (!from || !to || trigger === '') {
			rejected.push({ from: clean(item?.from), to: clean(item?.to), reason: 'UNKNOWN_STATE_OR_TRIGGER' });
			continue;
		}
		const actions = (Array.isArray(item.actions) ? item.actions : []).map(clean).filter(Boolean);
		transitions.push({
			transition_id: `${feature.feature_id}.T${String(transitions.length + 1).padStart(2, '0')}`,
			from,
			to,
			trigger,
			conditions: (Array.isArray(item.conditions) ? item.conditions : []).map(clean).filter(Boolean),
			actions,
			unbound_signals: actions.filter((action) => /[A-Z][A-Za-z0-9_]{4,}/.test(action)
				&& ![...signalNames].some((name) => action.includes(name))),
			evidence_refs: (feature.fact_refs || []).slice(0, 3)
		});
	}
	return { state_id: feature.feature_id, feature_id: feature.feature_id, name: feature.name, states, transitions, rejected };
}

/** Deterministic checks; run before saving. */
export function validate(machine) {
	const issues = [];
	if (machine.states.length === 0) issues.push({ code: 'NO_STATES', message: '没有状态' });
	if (machine.transitions.length === 0) issues.push({ code: 'NO_TRANSITIONS', message: '没有转移' });
	const referenced = new Set(machine.transitions.flatMap((item) => [item.from, item.to]));
	for (const state of machine.states) {
		if (!referenced.has(state.state_id)) issues.push({ code: 'ORPHAN_STATE', ref: state.state_id, message: `孤立状态：${state.name}` });
	}
	for (const transition of machine.transitions) {
		if (!machine.states.some((state) => state.state_id === transition.from) || !machine.states.some((state) => state.state_id === transition.to)) {
			issues.push({ code: 'UNKNOWN_STATE', ref: transition.transition_id, message: `${transition.transition_id} 引用了不存在的状态` });
		}
		if (!clean(transition.trigger)) issues.push({ code: 'NO_TRIGGER', ref: transition.transition_id, message: `${transition.transition_id} 缺少触发条件` });
		if (transition.unbound_signals?.length > 0) {
			issues.push({ code: 'UNBOUND_SIGNAL', ref: transition.transition_id, message: `${transition.transition_id} 的动作里有未绑定信号` });
		}
	}
	for (const [index, rejected] of (machine.rejected || []).entries()) {
		issues.push({ code: 'REJECTED_TRANSITION', rejected_index: index, message: `丢弃转移 ${rejected.from}→${rejected.to}（${rejected.reason}）` });
	}
	return issues;
}
