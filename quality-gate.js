import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { currentModule } from './scope.js';
import { digestOf, isPointCopy } from './artifacts.js';

/**
 * One gate for every path that can turn a candidate into an approval:
 * artifact.approve, the Excel review reflow and package.freeze. A structural
 * lint pass is recorded as lint_passed and leaves the case a candidate; only a
 * review record written against this exact content can approve it.
 */
export const REVIEW_FIELDS = ['review_status', 'reviewed_at', 'review_conclusion', 'review_comment', 'reviewer', 'lint_passed', 'review_digest', 'review_kind'];

export function caseContentDigest(item) {
	const content = { ...item };
	for (const key of REVIEW_FIELDS) delete content[key];
	return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function reviewsPath(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule(), 'case-reviews.json');
}

export function loadReviews(dataRoot, projectId) {
	try {
		return JSON.parse(fs.readFileSync(reviewsPath(dataRoot, projectId), 'utf8'));
	} catch {
		return { version: 0, updatedAt: null, items: [] };
	}
}

export function saveReviews(dataRoot, projectId, document) {
	const file = reviewsPath(dataRoot, projectId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const next = { version: (document.version || 0) + 1, updatedAt: new Date().toISOString(), items: document.items };
	fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 1));
	fs.renameSync(file + '.tmp', file);
	return next;
}

/** Keep the first decision: a later pass must not erase a first-round rejection. */
export function recordReview(dataRoot, projectId, entry) {
	return recordReviews(dataRoot, projectId, [entry]).items.find((item) => item.case_id === entry.case_id);
}

export function recordReviews(dataRoot, projectId, entries) {
	const document = loadReviews(dataRoot, projectId);
	for (const entry of entries) {
		const index = document.items.findIndex((item) => item.case_id === entry.case_id);
		const previous = index >= 0 ? document.items[index] : null;
		const history = [...(previous?.history || [])];
		if (previous) history.push({ case_digest: previous.case_digest, review_kind: previous.review_kind, conclusion: previous.conclusion, reviewer: previous.reviewer, at: previous.at, fields: previous.fields, findings: previous.findings });
		const next = {
			case_id: entry.case_id,
			// 变体锚：重生成会换 case_id，首审必须按变体（测试点）保留，否则首审率被抬高。
			variant_id: entry.variant_id || previous?.variant_id || null,
			case_digest: entry.case_digest,
			review_kind: entry.review_kind,
			conclusion: entry.conclusion,
			reviewer: entry.reviewer,
			fields: entry.fields || {},
			// 同码多项必须逐条留档：按错误码做键会把 3 条同类发现压成 1 条。
			findings: entry.findings || [],
			basis: entry.basis || '',
			at: new Date().toISOString(),
			first_result: previous?.first_result || entry.conclusion,
			first_at: previous?.first_at || new Date().toISOString(),
			history
		};
		if (index >= 0) document.items[index] = next;
		else document.items.push(next);
	}
	return saveReviews(dataRoot, projectId, document);
}

// 结构检查通过 is deliberately absent: a lint pass is not a content approval.
export const PASS = new Set(['通过', 'approved', 'pass']);

/**
 * 逐 ID 回执校验：漏答、外来编号、重复编号都让整页失败，绝不把「模型没答」当成通过。
 * @param {object} parsed 模型返回的 JSON
 * @param {string[]} ids 本页请求的用例编号，顺序即请求顺序
 */
export function validateReceipts(parsed, ids) {
	if (!Array.isArray(parsed?.receipts)) throw new Error('独立审查未返回逐 ID 回执（receipts），请重试');
	const wanted = new Set(ids);
	const seen = new Set();
	const rows = [];
	for (const row of parsed.receipts) {
		const id = String(row?.case_id || '');
		if (!wanted.has(id)) throw new Error(`回执包含未请求的用例编号：${id || '空'}`);
		if (seen.has(id)) throw new Error(`回执重复返回用例编号：${id}`);
		seen.add(id);
		const findings = (Array.isArray(row.findings) ? row.findings : [])
			.filter((entry) => entry && typeof entry.message === 'string' && entry.message.trim())
			.map((entry) => ({ code: String(entry.code || 'REVIEW'), field: String(entry.field || ''), message: entry.message,
				...(typeof entry.evidence_ref === 'string' && entry.evidence_ref ? { evidence_ref: entry.evidence_ref } : {}),
				...(typeof entry.quote === 'string' && entry.quote ? { quote: entry.quote } : {}),
				...(typeof entry.suggestion === 'string' && entry.suggestion ? { suggestion: entry.suggestion } : {}) }));
		const conclusion = String(row.conclusion || '');
		if (!['通过', '待修改', '待证据'].includes(conclusion)) throw new Error(`用例 ${id} 的回执结论无效：${conclusion || '空'}`);
		if ((conclusion === '通过') !== (findings.length === 0)) throw new Error(`用例 ${id} 的回执结论与发现条数不一致`);
		rows.push({ case_id: id, conclusion, findings });
	}
	const missing = ids.filter((id) => !seen.has(id));
	if (missing.length) throw new Error(`回执缺少用例编号：${missing.join('、')}`);
	return rows;
}

export function reviewPagesPath(dataRoot, projectId, stage = 'cases') {
	return path.join(dataRoot, 'artifacts', projectId, currentModule(), stage === 'cases' ? 'review-pages.json' : `review-pages-${stage}.json`);
}

export function loadReviewPages(dataRoot, projectId, stage) {
	try {
		return JSON.parse(fs.readFileSync(reviewPagesPath(dataRoot, projectId, stage), 'utf8'));
	} catch {
		return { baseline: null, config: null, pages: {} };
	}
}

/**
 * 评审配置键必须覆盖全部有效输入：换模型、换提示/Skill、换参数或换证据版本都要重审，
 * 否则旧回执会冒充新配置下的独立评审。prompt 传空页提示骨架（已含 Skill 正文）。
 */
export function reviewConfigKey({ reviewer, pageSize, skill, provider, model, prompt, params, evidence }) {
	return digestOf({ reviewer, page_size: pageSize, skill: skill || '', provider, model,
		prompt: digestOf(prompt), params, evidence: evidence || '' });
}

/** 成功页按「内容基线 + 评审配置 + 页内 ID」留档；基线或配置一变，旧回执一律不再复用。 */
export function saveReviewPage(dataRoot, projectId, { baseline, config, ids, receipts }, stage) {
	const document = loadReviewPages(dataRoot, projectId, stage);
	const next = document.baseline === baseline && document.config === config ? document : { baseline, config, pages: {} };
	next.pages[digestOf(ids)] = { ids, receipts, at: new Date().toISOString() };
	const file = reviewPagesPath(dataRoot, projectId, stage);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 1));
	fs.renameSync(file + '.tmp', file);
	return next;
}

/**
 * 首审按变体统计：同一变体在旧编号下的首次退回不能被新编号的通过掩盖。
 * @param {object} document case-reviews 文档
 * @param {Map<string,string>} variantOf case_id → variant_id（缺失时由调用方按测试点补齐）
 */
export function firstReviewStats(document, variantOf = new Map(), scope = null) {
	const earliest = new Map();
	for (const entry of document.items || []) {
		const variant = entry.variant_id || variantOf.get(entry.case_id) || entry.case_id;
		if (scope && !scope.has(variant)) continue;
		const events = [...(entry.history || []), entry.at ? entry : {
			at: entry.first_at, conclusion: entry.first_result || entry.conclusion, review_kind: entry.review_kind
		}];
		for (const event of events) {
			if (!event.at || ['model', 'lint'].includes(event.review_kind)) continue;
			const prior = earliest.get(variant);
			if (!prior || event.at < prior.at) earliest.set(variant, {
				at: event.at, conclusion: event.conclusion, variant_id: variant, case_id: entry.case_id
			});
		}
	}
	const rows = [...earliest.values()];
	const passed = rows.filter((row) => PASS.has(row.conclusion)).length;
	return { denominator: scope?.size ?? rows.length, reviewed: rows.length, passed, returned: rows.length - passed, rows };
}

/**
 * @returns {{ok: boolean, reasons: string[], lint_passed: boolean}}
 */
export function approvalGate(item, { reviews, errors = [], point, points, cases }) {
	const reasons = [];
	const blocking = errors.filter((entry) => entry.severity !== 'warning');
	const lintPassed = blocking.length === 0;
	if (!lintPassed) reasons.push(...blocking.map((entry) => `${entry.code}: ${entry.message}`));
	if (!point) reasons.push(`来源测试点不存在：${item.point_id}`);
	else if (point.review_status !== 'approved') reasons.push(`来源测试点未批准：${item.point_id}`);
	if (points && cases && cases.source_points_digest !== digestOf(points.items)) reasons.push('用例基线与当前测试点不一致，请重新生成');
	if (isPointCopy(item, point)) reasons.push('用例只是把测试点动作复制成唯一步骤，未经展开，不能批准');
	const record = (reviews?.items || []).find((entry) => entry.case_id === item.case_id);
	const digest = caseContentDigest(item);
	if (!record) reasons.push('缺少本版本的逐例评审记录');
	else if (record.case_digest !== digest) reasons.push(`评审记录对应旧内容（${record.case_digest.slice(0, 12)}…），当前内容为 ${digest.slice(0, 12)}…，请重新评审`);
	else if (record.review_kind === 'lint') reasons.push('只有结构检查记录，缺少独立内容评审');
	else if (record.review_kind === 'model') reasons.push('只有模型原始回执，未经独立裁决，不能批准');
	else if (!PASS.has(record.conclusion)) reasons.push(`评审结论未通过：${record.conclusion}`);
	return { ok: reasons.length === 0, reasons, lint_passed: lintPassed, case_digest: digest };
}

/** Structural pass is recorded, never promoted to approved. */
export function markLintPassed(item, errors) {
	const blocking = errors.filter((entry) => entry.severity !== 'warning');
	item.lint_passed = blocking.length === 0;
	if (item.review_status === 'approved' && !item.lint_passed) item.review_status = 'candidate';
	return item;
}

/**
 * 确定性三色异常分流引擎（Review-by-Exception，零大模型开销）：
 * - approved：已正式批准
 * - red：红灯阻断（缺必填/结构错误/AI审查打回/非必测分支），禁止批量放行
 * - yellow：黄灯重点裁决（P0 核心项/含延期或待确认缺口/信号绑定歧义/尚未独立审查），需人工重点看
 * - green：绿灯常规项（证据齐全、零阻塞错误、AI审查已判通过），支持一键人工签收
 */
export function classifyApprovalBuckets(kind, items = [], context = {}) {
	const byId = {};
	const counts = { approved: 0, red: 0, yellow: 0, green: 0, total: items.length };
	const pendingBindings = new Set(
		(context.bindings?.items || [])
			.filter((b) => b.status === 'ambiguous' || b.status === 'unmatched')
			.map((b) => b.subject?.name)
			.filter(Boolean)
	);
	const hasUnresolvedBinding = (text) => {
		if (!pendingBindings.size || !text) return false;
		for (const name of pendingBindings) {
			if (name.length >= 2 && text.includes(name)) return true;
		}
		return false;
	};
	const TBD_RE = /\bTBD\b|待确认|待定|原文未明确|PRD未明确/i;

	if (kind === 'contracts') {
		const openConflicts = new Set((context.conflicts?.items || []).filter((c) => c.status === 'open').map((c) => c.contract_id));
		const factIds = context.factIds instanceof Set ? context.factIds : null;
		for (const item of items) {
			const id = item.contract_id;
			if (!id) continue;
			if (item.status === 'approved') {
				byId[id] = { bucket: 'approved', reasons: [] };
				counts.approved += 1;
				continue;
			}
			const redReasons = [];
			const missing = [!item.trigger && '触发动作', !item.condition && '前置条件', !item.expected && '可观察预期'].filter(Boolean);
			if (missing.length) redReasons.push(`缺字段：${missing.join('、')}`);
			if (!item.fact_refs?.length) redReasons.push('缺少来源事实');
			else if (factIds && item.fact_refs.some((ref) => !factIds.has(ref))) redReasons.push('引用事实已失效');
			if (redReasons.length) {
				byId[id] = { bucket: 'red', reasons: redReasons };
				counts.red += 1;
				continue;
			}
			const yellowReasons = [];
			if (openConflicts.has(id)) yellowReasons.push('存在待裁决冲突');
			const joined = `${item.condition || ''} ${item.trigger || ''} ${item.expected || ''}`;
			if (TBD_RE.test(joined)) yellowReasons.push('含待确认/TBD条款');
			if (hasUnresolvedBinding(joined)) yellowReasons.push('关联未确认信号/控件');
			if (yellowReasons.length) {
				byId[id] = { bucket: 'yellow', reasons: yellowReasons };
				counts.yellow += 1;
			} else {
				byId[id] = { bucket: 'green', reasons: ['四要素齐全且无冲突'] };
				counts.green += 1;
			}
		}
		return { byId, counts };
	}

	if (kind === 'points') {
		const pointQuality = context.pointQuality || {};
		for (const item of items) {
			const id = item.point_id;
			if (!id) continue;
			if (item.review_status === 'approved') {
				byId[id] = { bucket: 'approved', reasons: [], p0: item.priority === 'P0' };
				counts.approved += 1;
				continue;
			}
			const redReasons = [];
			if (item.classification && item.classification !== 'required') {
				redReasons.push(`非必测分支（${item.classification}）`);
			}
			const missingPointFields = [!item.action && '操作步骤', !item.expected && '预期结果'].filter(Boolean);
			if (missingPointFields.length) redReasons.push(`缺字段：${missingPointFields.join('、')}`);
			if (!item.fact_refs?.length && !item.contract_id) redReasons.push('缺少来源依据');
			const qIssues = pointQuality[id] || [];
			if (qIssues.length) redReasons.push(...qIssues.slice(0, 2));
			if (redReasons.length) {
				byId[id] = { bucket: 'red', reasons: redReasons, p0: item.priority === 'P0' };
				counts.red += 1;
				continue;
			}
			const yellowReasons = [];
			if (item.priority === 'P0') yellowReasons.push('★ P0 核心主流程/高危项');
			const joined = `${item.condition || ''} ${item.action || ''} ${item.expected || ''}`;
			if (TBD_RE.test(joined)) yellowReasons.push('含待确认/TBD表述');
			if (hasUnresolvedBinding(joined)) yellowReasons.push('关联未确认信号/控件');
			if (yellowReasons.length) {
				byId[id] = { bucket: 'yellow', reasons: yellowReasons, p0: item.priority === 'P0' };
				counts.yellow += 1;
			} else {
				byId[id] = { bucket: 'green', reasons: ['来源齐全且零质量告警'], p0: false };
				counts.green += 1;
			}
		}
		return { byId, counts };
	}

	// kind === 'cases'
	const reviewByCase = new Map((context.reviews?.items || []).map((r) => [r.case_id, r]));
	const agentReviewByCase = new Map((context.agentReview?.items || []).map((r) => [r.object_id || r.case_id, r]));
	const pointById = context.pointById instanceof Map
		? context.pointById
		: new Map((context.points || []).map((p) => [p.point_id, p]));
	const lintErrorsByCase = context.lintErrorsByCase instanceof Map ? context.lintErrorsByCase : new Map();

	for (const item of items) {
		const id = item.case_id;
		if (!id) continue;
		const isP0 = item.priority === 'P0';
		if (item.review_status === 'approved') {
			byId[id] = { bucket: 'approved', reasons: [], p0: isP0, modelPassed: true };
			counts.approved += 1;
			continue;
		}
		const digest = caseContentDigest(item);
		const rec = reviewByCase.get(id);
		const agentRec = agentReviewByCase.get(id);
		const freshRec = rec && rec.case_digest === digest ? rec : null;
		const freshConclusion = freshRec?.conclusion || (agentRec && (!agentRec.case_digest || agentRec.case_digest === digest) ? agentRec.conclusion : '');
		const modelPassed = Boolean(freshConclusion && PASS.has(freshConclusion));

		const redReasons = [];
		const lintErrs = lintErrorsByCase.get(id) || [];
		if (lintErrs.length) redReasons.push(`结构校验未通过（${lintErrs[0].code || 'LINT'}）`);
		else if (!(item.steps?.length) || !(item.expected_items?.length)) redReasons.push('缺少执行步骤或预期结果');
		const pt = pointById.get(item.point_id);
		if (!pt) redReasons.push('来源测试点缺失');
		else if (pt.review_status !== 'approved') redReasons.push('来源测试点尚未批准');
		if (freshConclusion === '待修改') {
			const fCount = (freshRec?.findings || agentRec?.findings || []).length;
			redReasons.push(`AI 审查打回（${fCount || 1} 处待修改）`);
		}
		if (redReasons.length) {
			byId[id] = { bucket: 'red', reasons: redReasons, p0: isP0, modelPassed: false };
			counts.red += 1;
			continue;
		}

		const yellowReasons = [];
		if ((item.deferred_items || []).length > 0) yellowReasons.push(`含 ${item.deferred_items.length} 项待裁决延期缺口`);
		if (freshConclusion === '待证据') yellowReasons.push('AI 审查标记待补充证据');
		if (!modelPassed) yellowReasons.push('尚未完成独立审查');
		if (isP0) yellowReasons.push('★ P0 核心主流程/高危项');
		const joined = `${item.title || ''} ${item.expected || ''}`;
		if (TBD_RE.test(joined)) yellowReasons.push('含待确认/TBD条款');

		if (yellowReasons.length) {
			byId[id] = { bucket: 'yellow', reasons: yellowReasons, p0: isP0, modelPassed };
			counts.yellow += 1;
		} else {
			byId[id] = { bucket: 'green', reasons: ['结构零错误 · AI 审查已通过'], p0: false, modelPassed: true };
			counts.green += 1;
		}
	}
	return { byId, counts };
}
