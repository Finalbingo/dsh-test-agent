/**
 * Cockpit test agent — host side.
 *
 * The page talks to /cts/api/chat and receives SSE frames. A run first grounds
 * itself with project.summary, then loops: the model may ask for evidence, the
 * host executes the tool and feeds the result back. Every frame is appended to
 * an on-disk run log so a refresh replays the same conversation.
 */
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDataDir, listProjects, summary, project as findProject, appendEvent, readEvents, latestRun, dataDir, sourceRoots } from './store.js';
import { build as buildEvidence, load as loadEvidence, loadAll as loadEvidenceAll, search as searchEvidence, read as readEvidence, loadDesignEvidence, formatSemanticDesignEvidence, semanticEvidenceDocument, buildDesignPageSemanticSummaries, stripDesignComponentPrefix } from './evidence.js';
import { state as designState, compile as designCompile, compileAsync, pages as designPages, search as designSearch, node as designNode, layerPages, layerChildren, layerSources, layerPagesOfFile, layerDetailLocal, layerNodeInfo, previewFile, previewNode, saveMcpDesign, copyMcpDesign, removedDesigns, setDesignRemoved, deletePreviewCache, queryLayers } from './design.js';
import { buildIndex as buildUiIndex, state as uiState, loadIndex as loadUiIndex, query as queryUi, match as matchUi, derive as deriveUi, loadLinks as loadUiLinks, saveLinks as saveUiLinks, recordDecision as recordUiDecision, propagate as propagateUi, coverage as uiCoverage, variants as uiVariants, validateDecision as validateUiDecision } from './ui.js';
import { attachCaseFigures } from './ui-figures.js';
import { suggest as suggestBindings, loadBindings, confirm as confirmBinding, reject as rejectBinding, manual as manualBinding, stats as bindingStats, saveBindings, buildSignalIndex } from './bindings.js';
import { statePrompt, mergeStates, validate as validateState, loadStates, saveStates, evaluateStateEligibility, filterEligibleStateFeatures } from './states.js';
import { freeze as freezePackage, fork as forkPackage, list as listPackages, currentPackage, isFrozen, snapshotArtifacts, readSnapshot } from './package.js';
import { build as buildHistory, search as searchHistory, load as loadHistory } from './history.js';
import { listActivity, recordActivity } from './activity.js';
import { authorRole, REVIEW_STAGES, ROLE_INSTRUCTIONS, STAGE_SKILLS } from './agent-roles.js';
import { runWorker } from './worker.js';
import { loadBundle, loadRules, makeSelection, digestFieldValid } from './tkr/registry.js';
import { deriveProfile, derivePolicy, annotateSelection } from './tkr/profile.js';
import { enterScope, resolveModule, currentModule, currentConfig, hasCapability, declaredSource, signalPrefixes, withModule, dutNode, defaultSurface, configTerms, coverageMode, includeSingleEntries } from './scope.js';
import { checkFacts, checkCases } from './agents.js';
import { buildOutline, buildOutlineFromBranches, branchResolvers, outlineFeatures, outlineCoverage, deliveryCases, generatableScenario, methods, reviewChanges } from './test-design.js';
import { buildWorkbook, zip } from './xlsx.js';
import { listEntries, readText } from './parsers/zip.js';
import { exportDelivery } from './delivery-export.js';
import { contractBasis, editContract, contractPoints } from './contracts.js';
import { skill, compose, enterSkillScope, listSkills, updateSkill, skillDigests } from './skills.js';
import { acquire as acquireLock } from './lock.js';
import { parseXlsx } from './parsers/xlsx.js';
import { PixsoMcp, savePng, isRemote, REMOTE_URL, DEFAULT_URL } from './design-mcp.js';
import { caseVisuals, caseFigurePath, missingInterfaceFigures, designEvidenceApplicable, confirmedFigures, figureBasis } from './case-visuals.js';
import { startFlow as startPixsoOAuth, finishFlow as finishPixsoOAuth, loadToken as loadPixsoToken, recordCallback } from './oauth.js';
import { build as buildEcsm, currentVersion as currentEcsmVersion, versions as ecsmVersions, freeze as freezeEcsm, impact as ecsmImpact, frozenModel, modelIssues } from './ecsm.js';
import { derive as deriveQuestions, load as loadQuestions, save as saveQuestions, merge as mergeQuestions } from './questions.js';
import { startRun, recordBatch, finishRun, loadRun, listRuns, pendingPoints } from './case-runs.js';
import { parseDbc, auditCases, locateSignal, directionOf } from './signal-audit.js';
import { caseContentDigest as caseDigest, REVIEW_FIELDS, loadReviews, recordReview, recordReviews, approvalGate, markLintPassed, firstReviewStats, PASS, validateReceipts, loadReviewPages, saveReviewPage, reviewConfigKey } from './quality-gate.js';
import { applyAuthority, applyCaseIds, attachReviewCard, buildGaps, buildRestore, normalizeCaseStructure, structureCase, enrichSignals, boundaryTargets, boundaryPrompt, buildCells, matrixPrompt, familyCoverage, digestOf, assignUnassigned, factPrompt, factTask, pointPrompt, casePrompt, caseVariant, parseJson, mergeFacts, mergePoints, checkPointQuality, mergeCases, mergeCasesDetailed, keepPointReviews, lint, isPointCopy, load as loadArtifact, save as saveArtifact, archive as archiveArtifact, exportCases, EXPORT_TEMPLATES, CASE_COLUMN_KEYS, applyPatch, removeItem, markReview, coverage, reviewPrompt, featurePrompt, mergeFeatures, attachFeatures, decorateCases, buildClosedLoopCoveragePlan, closedLoopForBatch, evaluateClosedLoopCoverage, closedLoopSupplementPrompt, buildExhaustiveExpansionHints, resolvePointFeedbackAttribution, enrichPrepareFeedbackReadback } from './artifacts.js';

export const name = 'cts-agent';
export const inject = ['webServer', 'connection', 'tools'];

const API = '/cts/api';
const CHAT = '/cts/api/chat';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ROUNDS = 5;
const GENERATE = '/cts/api/generate';
const REVIEW = '/cts/api/review';
const UPLOAD = '/cts/api/upload';
const OAUTH_START = '/cts/api/oauth/start';
const OAUTH_CALLBACK = '/cts/api/oauth/callback';
const OAUTH_PORT = 38123;
const FILE = '/cts/file';
const DOWNLOAD = '/cts/api/download';
const FACT_BATCH = 8;
const FACT_MAX_BATCHES = 90;
const POINT_BATCH = 20;
const CASE_BATCH = 8;
const MAX_BATCHES = 60;
const CASE_MAX_BATCHES = 240;

const loadStandardSpecText = async (projectDir) => {
	const rel = declaredSource('standard');
	if (!rel) return '';
	const rootDir = path.resolve(projectDir);
	const full = path.resolve(rootDir, rel);
	if (!full.startsWith(rootDir + path.sep)) return '';
	try {
		const raw = await fs.readFile(full, 'utf8');
		if (raw.includes('\u0000')) return '';
		return raw.trim().slice(0, 3500);
	} catch {
		return '';
	}
};

const SYSTEM = [
	'你是座舱测试 Agent，坐在一个测试工作台页面里，帮用户把 PRD、信号矩阵、设计稿变成测试点与用例。',
	'规则：',
	'1. 只说有据可查的话。没读到的内容不许编，明确说"资料里没有"。',
	'2. 需要资料时调用工具，不要凭印象回答。',
	'3. 回答用中文，先给结论，再给依据（引用证据编号 E-xxxx 与出处）。',
	'4. 发现资料缺口（例如信号没有定义、状态没有来源）要单独列出来。',
	'5. 排版克制：正文控制在 500 字内；不要在普通文本外面套代码块；信号名直接写，不要每个都加反引号；每条结论最多引 2 个证据编号；只有三项以上对比才用表格。'
].join('\n');

const TOOL_HELP = [
	'可用工具（需要时只输出一行 JSON，不要加解释、不要加代码块围栏）：',
	'{"tool":"evidence.search","args":{"query":"关键词","limit":8}}  → 检索证据，返回 E-xxxx 编号与片段',
	'{"tool":"evidence.read","args":{"id":"E-0001","offset":0,"limit":4000}}  → 读取某条证据正文',
	'{"tool":"signal.lookup","args":{"name":"<信号名或报文名>"}}  → 在通信/信号矩阵（DBC/Excel）或接口文档里查信号定义、方向与枚举',
	'{"tool":"design.search","args":{"query":"<控件名>","limit":10}}  → 在设计稿里按文字/控件名搜节点',
	'{"tool":"design.node","args":{"id":"pixso.x::node::123:456"}}  → 读一个设计节点的详情与子节点',
	'{"tool":"history.search","args":{"query":"<功能名>"}}  → 查历史项目里怎么定义/测过这个功能',
	'{"tool":"project.summary","args":{}}  → 项目资料清单',
	'',
	'遇到资料缺口或歧义（信号没定义、控件找不到、两处说法冲突）时，不要猜，也不要自己填。',
	'停下来输出一行：{"gate":{"question":"要问用户的一句话","options":["可选项1","可选项2"]}}',
	'用户回答后你会收到「用户回答：…」，再继续。options 可以省略（自由填写）。',
	'拿到"工具结果"后继续推理；信息够了就用中文直接回答，不要再输出 JSON。'
].join('\n');

const TOOLS = [
	{ name: 'evidence.search', description: 'Search project evidence chunks by keyword. Returns numbered hits.' },
	{ name: 'evidence.read', description: 'Read one evidence chunk by id.' },
	{ name: 'signal.lookup', description: 'Look up a CAN signal definition across the project signal matrices.' },
	{ name: 'project.summary', description: 'Project inventory: PRD / signal / design file counts.' }
];

const activityResult = Symbol('activityResult');
const ACTIVITY_ACTIONS = new Map([
	// 资料与证据
	['evidence.build', '构建证据'], ['sources.save', '保存资料配置'],
	['assets.tags.update', '更新模块资料关联'], ['assets.add', '添加资料'], ['assets.remove', '移除资料'], ['assets.adopt', '采纳资产库资料'],
	// 绑定与设计
	['binding.suggest', '推荐绑定'], ['binding.confirm', '确认绑定'], ['binding.manual', '手动绑定'], ['binding.reject', '驳回绑定'],
	['ui.build', '构建设计索引'], ['ui.links.derive', '匹配设计'], ['ui.figures', '补用例配图'],
	['design.renderAll', '批量获取设计预览'], ['design.importLibrary', '导入设计组件库'],
	// 合同 / 大纲 / 测试点 / 用例操作
	['contracts.save', '保存需求合同'], ['outline.save', '保存测试大纲'], ['outline.approve', '批准测试大纲'], ['outline.apply', '应用大纲范围'],
	['artifact.approve', '批准条目'], ['artifact.reject', '驳回条目'], ['artifact.approveBatch', '批量批准'], ['artifact.rejectBatch', '批量驳回'],
	['artifact.update', '编辑条目'], ['artifact.delete', '删除条目'], ['artifact.clear', '清空产物'], ['artifact.regenerate', '重生成条目'],
	['points.dedupe', '测试点去重'], ['points.expand', '展开测试点'], ['points.boundary', '补全边界测试点'],
	['points.transitions', '补全状态迁移测试点'], ['points.matrix', '补全组合矩阵测试点'],
	// 审查 / 修复 / 冻结 / 导出
	['agents.run', 'Agent 复核'], ['cases.reviewApply', '应用审查修订'], ['cases.reviewImport', '导入审查结果'],
	['ecsm.freeze', '冻结 ECSM 模型'], ['ecsm.repair', '修复模型缺口'], ['package.freeze', '冻结交付包'], ['package.fork', '派生交付版本'],
	['artifacts.export', '导出用例表格'], ['artifacts.exportBundle', '导出交付包'], ['outline.export', '导出测试大纲'],
	['ecsm.export', '导出 ECSM 模型'], ['package.export', '导出冻结包'],
	// 项目与模块配置
	['project.update', '更新项目配置'], ['project.autoConfig', '自动识别项目配置'],
	['module.create', '新建模块'], ['module.update', '更新模块配置'],
	['questions.build', '整理待回答问题'], ['questions.answer', '回答待决问题'], ['tkr.select', '选择测试规则']
]);
const GENERATION_LABELS = {
	facts: '提取产品事实', features: '归并功能点', states: '推导状态',
	contracts: '生成需求合同', points: '生成测试点', cases: '生成用例'
};

function sendJson(res, status, payload) {
	res.statusCode = status;
	res[activityResult]?.(status < 400 && payload.ok === true ? 'completed' : 'failed');
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

function inferBucket(fileName) {
	const name = String(fileName || '').toLowerCase();
	const ext = name.includes('.') ? name.split('.').pop() : '';
	if (['dbc', 'arxml', 'ldf'].includes(ext)) return 'signals';
	if (['pix', 'fig', 'sketch'].includes(ext)) return 'design';
	if (['md', 'docx', 'pdf', 'doc', 'txt'].includes(ext)) return 'prd';
	if (['xlsx', 'xls', 'csv'].includes(ext)) return /矩阵|signal|dbc|can/.test(name) ? 'signals' : 'other';
	if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'design';
	return 'other';
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function resolveModel(ctx, config) {
	const llm = ctx.get('llm');
	if (!llm) throw Object.assign(new Error('当前 profile 未挂载 llm 服务'), { code: 'NO_LLM' });
	const providers = llm.listProviders();
	if (!Array.isArray(providers) || providers.length === 0) {
		throw Object.assign(new Error('没有已注册的模型路由，请先在设置里配置模型'), { code: 'NO_PROVIDER' });
	}
	const wanted = typeof config?.provider === 'string' && config.provider ? config.provider : '';
	const provider = providers.find((item) => item.id === wanted) || providers[0];
	const models = await llm.listModels(provider.id);
	const wantedModel = typeof config?.model === 'string' && config.model ? config.model : '';
	const model = models.find((item) => item.id === wantedModel) || models[0];
	if (!model) throw Object.assign(new Error('该模型路由没有可用模型'), { code: 'NO_MODEL' });
	return { llm, provider: provider.id, model: model.id };
}

const message = (role, text) => ({ role, content: [{ type: 'text', text }] });

/** Accepts a bare JSON object, or one wrapped in a ``` fence. */
function parseToolCall(text) {
	const trimmed = String(text || '').trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
	const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	if (!unfenced.startsWith('{')) return null;
	try {
		const value = JSON.parse(unfenced);
		if (value && value.gate && typeof value.gate.question === 'string' && value.gate.question.trim() !== '') {
			return { gate: value.gate };
		}
		if (value && typeof value.tool === 'string' && value.tool !== '') {
			return { tool: value.tool, args: value.args && typeof value.args === 'object' ? value.args : {} };
		}
	} catch {
		return null;
	}
	return null;
}

/** A response may carry several actions (two tool calls, or tool then gate). */
function extractActions(text) {
	const source = String(text || '');
	const actions = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') { inString = true; continue; }
		if (char === '{') {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === '}') {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				const slice = source.slice(start, index + 1);
				start = -1;
				try {
					const value = JSON.parse(slice);
					if (value && value.gate && typeof value.gate.question === 'string') actions.push({ gate: value.gate });
					else if (value && typeof value.tool === 'string' && value.tool !== '') actions.push({ tool: value.tool, args: value.args && typeof value.args === 'object' ? value.args : {} });
				} catch {
					// not an action, ignore
				}
			}
		}
	}
	return actions;
}

/** Models name these fields inconsistently; accept the common aliases. */
function pickArg(args, names) {
	for (const name of names) {
		const value = args?.[name];
		if (Array.isArray(value)) {
			const first = value.find((item) => typeof item === 'string' && item.trim() !== '');
			if (first) return first.trim();
			continue;
		}
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
		if (typeof value === 'number') return String(value);
	}
	return '';
}

function stringify(value) {
	const text = JSON.stringify(value, null, 1);
	return text.length > 6000 ? `${text.slice(0, 6000)}\n…（已截断）` : text;
}

function chunk(list, size) {
	const out = [];
	for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
	return out;
}

/**
 * One model call whose text is consumed whole (generation, not conversation).
 * JSON extraction does not need deliberation, and thinking eats the token budget
 * before any text arrives, so we ask for the least reasoning the route allows.
 */
async function collect(model, prompt, maxTokens = 6000, images = []) {
	const run = async (extra) => {
		let text = '';
		for await (const part of model.llm.stream({
			provider: model.provider,
			model: model.model,
			maxTokens,
			messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images] }],
			...extra
		})) {
			if (part?.type === 'text-delta' && typeof part.text === 'string') text += part.text;
			else if (part?.type === 'finish' && (part.reason?.kind === 'error' || part.reason?.kind === 'aborted')) {
				throw Object.assign(new Error(part.reason?.failure?.message || '模型调用未完成'), { code: part.reason?.failure?.code || 'LLM_FAILED' });
			}
		}
		return text;
	};
	try {
		return await run({ reasoningEffort: 'off' });
	} catch {
		try {
			return await run({ reasoningEffort: 'low' });
		} catch {
			return await run({});
		}
	}
}

/**
 * One writer per run. Concurrent fs.appendFile calls interleave bytes and corrupt
 * the log (the page then replays scrambled text), so writes are queued and token
 * deltas are batched.
 */
function createLog(config, projectId, runId) {
	let queue = Promise.resolve();
	let buffer = '';
	const write = (event) => {
		const record = { ...event, at: new Date().toISOString() };
		queue = queue.then(() => appendEvent(config, projectId, runId, record)).catch(() => {});
		return queue;
	};
	const pushText = (text) => {
		buffer += text;
		if (buffer.length >= 600) {
			const chunk = buffer;
			buffer = '';
			write({ type: 'text.delta', text: chunk });
		}
	};
	const flush = () => {
		if (buffer !== '') {
			const chunk = buffer;
			buffer = '';
			write({ type: 'text.delta', text: chunk });
		}
		return queue;
	};
	return { write, pushText, flush };
}

export function apply(ctx, config) {
	const root = dataDir(config);
	const activityFor = (project, action, role, artifact, run = crypto.randomUUID(), module = currentModule()) => {
		return (stage, detail = '') => {
			try {
				recordActivity(root, { project, module, action, stage, detail, run, role, artifact });
			} catch (error) {
				console.warn('cts-agent: 无法写入动作记录', error.code || 'WRITE_FAILED');
			}
		};
	};
	const trackStream = (record, event, data) => {
		if (event === 'run.start') record('started');
		else if (event === 'phase') record('progress', data.label);
		else if (event === 'error') record('failed', data.code);
		else if (event === 'batch.failed' || event === 'review.pageFailed') {
			record('progress', data.batch ? `第 ${data.batch} 批失败` : `第 ${data.page} 页失败`);
		} else if (event === 'run.end' && data.published !== false) {
			const detail = Number.isInteger(data.count) ? `${data.count} 条`
				: Number.isInteger(data.reviewed) ? `已审查 ${data.reviewed} 条` : '';
			record(data.failed_ids?.length || data.stopped ? 'partial' : 'completed', detail);
		}
	};
	let defaults = null;
	const previewJobs = new Map();
	const POOL_DESIGN_KEY = '__pool__';
	const poolDesignDir = () => path.join(root, 'design', POOL_DESIGN_KEY);
	const localPixso = () => new PixsoMcp(isRemote(config?.pixsoMcpUrl) ? DEFAULT_URL : config?.pixsoMcpUrl || DEFAULT_URL, 45000);
	const pixName = (name) => String(name || '').normalize('NFC').trim().replace(/\.pix$/i, '').toLowerCase();
	const activeDocument = async (client) => {
		const result = await client.callTool('eval_script', {
			script: 'return { name: pixso.root.name, fileKey: pixso.fileKey || "", pages: pixso.root.children.map(page => page.id) };'
		});
		return JSON.parse(result.content.find((entry) => entry.type === 'text').text);
	};
	const inspectMcpDocument = async (client) => {
		try {
			const result = await client.callTool('eval_script', {
				script: `return {
					name: pixso.root?.name || "",
					fileKey: pixso.fileKey || "",
					currentPageId: pixso.currentPage?.id || "",
					pages: (pixso.root?.children || []).map(page => ({
						id: page.id,
						name: page.name || page.id,
						framesCount: (page.children || []).filter(n => n.visible !== false).length,
						frames: (page.children || []).filter(n => n.visible !== false).slice(0, 8).map(n => ({
							id: n.id, name: n.name || n.id, type: n.type || ""
						}))
					}))
				};`
			});
			const text = result.content?.find((entry) => entry.type === 'text')?.text;
			if (text) {
				const parsed = JSON.parse(text);
				if (parsed && parsed.name && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
					return {
						name: parsed.name,
						fileKey: parsed.fileKey || '',
						currentPageId: parsed.currentPageId || '',
						pages: parsed.pages.map((page) => typeof page === 'string'
							? { id: page, name: page, framesCount: 0, frames: [] }
							: { id: page.id, name: page.name || page.id, framesCount: Number(page.framesCount) || 0, frames: Array.isArray(page.frames) ? page.frames : [] })
					};
				}
			}
		} catch {
			try {
				const top = await client.callTool('get_top_level_frames', { type: 'page' });
				const text = top.content?.find((entry) => entry.type === 'text')?.text;
				const parsed = text ? JSON.parse(text) : null;
				const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.pages) ? parsed.pages : Array.isArray(parsed?.frames) ? parsed.frames : [];
				if (list.length > 0) {
					return {
						name: parsed?.name || 'Pixso 当前设计稿',
						fileKey: parsed?.fileKey || '',
						currentPageId: '',
						pages: list.map((p) => ({ id: String(p.id || p.guid || ''), name: String(p.name || p.id || ''), framesCount: 0, frames: [] })).filter((p) => p.id)
					};
				}
			} catch {
				// Neither worked -> no open design document or unsupported method
			}
		}
		return null;
	};
	const sameDocument = (doc, source, pages) => pixName(doc.name) === pixName(source.name) &&
		(!source.fileKey || doc.fileKey === source.fileKey) &&
		doc.pages.length > 0 && pages.length > 0 && pages.every((page) => doc.pages.includes(page.id));

	async function readMcpPage(client, document, pageId) {
		const nodes = [];
		const size = 500;
		let pageName;
		let total;
		do {
			const result = await client.callTool('eval_script', { script: `
				const page = pixso.getNodeById(${JSON.stringify(pageId)});
				if (!page || page.type !== "PAGE") return null;
				const all = page.findAll();
				return { name: pixso.root.name, fileKey: pixso.fileKey || "", pageName: page.name, total: all.length,
					nodes: all.slice(${nodes.length}, ${nodes.length + size}).map(node => ({
						id: node.id, parent: node.parent.id, type: node.type, name: node.name,
						visible: node.visible !== false, box: node.absoluteBoundingBox || null,
						componentKey: node.componentKey || "", componentProperties: node.componentProperties || null,
						text: node.type === "TEXT" ? node.characters.slice(0, 4000) : ""
					})) };
			` });
			const chunk = JSON.parse(result.content.find((entry) => entry.type === 'text').text);
			if (!chunk || chunk.name !== document.name || chunk.fileKey !== (document.fileKey || '')) {
				throw new Error('Pixso 当前设计稿已切换，请重新导入');
			}
			if ((total !== undefined && total !== chunk.total) || chunk.nodes.length !== Math.min(size, chunk.total - nodes.length)) {
				throw new Error('Pixso 页面读取期间发生变化，请重新导入');
			}
			total = chunk.total;
			pageName = chunk.pageName;
			nodes.push(...chunk.nodes);
		} while (nodes.length < total);
		return { id: pageId, name: pageName, nodes };
	}
	const caseImageBlocks = async (model, projectId, visualsByPoint) => {
		const attachments = ctx.get('attachments');
		if (!attachments || !model.llm.resolveModelInfo) return [];
		const info = await model.llm.resolveModelInfo(model.provider, model.model).catch(() => null);
		if (!info?.inputModalities?.includes('image')) return [];
		const entries = Object.entries(visualsByPoint);
		const figures = [0, 1].flatMap((position) => entries.flatMap(([id, list]) =>
			list[position] ? [{ id, figure: list[position] }] : []));
		const inputs = await Promise.all(figures.map(async ({ figure }) => ({
			data: await fs.readFile(caseFigurePath(root, projectId, figure)), mediaType: 'image/png'
		})));
		if (!inputs.length) return [];
		const refs = await attachments.saveImages(inputs);
		return figures.flatMap(({ id, figure }, index) => [
			{ type: 'text', text: `${id} · ${figure.role} · ${figure.name}` },
			{ type: 'image', attachment: refs[index] }
		]);
	};
	const collectCase = async (model, projectId, prompt, visuals, onFallback = () => {}, maxTokens = 12000) => {
		const images = await caseImageBlocks(model, projectId, visuals).catch((error) => { onFallback(error); return []; });
		return collect(model, prompt, maxTokens, images).catch((error) => {
			if (!images.length) throw error;
			onFallback(error);
			return collect(model, prompt, maxTokens);
		});
	};

	async function cachePreview(client, projectId, projectDir, source, id, checkDocument, bounds) {
		const { file, cached } = previewFile(projectDir, source, id);
		if (cached) return file;
		const shot = await client.screenshot(id, { scale: 1, width: bounds?.width, height: bounds?.height });
		await checkDocument();
		if (shot.buffer.length < 24 || shot.buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
			throw new Error('Pixso 未返回有效 PNG');
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temp = file + '.' + crypto.randomUUID() + '.tmp';
		try {
			await fs.writeFile(temp, shot.buffer);
			if (removedDesigns(root, projectId).has(source.id)) throw new Error('设计稿已删除');
			fsSync.renameSync(temp, file);
		} finally {
			await fs.unlink(temp).catch(() => {});
		}
		return file;
	}

	const rememberDesignSource = async (info, projectId, moduleId, source) => {
		if (!source?.id) return null;
		const designDoc = await withModule(moduleId, () => loadArtifact(root, projectId, 'design-sources'));
		const items = [...(designDoc.items || [])];
		const entry = { source_id: source.id, version: source.revision || '', name: source.name || '', kind: 'pixso-mcp',
			imported_at: new Date().toISOString() };
		const index = items.findIndex((item) => item.source_id === source.id);
		if (index >= 0) items[index] = entry; else items.push(entry);
		await withModule(moduleId, () => saveArtifact(root, projectId, 'design-sources', { ...designDoc, items }));
		const scopeDoc = await withModule(moduleId, () => loadArtifact(root, projectId, 'source-scope'));
		const scopePath = `design/${source.id}`;
		const scopeItems = [...(scopeDoc.items || [])];
		const scopeEntry = { path: scopePath, role: 'design', source_id: source.id, source_version: source.revision || '' };
		const scopeIndex = scopeItems.findIndex((item) => item.path === scopePath);
		if (scopeIndex >= 0) scopeItems[scopeIndex] = { ...scopeItems[scopeIndex], ...scopeEntry };
		else scopeItems.push(scopeEntry);
		await withModule(moduleId, () => saveArtifact(root, projectId, 'source-scope', { ...scopeDoc,
			meta: { ...(scopeDoc.meta || {}), mode: scopeDoc.mode === 'selected' ? 'selected' : 'all' }, items: scopeItems }));
		return { ...entry, path: scopePath };
	};

	function startPreviews(info, projectId, filename = '', importCurrent = false, moduleId = currentModule(), selectedPages = null) {
		const isPool = projectId === POOL_DESIGN_KEY;
		const current = previewJobs.get(projectId);
		if (current?.running) return current;
		const job = { id: crypto.randomUUID(), running: true, phase: importCurrent ? 'connect' : 'compile', total: 0, done: 0, failed: 0, source: '', compiled: false, module: moduleId, scope: isPool ? 'pool' : 'project' };
		previewJobs.set(projectId, job);
		const record = isPool ? () => {} : activityFor(projectId, importCurrent ? '导入 Pixso 设计稿' : '缓存 Pixso 截图', '', 'design', job.id, moduleId);
		record('started');
		void (async () => {
			try {
				let sources = layerSources(root, projectId);
				if (!importCurrent && (filename || !sources.some((source) => source.store))) {
					const compilation = await compileAsync(info.dir, projectId, root);
					job.compiled = true;
					job.indexChanged = !compilation.reused;
					if (filename) {
						const uploaded = layerSources(root, projectId, true).filter((source) => pixName(source.name) === pixName(filename));
						if (uploaded.length === 1) setDesignRemoved(root, projectId, uploaded[0], false);
					}
					sources = layerSources(root, projectId);
				}
				job.phase = 'connect';
				const client = localPixso();
				let document;
				try {
					await client.connect();
					document = await activeDocument(client);
				} catch (error) {
					throw new Error(`请打开 Pixso 客户端和对应设计稿，并启用本地 MCP 后重试（${error.message}）`);
				}
				let importedId;
				if (importCurrent) {
					if (!document.name || !document.pages.length) throw new Error('Pixso 当前设计稿没有可导入的页面');
					const targetPageIds = Array.isArray(selectedPages) && selectedPages.length
						? document.pages.filter((id) => selectedPages.includes(id))
						: document.pages;
					if (Array.isArray(selectedPages) && selectedPages.length && !targetPageIds.length) {
						throw new Error('所选原型页面不在当前打开的设计稿中，请刷新后重试');
					}
					job.phase = 'import';
					job.source = document.name;
					job.pagesDone = 0;
					job.pagesTotal = targetPageIds.length;
					const pageTrees = [];
					for (const pageId of targetPageIds) {
						pageTrees.push(await readMcpPage(client, document, pageId));
						job.pagesDone++;
					}
					if (!pageTrees.some((page) => page.nodes.length)) {
						throw new Error(`Pixso 设计稿「${document.name}」没有图层。请打开包含设计内容的文档后重试。`);
					}
					const latest = await activeDocument(client);
					if (JSON.stringify(latest) !== JSON.stringify(document)) throw new Error('Pixso 当前设计稿已变化，请重新导入');
					if (isPool) {
						importedId = saveMcpDesign(root, POOL_DESIGN_KEY, document, pageTrees);
						job.compiled = true;
						job.indexChanged = true;
						sources = layerSources(root, POOL_DESIGN_KEY);
						const importedSource = sources.find((source) => source.id === importedId);
						if (!importedSource) throw new Error('设计稿索引未发布');
						job.designSource = { source_id: importedSource.id, version: importedSource.revision, name: importedSource.name, scope: 'pool' };
					} else {
						const uploads = layerSources(root, projectId, true).filter((source) => !source.store &&
							sameDocument(document, source, layerPagesOfFile(source.db, source.id)));
						const release = await acquireLock(root, projectId);
						try {
							assertWritable(projectId);
							importedId = saveMcpDesign(root, projectId, document, pageTrees, uploads.length === 1 ? uploads[0] : undefined);
							setDesignRemoved(root, projectId, { id: importedId }, false);
							job.compiled = true;
							job.indexChanged = true;
							sources = layerSources(root, projectId);
							const importedSource = sources.find((source) => source.id === importedId);
							if (!importedSource) throw new Error('设计稿索引未发布');
							await buildEvidence(config, info, root, { designSource: importedSource.id });
							await rememberDesignSource(info, projectId, moduleId, importedSource);
							job.designSource = { source_id: importedSource.id, version: importedSource.revision, name: importedSource.name, module: moduleId };
							job.evidenceBuilt = true;
						} finally {
							await release();
						}
					}
				} else if (!filename) {
					sources = (await moduleLayerSources({ project: projectId, module: moduleId })).filter((source) => !source.historical);
				}
				let matches = sources.filter((source) => importedId ? source.id === importedId : !filename || pixName(source.name) === pixName(filename))
					.map((source) => ({ source, pages: layerPagesOfFile(source.db, source.id) }))
					.filter(({ source, pages }) => sameDocument(document, source, pages));
				if (matches.length > 1) {
					const preferred = matches.filter(({ source }) => filename ? !source.store : source.fileKey && source.fileKey === document.fileKey);
					if (preferred.length) matches = preferred;
				}
				if (matches.length !== 1) throw new Error(`请在 Pixso 打开${filename || '待缓存的项目设计稿'}后重试（当前打开：${document.name || '未知'}）`);
				const [{ source, pages }] = matches;
				job.source = source.name;
				const activePageSet = importCurrent && Array.isArray(selectedPages) && selectedPages.length
					? new Set(selectedPages)
					: new Set(document.pages);
				const layers = pages.filter((page) => activePageSet.has(page.id))
					.flatMap((page) => layerChildren(root, projectId, page.id, source.id))
					.filter((node) => node.visible && node.width > 0 && node.height > 0);
				const checkDocument = async () => {
					if (!sameDocument(await activeDocument(client), source, pages)) {
						throw Object.assign(new Error(`Pixso 已切换设计稿，请重新打开 ${source.name} 后重试`), { code: 'PIXSO_SWITCHED' });
					}
				};
				job.phase = 'render';
				job.total = layers.length;
				record('progress', `${source.name} · ${job.total} 张截图`);
				for (const layer of layers) {
					job.layer = layer.name || layer.id;
					try {
						await cachePreview(client, projectId, info.dir, source, layer.id, checkDocument, layer);
						job.done++;
					} catch (error) {
						job.failed++;
						job.lastFailure = `${layer.name || layer.id}（${layer.id}） ${error.message}`;
						if (error.code === 'PIXSO_SWITCHED') throw error;
						await checkDocument();
					}
				}
				job.phase = 'complete';
			} catch (error) {
				job.phase = 'error';
				job.error = error.code === 'ETIMEDOUT' ? '解析超时，请确认设计稿可正常打开后重试' : error.message;
			} finally {
				job.running = false;
				record(job.error ? 'failed' : job.failed ? 'partial' : 'completed', job.error || `${job.source} · 截图 ${job.done}/${job.total}，失败 ${job.failed}`);
			}
		})();
		return job;
	}

	async function runTool(context) {
		const { projectId, name, args } = context;
		if (name === 'project.summary') return summary(config, args.project || projectId);
		if (name === 'evidence.search') {
			const query = pickArg(args, ['query', 'q', 'text', 'queries', 'value']);
			const result = await searchEvidence(config, projectId, root, query, { limit: args.limit, kind: args.kind, document: await scopedEvidence(projectId) });
			if (result.total === 0) return { query: result.query, hits: [], note: '没有命中；先构建证据或换关键词' };
			return result;
		}
		if (name === 'evidence.read') {
			const id = pickArg(args, ['id', 'evidence_id', 'ref', 'refs', 'ids', 'value']);
			return readEvidence(config, projectId, root, id, { offset: args.offset, limit: args.limit, document: await scopedEvidence(projectId) });
		}
		if (name.startsWith('design.')) {
			const allowed = await moduleDesignRevisions(projectId);
			const sources = layerSources(root, projectId, false, allowed).filter((source) => allowed.get(source.id) === source.revision);
			return queryLayers(sources, { action: name.slice('design.'.length), source: args.source, id: String(args.id || ''), text: String(args.query || ''), limit: args.limit });
		}
		if (name === 'history.search') {
			return searchHistory(root, String(args.query || ''), args.limit);
		}
		if (name === 'signal.lookup') {
			const query = String(args.name || args.query || '').trim();
			if (query === '') throw new Error('signal.lookup 需要 name');
			const info = await findProject(config, projectId);
			const structured = [];
			if (info?.dir) {
				const { index } = buildSignalIndex(info.dir);
				const needle = query.toLowerCase();
				const compactNeedle = needle.replace(/[\s_-]/g, '');
				for (const sig of index.values()) {
					const exact = sig.name.toLowerCase() === needle || sig.message.toLowerCase() === needle || sig.message_id.toLowerCase() === needle;
					const fuzzy = exact || sig.name.toLowerCase().includes(needle)
						|| sig.name.toLowerCase().replace(/[\s_-]/g, '').includes(compactNeedle)
						|| (sig.description && sig.description.toLowerCase().includes(needle))
						|| sig.message.toLowerCase().includes(needle);
					if (!fuzzy) continue;
					structured.push({
						exact,
						name: sig.name,
						description: sig.description || '',
						message: sig.message,
						message_id: sig.message_id,
						transmitter: sig.transmitter || '',
						direction: sig.transmitter ? directionOf(sig.transmitter) : '发送方未声明',
						receivers: sig.receivers || [],
						cycle: sig.cycle || '',
						range: sig.min !== '' || sig.max !== '' ? `${sig.min}~${sig.max}${sig.unit ? ` ${sig.unit}` : ''}` : '',
						initial: sig.initial || '',
						invalid: sig.invalid || '',
						value_table: sig.valueDesc || '',
						source: sig.source || ''
					});
				}
				structured.sort((a, b) => Number(b.exact) - Number(a.exact) || a.name.localeCompare(b.name));
			}
			const hits = structured.slice(0, Math.min(12, Math.max(1, Number(args.limit) || 8))).map(({ exact, ...rest }) => rest);
			if (hits.length > 0) return { query, total: structured.length, signals: hits };
			return searchEvidence(config, projectId, root, query, { limit: 6, document: await scopedEvidence(projectId) });
		}
		throw new Error(`未知工具：${name}`);
	}

	// A gate is an open question: the run waits for the user instead of guessing.
	const pendingGates = new Map();

	/** Move a flat artifacts/<project>/* layout into artifacts/<project>/<module>/. */
	const ensureModuleLayout = async (projectId, info) => {
		const modules = Array.isArray(info?.modules) ? info.modules : [];
		const moduleId = resolveModule(info, '');
		if (modules.length === 0) return;
		const flat = path.join(root, 'artifacts', projectId);
		const target = path.join(flat, moduleId);
		if (await fs.stat(target).then(() => true).catch(() => false)) return;
		const entries = await fs.readdir(flat).catch(() => []);
		if (entries.length === 0) return;
		if (!entries.includes('facts.json') && !entries.includes('cases.json')) return;
		await fs.mkdir(target, { recursive: true });
		for (const entry of entries) {
			if (entry === moduleId) continue;
			await fs.rename(path.join(flat, entry), path.join(target, entry)).catch(() => {});
		}
	};

	const refreshQuestions = async (projectId) => {
		const [bindings, cases, points, facts] = await Promise.all([
			Promise.resolve(loadBindings(root, projectId)),
			loadArtifact(root, projectId, 'cases'),
			loadArtifact(root, projectId, 'points'),
			loadArtifact(root, projectId, 'facts')
		]);
		const states = loadStates(root, projectId);
		const fresh = deriveQuestions({ bindings, states, cases, points, facts });
		const merged = mergeQuestions(loadQuestions(root, projectId), fresh);
		return saveQuestions(root, projectId, merged);
	};

	const pixsoToken = async (config) => {
		const configured = typeof config?.pixsoToken === 'string' ? config.pixsoToken.trim() : '';
		if (configured) return { token: configured, source: 'config' };
		const stored = await loadPixsoToken(root).catch(() => null);
		if (stored?.access_token) return { token: stored.access_token, source: 'oauth' };
		return { token: '', source: 'none' };
	};

	const originOf = (req) => {
		const forwarded = String(req.headers['x-forwarded-proto'] || '');
		const proto = forwarded || (req.socket?.encrypted ? 'https' : 'http');
		const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:50798');
		return `${proto}://${host}`;
	};

	const scopeRequest = async (body) => {
		if (typeof body?.project !== 'string' || body.project === '') return;
		const info = await findProject(config, body.project);
		await ensureModuleLayout(body.project, info);
		return { module: resolveModule(info, body.module), config: info?.quality };
	};

	const assertWritable = (projectId) => {
		if (isFrozen(root, projectId)) {
			throw new Error('该版本已冻结，不能修改；先「派生新版本」再编辑');
		}
	};

	const isSignalMatrixFile = (sourcePath) => /\.(dbc|arxml|ldf)$/i.test(sourcePath)
		|| (/^signals\//i.test(sourcePath) && /\.(xlsx|xls|csv)$/i.test(sourcePath))
		|| (/\.(xlsx|xls)$/i.test(sourcePath) && /矩阵|signal|matrix|通信|协议|接口|dbc|can/i.test(sourcePath));
	const DEFAULT_USAGE = (sourcePath, kind = '') => {
		if (sourcePath.startsWith('design/') || /\.(pix|png|jpe?g|webp|svg)$/i.test(sourcePath) || kind === 'design') return 'design';
		if (isSignalMatrixFile(sourcePath)) return 'interface';
		if (/^(prd|other)\//.test(sourcePath) || /\.(md|markdown|txt|pdf|docx?|html?)$/i.test(sourcePath)) return 'requirement';
		return 'reference';
	};
	const tagScopeFor = (tagRegistry, sourcePath, moduleId) => {
		const direct = tagRegistry?.[sourcePath];
		const tags = Array.isArray(direct?.tags) ? direct.tags : null;
		if (tags) return tags.includes(moduleId) ? 'module' : tags.includes('') ? 'shared' : 'untagged';
		// 设计稿的 evidence source 是 design/<logical_id>，不是 .pix 文件路径；按设计目录的标签汇总。
		if (sourcePath.startsWith('design/')) {
			const entries = Object.entries(tagRegistry || {}).filter(([key]) => key.startsWith('design/'));
			if (entries.some(([, entry]) => (entry.tags || []).includes(moduleId))) return 'module';
			if (entries.some(([, entry]) => (entry.tags || []).includes(''))) return 'shared';
			if (entries.length) return 'untagged';
		}
		return 'untagged';
	};
	/**
	 * One resolver for material rows, evidence filtering and configuration suggestions.
	 * A row is a source file with identity, content version, usage and selection state.
	 */
	const resolveMaterials = async (projectId, requestedModule) => {
		const info = await findProject(config, projectId);
		if (!info) throw new Error(`项目不存在：${projectId}`);
		const moduleId = requestedModule ? resolveModule(info, requestedModule) : currentModule();
		const evidence = await loadEvidenceAll(config, projectId, root).catch(() => ({ items: [], stats: { sources: [] } }));
		const tagRegistry = await syncProjectAssetTags(info).catch(() => null);
		const scopeDoc = await withModule(moduleId, () => loadArtifact(root, projectId, 'source-scope'));
		const explicitSelection = scopeDoc.mode === 'selected';
		const scopeItems = new Map((scopeDoc.items || []).map((item) => [item.path, item]));
		const selectionDoc = await withModule(moduleId, () => loadArtifact(root, projectId, 'material-selection'));
		const selectionPaths = new Set((selectionDoc.items || []).map((item) => item.path));
		const designDoc = await withModule(moduleId, () => loadArtifact(root, projectId, 'design-sources'));
		const designSources = new Map((designDoc.items || []).map((item) => [`design/${item.source_id}`, item]));
		const activeDesigns = new Map(layerSources(root, projectId).filter((source) => source.store)
			.map((source) => [`design/${source.id}`, source.revision]));
		let statsSources = evidence?.stats?.sources || [];
		let evidenceItems = evidence.items;
		const pinned = new Map(designDoc.items.map((source) => [source.source_id, source.version]));
		const available = new Map(layerSources(root, projectId, false, pinned).map((source) => [`design/${source.id}`, source.revision]));
		for (const [sourcePath, binding] of designSources) {
			if (!binding.version || binding.version === activeDesigns.get(sourcePath) || available.get(sourcePath) !== binding.version) continue;
			const historical = await loadDesignEvidence(config, projectId, root, sourcePath, binding.version).catch(() => null);
			if (!historical) continue;
			statsSources = [...statsSources.filter((entry) => entry.path !== sourcePath), historical.source];
			evidenceItems = [...evidenceItems.filter((item) => item.source !== sourcePath), ...historical.items];
		}
		const legacySources = statsSources.length === 0;
		if (legacySources) {
			const bySource = new Map();
			for (const item of evidence?.items || []) {
				const entry = bySource.get(item.source) || { path: item.source, kind: '', items: 0, version: item.source_version || '' };
				entry.items += 1;
				bySource.set(item.source, entry);
			}
			statsSources = [...bySource.values()];
		}
		const rows = [];
		const selectedPaths = new Set();
		for (const source of statsSources) {
			const path = source.path;
			const scopeItem = scopeItems.get(path);
			const designBinding = designSources.get(path) || null;
			const tagScope = designBinding ? 'module' : (legacySources ? 'shared' : tagScopeFor(tagRegistry, path, moduleId));
			const tagged = Boolean(designBinding) || tagScope === 'module' || tagScope === 'shared';
			const scopeAllows = !explicitSelection || scopeItems.has(path);
			const selected = tagged && scopeAllows;
			const usage = scopeItem?.role || (designBinding ? 'design' : DEFAULT_USAGE(path, source.kind));
			const error = source.error || '';
			const items = Number(source.items || 0);
			const designVersionChanged = Boolean(designBinding?.version && designBinding.version !== activeDesigns.get(path) &&
				(designBinding.version !== available.get(path) || designBinding.version !== source.design_revision));
			const designEvidenceStale = Boolean(designBinding?.version && !designVersionChanged && designBinding.version !== source.design_revision);
			let exclusion = '';
			if (error) exclusion = '解析失败：' + error;
			else if (!tagged) exclusion = '未打当前模块或历史共享标签';
			else if (explicitSelection && !scopeItems.has(path)) exclusion = '显式资料范围未选择';
			else if (designVersionChanged) exclusion = '当前模块选用的设计稿版本已变化，请核对并重新导入本轮要用的设计稿';
			else if (designEvidenceStale) exclusion = '设计稿证据版本未同步，请重新解析本轮资料';
			else if (!items) exclusion = '未解析出证据条目';
			else if (usage === 'reference') exclusion = '仅供浏览（参考用途不进入生成）';
			if (selected && !error) selectedPaths.add(path);
			let version = designBinding?.version || source.version || '';
			if (!version && items) {
				const first = (evidence.items || []).find((item) => item.source === path);
				version = first?.source_version || '';
			}
			rows.push({
				id: source.source_id || path, source_id: source.source_id || path, path,
				name: path.split('/').pop() || path, kind: source.kind || '', items, bytes: source.bytes || 0,
				content_version: version, version, usage, role: usage, tag_scope: tagScope,
				selected, used: selected && usage !== 'reference' && !error && !designVersionChanged && !designEvidenceStale,
				...(designVersionChanged ? { design_issue: 'DESIGN_REVISION_CHANGED' } : designEvidenceStale ? { design_issue: 'DESIGN_EVIDENCE_STALE' } : {}),
				explicit: explicitSelection, in_selection: selectionPaths.has(path),
				exclusion, error
			});
		}
		const usedPaths = new Set(rows.filter((row) => row.used).map((row) => row.path));
		const scopedItems = evidenceItems.filter((item) => usedPaths.has(item.source));
		const scopedSources = statsSources.filter((source) => usedPaths.has(source.path));
		const filtered = { ...evidence, items: scopedItems, stats: { ...evidence.stats, sources: scopedSources,
			parsed: scopedSources.length, items: scopedItems.length, chars: scopedItems.reduce((sum, item) => sum + item.chars, 0) } };
		return { project: info, project_id: info.id, project_name: info.name, module_id: moduleId,
			explicit_selection: explicitSelection, scope_version: scopeDoc.version || 0,
			rows, evidence: filtered, selection: selectionDoc.items || [],
			counts: { total: rows.length, selected: rows.filter((row) => row.selected).length,
				used: rows.filter((row) => row.used).length,
				reference: rows.filter((row) => row.selected && row.usage === 'reference').length,
				excluded: rows.filter((row) => row.selected && row.exclusion).length } };
	};
	const scopedEvidence = async (projectId) => {
		const resolved = await resolveMaterials(projectId, currentModule());
		return resolved.evidence;
	};
	const moduleDesignRevisions = async (projectId) => {
		const { rows } = await resolveMaterials(projectId, currentModule());
		const scoped = new Map(rows.filter((row) => row.used && row.kind === 'pixso-mcp')
			.map((row) => [row.path.slice('design/'.length), row.content_version]));
		return new Map(layerSources(root, projectId, false, scoped).filter((source) => !source.store || scoped.get(source.id) === source.revision)
			.map((source) => [source.id, source.revision]));
	};
	const moduleCaseVisuals = async (info, projectId, bindings) => {
		const allowed = await moduleDesignRevisions(projectId);
		return caseVisuals(root, projectId, info.dir, bindings, allowed);
	};
	const moduleLayerSources = async ({ project, module }) => {
		if (!module) return layerSources(root, project);
		const { items } = await loadArtifact(root, project, 'design-sources');
		return layerSources(root, project, false, new Map(items.map((entry) => [entry.source_id, entry.version])));
	};
	const sourceKindRole = (row) => {
		if (row.path.startsWith('prd/')) return 'prd';
		if (row.path.startsWith('signals/') || isSignalMatrixFile(row.path) || row.usage === 'interface') return 'dbc';
		if (row.path.startsWith('design/') || row.usage === 'design') return 'design';
		return row.usage === 'reference' ? 'reference' : 'aux';
	};
	const suggestModuleQuality = async (projectId, moduleId) => {
		const resolved = await resolveMaterials(projectId, moduleId);
		const info = resolved.project;
		const used = resolved.rows.filter((row) => row.used);
		const byRole = (role) => used.filter((row) => sourceKindRole(row) === role);
		const prds = byRole('prd');
		const dbcs = byRole('dbc');
		const designs = byRole('design');
		const current = info.quality || {};
		const currentSources = { ...(current.sources || {}) };
		const candidates = { prd: prds.map((row) => ({ path: row.path, version: row.content_version, usage: row.usage, items: row.items })),
			dbc: dbcs.map((row) => ({ path: row.path, version: row.content_version, usage: row.usage, items: row.items })),
			design: designs.map((row) => ({ path: row.path, version: row.content_version, usage: row.usage, items: row.items })) };
		const invalidOverrides = [];
		const choose = (rows, currentPath, key) => {
			if (currentPath && rows.some((row) => row.path === currentPath)) return currentPath;
			if (currentPath) invalidOverrides.push({ key, path: currentPath, reason: '手工覆盖的来源已不在本模块有效范围或已失效' });
			return rows.length === 1 ? rows[0].path : '';
		};
		const prd = choose(prds, currentSources.prd, 'prd');
		const dbc = choose(dbcs, currentSources.dbc, 'dbc');
		const design = choose(designs, currentSources.design, 'design');
		const missing = [];
		if (!prds.length) missing.push({ code: 'PRD_SOURCE_MISSING', message: '本模块没有有效的产品需求资料', candidates: [] });
		else if (prds.length > 1 && !prd) missing.push({ code: 'PRD_SOURCE_AMBIGUOUS', message: '本模块有多份有效需求资料，请指定主来源', candidates: candidates.prd });
		if (!prd) delete currentSources.prd; else currentSources.prd = prd;
		if (dbcs.length > 1 && !dbc) missing.push({ code: 'DBC_SOURCE_AMBIGUOUS', message: '本模块有多份有效信号资料，请指定主来源', candidates: candidates.dbc });
		if (dbcs.length === 1) currentSources.dbc = dbc; else if (!dbc) delete currentSources.dbc;
		if (designs.length === 1) currentSources.design = design; else if (!design) delete currentSources.design;
		let base = {};
		let sibling = '';
		if (prd) {
			const prdFile = path.join(info.dir, prd);
			const prdHash = await fileHash(prdFile).catch(() => '');
			for (const item of await listProjects(config)) {
				if (item.id === info.id || !item.quality?.surfaces?.length || !item.quality.sources?.prd) continue;
				const otherPrd = path.join(item.dir, item.quality.sources.prd);
				const otherHash = await fileHash(otherPrd).catch(() => '');
				// 同名不算同源；只有内容摘要一致才继承术语与界面配置。
				if (prdHash && prdHash === otherHash) { base = item.quality; sibling = item.id; break; }
			}
		}
		const capabilities = new Set(current.capabilities?.length ? current.capabilities : (base.capabilities?.length ? base.capabilities : ['text']));
		capabilities.add('text');
		if (dbc) capabilities.add('protocol'); else capabilities.delete('protocol');
		if (design) capabilities.add('design'); else capabilities.delete('design');
		let inferredPrefixes = [];
		let inferredDut = '';
		if (dbc && ((!current.signal_prefixes?.length && !base.signal_prefixes?.length) || (!current.dut_node && !base.dut_node))) {
			try {
				const parsed = parseDbc(path.join(info.dir, dbc));
				const msgs = [...(parsed.messages?.values() || [])];
				if (!current.signal_prefixes?.length && !base.signal_prefixes?.length) {
					const prefixCounts = new Map();
					for (const msg of msgs) {
						for (const sig of msg.signals || []) {
							const hit = /^([A-Za-z][A-Za-z0-9]{1,8}_)/.exec(String(sig.name || ''));
							if (hit) prefixCounts.set(hit[1], (prefixCounts.get(hit[1]) || 0) + 1);
						}
					}
					inferredPrefixes = [...prefixCounts.entries()]
						.filter(([, count]) => count >= 2)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 20)
						.map(([prefix]) => prefix);
				}
				if (!current.dut_node && !base.dut_node && msgs.length > 0) {
					const transmitters = [...new Set(msgs.map((msg) => String(msg.transmitter || '').trim()).filter(Boolean))];
					const nameTokens = path.basename(dbc, path.extname(dbc)).split(/[^A-Za-z0-9]+/).filter(Boolean);
					const exactTokenHits = transmitters.filter((tx) => nameTokens.includes(tx));
					const ciTokenHits = exactTokenHits.length
						? exactTokenHits
						: transmitters.filter((tx) => nameTokens.some((tok) => tok.toLowerCase() === tx.toLowerCase()));
					if (ciTokenHits.length === 1) {
						inferredDut = ciTokenHits[0];
					} else {
						const rxCounts = new Map();
						for (const msg of msgs) {
							for (const rx of new Set(msg.receivers || [])) {
								rxCounts.set(rx, (rxCounts.get(rx) || 0) + 1);
							}
						}
						const hubHits = transmitters.filter((tx) => (rxCounts.get(tx) || 0) >= msgs.length * 0.5);
						if (hubHits.length === 1) inferredDut = hubHits[0];
					}
				}
			} catch { /* Non-fatal if signal file is incomplete during early autoconfig. */ }
		}
		const isCustomSurfaces = (list) => Boolean(list?.length && !(list.length === 1 && list[0] === '页面'));
		const hasCustomSurfaces = isCustomSurfaces(current.surfaces);
		const hasBaseSurfaces = isCustomSurfaces(base.surfaces);
		let surfaces = hasCustomSurfaces ? [...current.surfaces] : (hasBaseSurfaces ? [...base.surfaces] : ['页面']);
		if (design && !hasCustomSurfaces && !hasBaseSurfaces) {
			try {
				const dState = designState(info.dir, info.id, root);
				const pageNames = [];
				for (const src of dState.sources || []) {
					const listed = designPages(dState.store, src.logical_file_id)?.pages || [];
					for (const p of listed) {
						const pageName = String(p?.name || '').trim();
						const count = Number(p?.board_count ?? p?.boards?.length ?? 0);
						if (!pageName || p.internal || count <= 0) continue;
						if (/^(?:cover|封面|颜色|color|颜色规范)$/i.test(pageName)) continue;
						pageNames.push(pageName);
					}
				}
				if (pageNames.length) surfaces = [...new Set(['页面', ...pageNames])];
			} catch { /* Keep default surfaces if design index is not yet compiled. */ }
		}
		const quality = {
			...base, ...current,
			capabilities: [...capabilities],
			sources: currentSources,
			surfaces: [...surfaces],
			...(inferredPrefixes.length ? { signal_prefixes: inferredPrefixes } : {}),
			...(inferredDut ? { dut_node: inferredDut } : {}),
			default_surface: current.default_surface && surfaces.includes(current.default_surface)
				? current.default_surface
				: (base.default_surface && surfaces.includes(base.default_surface) ? base.default_surface : surfaces[0])
		};
		return { info, resolved, quality, candidates, missing, invalidOverrides, sibling,
			updated: JSON.stringify(quality) !== JSON.stringify(current) };
	};

	const ASSET_BUCKETS = [
		{ dir: 'prd', kind: 'PRD' },
		{ dir: 'signals', kind: '信号矩阵' },
		{ dir: 'design', kind: 'UI 设计' },
		{ dir: 'other', kind: '其他' }
	];
	const assetFiles = async (baseDir, scope, projectId, moduleId) => {
		const items = [];
		for (const bucket of ASSET_BUCKETS) {
			const full = path.join(baseDir, bucket.dir);
			const entries = await fs.readdir(full).catch(() => []);
			for (const entry of entries) {
				if (entry.startsWith('.')) continue;
				const file = path.join(full, entry);
				const stat = await fs.stat(file).catch(() => null);
				if (!stat || !stat.isFile()) continue;
				items.push({
					id: `${scope}:${projectId || 'global'}:${moduleId || ''}:${bucket.dir}/${entry}`,
					scope, project_id: projectId || '', module_id: moduleId || '',
					name: entry, path: `${bucket.dir}/${entry}`, kind: bucket.kind, dir: bucket.dir,
					bytes: stat.size, modified: stat.mtime.toISOString(), editable: scope === 'global' ? true : true
				});
			}
		}
		return items;
	};
	const globalAssets = async () => {
		const files = await assetFiles(path.join(root, 'assets', 'global'), 'global', '', '');
		const skills = listSkills(root).map((item) => ({
			id: `global:skill:${item.name}`, scope: 'global', project_id: '', module_id: '',
			name: item.name, path: `skills/${item.name}.md`, kind: 'Skill', dir: 'skills',
			bytes: Buffer.byteLength(item.content || '', 'utf8'), modified: item.updatedAt || null,
			editable: true, virtual: true
		}));
		return [...files, ...skills];
	};
	const projectAssets = async (info) => assetFiles(info.dir, 'project', info.id, '');
	const moduleAssets = async (info, moduleId) => assetFiles(path.join(info.dir, 'modules', moduleId, 'assets'), 'module', info.id, moduleId);
	const inferKind = (relative) => {
		const dir = String(relative).split('/')[0];
		return ({ prd: 'PRD', signals: '信号矩阵', design: 'UI 设计', other: '其他' })[dir] || '其他';
	};
	const assetBase = (scope, info, moduleId) => scope === 'global'
		? path.join(root, 'assets', 'global')
		: scope === 'module' ? path.join(info.dir, 'modules', moduleId, 'assets') : info.dir;
	const assetTrashRoot = (scope, info, moduleId) => scope === 'global'
		? path.join(root, '.trash', 'assets')
		: scope === 'module' ? path.join(info.dir, 'modules', moduleId, '.trash', 'assets') : path.join(info.dir, '.trash', 'assets');
	const walkAssetFiles = async (base, prefix = '') => {
		const found = [];
		const entries = await fs.readdir(path.join(base, prefix), { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const relative = prefix ? path.join(prefix, entry.name) : entry.name;
			if (entry.isDirectory()) found.push(...await walkAssetFiles(base, relative));
			else found.push(relative);
		}
		return found;
	};

	const assetTagsFile = path.join(root, 'assets', 'tags.json');
	const readAssetTags = async () => {
		try { return JSON.parse(await fs.readFile(assetTagsFile, 'utf8')); }
		catch { return { projects: {} }; }
	};
	const writeAssetTags = async (doc) => {
		await fs.mkdir(path.dirname(assetTagsFile), { recursive: true });
		await fs.writeFile(assetTagsFile, JSON.stringify(doc, null, 1), 'utf8');
		return doc;
	};
	const syncProjectAssetTags = async (info) => {
		const doc = await readAssetTags();
		doc.projects ||= {};
		const current = doc.projects[info.id] || {};
		let changed = false;
		for (const item of await projectAssets(info)) {
			if (!current[item.path]) {
				// 迁移旧资产：历史项目资料默认项目共享，保持原有可用性。
				current[item.path] = { name: item.name, kind: item.kind, tags: [''] };
				changed = true;
			}
		}
		if (changed) { doc.projects[info.id] = current; await writeAssetTags(doc); }
		return current;
	};
	const projectTagList = async (info, moduleId) => {
		const tags = await syncProjectAssetTags(info);
		return (await projectAssets(info)).map((item) => ({
			...item, scope: 'project', tags: tags[item.path]?.tags || [],
			visible: (tags[item.path]?.tags || []).includes('') || (moduleId ? (tags[item.path]?.tags || []).includes(moduleId) : false)
		}));
	};
	const registerProjectAsset = async (info, relative, tags = []) => {
		const doc = await readAssetTags();
		doc.projects ||= {};
		doc.projects[info.id] ||= {};
		doc.projects[info.id][relative] = { name: path.basename(relative), kind: inferKind(relative), tags };
		await writeAssetTags(doc);
	};
	const updateProjectAssetTag = async (info, relative, moduleId, action) => {
		const doc = await readAssetTags();
		doc.projects ||= {};
		const project = doc.projects[info.id] || {};
		const entry = project[relative] || { name: path.basename(relative), kind: inferKind(relative), tags: [''] };
		const tags = new Set(entry.tags || []);
		if (moduleId) {
			if (action === 'remove') tags.delete(moduleId); else tags.add(moduleId);
		}
		entry.tags = [...tags];
		project[relative] = entry;
		doc.projects[info.id] = project;
		await writeAssetTags(doc);
		return entry;
	};

	const inboxAssets = async () => (await assetFiles(path.join(root, 'assets', 'inbox'), 'inbox', '', '')).map((item) => ({ ...item, storage: 'inbox', project_id: '', project_name: '', tags: [] }));
	const fileHash = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
	const poolAssetList = async () => {
		const raw = [];
		for (const item of await inboxAssets()) raw.push({ ...item, abs: path.join(root, 'assets', 'inbox', item.path) });
		for (const source of layerSources(root, POOL_DESIGN_KEY)) {
			if (!source.store) continue;
			raw.push({
				id: `mcp:pool:${source.id}`,
				name: source.name || source.id,
				path: `design/${source.id}`,
				kind: 'UI 设计',
				dir: 'design',
				bytes: 0,
				modified: null,
				storage: 'mcp-pool',
				project_id: '',
				project_name: '',
				hash: source.revision,
				mcp: true,
				tags: []
			});
		}
		const projects = [];
		const global = await globalAssets();
		for (const item of await listProjects(config)) {
			const tags = await syncProjectAssetTags(item).catch(() => null);
			const files = await projectAssets(item);
			projects.push({ id: item.id, name: item.name, readonly: item.readonly, count: files.length, modules: item.modules || [] });
			const moduleNames = new Map((item.modules || []).map((module) => [module.id, module.name]));
			for (const asset of files) {
				raw.push({ ...asset, storage: 'project', project_id: item.id, project_name: item.name,
					abs: path.join(item.dir, asset.path),
					tags: (tags?.[asset.path]?.tags || []).map((moduleId) => ({ project_id: item.id, module_id: moduleId,
						module_name: moduleId ? (moduleNames.get(moduleId) || moduleId) : '' })) });
			}
			const mcpList = layerSources(root, item.id).filter((source) => source.store);
			if (mcpList.length) {
				const moduleDesignDocs = await Promise.all((item.modules || []).map(async (module) => ({
					module,
					items: (await withModule(module.id, () => loadArtifact(root, item.id, 'design-sources'))).items || []
				})));
				for (const source of mcpList) {
					const mcpTags = [];
					for (const { module, items } of moduleDesignDocs) {
						if (items.some((entry) => entry.source_id === source.id)) {
							mcpTags.push({ project_id: item.id, module_id: module.id, module_name: module.name || module.id });
						}
					}
					raw.push({
						id: `mcp:${item.id}:${source.id}`,
						name: source.name || source.id,
						path: `design/${source.id}`,
						kind: 'UI 设计',
						dir: 'design',
						bytes: 0,
						modified: null,
						storage: 'mcp-project',
						project_id: item.id,
						project_name: item.name,
						hash: source.revision,
						mcp: true,
						tags: mcpTags
					});
				}
			}
		}
		const groups = new Map();
		for (const item of raw) {
			let hash = item.hash || '';
			if (!hash) {
				try { hash = await fileHash(item.abs); }
				catch { hash = `${item.storage}:${item.abs}`; }
			}
			const key = hash;
			let group = groups.get(key);
			if (!group) {
				group = { id: `asset-${hash.slice(0, 18)}`, hash, name: item.name, kind: item.kind, bytes: item.bytes,
					modified: item.modified, scope: 'project', mcp: Boolean(item.mcp), copies: [], tags: [], projects: [] };
				groups.set(key, group);
			}
			if (item.mcp) group.mcp = true;
			group.copies.push({ storage: item.storage, project_id: item.project_id || '', project_name: item.project_name || '',
				path: item.path, tags: item.tags || [], bytes: item.bytes, kind: item.kind, modified: item.modified, mcp: Boolean(item.mcp) });
			if (item.project_id && !group.projects.some((project) => project.id === item.project_id)) {
				group.projects.push({ id: item.project_id, name: item.project_name || item.project_id });
			}
			if (item.modified && (!group.modified || String(item.modified) > String(group.modified))) group.modified = item.modified;
			for (const tag of item.tags || []) {
				if (!group.tags.some((existing) => existing.project_id === tag.project_id && existing.module_id === tag.module_id)) {
					group.tags.push(tag);
				}
			}
		}
		return { assets: [...groups.values()], projects, global };
	};

	const projectCopyByHash = async (info, hash) => {
		if (!hash) return null;
		for (const item of await projectAssets(info)) {
			const file = path.join(info.dir, item.path);
			const found = await fileHash(file).catch(() => '');
			if (found === hash) return item;
		}
		return null;
	};
	const recordMaterialSelection = async (info, moduleId, entry) => {
		const doc = await withModule(moduleId, () => loadArtifact(root, info.id, 'material-selection'));
		const items = [...(doc.items || [])];
		const index = items.findIndex((item) => item.path === entry.path);
		const next = { ...entry, selected_at: new Date().toISOString() };
		if (index >= 0) items[index] = next; else items.push(next);
		return withModule(moduleId, () => saveArtifact(root, info.id, 'material-selection', { ...doc, items, meta: { ...(doc.meta || {}), updated_at: new Date().toISOString() } }));
	};
	const poolImport = async (body) => {
		if (!body.project || !body.module) throw new Error('导入资产必须指定项目和模块');
		const info = await findProject(config, body.project);
		if (!info) throw new Error(`项目不存在：${body.project}`);
		if (info.readonly) throw new Error('只读项目不能导入资产');
		const moduleId = resolveModule(info, body.module);
		if (!(info.modules || []).some((item) => item.id === moduleId)) throw new Error('模块不存在');
		const sourceStorage = String(body.storage || 'inbox');
		const relative = String(body.path || '');
		if (!relative || relative.includes('..')) throw new Error('非法资产路径');
		if (sourceStorage === 'mcp-pool' || sourceStorage === 'mcp-project') {
			const sourceId = relative.replace(/^design\//, '');
			const fromProjectId = sourceStorage === 'mcp-pool' ? POOL_DESIGN_KEY : String(body.source_project || body.project);
			const sourceInfo = fromProjectId === POOL_DESIGN_KEY ? null : await findProject(config, fromProjectId);
			if (fromProjectId !== POOL_DESIGN_KEY && !sourceInfo) throw new Error('源项目不存在');
			const fromDir = fromProjectId === POOL_DESIGN_KEY ? poolDesignDir() : sourceInfo.dir;
			const sourceEntry = layerSources(root, fromProjectId).find((s) => s.store && s.id === sourceId);
			if (!sourceEntry) throw new Error('资产池中找不到该 MCP 设计稿');
			const expected = String(body.asset_hash || body.expected_hash || '');
			if (expected && expected !== sourceEntry.revision) throw new Error('资产内容版本已变化，请刷新预览后重新导入');
			const hadInTarget = layerSources(root, info.id).some((s) => s.store && s.id === sourceId && s.revision === sourceEntry.revision);
			if (fromProjectId !== info.id) {
				copyMcpDesign(root, fromProjectId, info.id, sourceEntry.id, sourceEntry.revision, fromDir, info.dir);
			}
			setDesignRemoved(root, info.id, { id: sourceEntry.id }, false);
			const importedSource = layerSources(root, info.id).find((s) => s.store && s.id === sourceEntry.id);
			if (!importedSource) throw new Error('MCP 设计稿索引未发布');
			await buildEvidence(config, info, root, { designSource: importedSource.id });
			await rememberDesignSource(info, info.id, moduleId, importedSource);
			const selection = await recordMaterialSelection(info, moduleId, {
				path: `design/${importedSource.id}`, asset_hash: importedSource.revision, content_version: importedSource.revision,
				usage: 'design', source_project: fromProjectId === POOL_DESIGN_KEY ? '' : fromProjectId,
				source_path: `design/${importedSource.id}`, selected_by: String(body.selected_by || 'user')
			});
			return {
				project: info.id, path: `design/${importedSource.id}`, module: moduleId,
				reused: hadInTarget || fromProjectId === info.id,
				hash: importedSource.revision, content_version: importedSource.revision,
				selection_version: selection.version, usage: 'design'
			};
		}
		let sourceFile;
		let sourceProjectId = '';
		if (sourceStorage === 'inbox') {
			sourceFile = path.join(root, 'assets', 'inbox', relative);
		} else {
			sourceProjectId = String(body.source_project || body.project);
			const sourceInfo = await findProject(config, sourceProjectId);
			if (!sourceInfo) throw new Error('源项目不存在');
			sourceFile = path.join(sourceInfo.dir, relative);
		}
		if (!fsSync.existsSync(sourceFile)) throw new Error('资产池中找不到该资产');
		const hash = await fileHash(sourceFile);
		const expected = String(body.asset_hash || body.expected_hash || '');
		if (expected && expected !== hash) throw new Error('资产内容版本已变化，请刷新预览后重新导入');
		if (body.expected_version && String(body.expected_version) !== hash.slice(0, 18) && String(body.expected_version) !== hash) {
			throw new Error('资产内容版本已变化，请刷新预览后重新导入');
		}
		let projectPath = relative;
		let target = null;
		let created = false;
		if (sourceProjectId === info.id && sourceStorage === 'project') {
			target = (await projectAssets(info)).find((item) => item.path === relative);
			if (!target) throw new Error('项目资产不存在');
			projectPath = target.path;
		} else {
			target = await projectCopyByHash(info, hash);
			if (target) {
				projectPath = target.path;
			} else {
				const bucket = ['prd', 'signals', 'design', 'other'].includes(relative.split('/')[0]) ? relative.split('/')[0] : inferBucket(relative);
				const name = path.basename(relative);
				const dir = path.join(info.dir, bucket);
				await fs.mkdir(dir, { recursive: true });
				let dest = path.join(dir, name);
				if (fsSync.existsSync(dest)) dest = path.join(dir, `${hash.slice(0, 6)}-${name}`);
				await fs.copyFile(sourceFile, dest);
				projectPath = path.join(bucket, path.basename(dest));
				target = { path: projectPath };
				created = true;
				await registerProjectAsset(info, projectPath, []);
			}
		}
		try {
			await updateProjectAssetTag(info, projectPath, moduleId, 'add');
			const usage = ['requirement', 'interface', 'design', 'reference'].includes(body.usage) ? body.usage
				: (['requirement', 'interface', 'design', 'reference'].includes(body.purpose) ? body.purpose : DEFAULT_USAGE(projectPath));
			const scope = await withModule(moduleId, () => loadArtifact(root, info.id, 'source-scope'));
			const previousScope = scope.items.find((entry) => entry.path === projectPath);
			if (scope.mode === 'selected' || previousScope || usage !== DEFAULT_USAGE(projectPath)) {
				if (previousScope?.role !== usage) await withModule(moduleId, () => saveArtifact(root, info.id, 'source-scope', {
					...scope, meta: { ...(scope.meta || {}), mode: scope.mode === 'selected' ? 'selected' : 'all' },
					items: [...scope.items.filter((entry) => entry.path !== projectPath), { ...previousScope, path: projectPath, role: usage }]
				}));
			}
			const selection = await recordMaterialSelection(info, moduleId, {
				path: projectPath, asset_hash: hash, content_version: hash.slice(0, 18),
				usage, source_project: sourceProjectId || '', source_path: relative, selected_by: String(body.selected_by || 'user')
			});
			return { project: info.id, path: projectPath, module: moduleId, reused: Boolean(target) && !created,
				hash, content_version: hash.slice(0, 18), selection_version: selection.version, usage };
		} catch (error) {
			if (created) {
				await fs.rm(path.join(info.dir, projectPath), { force: true }).catch(() => {});
				const doc = await readAssetTags();
				if (doc.projects?.[info.id]) { delete doc.projects[info.id][projectPath]; await writeAssetTags(doc); }
			}
			throw error;
		}
	};

	const resolveAssetRef = async (projectId, ref) => {
		const storage = String(ref?.storage || 'project');
		const relative = String(ref?.path || '');
		if (!relative || relative.includes('..')) throw new Error('非法资产路径');
		if (storage === 'inbox') return { storage, project_id: '', path: relative, file: path.join(root, 'assets', 'inbox', relative) };
		const info = await findProject(config, String(ref?.project_id || projectId));
		if (!info) throw new Error('项目不存在');
		return { storage, project_id: info.id, project_name: info.name, path: relative, file: path.join(info.dir, relative) };
	};
	const assetImpact = async (projectId, relative) => {
		const info = await findProject(config, projectId);
		const modules = [];
		for (const item of info?.modules || []) {
			const doc = await withModule(item.id, () => loadArtifact(root, projectId, 'source-scope'));
			const explicit = doc.mode === 'selected';
			modules.push({ id: item.id, name: item.name, visible: explicit ? doc.items.some((entry) => entry.path === relative) : true });
		}
		const evidence = await loadEvidenceAll(config, projectId, root).catch(() => ({ items: [] }));
		return { modules, evidence: evidence.items.filter((item) => item.source === relative).length };
	};
	const batchImportPlan = async (body) => {
		if (!body.project || !body.module) throw new Error('批量导入必须指定项目和模块');
		const info = await findProject(config, body.project);
		if (!info) throw new Error(`项目不存在：${body.project}`);
		const moduleId = resolveModule(info, body.module);
		const items = Array.isArray(body.items) ? body.items : [];
		const plans = [];
		for (const item of items) {
			const id = String(item.id || `${item.storage || 'inbox'}:${item.path || ''}`);
			const relative = String(item.path || '');
			const sourceStorage = String(item.storage || 'inbox');
			const sourceProject = String(item.source_project || body.project || '');
			try {
				if (!relative || relative.includes('..')) throw new Error('非法资产路径');
				if (sourceStorage === 'mcp-pool' || sourceStorage === 'mcp-project') {
					const sourceId = relative.replace(/^design\//, '');
					const fromProjectId = sourceStorage === 'mcp-pool' ? POOL_DESIGN_KEY : sourceProject;
					const sourceEntry = layerSources(root, fromProjectId).find((s) => s.store && s.id === sourceId);
					if (!sourceEntry) throw new Error('源 MCP 设计稿不存在');
					if (item.asset_hash && item.asset_hash !== sourceEntry.revision) throw new Error('内容版本已变化');
					const hasInTarget = layerSources(root, info.id).some((s) => s.store && s.id === sourceId && s.revision === sourceEntry.revision);
					const action = hasInTarget ? 'reuse' : 'copy';
					plans.push({
						id, path: `design/${sourceId}`, storage: sourceStorage,
						source_project: fromProjectId === POOL_DESIGN_KEY ? '' : fromProjectId, source_path: `design/${sourceId}`,
						hash: sourceEntry.revision, action,
						reason: action === 'reuse' ? '当前项目已有同版本 MCP 设计稿' : '从资产池分配 MCP 设计稿到当前模块'
					});
					continue;
				}
				const sourceInfo = sourceStorage === 'inbox' ? null : await findProject(config, sourceProject);
				const sourceFile = sourceStorage === 'inbox' ? path.join(root, 'assets', 'inbox', relative) : path.join(sourceInfo?.dir || '', relative);
				if (!fsSync.existsSync(sourceFile)) throw new Error('源资产不存在');
				const hash = await fileHash(sourceFile);
				if (item.asset_hash && item.asset_hash !== hash) throw new Error('内容版本已变化');
				const existingByHash = await projectCopyByHash(info, hash);
				const sameName = (await projectAssets(info)).find((asset) => asset.name === path.basename(relative));
				const action = existingByHash ? 'reuse' : sameName ? 'rename' : 'copy';
				plans.push({ id, path: existingByHash?.path || sameName?.path || '', storage: sourceStorage,
					source_project: sourceProject, source_path: relative, hash, action,
					reason: action === 'reuse' ? '当前项目已有同哈希副本' : action === 'rename' ? '同名不同内容，将改名复制' : '复制到当前项目' });
			} catch (error) {
				plans.push({ id, path: relative, storage: sourceStorage, source_project: sourceProject, source_path: relative,
					action: 'error', reason: error.message });
			}
		}
		return { info, moduleId, plans };
	};
	const modelContracts = async (projectId, facts, features, evidence) => {
		const doc = await loadArtifact(root, projectId, 'contracts');
		if (!doc.items.length) return [];
		const active = evidence ?? await scopedEvidence(projectId).catch(() => null);
		const conflicts = (await loadArtifact(root, projectId, 'conflicts')).items;
				const featureIds = new Set(features.map((item) => item.feature_id));
		const transitions = new Map(loadStates(root, projectId).items.flatMap((machine) =>
			(machine.transitions || []).map((entry) => [entry.transition_id, machine.feature_id])));
		return doc.items.map((item) => item.status === 'approved' &&
			(!featureIds.has(item.feature_id) || conflicts.some((issue) => issue.contract_id === item.contract_id && (issue.status === 'open' || issue.resolved_at > item.approved_at)) || (item.transition_ref && transitions.get(item.transition_ref) !== item.feature_id)
				|| !item.basis || item.basis !== contractBasis(item, facts, active?.items || []))
			? { ...item, status: 'stale' } : item);
	};

	const loadModel = async (projectId, downstream = {}) => {
		const [facts, features] = await Promise.all([
			loadArtifact(root, projectId, 'facts'),
			loadArtifact(root, projectId, 'features')
		]);
		const contracts = await modelContracts(projectId, facts.items, features.items);
		return buildEcsm(root, projectId, { facts, features, states: loadStates(root, projectId), bindings: loadBindings(root, projectId), ...downstream, contracts });
	};

	const requireFrozenModel = async (projectId) => {
		const frozen = frozenModel(root, projectId);
		if (!frozen?.inputs) throw new Error('请先在 ECSM 确认并冻结产品模型');
		if ((await loadModel(projectId)).digest !== frozen.digest) throw new Error('产品模型有修改，请重新确认并冻结');
		return frozen;
	};

	const changedStateSources = (model, states) => Object.entries({ facts: '事实', features: '功能点', bindings: '绑定' })
		.filter(([kind]) => {
			const source = states[`source_${kind}_digest`];
			return source && source !== digestOf(model.inputs[kind].items);
		}).map(([, label]) => label);

	const summarizeOutline = (outline, stale = false) => outline ? {
		status: outline.status, modelDigest: outline.source_ecsm_digest,
		sourceKind: outline.source_kind, stale,
		generatable: outline.items.filter(generatableScenario).length,
		rebuild: Boolean(outline.pending?.length || outline.empty?.length)
	} : null;

	const caseGaps = (projectId, item, revisions) => missingInterfaceFigures(item, (item.image_refs || []).filter((figure) => {
		const image = caseFigurePath(root, projectId, figure);
		return image && fsSync.existsSync(image) &&
			(!revisions || !figure.source_id || !figure.revision || revisions.get(figure.source_id) === figure.revision);
	}));

	// 真实 UI 配图与信号/需求卡片分开统计，不把卡片算成界面覆盖。
	const UI_FIGURE_ROLES = new Set(['页面定位', '操作定位', '控件局部', '预期界面参考', '界面参考', '恢复入口']);

	// Manual approvals can follow independent review without changing the content it saw.
	const casesContentBaseline = (cases) => digestOf(cases.items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => !REVIEW_FIELDS.includes(key)))));
	const reviewBasis = (review, cases) => review.cases_digest_kind === 'content' ? casesContentBaseline(cases) : digestOf(cases.items);

	const deliveryState = async (projectId, { points, cases, review }, model) => {
		const gaps = {};
		const covered = new Set(cases.items.map((item) => item.point_id));
		const revisions = await moduleDesignRevisions(projectId);
		for (const item of cases.items) {
			const missing = caseGaps(projectId, item, revisions);
			if (missing.length) gaps[item.case_id] = missing;
		}
		const runs = listRuns(root, projectId);
		const latestRun = runs.at(-1) || null;
		// 最近几次运行里仍未被覆盖的失败点与门禁退回点都保留：一次成功的局部分支重试不应抹掉其它缺口。
		const failureByPoint = new Map();
		const droppedByPoint = new Map();
		for (const run of [...runs].reverse().slice(0, 5)) {
			const detail = loadRun(root, projectId, run.run_id) || null;
			for (const drop of detail?.dropped_details || []) {
				const pointId = drop?.point_id;
				if (!pointId || covered.has(pointId) || droppedByPoint.has(pointId)) continue;
				droppedByPoint.set(pointId, {
					point_id: pointId,
					reason: String(drop.reason || ''),
					assertion_refs: Array.isArray(drop.assertion_refs) ? drop.assertion_refs : [],
					messages: Array.isArray(drop.messages) ? drop.messages : [],
					run_id: run.run_id
				});
			}
			for (const batch of detail?.batches || []) {
				for (const failure of batch.failed_points || []) {
					const pointId = failure?.point_id;
					if (!pointId || covered.has(pointId) || failureByPoint.has(pointId)) continue;
					failureByPoint.set(pointId, { point_id: pointId, batch: batch.index ?? null,
						error: String(failure.error || ''), run_id: run.run_id });
				}
			}
		}
		const failedPoints = [...failureByPoint.values()];
		const droppedPoints = [...droppedByPoint.values()];
		const pendingPointIds = (latestRun?.pending_ids || []).filter((pointId) => !covered.has(pointId));
		return {
			gaps,
			failedPoints,
			droppedPoints,
			pendingPointIds,
			withAuxiliaryImages: cases.items.filter((item) => (item.image_refs || []).some((figure) =>
				(!figure.revision || revisions.get(figure.source_id) === figure.revision) &&
				fsSync.existsSync(caseFigurePath(root, projectId, figure)))).length,
			withUiImages: cases.items.filter((item) => (item.image_refs || []).some((figure) => UI_FIGURE_ROLES.has(figure.role) &&
				(!figure.revision || revisions.get(figure.source_id) === figure.revision) &&
				fsSync.existsSync(caseFigurePath(root, projectId, figure)))).length,
			staleImages: Object.fromEntries(cases.items.flatMap((item) => {
				const stale = (item.image_refs || []).filter((figure) => figure.source_id && figure.revision && revisions.get(figure.source_id) !== figure.revision);
				return stale.length ? [[item.case_id, stale.map(({ file }) => file)]] : [];
			})),
			pointsPending: points.items.filter((item) => item.review_status !== 'approved').length,
			casesPending: cases.items.filter((item) => item.review_status !== 'approved').length,
			pointsStale: !model?.inputs || points.source_ecsm_digest !== model.digest,
			casesStale: !cases.source_points_digest || cases.source_points_digest !== digestOf(points.items) || cases.source_ecsm_digest !== model?.digest,
			reviewStale: Boolean((review.cases_digest || review.items.length) && review.cases_digest !== reviewBasis(review, cases)),
			missingCases: points.items.filter((point) => !covered.has(point.point_id)).length
		};
	};

	/** Every approval must still match the content it was granted for. */
	const approvalAudit = (projectId, { points, cases }, factIds = new Set()) => {
		const reviews = loadReviews(root, projectId);
		const pointById = new Map(points.items.map((entry) => [entry.point_id, entry]));
		const errors = lint(cases.items, new Set(points.items.map((entry) => entry.point_id)), factIds, pointById);
		const byIndex = new Map();
		for (const entry of errors) {
			const index = Number(entry.at?.match(/\[(\d+)\]/)?.[1]);
			if (!Number.isInteger(index)) continue;
			if (!byIndex.has(index)) byIndex.set(index, []);
			byIndex.get(index).push(entry);
		}
		const stale = [];
		const unexpanded = [];
		cases.items.forEach((item, index) => {
			const gate = approvalGate(item, { reviews, errors: byIndex.get(index) || [], point: pointById.get(item.point_id), points, cases });
			if (item.review_status === 'approved' && !gate.ok) stale.push({ case_id: item.case_id, reasons: gate.reasons });
			if (isPointCopy(item, pointById.get(item.point_id))) unexpanded.push(item.case_id);
		});
		return { stale, unexpanded, reviewed: reviews.items.length };
	};

	const branchOutlineStale = async (projectId, outline) => outline?.source_kind === 'branches' &&
		outline.source_branches_digest !== (await loadArtifact(root, projectId, 'branches')).digest;
	const staleBranchOutlineMessage = '大纲对应当前分支清单已过期，请重新生成大纲';
	const waitingDeferrals = (deferrals) => deferrals.filter((item) => item.status === 'pending' || item.status === 'open');
	const deliveryBlocker = ({ points, cases }, model, design, accounting, status) => {
		const outline = design.items[0];
		if (status.outlineBranchesStale) return { step: 'outline', message: staleBranchOutlineMessage };
		if (outline && (outline.status !== 'approved' || outline.source_ecsm_digest !== model.digest)) {
			return { step: 'outline', message: '请确认本轮范围并批准当前测试大纲。' };
		}
		if (outline && points.source_outline_digest !== design.digest) return { step: 'outline', message: '请从当前大纲生成测试点。' };
		if (accounting.some((row) => row.required && row.state === 'missing')) return { step: 'outline', message: '本轮还有必测场景缺少测试点，请查看覆盖缺口。' };
		const allDeferred = accounting.length > 0 && accounting.every((row) => row.state === 'deferred');
		if (status.pointsStale) return { step: 'points', message: '请按当前冻结模型生成测试点。' };
		if (status.pointsPending) return { step: 'points', message: '请先完成测试点评审。' };
		if (status.deferralsPending) return { step: 'outline', message: '请先核对本轮待确认的延期。' };
		if (allDeferred) return null;
		if (!cases.items.length || status.casesStale) return { step: 'cases', message: '请按本轮已批准的测试点生成用例。' };
		if (cases.items.some((item) => item.review_status !== 'approved')) return { step: 'cases', message: '请先完成用例评审。' };
		const missingCaseRows = accounting.filter((row) => row.required && row.state === 'case_missing');
		const incompleteCaseRows = accounting.filter((row) => row.required && row.state === 'case_incomplete');
		const needsFigures = designEvidenceApplicable();
		const gapCount = cases.items.filter((item) => status.gaps?.[item.case_id]).length;
		const blockedByCases = (!outline && status.missingCases) || missingCaseRows.length || incompleteCaseRows.length
			|| (needsFigures && gapCount > 0);
		if (blockedByCases) {
			const details = [];
			if (missingCaseRows.length) {
				const ids = missingCaseRows.map((row) => row.point_id || row.scenario_id || row.requirement).filter(Boolean);
				details.push(`缺少用例的测试点 ${missingCaseRows.length} 个${ids.length ? `（${ids.slice(0, 5).join('、')}${ids.length > 5 ? ' 等' : ''}）` : ''}`);
			}
			if (incompleteCaseRows.length) details.push(`判据不完整的用例 ${incompleteCaseRows.length} 条`);
			if (needsFigures && gapCount) details.push(`缺界面图 ${gapCount} 条`);
			const failures = (status.failedPoints || []).filter((entry) => missingCaseRows.some((row) => row.point_id === entry.point_id));
			const reason = failures.slice(0, 3).map((entry) => `${entry.point_id}（${String(entry.error || '').slice(0, 80)}）`).join('；');
			return { step: 'cases', message: `请补齐${details.length ? details.join('；') : '缺失的用例'}${reason ? `；生成失败：${reason}` : ''}。` };
		}
		if (status.approvals.stale.length) {
			return { step: 'cases', message: `有 ${status.approvals.stale.length} 条用例缺少本版本的有效裁决，请重新评审。` };
		}
		if (status.approvals.unexpanded.length) {
			return { step: 'cases', message: `有 ${status.approvals.unexpanded.length} 条用例只是复制测试点，请展开执行步骤。` };
		}
		const caseIssues = lint(cases.items, new Set(points.items.map((item) => item.point_id)), new Set(model.inputs.facts.items.map((item) => item.fact_id)));
		if (caseIssues.some((issue) => issue.severity === 'error')) return { step: 'issues', message: '用例仍有校验错误，请处理问题清单。' };
		return null;
	};

	/** Raw body upload: the browser sends the file bytes, the name rides in a header. */
	const runUpload = async (req, res) => {
		const rejection = ctx.connection?.requestRejection?.(req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			sendJson(res, 405, { ok: false, error: '仅支持 POST' });
			return;
		}
		const projectId = String(req.headers['x-project'] || '');
		const requestedDir = String(req.headers['x-dir'] || '');
		const rawScope = String(req.headers['x-scope'] || 'project');
		const scope = ['global', 'project', 'module', 'pool'].includes(rawScope) ? rawScope : 'project';
		const moduleHeader = String(req.headers['x-module'] || '');
		const rawName = String(req.headers['x-filename'] || '');
		let name = '';
		try {
			name = decodeURIComponent(rawName).replace(/[\\/]/g, '_').trim();
		} catch {
			name = '';
		}
		if (name === '' || (scope !== 'global' && scope !== 'pool' && projectId === '')) {
			sendJson(res, 400, { ok: false, error: '缺少项目或文件名' });
			return;
		}
		const bucket = ['prd', 'signals', 'design', 'other'].includes(requestedDir) ? requestedDir : inferBucket(name);
		const info = scope === 'global' || scope === 'pool' ? null : await findProject(config, projectId);
		if (scope !== 'global' && scope !== 'pool' && !info) {
			sendJson(res, 404, { ok: false, error: '项目不存在' });
			return;
		}
		if (info?.readonly) {
			sendJson(res, 403, { ok: false, error: '只读项目不能上传' });
			return;
		}
		let base;
		if (scope === 'global') base = path.join(root, 'assets', 'global');
		else if (scope === 'pool') base = path.join(root, 'assets', 'inbox');
		else if (scope === 'module') {
			const moduleId = resolveModule(info, moduleHeader || undefined);
			if (!(info.modules || []).some((item) => item.id === moduleId)) {
				sendJson(res, 400, { ok: false, error: '模块不存在' });
				return;
			}
			base = path.join(info.dir, 'modules', moduleId, 'assets');
		} else base = info.dir;
		const dir = path.join(base, bucket);
		await fs.mkdir(dir, { recursive: true });
		const target = path.join(dir, name);
		const temporary = path.join(dir, '.' + crypto.randomUUID() + '.upload');
		const handle = await fs.open(temporary, 'wx');
		let bytes = 0;
		try {
			for await (const chunk of req) {
				bytes += chunk.length;
				if (bytes > 300 * 1024 * 1024) throw new Error('文件超过 300MB');
				await handle.write(chunk);
			}
		} catch (error) {
			await handle.close();
			await fs.unlink(temporary).catch(() => {});
			sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : '写入失败' });
			return;
		}
		await handle.close();
		const isPix = scope === 'project' && bucket === 'design' && /\.pix$/i.test(name);
		if (isPix && previewJobs.get(projectId)?.running) {
			await fs.unlink(temporary).catch(() => {});
			sendJson(res, 409, { ok: false, error: '项目正在解析或缓存截图，请完成后再上传设计稿' });
			return;
		}
		try {
			fsSync.renameSync(temporary, target);
		} catch (error) {
			await fs.unlink(temporary).catch(() => {});
			sendJson(res, 500, { ok: false, error: error.message });
			return;
		}
		if (projectId) {
			const uploadModule = moduleHeader || (info ? resolveModule(info) : '');
			activityFor(projectId, '上传资料', 'platform', '', undefined, uploadModule)('completed', `${bucket}/${name}`);
		}
		if (scope === 'project' && info) await registerProjectAsset(info, path.join(bucket, name), []).catch(() => {});
		if (isPix) startPreviews(info, projectId, name);
		sendJson(res, 200, { ok: true, state: { added: path.join(bucket, name), bytes, readonly: false, scope } });
	};

	const runChat = async (req, res) => {
		const rejection = ctx.connection?.requestRejection?.(req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			sendJson(res, 405, { ok: false, error: '仅支持 POST' });
			return;
		}
		const raw = await readBody(req);
		if (raw === null) {
			sendJson(res, 413, { ok: false, error: '请求体过大' });
			return;
		}
		let body;
		try {
			body = JSON.parse(raw || '{}');
		} catch {
			sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' });
			return;
		}
		enterScope(await scopeRequest(body));
		enterSkillScope(root);
		const projectId = typeof body.project === 'string' ? body.project : '';
		const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
		if (projectId === '' || userMessage === '') {
			sendJson(res, 400, { ok: false, error: '缺少项目或消息' });
			return;
		}

		res.statusCode = 200;
		res.setHeader('content-type', 'text/event-stream; charset=utf-8');
		res.setHeader('cache-control', 'no-cache, no-transform');
		res.setHeader('connection', 'keep-alive');
		res.setHeader('x-accel-buffering', 'no');
		const send = (event, data) => {
			if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};
		const runId = `R-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
		const log = createLog(config, projectId, runId);
		const record = activityFor(projectId, 'Agent 对话');
		const activeTools = new Map();
		const emit = (event, data) => {
			send(event, data);
			log.write({ type: event, ...data });
			if (event === 'tool.start') {
				activeTools.set(data.callId, data.tool);
				record('tool', data.tool);
			} else if (event === 'tool.end') {
				record(data.ok ? 'tool_completed' : 'tool_failed', activeTools.get(data.callId));
				activeTools.delete(data.callId);
			} else if (event === 'gate.request') record('progress', '等待确认');
			else if (event === 'gate.answered') record('progress', '收到确认');
			else trackStream(record, event, data);
		};

		let callSeq = 0;
		const startedAt = Date.now();
		const MAX_SECONDS = Number(config?.maxRunSeconds) || 600;
		const MAX_TOOL_CALLS = Number(config?.maxToolCalls) || 30;
		let toolCalls = 0;
		try {
			const model = await resolveModel(ctx, config).catch((error) => {
				emit('error', { code: error.code || 'MODEL_UNAVAILABLE', message: error.message });
				return null;
			});
			if (!model) {
				res.end();
				return;
			}
			defaults = { provider: model.provider, model: model.model };
			emit('run.start', { runId, provider: model.provider, model: model.model });
			emit('user', { text: userMessage });

			// Ground every run in the inventory; it is cheap and always relevant.
			const callId = `t${++callSeq}`;
			emit('tool.start', { callId, tool: 'project.summary', input: { project: projectId } });
			const info = await summary(config, projectId);
			const infoText = `PRD ${info.counts.prd} · 信号 ${info.counts.signals} · 设计 ${info.counts.design} · 其他 ${info.counts.other}`;
			emit('tool.end', { callId, ok: true, summary: infoText, data: info });

			const evidenceIndex = await loadEvidence(config, projectId, root);
			const evidenceNote = evidenceIndex
				? `证据库已构建：${evidenceIndex.stats.items} 条（${evidenceIndex.stats.chars} 字），构建于 ${evidenceIndex.builtAt}`
				: '证据库尚未构建：先调用 evidence.build，否则 evidence.search 没有内容。';

			const messages = [
				message('system', `${SYSTEM}\n\n${TOOL_HELP}`),
				message('user', [
					`项目摘要：${infoText}`,
					`文件：${JSON.stringify(info.files)}`,
					evidenceNote,
					'',
					`用户：${userMessage}`
				].join('\n'))
			];

			let answer = '';
			for (let round = 0; round < MAX_ROUNDS; round += 1) {
				if (Date.now() - startedAt > MAX_SECONDS * 1000) {
					emit('budget', { limit: 'time', seconds: Math.round((Date.now() - startedAt) / 1000) });
					break;
				}
				if (toolCalls >= MAX_TOOL_CALLS) {
					emit('budget', { limit: 'tool_calls', calls: toolCalls });
					break;
				}
				let text = '';
				let buffered = false;
				let decided = false;
				for await (const chunk of model.llm.stream({
					provider: model.provider,
					model: model.model,
					maxTokens: 2000,
					messages
				})) {
					if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
						text += chunk.text;
						if (!decided) {
							const head = text.trimStart();
							if (head.length >= 1) {
								decided = true;
								buffered = head.startsWith('{') || head.startsWith('```');
							}
						}
						if (decided && !buffered) {
							answer += chunk.text;
							send('text.delta', { text: chunk.text });
							log.pushText(chunk.text);
						}
					} else if (chunk?.type === 'finish') {
						const kind = chunk.reason?.kind || 'stop';
						if (kind === 'error' || kind === 'aborted') {
							throw Object.assign(new Error(chunk.reason?.failure?.message || `模型调用未完成（${kind}）`), {
								code: chunk.reason?.failure?.code || kind
							});
						}
					}
				}

				const actions = buffered ? extractActions(text) : [];
				if (actions.length === 0) {
					if (buffered && text.trim() !== '') {
						answer += text;
						send('text.delta', { text });
						log.pushText(text);
					}
					break;
				}

				const replies = [];
				let gated = false;
				for (const action of actions) {
					if (action.gate) {
						const gateId = `G-${crypto.randomBytes(4).toString('hex')}`;
						const question = String(action.gate.question || '').slice(0, 500);
						const options = Array.isArray(action.gate.options) ? action.gate.options.map((option) => String(option).slice(0, 120)).slice(0, 6) : [];
						emit('gate.request', { gateId, question, options });
						const answer = await new Promise((resolve) => {
							const timer = setTimeout(() => {
								pendingGates.delete(gateId);
								resolve('（用户超时未回答，请按最保守的假设继续，并在结论里标注该假设）');
							}, 15 * 60 * 1000);
							pendingGates.set(gateId, (value) => {
								clearTimeout(timer);
								pendingGates.delete(gateId);
								resolve(value);
							});
						});
						emit('gate.answered', { gateId, answer });
						replies.push(`用户回答：${answer}`);
						gated = true;
						continue;
					}
					const toolId = `t${++callSeq}`;
					toolCalls += 1;
					emit('tool.start', { callId: toolId, tool: action.tool, input: action.args });
					let payload;
					let ok = true;
					try {
						payload = await runTool({ projectId, name: action.tool, args: action.args });
					} catch (error) {
						ok = false;
						payload = { error: error instanceof Error ? error.message : String(error) };
					}
					const summaryLine = ok
						? (Array.isArray(payload?.hits) ? `${payload.hits.length} 条命中` : action.tool === 'project.summary' ? '项目清单' : '已读取')
						: `失败：${payload.error}`;
					emit('tool.end', { callId: toolId, ok, summary: summaryLine, data: payload });
					replies.push(`工具结果（${action.tool}）：\n${stringify(payload)}`);
				}

				// Keep the transcript user-only: durable assistant turns need adapter
				// replay metadata this host-side loop does not carry.
				messages.push(message('user', `${replies.join('\n\n')}\n\n继续；信息够了就直接回答（不要再用 JSON 输出工具或问题）。`));
			}

			log.flush();
			log.write({ type: 'final', text: answer });
			emit('run.end', { runId, chars: answer.length });
		} catch (error) {
			emit('error', { code: error.code || 'HOST_ERROR', message: error instanceof Error ? error.message : String(error) });
		} finally {
			res.end();
		}
	};


	async function refreshUiLinks(projectId, options = {}) {
		const info = await findProject(config, projectId);
		if (!info) return null;
		const [facts, contracts, points, cases, features] = await Promise.all(['facts', 'contracts', 'points', 'cases', 'features'].map((kind) => loadArtifact(root, projectId, kind)));
		if (!facts.items.length) return null;
		const result = deriveUi(root, projectId, { facts, contracts, points, cases, features }, options);
		const figureResults = [];
		let casesVersion = cases.version;
		if (options.figures && cases.items.length) {
			const index = loadUiIndex(root, projectId);
			const links = result.document;
			const allowedDesigns = await moduleDesignRevisions(projectId);
			const changed = new Map();
			for (const item of cases.items) {
				if (options.caseIds && !options.caseIds.has(item.case_id)) continue;
				const before = digestOf(item);
				try {
					const attached = await attachCaseFigures({ projectDir: info.dir, index, links, caseItem: item, allowedDesigns });
					figureResults.push(...(attached.results || []));
					if (before !== digestOf(item)) changed.set(item.case_id, { before, item });
				} catch (error) {
					figureResults.push({ case_id: item.case_id, status: 'failed', reason: String(error?.message || error) });
				}
			}
			if (changed.size) {
				const release = await acquireLock(root, projectId);
				try {
					const { items, version, updatedAt, digest, ...meta } = await loadArtifact(root, projectId, 'cases');
					if (!isFrozen(root, projectId)) {
						const merged = items.map((item) => {
							const update = changed.get(item.case_id);
							return update?.before === digestOf(item) ? update.item : item;
						});
						if (digestOf(items) !== digestOf(merged)) {
							casesVersion = (await saveArtifact(root, projectId, 'cases', { version, items: merged, meta })).version;
						}
					}
				} finally { await release(); }
			}
		}
		const coverageReport = uiCoverage(root, projectId, { contracts, points, cases });
		return { stats: { links: result.document.items.length, stale: result.stats?.stale || 0, review: result.stats?.review || 0 },
			figures: { attached: figureResults.filter((entry) => entry.status === 'attached').length,
				skipped: figureResults.filter((entry) => entry.status === 'skipped').length,
				failed: figureResults.filter((entry) => entry.status === 'failed').length },
			summary: coverageReport.stats, statusCounts: coverageReport.statusCounts, casesVersion };
	}

	const runGenerate = async (req, res) => {
		const rejection = ctx.connection?.requestRejection?.(req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		const raw = await readBody(req);
		if (raw === null) {
			sendJson(res, 413, { ok: false, error: '请求体过大' });
			return;
		}
		let body;
		try {
			body = JSON.parse(raw || '{}');
		} catch {
			sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' });
			return;
		}
		enterScope(await scopeRequest(body));
		enterSkillScope(root);
		const projectId = typeof body.project === 'string' ? body.project : '';
		const kind = typeof body.kind === 'string' ? body.kind : '';
		const forceWorker = body.worker === true;
		if (projectId === '' || !['facts', 'features', 'states', 'contracts', 'points', 'cases'].includes(kind)) {
			sendJson(res, 400, { ok: false, error: '需要 project 与 kind（facts/points/cases）' });
			return;
		}

		res.statusCode = 200;
		res.setHeader('content-type', 'text/event-stream; charset=utf-8');
		res.setHeader('cache-control', 'no-cache, no-transform');
		res.setHeader('connection', 'keep-alive');
		res.setHeader('x-accel-buffering', 'no');
		const runId = `G-${Date.now().toString(36)}`;
		const role = authorRole(kind);
		const instructions = ROLE_INSTRUCTIONS[role] + ' 输出以本阶段明确给出的任务和 JSON 格式为准。\n\n';
		const author = (model, prompt, maxTokens) => collect(model, instructions
			+ (['features', 'states', 'contracts'].includes(kind) ? compose(STAGE_SKILLS[kind], prompt) : prompt), maxTokens);
		const record = activityFor(projectId, GENERATION_LABELS[kind], role, kind);
		let aborted = false;
		const heartbeat = setInterval(() => {
			if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
		}, 15000);
		heartbeat.unref();
		res.once('close', () => {
			if (!res.writableEnded) aborted = true;
			clearInterval(heartbeat);
		});
		const send = (event, data) => {
			trackStream(record, event, data);
			if (event === 'worker') record('tool', data.tool);
			if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};
		try {
			assertWritable(projectId);
			const projectInfo = await findProject(config, projectId);
			if (!projectInfo) throw new Error(`项目不存在：${projectId}`);
			const fastTrackFacts = body.source_mode === 'facts';
			const frozen = !fastTrackFacts && body.draft === false && ['points', 'cases'].includes(kind) ? await requireFrozenModel(projectId) : null;
			const outline = frozen ? await loadArtifact(root, projectId, 'outline') : null;
			if (!fastTrackFacts && body.require_outline === true && !outline?.items.length) throw new Error('请先生成并批准测试大纲');
			if (body.outline_digest && (!outline?.digest || outline.digest !== body.outline_digest)) throw new Error('测试大纲已变化，请刷新');
			if (await branchOutlineStale(projectId, outline?.items[0])) throw new Error(staleBranchOutlineMessage);
			const fromBranches = !fastTrackFacts && kind === 'points' && body.from_branches === true;
			// 显式分支请求或快速事实轨优先：冻结模型里存在旧合同不代表本轮要走合同入口。
			const fromContracts = !fastTrackFacts && kind === 'points' && !fromBranches && Boolean(frozen && (body.from_contracts === true || frozen.inputs.contracts));
			const model = fromContracts || fromBranches || (kind === 'points' && outline?.items.length) ? null : await resolveModel(ctx, config);
			send('run.start', { runId, kind, role, provider: model?.provider, model: model?.model,
				instructions_digest: digestOf(instructions), skill: STAGE_SKILLS[kind], skill_version: skillDigests()[STAGE_SKILLS[kind]] });

			if (kind === 'contracts') {
				const [facts, features, doc, evidence] = await Promise.all([
					loadArtifact(root, projectId, 'facts'), loadArtifact(root, projectId, 'features'),
					loadArtifact(root, projectId, 'contracts'), scopedEvidence(projectId)
				]);
				const bindings = loadBindings(root, projectId);
				const ids = new Set(Array.isArray(body.feature_ids) ? body.feature_ids : []);
				const selected = features.items.filter((item) => ids.has(item.feature_id));
				if (!selected.length || selected.length !== ids.size) throw new Error('请选择要整理的功能');
				const active = new Set(evidence.items.map((item) => item.id));
				const factById = new Map(facts.items.filter((item) => item.evidence_refs?.length && item.evidence_refs.every((id) => active.has(id)))
					.map((item) => [item.fact_id, item]));
				const signalIndex = buildSignalIndex(projectInfo.dir).index;
				const bindingsFor = (factList) => {
					const factSet = new Set(factList.map((item) => item.fact_id));
					const controls = [];
					const signals = [];
					for (const b of bindings.items || []) {
						if (b.status !== 'bound' || !b.target) continue;
						if (!(b.subject?.fact_ids || []).some((id) => factSet.has(id))) continue;
						if (b.kind === 'control') controls.push({ name: b.subject.name, page: b.target.page || b.subject.page || '' });
						if (b.kind === 'signal') {
							const meta = signalIndex.get(String(b.subject.name || '').replace(/[\s_\-]/g, '').toLowerCase());
							signals.push({
								name: b.subject.name, message: b.target.message, message_id: b.target.message_id,
								direction: meta?.transmitter ? directionOf(meta.transmitter) : '',
								value_table: meta?.valueDesc || b.target.valueDesc || ''
							});
						}
					}
					return { controls, signals };
				};
				const items = [...doc.items];
				const evidenceDigest = digestOf(evidence.items);
				const inputDigest = digestOf([evidenceDigest, facts.digest, features.digest, doc.version,
					model.provider, model.model, instructions, skillDigests()[STAGE_SKILLS[kind]], selected.map((item) => item.feature_id)]);
				const cacheDir = path.join(root, 'artifacts', projectId, currentModule(), 'contract-drafts', inputDigest);
				await fs.mkdir(cacheDir, { recursive: true });
				for (const [index, feature] of selected.entries()) {
					send('phase', { step: index + 1, total: selected.length, label: '整理需求 · ' + feature.name });
					const source = feature.fact_refs.map((id) => factById.get(id)).filter(Boolean);
					if (!source.length) continue;
					for (const batch of chunk(source, 25)) {
						const cache = path.join(cacheDir, digestOf([feature.feature_id, batch]) + '.json');
						let raw = await fs.readFile(cache, 'utf8').then(JSON.parse).catch(() => null);
						const boundCtx = bindingsFor(batch);
						const contextLines = [
							boundCtx.controls.length ? '已确认控件参考：' + JSON.stringify(boundCtx.controls) : '',
							boundCtx.signals.length ? '已确认信号参考（含方向与枚举，不得把反馈当请求）：' + JSON.stringify(boundCtx.signals) : ''
						].filter(Boolean).join('\n');
						if (!raw) raw = parseJson(await author(model,
							'将下面功能「' + feature.name + '」的事实拆成独立、可观察的需求合同（一条合同对应一个独立的前置条件+触发/事件+可观察预期分支；相反初态、不同入口、不同反馈/异常分支拆开，同一触发下的多个同时结果保留在同一合同）。\n'
							+ '逐一保留来源 fact_refs；条件、预期无法确定时留空，不编造。只用给出的事实与已确认参考。\n'
							+ '输出 JSON：{"contracts":[{"title":"","trigger":"","condition":"","expected":"","fact_refs":[],"rule_ids":[]}]}。可用测试方法编号：'
							+ JSON.stringify(methods) + (contextLines ? '\n' + contextLines : '') + '\n' + JSON.stringify(batch), 6000));
						if (!Array.isArray(raw?.contracts)) throw new Error('未得到有效的合同草稿，重试时会复用已完成批次');
						const staged = cache + '.' + crypto.randomUUID();
						await fs.writeFile(staged, JSON.stringify(raw));
						await fs.rename(staged, cache);
						const valid = new Set(batch.map((item) => item.fact_id));
						for (const entry of raw.contracts) {
							if (!entry?.title || !entry.fact_refs?.length || !Array.isArray(entry.fact_refs) || !entry.fact_refs.every((id) => valid.has(id))) continue;
							const item = editContract(null, { ...entry, feature_id: feature.feature_id }, selected, facts.items, evidence.items, false, []);
							const duplicate = items.some((prior) => ['feature_id', 'title', 'trigger', 'condition', 'expected'].every((key) => prior[key] === item[key]));
							if (!duplicate) items.push(item);
						}
					}
				}
				const unlock = await acquireLock(root, projectId);
				try {
					assertWritable(projectId);
					for (const [kind, prior] of [['contracts', doc], ['facts', facts], ['features', features]]) {
						if ((await loadArtifact(root, projectId, kind)).version !== prior.version) throw new Error('需求资料或评审已更新，请重试');
					}
					if (digestOf((await scopedEvidence(projectId)).items) !== evidenceDigest) throw new Error('证据已更新，请重试');
					if (items.length > doc.items.length) await saveArtifact(root, projectId, 'contracts', { ...doc, items });
					await fs.rm(cacheDir, { recursive: true, force: true });
				} finally { await unlock(); }
				// 草稿缺 trigger/condition/expected 是确认阶段的真实阻塞，生成时就要点名。
				const incomplete = items
					.filter((item) => item.status !== 'approved' && (item.missing_fields?.length
						|| !item.trigger || !item.condition || !item.expected))
					.map((item) => ({ contract_id: item.contract_id, title: item.title,
						missing_fields: item.missing_fields?.length ? item.missing_fields
							: [!item.trigger && '触发动作', !item.condition && '前置条件', !item.expected && '可观察预期'].filter(Boolean) }));
				if (incomplete.length) send('contracts.incomplete', { count: incomplete.length, contracts: incomplete.slice(0, 20) });
				send('run.end', { kind, count: items.length - doc.items.length, incomplete: incomplete.length, incomplete_contracts: incomplete.slice(0, 20) });
				return;
			}

			if (kind === 'facts') {
				let evidence = await scopedEvidence(projectId);
				if (!evidence || !Array.isArray(evidence.items) || evidence.items.length === 0) {
					throw new Error('证据库为空：先在左侧点「构建证据」');
				}
				// A module only consumes the slices of the shared PRD that mention it;
				// if the keywords miss everything, fall back to the whole project.
				const moduleMeta = (projectInfo.modules || []).find((item) => item.id === currentModule()) || {};
				const keywords = (moduleMeta.keywords || []).filter((word) => typeof word === 'string' && word.trim() !== '');
				if (keywords.length > 0 && !(await loadArtifact(root, projectId, 'source-scope')).items.length) {
					const matched = evidence.items.filter((item) => keywords.some((word) => String(item.text).includes(word) || String(item.location).includes(word)));
					if (matched.length >= 5) {
						send('module.filter', { module: moduleMeta.name || '', keywords, before: evidence.items.length, after: matched.length });
						evidence = { ...evidence, items: matched };
					} else {
						send('module.filter', { module: moduleMeta.name || '', keywords, before: evidence.items.length, after: evidence.items.length, fallback: true });
					}
				}
				const nonDesign = evidence.items.filter((item) => item.kind !== 'design');
				const designItems = evidence.items.filter((item) => item.kind === 'design');
				if (nonDesign.length > 0 && designItems.length > 1) {
					const moduleTokens = [...new Set([
						...String(moduleMeta.name || '').split(/[-_\s/]+/),
						...keywords.flatMap((word) => [word, ...String(word).split(/[-_\s/]+/)])
					].map((word) => word.trim()).filter((word) => word.length >= 2))];
					const textCorpus = nonDesign.map((item) => `${item.location || ''}\n${item.text || ''}`).join('\n').toLowerCase();
					const hasTwoMentions = (needle) => {
						if (!needle) return false;
						const first = textCorpus.indexOf(needle);
						return first !== -1 && textCorpus.indexOf(needle, first + needle.length) !== -1;
					};
					const relevantDesign = designItems.filter((item) => {
						const pageName = String(item.location || '').split(/[·/]/).pop().trim();
						if (!pageName || /^(?:cover|封面|颜色|color|模型)$/i.test(pageName)) return false;
						const low = pageName.toLowerCase();
						if (moduleTokens.some((tok) => {
							const t = tok.toLowerCase();
							return low.includes(t) || t.includes(low);
						})) return true;
						return hasTwoMentions(low);
					});
					if (relevantDesign.length >= 1) {
						evidence = { ...evidence, items: [...nonDesign, ...relevantDesign] };
						send('design.filter', { before: designItems.length, after: relevantDesign.length, pages: relevantDesign.map((item) => item.location) });
					}
				}
				const rawDesignEvidenceIds = new Set(evidence.items.filter((item) => item.kind === 'design').map((item) => item.id));
				const factUiIndex = loadUiIndex(root, projectId);
				const prdTextForDesign = nonDesign.map((item) => item.text || '').join('\n');
				const designMeta = { uiIndex: factUiIndex, prdText: prdTextForDesign, aliases: configTerms('aliases') };
				evidence = semanticEvidenceDocument(evidence, designMeta);
				// 多份大型信号矩阵切块会淹没需求文档事实抽取：仅将与需求正文存在信号/报文交集的矩阵块送入 facts 批处理，全量信号仍通过 buildSignalIndex 供绑定与查询使用。
				const signalMatrixItems = evidence.items.filter((item) => /^signals\//i.test(String(item.source || '')));
				const nonSignalItems = evidence.items.filter((item) => !/^signals\//i.test(String(item.source || '')));
				if (nonSignalItems.length > 0 && signalMatrixItems.length > 12) {
					const prdCorpus = nonSignalItems.map((item) => `${item.location || ''}\n${item.text || ''}`).join('\n');
					const prdLow = prdCorpus.toLowerCase();
					const prdHex = new Set([...prdLow.matchAll(/\b0x[0-9a-f]{3,8}\b/g)].map((m) => m[0]));
					const prdAscii = new Set([...prdCorpus.matchAll(/\b[A-Za-z][A-Za-z0-9_]{3,40}\b/g)].map((m) => m[0].replace(/[\s_-]/g, '').toLowerCase()));
					const relevantSignals = signalMatrixItems.filter((item) => {
						const txt = String(item.text || '');
						const low = txt.toLowerCase();
						for (const hx of low.matchAll(/\b0x[0-9a-f]{3,8}\b/g)) {
							if (prdHex.has(hx[0])) return true;
						}
						for (const tok of txt.matchAll(/\b[A-Za-z][A-Za-z0-9_]{3,40}\b/g)) {
							const nk = tok[0].replace(/[\s_-]/g, '').toLowerCase();
							if (nk.length >= 5 && prdAscii.has(nk)) return true;
						}
						return false;
					});
					evidence = { ...evidence, items: [...nonSignalItems, ...relevantSignals] };
					send('signals.filter', { before: signalMatrixItems.length, after: relevantSignals.length });
				}
				const ids = new Set(evidence.items.map((item) => item.id));
				const batches = chunk(evidence.items, FACT_BATCH).slice(0, FACT_MAX_BATCHES);
				const current = await loadArtifact(root, projectId, 'facts');
				const replaceFacts = body.replace === true;
				if (replaceFacts) await archiveArtifact(root, projectId, 'facts');
				let items = replaceFacts ? [] : current.items.slice();
				const { index: signalIndex } = buildSignalIndex(projectInfo.dir);
				const lookupFactSignal = (key) => {
					if (signalIndex.has(key)) return signalIndex.get(key);
					const prefixHits = [];
					const suffixHits = [];
					const multisetHits = [];
					const charsetHits = [];
					const keyMs = key.length >= 9 ? key.split('').sort().join('') : '';
					for (const [k, v] of signalIndex.entries()) {
						if (k.length >= 8 && key.startsWith(k) && key.length - k.length <= 6) prefixHits.push(v);
						if (key.length >= 8 && k.endsWith(key) && k.length - key.length <= 6) suffixHits.push(v);
						if (keyMs && k.length === key.length && k.split('').sort().join('') === keyMs) multisetHits.push(v);
						if (k.length >= 10 && key.length >= 10 && Math.abs(k.length - key.length) <= 2
							&& [...key].every((ch) => k.includes(ch)) && [...k].every((ch) => key.includes(ch))) {
							charsetHits.push(v);
						}
					}
					if (prefixHits.length === 1) return prefixHits[0];
					if (suffixHits.length === 1) return suffixHits[0];
					if (multisetHits.length === 1) return multisetHits[0];
					if (charsetHits.length === 1) return charsetHits[0];
					return null;
				};
				const designPagesSummary = buildDesignPageSemanticSummaries(evidence.items, designMeta);
				const contextForBatch = (batch) => {
					const matchedSignals = [];
					const seenSig = new Set();
					if (signalIndex.size > 0) {
						const joined = batch.map((item) => item.text).join('\n');
						for (const match of joined.matchAll(/[A-Za-z][A-Za-z0-9_]{3,40}/g)) {
							const key = match[0].replace(/[\s_-]/g, '').toLowerCase();
							if (key.length < 5) continue;
							const sig = lookupFactSignal(key);
							if (!sig || seenSig.has(sig.name)) continue;
							seenSig.add(sig.name);
							matchedSignals.push({
								name: sig.name, description: sig.description || '',
								message: sig.message, message_id: sig.message_id,
								direction: sig.transmitter ? directionOf(sig.transmitter) : '',
								valueDesc: sig.valueDesc || ''
							});
							if (matchedSignals.length >= 20) break;
						}
					}
					const hasNonDesign = batch.some((item) => item.kind !== 'design');
					return {
						signals: matchedSignals,
						design: hasNonDesign ? designPagesSummary : [],
						designMeta
					};
				};
				// Forced retrieval experiment: pull neighbouring historical definitions
				// by the batch's section wording, then hand them over as context only.
				const historyFor = (batch) => {
					if (body.history !== true) return [];
					const terms = new Set();
					for (const item of batch) {
						for (const run of String(item.location || '').match(/[\u4e00-\u9fff]{2,6}/g) || []) terms.add(run);
					}
					const picked = new Map();
					for (const term of [...terms].slice(0, 6)) {
						for (const hit of searchHistory(root, term, 2).hits || []) {
							if (!picked.has(hit.id)) picked.set(hit.id, hit);
						}
					}
					return [...picked.values()].slice(0, 4);
				};
				for (let index = 0; index < batches.length; index += 1) {
					send('phase', { step: index + 1, total: batches.length, label: `抽取产品事实 ${index + 1}/${batches.length}` });
					const history = historyFor(batches[index]);
					const batchContext = contextForBatch(batches[index]);
					const rawText = (config?.factsWorker === true || forceWorker) ? await runWorker({
						model,
						system: instructions + skill(STAGE_SKILLS.facts),
						task: factTask(batches[index], projectInfo.name, history, batchContext),
						tools: ['evidence.search', 'evidence.read', 'signal.lookup', 'design.search', 'design.node', 'history.search'],
						maxRounds: 3,
						maxTokens: Number(config?.factsWorkerTokens) || 8000,
						onEvent: (event) => {
							if (event.type === 'tool') send('worker', { step: index + 1, tool: event.tool, args: event.args });
						},
						runTool: async (name, args) => {
							if (name === 'evidence.search') return searchEvidence(config, projectId, root, String(args.query || ''), { limit: args.limit, document: evidence });
							if (name === 'evidence.read') return readEvidence(config, projectId, root, String(args.id || ''), { offset: args.offset, limit: args.limit, document: evidence });
							if (name === 'history.search') return searchHistory(root, String(args.query || ''), args.limit);
							if (name === 'signal.lookup' || name.startsWith('design.')) return runTool({ projectId, name, args });
							throw new Error(`未知工具：${name}`);
						}
					}) : await author(model, compose('cts-facts', factTask(batches[index], projectInfo.name, history, batchContext)));
					const parsedFacts = parseJson(rawText);
					if (!parsedFacts) send('debug', { step: index + 1, rawLen: rawText.length, head: rawText.slice(0, 300), tail: rawText.slice(-200) });
					const added = mergeFacts(items, parsedFacts, ids, { designEvidenceIds: rawDesignEvidenceIds });
					const base = items.length;
					items = items.concat(added.map((fact, offset) => ({ ...fact, fact_id: `F-${String(base + offset + 1).padStart(4, '0')}` })));
					send('artifact.updated', { kind: 'facts', count: items.length });
				}
				const unlock = await acquireLock(root, projectId);
				let saved;
				try {
					assertWritable(projectId);
					if ((await loadArtifact(root, projectId, 'facts')).version !== current.version) throw new Error('生成期间有修改，请重试');
					saved = await saveArtifact(root, projectId, 'facts', { version: current.version, items });
				} finally { await unlock(); }
				await refreshUiLinks(projectId).catch(() => null);
				send('run.end', { kind, count: items.length, version: saved.version });
				return;
			}

			if (kind === 'features') {
				const facts = await loadArtifact(root, projectId, 'facts');
				if (facts.items.length === 0) throw new Error('还没有产品事实：先生成事实');
				const factIds = new Set(facts.items.map((fact) => fact.fact_id));
				const batches = chunk(facts.items, 25).slice(0, MAX_BATCHES);
				const current = await loadArtifact(root, projectId, 'features');
				const replaceFeatures = body.replace !== false;
				if (replaceFeatures) await archiveArtifact(root, projectId, 'features');
				let items = replaceFeatures ? [] : current.items.slice();
				const prefix = 'FTR';
				const priorIds = new Map(current.items.map((item) => [item.name, item.feature_id]));
				const allocated = new Set(current.items.map((item) => item.feature_id));
				let serial = Math.max(0, ...current.items.map((item) => Number(/^FTR_(\d+)$/.exec(item.feature_id)?.[1] || 0))) + 1;
				for (let index = 0; index < batches.length; index += 1) {
					send('phase', { step: index + 1, total: batches.length, label: `归并功能点 ${index + 1}/${batches.length}` });
					const rawText = await author(model, featurePrompt(batches[index], projectInfo.name));
					const added = mergeFeatures(items, parseJson(rawText), factIds);
					for (const feature of added) {
						let id = priorIds.get(feature.name);
						while (!id) {
							const candidate = prefix + '_' + String(serial++).padStart(3, '0');
							if (!allocated.has(candidate)) id = candidate;
						}
						allocated.add(id);
						items.push({ ...feature, feature_id: id });
					}
					send('artifact.updated', { kind: 'features', count: items.length });
				}
				const unlock = await acquireLock(root, projectId);
				let saved;
				try {
					assertWritable(projectId);
					if ((await loadArtifact(root, projectId, 'features')).version !== current.version) throw new Error('生成期间有修改，请重试');
					saved = await saveArtifact(root, projectId, 'features', { version: current.version, items });
				} finally { await unlock(); }
				send('run.end', { kind: 'features', count: items.length, version: saved.version });
				return;
			}

			if (kind === 'states') {
				const features = await loadArtifact(root, projectId, 'features');
				if (features.items.length === 0) throw new Error('还没有功能点：先生成功能点');
				const facts = await loadArtifact(root, projectId, 'facts');
				const bindings = loadBindings(root, projectId);
				const current = loadStates(root, projectId);
				const decisions = new Map(loadQuestions(root, projectId).items
					.filter((item) => item.kind === 'state' && item.status === 'answered' && item.answer && !item.options?.includes(item.answer))
					.map((item) => [item.ref, item.answer]));
				const replaceStates = body.replace !== false;
				// Re-derive only the named features: the remedy for a binding change
				// must not silently re-stamp the digest on untouched state machines.
				const redo = new Set(Array.isArray(body.feature_ids) ? body.feature_ids : []);
				if (redo.size) {
					await archiveArtifact(root, projectId, 'states');
					const known = new Set(features.items.map((feature) => feature.feature_id));
					if ([...redo].some((id) => !known.has(id))) throw new Error('要重新推导的功能点不存在');
				}
				if (replaceStates && !redo.size) await archiveArtifact(root, projectId, 'states');
				const done = replaceStates && !redo.size ? new Set() : new Set(current.items.filter((item) => !redo.has(item.feature_id)).map((item) => item.feature_id));
				const pending = features.items.filter((feature) => redo.has(feature.feature_id) || !done.has(feature.feature_id));
				const eligibility = filterEligibleStateFeatures(pending, facts.items, decisions);
				const eligibleFeatures = eligibility.eligible.map((entry) => entry.feature);
				send('states.eligibility', {
					eligible: eligibility.eligible.length,
					skipped_static: eligibility.skipped_static.length,
					insufficient_evidence: eligibility.insufficient_evidence.length
				});
				const batches = chunk(eligibleFeatures, 6).slice(0, MAX_BATCHES);
				let items = replaceStates && !redo.size ? [] : current.items.filter((item) => !redo.has(item.feature_id));
				for (let index = 0; index < batches.length; index += 1) {
					send('phase', { step: index + 1, total: batches.length, label: `推导状态机 ${index + 1}/${batches.length}` });
					for (const feature of batches[index]) {
						const decision = decisions.get(feature.feature_id);
						const prompt = statePrompt(feature, facts.items, bindings.items);
						const rawText = await author(model, decision ? prompt + '\n人工确认的触发条件：' + JSON.stringify(decision) : prompt, 3000);
						const machine = mergeStates(feature, parseJson(rawText), facts.items, bindings.items);
						if (decision) machine.human_decision = decision;
						machine.issues = validateState(machine);
						items.push(machine);
						send('artifact.updated', { kind: 'states', count: items.length });
					}
				}
				const priorDiag = (!replaceStates || redo.size) && current.diagnostics ? current.diagnostics : { generated: [], skipped_static: [], insufficient_evidence: [] };
				const keepPrior = (list) => (Array.isArray(list) ? list : []).filter((entry) => !redo.has(entry.feature_id) && !pending.some((p) => p.feature_id === entry.feature_id));
				const diagnostics = {
					generated: [...keepPrior(priorDiag.generated), ...eligibility.eligible.map((entry) => entry.diagnostic)],
					skipped_static: [...keepPrior(priorDiag.skipped_static), ...eligibility.skipped_static],
					insufficient_evidence: [...keepPrior(priorDiag.insufficient_evidence), ...eligibility.insufficient_evidence]
				};
				const saved = saveStates(root, projectId, items, {
					source_features_digest: digestOf(features.items),
					source_facts_digest: digestOf(facts.items),
					source_bindings_digest: digestOf(bindings.items),
					diagnostics
				});
				const open = await refreshQuestions(projectId).then((document) => document.items.filter((item) => item.status === 'open').length).catch(() => 0);
				send('questions.updated', { open });
				const issueCount = items.reduce((sum, item) => sum + (item.issues || []).length, 0);
				send('run.end', { kind: 'states', count: items.length, version: saved.version, issues: issueCount, diagnostics });
				return;
			}

			if (kind === 'points') {
				const approved = (frozen?.inputs.contracts?.items || []).filter((item) => item.status === 'approved');
				if (fromContracts && !approved.length) throw new Error('请先确认需求合同并重新冻结 ECSM');
				const design = outline?.items.length ? outline.items[0] : null;
				// 范围只有一份：请求的输入与当前大纲的来源不一致时明确拒绝，不静默换分母。
				if (design && fromContracts && design.source_kind === 'branches') throw new Error('当前大纲由需求分支生成；请改用分支入口，或先按合同重建大纲');
				if (design && (design.status !== 'approved' || design.source_ecsm_digest !== frozen.digest)) throw new Error('请先评审当前模型的测试大纲');
				const facts = frozen?.inputs.facts || await loadArtifact(root, projectId, 'facts');
				if (facts.items.length === 0) throw new Error('还没有产品事实：先生成事实');
				const batches = chunk(facts.items, POINT_BATCH).slice(0, MAX_BATCHES);
				const current = await loadArtifact(root, projectId, 'points');
				// 从合同重建整组是该操作的语义；其余路径默认追加，整轮重生成须显式要求。
				const replace = fromContracts ? body.replace !== false : body.replace === true;
				if (fromContracts && !replace) throw new Error('合同生成按冻结版本重新生成整组测试点');
				if (frozen && !replace && current.items.length && current.source_ecsm_digest !== frozen.digest) throw new Error('追加测试点需要使用同一 ECSM 版本');
				if (design && !design.items.some(generatableScenario)) {
					throw new Error('没有可生成的场景，请调整范围、预算或评审意见');
				}
				if (replace) await archiveArtifact(root, projectId, 'points');
				const featureDoc = frozen?.inputs.features || await loadArtifact(root, projectId, 'features');
				const stateDoc = frozen?.inputs.states || loadStates(root, projectId);
				const factToFeature = new Map();
				for (const feature of featureDoc.items) {
					for (const ref of feature.fact_refs || []) factToFeature.set(ref, feature.feature_id);
				}
				const machineByFeature = new Map(stateDoc.items.map((machine) => [machine.feature_id, machine]));
				const machinesFor = (batch) => {
					const ids = new Set(batch.map((fact) => factToFeature.get(fact.fact_id)).filter(Boolean));
					return [...ids].map((id) => machineByFeature.get(id)).filter(Boolean).slice(0, 6);
				};
				let branchList = null;
				if (fromBranches) {
					branchList = await loadArtifact(root, projectId, 'branches');
					if (!branchList.items.length) throw new Error('还没有分支清单：先运行 build-branches 并保存 branches');
					// 两处入口共读同一份冻结范围：分支必须先成为已批准大纲，测试点不再自行重算场景。
					if (design?.source_kind !== 'branches') throw new Error('请先用「从分支生成大纲」并批准，再生成测试点');
					if (design.source_branches_digest !== branchList.digest) throw new Error(staleBranchOutlineMessage);
					if (branchList.prd?.sha256 && frozen?.inputs?.facts && branchList.version !== frozen.version) {
						send('branch.version', { branches_version: branchList.version, ecsm_version: frozen.version });
					}
				}
				const tokens = (value) => new Set(String(value || '').match(/[一-龥]{2,}|[A-Za-z][A-Za-z0-9_]{3,}/g) || []);
				// 分支驱动的大纲承载全部在范围分支（含待证据/静态/排除），分母不能只取可生成项。
				const branchDrivenOutline = design?.source_kind === 'branches';
				// TKR 注解留在大纲行上，点靠 scenario_refs 关联；复制到点上会让规则包换版作废测试点与用例的基线摘要。
				let items = design ? (branchDrivenOutline ? design.items : design.items.filter(generatableScenario)).map(({ coverage_targets, tkr_rule_refs, ...item }, index) => ({
					...item, point_id: 'T-' + String(index + 1).padStart(4, '0'), scenario_refs: [item.scenario_id], review_status: 'candidate'
				})) : fromContracts ? contractPoints(approved) : replace ? [] : current.items.slice();
				const pointBindings = frozen?.inputs.bindings || loadBindings(root, projectId);
				const pointSignalIndex = buildSignalIndex(projectInfo.dir).index;
				const resolvedCoverageMode = body.coverage_mode === 'exhaustive' || (!body.coverage_mode && coverageMode() === 'exhaustive') ? 'exhaustive' : 'standard';
				const resolvedIncludeSingleEntries = body.include_single_entries !== undefined
					? body.include_single_entries === true
					: (includeSingleEntries() || resolvedCoverageMode === 'exhaustive');
				const standardSpecText = await loadStandardSpecText(projectInfo.dir);
				const closedLoopPlan = buildClosedLoopCoveragePlan(facts.items, featureDoc.items, pointBindings.items, pointSignalIndex, {
					dut: dutNode(),
					includeSingleEntries: resolvedIncludeSingleEntries
				});
				const pointContextFor = (batch, closedLoopCells = []) => {
					const factIds = new Set(batch.map((fact) => fact.fact_id));
					const controls = [];
					const ambiguousControls = [];
					const signals = [];
					const seenC = new Set();
					const seenAmb = new Set();
					const seenS = new Set();
					for (const b of pointBindings.items || []) {
						if (!(b.subject?.fact_ids || []).some((id) => factIds.has(id))) continue;
						if (b.kind === 'control' && b.status === 'ambiguous' && !seenAmb.has(b.subject.name)) {
							seenAmb.add(b.subject.name);
							ambiguousControls.push({
								name: b.subject.name,
								candidates: (b.candidates || []).map((c) => `${c.name}${c.node_id ? `(${c.node_id})` : ''}`).slice(0, 4)
							});
							continue;
						}
						if (b.status !== 'bound' || !b.target) continue;
						if (b.kind === 'control' && !seenC.has(b.subject.name)) {
							seenC.add(b.subject.name);
							controls.push({
								name: b.subject.name,
								businessName: stripDesignComponentPrefix(b.subject.name),
								componentName: b.target.name || b.subject.name,
								page: b.target.page || b.subject.page || ''
							});
						}
						if (b.kind === 'signal' && !seenS.has(b.subject.name)) {
							seenS.add(b.subject.name);
							const meta = pointSignalIndex.get(String(b.subject.name || '').replace(/[\s_-]/g, '').toLowerCase());
							signals.push({
								name: b.subject.name, message: b.target.message, message_id: b.target.message_id,
								direction: meta?.transmitter ? directionOf(meta.transmitter) : '',
								valueDesc: meta?.valueDesc || b.target.valueDesc || ''
							});
						}
					}
					const exhaustiveHints = resolvedCoverageMode === 'exhaustive'
						? buildExhaustiveExpansionHints(batch, pointSignalIndex, pointBindings.items)
						: [];
					return {
						controls,
						ambiguousControls,
						signals,
						closedLoopCells,
						coverageMode: resolvedCoverageMode,
						exhaustiveHints,
						standardSpec: standardSpecText
					};
				};
				if (!fromContracts && !fromBranches) for (let index = 0; index < batches.length; index += 1) {
					if (aborted) break;
					send('phase', { step: index + 1, total: batches.length, label: `设计测试点 ${index + 1}/${batches.length}` });
					const rawBatch = batches[index];
					const batchCl = closedLoopForBatch(rawBatch, closedLoopPlan, facts.items);
					const batch = batchCl.batchFacts;
					const machines = machinesFor(batch);
					const rawText = await author(model, pointPrompt(batch, projectInfo.name, machines, pointContextFor(batch, batchCl.cells)), 12000);
					const added = mergePoints(items, parseJson(rawText), batchCl.allowedFactIds, {
						requireEvidence: true,
						transitionIds: new Set(machines.flatMap((machine) => machine.transitions.map((transition) => transition.transition_id)))
					});
					const base = items.length;
					items = items.concat(added.map((point, offset) => ({ ...point, point_id: `T-${String(base + offset + 1).padStart(4, '0')}` })));
					send('artifact.updated', { kind: 'points', count: items.length });
				}
				let closedLoopCoverage = evaluateClosedLoopCoverage(items, closedLoopPlan);
				if (!aborted && !fromContracts && !fromBranches && !design && closedLoopCoverage.missing_cells.length > 0) {
					send('phase', { step: batches.length + 1, total: batches.length + 1, label: `补齐全局闭环规则×入口×分支 (${closedLoopCoverage.missing_cells.length} 项)` });
					const suppAllowedIds = new Set(closedLoopCoverage.missing_cells.flatMap((c) => c.required_fact_refs || []));
					const suppRaw = await author(model, closedLoopSupplementPrompt(closedLoopCoverage.missing_cells, projectInfo.name, closedLoopPlan, facts.items), 8000);
					const suppAdded = mergePoints(items, parseJson(suppRaw), suppAllowedIds, { requireEvidence: true });
					const base = items.length;
					items = items.concat(suppAdded.map((point, offset) => ({ ...point, point_id: `T-${String(base + offset + 1).padStart(4, '0')}` })));
					closedLoopCoverage = evaluateClosedLoopCoverage(items, closedLoopPlan);
					send('artifact.updated', { kind: 'points', count: items.length });
				} else if ((fromContracts || fromBranches || design) && closedLoopCoverage.missing_cells.length > 0) {
					for (const mc of closedLoopCoverage.missing_cells) {
						closedLoopCoverage.gaps.push({
							kind: 'out_of_frozen_scope_closed_loop_cell',
							cell_id: mc.cell_id,
							entry_label: mc.entry_label,
							branch_label: mc.branch_label,
							fact_ids: mc.required_fact_refs,
							message: `冻结范围未包含闭环格子「${mc.entry_label} × ${mc.branch_label}」，作为范围外建议登记缺口`
						});
					}
				}
				if (!fromContracts && !fromBranches) attachFeatures(items, facts.items, featureDoc.items);
				const keptReviews = keepPointReviews(items, current.items);
				const release = await acquireLock(root, projectId);
				let saved;
				try {
					assertWritable(projectId);
					const latest = await loadArtifact(root, projectId, 'points');
					if (latest.version !== current.version || latest.digest !== current.digest) throw new Error('生成期间测试点已变化，请重试');
					if (frozen && (await requireFrozenModel(projectId)).digest !== frozen.digest) throw new Error('生成期间 ECSM 已变化，请重试');
					if (design && (await loadArtifact(root, projectId, 'outline')).digest !== outline.digest) throw new Error('测试大纲已变化，请重试');
					if (await branchOutlineStale(projectId, design)) throw new Error(staleBranchOutlineMessage);
					saved = await saveArtifact(root, projectId, 'points', { version: current.version, items, meta: {
						source_facts_digest: digestOf(facts.items),
						source_features_digest: digestOf(featureDoc.items),
						source_states_digest: digestOf(stateDoc.items),
						source_ecsm_digest: frozen?.digest || null,
						source_ecsm_version: frozen?.version || null,
						source_kind: fromBranches ? 'branches' : fromContracts ? 'contracts' : 'facts',
						source_branches_digest: fromBranches ? branchList.digest : null,
						source_outline_digest: design ? outline.digest : null,
						coverage_mode: resolvedCoverageMode,
						include_single_entries: resolvedIncludeSingleEntries,
						closed_loop_coverage: closedLoopCoverage
					} });
				} finally {
					await release();
				}
				const modelTransitions = new Set(stateDoc.items.flatMap((machine) => (machine.transitions || []).map((entry) => entry.transition_id)));
				const scopedRequirements = design ? design.items.filter((item) => item.required || item.included) : fromContracts ? approved : null;
				const targets = scopedRequirements
					? new Set(scopedRequirements.map((item) => item.transition_ref).filter(Boolean))
					: modelTransitions;
				const covered = new Set(items.map((point) => point.transition_ref).filter((ref) => targets.has(ref) && modelTransitions.has(ref)));
				await refreshUiLinks(projectId).catch(() => null);
				send('run.end', {
					kind,
					count: items.length,
					version: saved.version,
					transitions: targets.size,
					transitionScope: design ? 'outline' : fromContracts ? 'contracts' : 'model',
					covered: covered.size,
					kept_reviews: keptReviews,
					families: familyCoverage(items),
					coverage_mode: resolvedCoverageMode,
					include_single_entries: resolvedIncludeSingleEntries,
					closed_loop_coverage: {
						total: closedLoopCoverage.cells.length,
						covered: closedLoopCoverage.covered_cells.length,
						missing: closedLoopCoverage.missing_cells.length,
						excluded: closedLoopCoverage.excluded_entries.length,
						gaps: closedLoopCoverage.gaps.length
					}
				});
				return;
			}

			const points = await loadArtifact(root, projectId, 'points');
			// 分支驱动与合同驱动共用同一道大纲闸门：范围只有一份。
			if (outline?.items.length && (points.source_outline_digest !== outline.digest || outline.items[0].status !== 'approved' || outline.items[0].source_ecsm_digest !== frozen.digest)) {
				throw new Error('请按已批准的当前大纲生成并批准测试点');
			}
			if (points.items.length === 0) throw new Error('还没有测试点：先生成测试点');
			const scopedIds = Array.isArray(body.point_ids) && body.point_ids.length ? new Set(body.point_ids) : null;
			const inScope = scopedIds ? points.items.filter((point) => scopedIds.has(point.point_id)) : points.items;
			if (scopedIds && inScope.length !== scopedIds.size) throw new Error('选择的测试点不存在');
			let variant = null;
			if (body.case_variant) {
				const requested = body.case_variant;
				const alternatives = String(inScope[0]?.action || '').split(/或/).map((entry) => entry.trim());
				const position = alternatives.indexOf(requested.action);
				if (inScope.length !== 1 || !scopedIds || requested.point_id !== inScope[0].point_id ||
					alternatives.length < 2 || position < 0 || body.draft !== false ||
					body.replace === true || body.retry_defective === true || body.review_repair) {
					throw new Error('请选择同一已批准测试点中明确写出的单条触发路径');
				}
				variant = { point_id: requested.point_id, case_role: 'path-' + (position + 1), action: requested.action };
			}
			if (frozen && (points.source_ecsm_digest !== frozen.digest || inScope.some((item) => item.review_status !== 'approved'))) {
				throw new Error('请先按当前冻结模型生成并批准测试点');
			}
			const facts = frozen?.inputs.facts || await loadArtifact(root, projectId, 'facts');
			const factIds = new Set(facts.items.map((fact) => fact.fact_id));
			const pointIds = new Set(points.items.map((point) => point.point_id));
			const pointMap = new Map(points.items.map((point) => [point.point_id, point]));
			const current = await loadArtifact(root, projectId, 'cases');
			const repair = body.review_repair ? await reviewRepairInput(projectId, 'cases', body.review_repair.object_id, body.review_repair.finding_indexes) : null;
			if (repair && (body.retry_defective !== true || body.replace === true || body.review_repair.basis !== repair.basis ||
				!Array.isArray(body.case_ids) || body.case_ids.length !== 1 || body.case_ids[0] !== repair.item.case_id ||
				!scopedIds || scopedIds.size !== 1 || !scopedIds.has(repair.item.point_id))) {
				throw new Error('修改范围或基线已变化，请重新预览');
			}
			// 重跑默认只补缺口：整轮重生成必须显式要求，否则一次重试会丢掉已完成批次。
			const replaceCases = body.replace === true;
			if (frozen && !replaceCases && current.items.length && current.source_points_digest !== digestOf(points.items)) throw new Error('追加用例需要使用同一版测试点');
			if (replaceCases) await archiveArtifact(root, projectId, 'cases');
			// 只重做判定不合格的個案：结构闸门拦下的用例回到缺口，合格的原样保留。
			const retained = replaceCases ? [] : current.items.slice();
			let reviewFeedback = new Map();
			const redo = new Map();
			const redoPoints = new Set();
			if (body.retry_defective === true && !replaceCases) {
				const factsForLint = frozen?.inputs.facts || await loadArtifact(root, projectId, 'facts');
				const ids = new Set(points.items.map((point) => point.point_id));
				const fids = new Set(factsForLint.items.map((fact) => fact.fact_id));
				const pmap = new Map(points.items.map((point) => [point.point_id, point]));
				const defective = new Set(retained.filter((item) => lint([item], ids, fids, pmap)
					.some((error) => error.severity !== 'warning')).map((item) => item.case_id));
				// 报文/字段/方向对不上本版 DBC 也是不合格，不能靠人工事后发现。
				// 只查项目声明的那份 DBC；没声明协议来源的项目跳过本项，不猜文件。
				const dbcRelative = declaredSource('dbc');
				if (hasCapability('protocol') && dbcRelative) {
					const dbc = parseDbc(path.join(root, 'projects', projectId, dbcRelative));
					const hard = new Set(['unknown_signal', 'unknown_message', 'ambiguous_message']);
					for (const row of auditCases(retained, dbc)) {
						if (hard.has(row.status)) defective.add(row.case_id);
					}
				}
				// 内容评审退回也是不合格：只看结构错误会把语义退回当成已有产物跳过。
				const reviews = loadReviews(root, projectId);
				const reviewByCase = new Map(reviews.items.map((entry) => [entry.case_id, entry]));
				const semantic = new Map();
				for (const item of retained) {
					const entry = reviewByCase.get(item.case_id);
					if (!entry || (entry.review_kind !== 'content' && entry.review_kind !== 'model')) continue;
					if (entry.case_digest !== caseDigest(item)) continue;
					if (PASS.has(entry.conclusion)) continue;
					defective.add(item.case_id);
					semantic.set(caseVariant(item), { case_id: item.case_id, basis: entry.basis || '', fields: entry.fields || {}, findings: entry.findings || [] });
				}
				if (repair) {
					defective.add(repair.item.case_id);
					semantic.set(caseVariant(repair.item), { case_id: repair.item.case_id, findings: repair.findings });
				}
				// 限定范围时取「所选 ∩ 缺陷」：范围外的用例既不撤下也不改动，选 1 个点不会波及其他 19 条。
				const scoped = Array.isArray(body.point_ids) && body.point_ids.length ? new Set(body.point_ids) : null;
				const inScope = retained.filter((item) => defective.has(item.case_id) && (!scoped || scoped.has(item.point_id)));
				const targetedCases = Array.isArray(body.case_ids) ? new Set(body.case_ids) : null;
				const targeted = inScope.filter((item) => !targetedCases || targetedCases.has(item.case_id));
				for (const item of targeted) {
					redo.set(caseVariant(item), item);
					redoPoints.add(item.point_id);
				}
				if (redo.size) await archiveArtifact(root, projectId, 'cases');
				// 范围外的缺陷也要报数：不声不响跳过会让人以为它们合格。
				if (defective.size) {
					send('cases.defective', { case_ids: targeted.map((item) => item.case_id), count: targeted.length,
						semantic_returns: targeted.filter((item) => semantic.has(caseVariant(item))).length,
						out_of_scope: defective.size - targeted.length });
				}
				reviewFeedback = semantic;
			}
			// 增量影响重跑：显式指定 redo_selected=true 时，仅重做所选 point_ids 的用例，其余已批准用例原样保留。
			if (body.redo_selected === true && !replaceCases && Array.isArray(body.point_ids) && body.point_ids.length) {
				const redoSet = new Set(body.point_ids);
				for (const item of retained) {
					if (redoSet.has(item.point_id) && !redo.has(caseVariant(item))) {
						redo.set(caseVariant(item), item);
						redoPoints.add(item.point_id);
					}
				}
				if (redo.size) await archiveArtifact(root, projectId, 'cases');
			}
			// 旧用例先留着：新候选校验并保存成功后才按点撤下，生成失败时原用例仍可读。
			const done = new Set(retained.map((item) => item.point_id));
			for (const pointId of redoPoints) done.delete(pointId);
			if (variant && !retained.some((item) => caseVariant(item) === caseVariant(variant))) done.delete(variant.point_id);
			const delayed = outline?.items.length ? new Set((await loadArtifact(root, projectId, 'deferrals')).items
				.filter((item) => item.outline_digest === outline.digest && item.points_digest === digestOf(points.items)).map((item) => item.point_id)) : new Set();
			const pending = points.items.filter((point) => !done.has(point.point_id) && !delayed.has(point.point_id)
				&& (!Array.isArray(body.point_ids) || !body.point_ids.length || body.point_ids.includes(point.point_id)));
			// Structured points carry a full assertion checklist; a batch of 8 would
			// overflow the completion budget and silently truncate the JSON.
			// Measured on V5: one case renders ~1300 + 400×assertions JSON chars.
			const assertionLoad = pending.reduce((sum, point) => sum + (point.expected_items?.length || 1), 0);
			const structured = pending.some((point) => point.expected_items?.length);
			const perCase = 1300 + 400 * (assertionLoad / Math.max(1, pending.length));
			const batchSize = structured ? Math.max(1, Math.min(CASE_BATCH, Math.floor(12000 / perCase))) : CASE_BATCH;
			const batches = chunk(pending, batchSize).slice(0, CASE_MAX_BATCHES);
			let items = retained.slice();
			let droppedTotal = 0;
			const droppedReasons = {};
			const bindingDoc = frozen?.inputs.bindings || loadBindings(root, projectId);
			const visualLibrary = await moduleCaseVisuals(projectInfo, projectId, bindingDoc);
			const reusableFigures = confirmedFigures(current.items);
			const previousByVariant = new Map((current.source_points_digest === digestOf(points.items) ? current.items : []).map((item) => [caseVariant(item), item]));
			const manualFor = (pointId, role) => {
				const previous = previousByVariant.get(caseVariant({ point_id: pointId, case_role: role }));
				return previous && (!role || role === (previous.case_role || 'primary')) ? (previous.image_refs || []).filter((figure) => figure.manual) : [];
			};
			let imageWarning = '';
			const { index: caseSignalIndex } = buildSignalIndex(projectInfo.dir);
			const caseFeaturesDoc = frozen?.inputs.features || await loadArtifact(root, projectId, 'features');
			const uiIndex = loadUiIndex(root, projectId);
			const uiStatesByNode = new Map();
			const pushNodeState = (nodeKey, stateVal) => {
				if (!nodeKey || !stateVal || stateVal === '变体' || stateVal === 'state_variant') return;
				const list = uiStatesByNode.get(nodeKey) || [];
				if (!list.includes(stateVal)) list.push(stateVal);
				uiStatesByNode.set(nodeKey, list);
			};
			for (const obj of uiIndex?.objects || []) {
				const st = obj.state;
				if (!st || st === '变体' || st === 'state_variant') continue;
				pushNodeState(obj.node_id || obj.n, st);
				pushNodeState(obj.board, st);
				pushNodeState(obj.parent, st);
			}
			const signalDetails = (name, fallback = {}) => {
				const meta = caseSignalIndex.get(String(name || '').replace(/[\s_-]/g, '').toLowerCase());
				return {
					...fallback,
					name,
					message: fallback.message || meta?.message || '',
					message_id: fallback.message_id || meta?.message_id || '',
					direction: fallback.direction || (meta?.transmitter ? directionOf(meta.transmitter) : ''),
					cycle: fallback.cycle || meta?.cycle || '',
					valueDesc: fallback.valueDesc || meta?.valueDesc || '',
					initial: fallback.initial || meta?.initial || '',
					invalid: fallback.invalid || meta?.invalid || ''
				};
			};
			const byFact = new Map();
			for (const binding of bindingDoc.items) {
				for (const factId of binding.subject.fact_ids || []) {
					const entry = byFact.get(factId) || { controls: [], ambiguousControls: [], signals: [] };
					if (binding.kind === 'control' && binding.status === 'ambiguous') {
						entry.ambiguousControls.push({
							name: binding.subject.name,
							candidates: (binding.candidates || []).map((c) => `${c.name}${c.node_id ? `(${c.node_id})` : ''}`).slice(0, 4)
						});
						byFact.set(factId, entry);
						continue;
					}
					if (binding.status !== 'bound' || !binding.target) continue;
					const target = binding.kind === 'control'
						? {
							name: binding.subject.name,
							businessName: stripDesignComponentPrefix(binding.subject.name),
							componentName: binding.target.name || binding.subject.name,
							node_id: binding.target.node_id,
							page: binding.target.page || binding.subject.page || '',
							states: uiStatesByNode.get(binding.target.node_id) || []
						}
						: signalDetails(binding.subject.name, { message: binding.target.message, message_id: binding.target.message_id });
					entry[binding.kind === 'control' ? 'controls' : 'signals'].push(target);
					byFact.set(factId, entry);
				}
			}
			// 未绑定但协议来源（DBC/Excel矩阵）能精确唯一命中的信号也要给出报文、方向与枚举，否则准备项写不出基线读回。
			// 拼写有差异的信号不给：那属于待裁决，不自动替换。
			const hintDbc = hasCapability('protocol') && declaredSource('dbc')
				? parseDbc(path.join(root, 'projects', projectId, declaredSource('dbc'))) : null;
			const exactSignals = new Map();
			const matchesSignal = (name) => {
				if (!exactSignals.has(name)) exactSignals.set(name, locateSignal(hintDbc, name));
				return exactSignals.get(name);
			};
			const formatValueTable = (signal) => {
				if (signal?.valueDesc) return signal.valueDesc;
				if (!signal?.valueTable) return '';
				return Object.entries(signal.valueTable).map(([k, v]) => `${k}:${v}`).join(' / ');
			};
			const hintsFor = (point) => {
				const merged = { controls: [], ambiguousControls: [], signals: [] };
				for (const factId of point.fact_refs || []) {
					const entry = byFact.get(factId);
					if (!entry) continue;
					merged.controls.push(...entry.controls);
					merged.ambiguousControls.push(...(entry.ambiguousControls || []));
					merged.signals.push(...entry.signals);
				}
				const feedbackAttribution = resolvePointFeedbackAttribution(point, {
					facts: facts.items,
					features: caseFeaturesDoc.items,
					bindings: bindingDoc.items,
					signalIndex: caseSignalIndex,
					dut: dutNode(),
					surface: defaultSurface()
				});
				if (feedbackAttribution.status === 'unique_feedback' && feedbackAttribution.attributions?.length) {
					for (const attr of feedbackAttribution.attributions) {
						if (attr.feedback_signal && !merged.signals.some((s) => s.name === attr.feedback_signal)) {
							merged.signals.push(signalDetails(attr.feedback_signal, { message: attr.message, message_id: attr.message_id }));
						}
					}
				}
				const subjects = (point.expected_items || []).flatMap((entry) => [entry.signal || entry.object, ...(entry.signals || [])]);
				for (const name of new Set(subjects)) {
					if (!hintDbc || !name) continue;
					const hits = matchesSignal(name);
					if (hits.length !== 1) continue;
					const { message, signal } = hits[0];
					const bound = merged.signals.find((item) => item.name === name);
					if (bound && (bound.message !== message.name || Number(bound.message_id) !== Number(message.id))) continue;
					merged.signals.push({
						name, message: message.name, message_id: message.id,
						direction: directionOf(message.transmitter),
						cycle: message.cycle || '',
						valueDesc: formatValueTable(signal),
						initial: signal.initial || '',
						invalid: signal.invalid || ''
					});
				}
				const dedupe = (list) => [...new Map(list.map((item) => [item.name, item])).values()];
				return {
					controls: dedupe(merged.controls),
					ambiguousControls: dedupe(merged.ambiguousControls),
					signals: dedupe(merged.signals),
					feedbackAttribution
				};
			};
			const run = startRun(root, projectId, {
				points_digest: digestOf(points.items), points_version: points.version,
				ecsm_digest: frozen?.digest || null, outline_digest: outline?.digest || null,
				cases_version: current.version, cases_digest: current.digest,
				role, provider: model.provider, model: model.model, skill: STAGE_SKILLS.cases,
				instructions_digest: digestOf(instructions), point_ids: pending.map((point) => point.point_id)
			});
			send('run.manifest', { run_id: run.run_id, baseline_digest: run.baseline_digest, batches: batches.length, pending: pending.map((point) => point.point_id) });
			let tracked = current;
			let stopped = null;
			const failedPoints = [];
			const droppedDetailsByPoint = new Map();
			// Each batch is persisted on its own: a later failure keeps earlier work.
			const persist = async (nextItems) => {
				const release = await acquireLock(root, projectId);
				try {
					assertWritable(projectId);
					const latest = await loadArtifact(root, projectId, 'cases');
					if (latest.version !== tracked.version || latest.digest !== tracked.digest) throw new Error('生成期间用例已被修改，请重新生成');
					if (repair && latest.version === current.version
						&& (await reviewRepairInput(projectId, 'cases', body.review_repair.object_id, body.review_repair.finding_indexes)).basis !== repair.basis) {
						throw new Error('审查资料或选中的意见已有变化，请重新预览');
					}
					if (frozen && (await requireFrozenModel(projectId)).digest !== frozen.digest) throw new Error('生成期间 ECSM 已变化，请重试');
					if (outline?.items.length && (await loadArtifact(root, projectId, 'outline')).digest !== outline.digest) throw new Error('测试大纲已变化，请重试');
					if (await branchOutlineStale(projectId, outline?.items[0])) throw new Error(staleBranchOutlineMessage);
					if (digestOf((await loadArtifact(root, projectId, 'points')).items) !== digestOf(points.items)) throw new Error('生成期间测试点已变化，请重试');
					const saved = await saveArtifact(root, projectId, 'cases', { version: tracked.version, items: nextItems, meta: {
						source_points_digest: digestOf(points.items), source_points_version: points.version, source_ecsm_digest: frozen?.digest || null
					} });
					tracked = saved;
					return saved;
				} finally {
					await release();
				}
			};
			for (let index = 0; index < batches.length; index += 1) {
				if (aborted) {
					stopped = '用户已取消生成';
					break;
				}
				send('phase', { step: index + 1, total: batches.length, label: `展开用例 ${index + 1}/${batches.length}` });
				const batchPoints = batches[index].map((point) => point.point_id);
				const hints = {};
				const visualsByPoint = {};
				for (const point of batches[index]) {
					const automatic = await visualLibrary.forPoint(point).catch((error) => { imageWarning = error.message; return []; });
					const figures = [...manualFor(point.point_id), ...automatic];
					visualsByPoint[point.point_id] = figures;
					const retryVariants = [...redo.values()].filter((item) => item.point_id === point.point_id);
					const reviews = retryVariants.map((item) => reviewFeedback.get(caseVariant(item))).filter(Boolean);
					const review = reviews.length ? { ...reviews[0], case_id: reviews.map((entry) => entry.case_id).join('、'),
						findings: reviews.flatMap((entry) => entry.findings || []) } : null;
					hints[point.point_id] = { ...hintsFor(point), figures, review, variant,
						retryRoles: retryVariants.map((item) => item.case_role || 'primary'),
						retryPaths: retryVariants.filter((item) => item.variant_action).map((item) => ({ case_role: item.case_role, action: item.variant_action })) };
				}
				let added = [];
				let batchDrops = [];
				try {
					const writingPoints = batches[index].map((point) => {
						if (!hintDbc || !point.expected_items?.length) return point;
						const confirmed = hints[point.point_id].signals.filter((item) => item.message && item.message_id);
						const known = new Set(confirmed.map((item) => item.name));
						const protocol_readbacks = Object.fromEntries(confirmed.filter(({ name }) => matchesSignal(name).length === 1)
							.map(({ name }) => [name, { message: matchesSignal(name)[0].message.name, message_id: matchesSignal(name)[0].message.id }]));
						return { ...point, protocol_readbacks, expected_items: point.expected_items.map((entry) => {
							const fields = [...new Set([...(entry.signals || []), entry.signal ||
								(/^can_(request|feedback)$/.test(entry.kind) ? entry.object : '')].filter(Boolean))];
							const missing = fields.filter((name) => !known.has(name) && matchesSignal(name).length !== 1);
							return missing.length ? { ...entry, binding_blocked: true, blocking: true,
								unresolved: [entry.unresolved, '通信来源未唯一确认原文字段「' + missing.join('、') + '」'].filter(Boolean).join('；') } : entry;
						}) };
					});
					const writingPointMap = new Map(writingPoints.map((point) => [point.point_id, point]));
					const prompt = casePrompt(writingPoints, projectInfo.name, hints);
					const environment = outline?.items[0]?.environment;
					const caseInput = environment ? prompt + '\n本轮环境可观察范围：' + environment + '\n区分可验证项与受限项。' : prompt;
					const emitImageWarning = (error) => { imageWarning = error.message; };
					const rawText = await collectCase(model, projectId, instructions + caseInput, visualsByPoint, emitImageWarning);
					const parsed = parseJson(rawText);
					if (!parsed) send('batch.parse_failed', { batch: index + 1, chars: String(rawText || '').length, tail: String(rawText || '').slice(-200) });
					const untouched = items.filter((item) => !redo.has(caseVariant(item)));
					const merged = mergeCasesDetailed(untouched, parsed, new Set(batchPoints), writingPointMap);
					const repairable = new Set(['CAPTURE_NOT_RECORDING', 'TRIGGER_MISSING', 'OBSERVATION_MISSING',
						'OBSERVATION_OBJECT_MISMATCH', 'OBSERVATION_WRONG_SURFACE', 'EXPECTED_EMPTY',
						'ASSERTION_COVERAGE_MISSING', 'ASSERTION_FRAME_COUNT_MISMATCH', 'ASSERTION_REF_MISMATCH']);
					const returned = merged.dropped.filter((drop) => (repairable.has(drop.reason) || drop.issues?.length)
						&& !merged.added.some((item) => item.point_id === drop.point_id));
					if (returned.length) {
						const retryIds = new Set(returned.map((drop) => drop.point_id));
						send('batch.candidate_rejected', { batch: index + 1, attempt: 1, candidates: returned });
						const retryPoints = writingPoints.filter((point) => retryIds.has(point.point_id));
						const feedback = returned.map((drop) =>
							`${drop.point_id} ${drop.reason} ${(drop.assertion_refs || []).join('、')} ${(drop.issues || []).map((issue) => issue.message).join('；')}`);
						try {
							const retryInput = casePrompt(retryPoints, projectInfo.name, hints)
								+ '\n只重新提交本次校验未通过的测试点。修正下列问题：\n' + feedback.join('\n')
								+ '\n修正提示：若为 OBSERVATION_OBJECT_MISMATCH，请将对应 expected_items[].object 名称一字不差写入其锚定的 observe 步骤的【】内（且每个 observe 步骤仅保留一对【】）；若为 STEP_MULTIPLE_OBJECTS，请拆成多个独立 observe 步骤；若为 EXPECTED_EMPTY，请补全非空的 expected_items（含 object/target/kind/observe），若确有阻断缺口则写入 deferred_items 并写明 unresolved。'
								+ (environment ? '\n本轮环境可观察范围：' + environment : '');
							const retryVisuals = Object.fromEntries([...retryIds].map((id) => [id, visualsByPoint[id]]));
							const repair = parseJson(await collectCase(model, projectId, instructions + retryInput, retryVisuals, emitImageWarning));
							const retried = mergeCasesDetailed([...untouched, ...merged.added], repair, retryIds, writingPointMap);
							merged.added.push(...retried.added);
							const recovered = new Set(retried.added.map((item) => item.point_id));
							merged.dropped = merged.dropped.filter((drop) => !recovered.has(drop.point_id)).concat(retried.dropped);
						} catch (error) {
							send('batch.repair_failed', { batch: index + 1, point_ids: [...retryIds], error: error.message });
						}
					}
					merged.added = merged.added.filter((item) => !redoPoints.has(item.point_id) || redo.has(caseVariant(item)));
					if (variant) merged.added = merged.added.filter((item) => caseVariant(item) === caseVariant(variant));
					batchDrops = merged.dropped;
					if (batchDrops.length) send('batch.candidate_rejected', { batch: index + 1, candidates: batchDrops });
					for (const drop of merged.dropped) {
						droppedTotal += 1;
						droppedReasons[drop.reason] = (droppedReasons[drop.reason] || 0) + 1;
						if (drop.point_id) {
							droppedDetailsByPoint.set(drop.point_id, {
								point_id: drop.point_id,
								reason: drop.reason || 'CANDIDATE_REJECTED',
								assertion_refs: Array.isArray(drop.assertion_refs) ? drop.assertion_refs : [],
								messages: (drop.issues || []).map((issue) => issue.message || String(issue)).filter(Boolean).slice(0, 6)
							});
						}
					}
					added = decorateCases(
						merged.added
							.map(normalizeCaseStructure)
							.map((c) => enrichPrepareFeedbackReadback(c, pointMap.get(c.point_id), hints[c.point_id]?.feedbackAttribution, defaultSurface(), bindingDoc)),
						bindingDoc
					);
					for (const item of added) {
						const point = pointMap.get(item.point_id);
						const variantAction = variant?.action || redo.get(caseVariant(item))?.variant_action;
						if (variantAction) item.variant_action = variantAction;
						if (outline?.items.length) {
							item.scenario_refs = point.scenario_refs;
							item.contract_refs = point.contract_refs;
							item.fact_refs = point.fact_refs;
							if (!item.restore_steps.length && point.recovery) item.restore_steps = [point.recovery];
						}
						const figures = await visualLibrary.forPoint(point, item.steps, item.expected, item.precondition, reusableFigures)
							.catch((error) => { imageWarning = error.message; return visualsByPoint[item.point_id].filter((figure) => !figure.manual); });
						const previous = previousByVariant.get(caseVariant(item));
						const manual = manualFor(item.point_id, item.case_role).filter((figure) => {
							const basis = figureBasis(previous, figure.role, figure.step);
							return basis ? basis === figureBasis(item, figure.role, figure.step) : !figure.step && !figure.reuse;
						});
						item.image_refs = [...new Map([...figures, ...manual].map((f) => [JSON.stringify([f.role, f.step, f.file]), f])).values()];
					}
					// 撤下不合格用例后数组长度会小于最大编号，按长度分配会撞号。
					let lastCaseNumber = items.reduce((max, item) => Math.max(max, Number(String(item.case_id || '').replace(/^C-/, '')) || 0), 0);
					added = added.map((item) => ({ ...item, case_id: redo.get(caseVariant(item))?.case_id
						|| `C-${String(++lastCaseNumber).padStart(4, '0')}` }));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failedPoints.push(...batchPoints.map((point_id) => ({ point_id, batch: index + 1, error: message })));
					recordBatch(root, projectId, run, { index: index + 1, point_ids: batchPoints, status: 'failed', case_ids: [], error: message });
					send('batch.failed', { batch: index + 1, point_ids: batchPoints, error: message });
					continue;
				}
				// Accounting is per point, not per batch: a batch can succeed for two
				// points and still leave the third one honestly pending.
				const produced = new Set(added.map((item) => item.point_id));
				const completedVariants = new Set(added.map(caseVariant));
				const missingInBatch = batchPoints.filter((point_id) => !produced.has(point_id)
					|| [...redo].some(([key, item]) => item.point_id === point_id && !completedVariants.has(key))).map((point_id) => ({
					point_id, batch: index + 1,
					error: batchDrops.filter((drop) => drop.point_id === point_id).map((drop) => drop.reason).join('、') || '模型未返回该测试点的可用用例'
				}));
				failedPoints.push(...missingInBatch);
				if (!added.length) {
					recordBatch(root, projectId, run, { index: index + 1, point_ids: [], status: 'failed', case_ids: [], failed_points: missingInBatch, error: '模型没有返回可用用例' });
					send('batch.failed', { batch: index + 1, point_ids: batchPoints, error: '模型没有返回可用用例' });
					continue;
				}
				const byVariant = new Map(items.map((item) => [caseVariant(item), item]));
				for (const item of added) byVariant.set(caseVariant(item), item);
				items = [...byVariant.values()];
				try {
					await persist(items);
				} catch (error) {
					stopped = error instanceof Error ? error.message : String(error);
					items = tracked.items.slice();
					recordBatch(root, projectId, run, { index: index + 1, point_ids: [], status: 'aborted', case_ids: [], failed_points: batchPoints.map((point_id) => ({ point_id, error: stopped })), error: stopped });
					send('batch.aborted', { batch: index + 1, point_ids: batchPoints, error: stopped });
					break;
				}
				recordBatch(root, projectId, run, { index: index + 1, point_ids: [...produced], status: 'ok', case_ids: added.map((item) => item.case_id), failed_points: missingInBatch });
				if (repair) {
					const revised = added.find((item) => caseVariant(item) === caseVariant(repair.item));
					if (revised) {
						const fields = ['title', 'precondition', 'prepare_detail', 'steps', 'expected', 'deferred_items', 'restore_steps', 'failure_policy'];
						send('repair.diff', { before_id: repair.item.case_id, after_id: revised.case_id,
							changes: fields.filter((field) => digestOf(repair.item[field] ?? null) !== digestOf(revised[field] ?? null))
								.map((field) => ({ field, before: repair.item[field], after: revised[field] })) });
					}
				}
				send('artifact.updated', { kind: 'cases', count: items.length });
			}
			// Feature ids and design-node annotations are cheap and idempotent, but only
			// the new rows are touched: a retry must not rewrite an accepted case.
			const caseFeatures = frozen?.inputs.features || await loadArtifact(root, projectId, 'features');
			const factFeatures = new Map();
			for (const feature of caseFeatures.items) for (const ref of feature.fact_refs || []) factFeatures.set(ref, feature.feature_id);
			const fresh = new Set(run.batches.filter((entry) => entry.status === 'ok').flatMap((entry) => entry.case_ids));
			for (const item of items) {
				if (!fresh.has(item.case_id)) continue;
				if (item.feature_id) continue;
				const point = pointMap.get(item.point_id);
				const refs = point?.fact_refs || [];
				item.feature_id = refs.map((ref) => factFeatures.get(ref)).find(Boolean) || '';
			}
			if (fresh.size) decorateCases(items.filter((item) => fresh.has(item.case_id)), loadBindings(root, projectId));
			const errors = lint(items, pointIds, factIds, pointMap);
			if (droppedTotal > 0) send('dropped', { total: droppedTotal, reasons: droppedReasons });
			const serious = errors.filter((error) => error.severity !== 'warning');
			send('lint', { total: items.length, errors: errors.slice(0, 20), errorCount: serious.length, warningCount: errors.length - serious.length });
			let saved = tracked;
			if (digestOf(items) !== digestOf(tracked.items)) saved = await persist(items);
			const openQuestions = await refreshQuestions(projectId).then((document) => document.items.filter((item) => item.status === 'open').length).catch(() => 0);
			send('questions.updated', { open: openQuestions });
			const linked = await refreshUiLinks(projectId, { figures: true, caseIds: fresh }).catch(() => null);
			const producedPointIds = new Set(items.map((item) => item.point_id));
			const droppedDetails = [...droppedDetailsByPoint.values()].filter((entry) => !producedPointIds.has(entry.point_id));
			const pendingIds = pendingPoints(points, saved, digestOf(points.items), delayed);
			finishRun(root, projectId, run, { pendingIds, stopped, droppedDetails });
			send('run.end', { kind: 'cases', count: items.length, version: linked?.casesVersion || saved.version, dropped: droppedTotal, dropped_details: droppedDetails, missing: pendingIds.length,
				run_id: run.run_id, baseline_digest: run.baseline_digest,
				completed_ids: [...new Set(run.completed_ids)], failed_ids: [...new Set([...run.failed_ids, ...failedPoints.map((entry) => entry.point_id)])], pending_ids: pendingIds,
				failures: failedPoints, stopped,
				missingImages: items.filter((item) => !item.image_refs?.length).length,
				missingInterfaceImages: items.filter((item) => caseGaps(projectId, item).length).length, imageWarning });
		} catch (error) {
			send('error', { code: error.code || 'GENERATE_FAILED', message: error instanceof Error ? error.message : String(error) });
		} finally {
			clearInterval(heartbeat);
			res.end();
		}
	};

	const reviewInputs = async (project, stage) => {
		const [document, facts, contracts, points, rawEvidence] = await Promise.all([
			loadArtifact(root, project, stage), loadArtifact(root, project, 'facts'),
			loadArtifact(root, project, 'contracts'), loadArtifact(root, project, 'points'),
			scopedEvidence(project).catch((error) => {
				if (error.code !== 'ENOENT') throw error;
				return { items: [] };
			})
		]);
		const reviewUiIndex = loadUiIndex(root, project);
		const reviewPrdText = (rawEvidence.items || []).filter((item) => item.kind !== 'design').map((item) => item.text || '').join('\n');
		const evidence = semanticEvidenceDocument(rawEvidence, { uiIndex: reviewUiIndex, prdText: reviewPrdText, aliases: configTerms('aliases') });
		const key = REVIEW_STAGES[stage].id;
		const objects = stage === 'outline' ? document.items[0]?.items || [] : document.items;
		const contractsById = new Map(contracts.items.map((item) => [item.contract_id, item]));
		const factsById = new Map(facts.items.map((item) => [item.fact_id, item]));
		const pointsById = new Map(points.items.map((item) => [item.point_id, item]));
		const evidenceById = new Map(evidence.items.map((item) => [item.id, item]));
		const reviewBindings = loadBindings(root, project);
		const parentFor = (item) => pointsById.get(item.point_id);
		const contextFor = (item) => {
			const point = stage === 'cases' ? parentFor(item) : null;
			const parents = (item.contract_refs || point?.contract_refs || []).map((id) => contractsById.get(id)).filter(Boolean);
			const facts = [...new Set([...(item.fact_refs || []), ...(point?.fact_refs || []), ...parents.flatMap((row) => row.fact_refs || [])])]
				.map((id) => factsById.get(id)).filter(Boolean);
			const refs = [...new Set(facts.flatMap((fact) => fact.evidence_refs || []))];
			for (const ref of [item.source?.evidence_id, point?.source?.evidence_id, ...(item.evidence_refs || [])]) {
				if (ref && !refs.includes(ref)) refs.push(ref);
			}
			const sources = refs.map((id) => evidenceById.get(id)).filter(Boolean).slice(0, 8)
				.map(({ id, source, location, text }) => ({ id, source, location, text: String(text || '').slice(0, 1200) }));
			const figures = (item.image_refs || []).map(({ node_id, role, revision, step_id, expected_id, name, sha256, state }) =>
				({ node_id, role, revision, step_id, expected_id, name, sha256, state }));
			const itemText = JSON.stringify(item);
			const signal_bindings = (reviewBindings?.items || [])
				.filter((b) => b.kind === 'signal' && b.status === 'bound' && b.target && b.subject?.name && itemText.includes(b.subject.name))
				.map((b) => ({
					name: b.subject.name,
					description: b.target.description || '',
					message: b.target.message || '',
					message_id: b.target.message_id || '',
					transmitter: b.target.transmitter || '',
					receivers: b.target.receivers || [],
					initial: b.target.initial || '',
					invalid: b.target.invalid || '',
					valueDesc: b.target.valueDesc || ''
				}));
			return { point, requirements: parents, original: item.source || point?.source, sources, signal_bindings, deferred: item.deferred_items,
				missing_sources: refs.filter((id) => !evidenceById.has(id)), figures };
		};
		const sourceBasis = digestOf([evidence.items, facts.items, stage === 'contracts' ? [] : contracts.items,
			stage === 'cases' ? points.items : [], stage === 'cases' ? objects.map((item) => contextFor(item).figures) : []]);
		return { document, objects, key, contextFor, sourceBasis,
			baseline: stage === 'cases' ? casesContentBaseline(document) : document.digest };
	};

	const reviewRepairInput = async (project, stage, id, indexes) => {
		const inputs = await reviewInputs(project, stage);
		const report = await loadArtifact(root, project, 'agent-review-' + stage);
		if (report.baseline !== inputs.baseline || report.evidence_version !== inputs.sourceBasis) throw new Error('审查意见已过期，请重新审查');
		const item = inputs.objects.find((row) => row[inputs.key] === id);
		const receipt = report.items.find((row) => row.object_id === id);
		if (!item || !receipt || !Array.isArray(indexes) || !indexes.length ||
			indexes.some((index) => !Number.isInteger(index) || !receipt.findings[index])) throw new Error('请选择该条目当前的审查意见');
		const findings = [...new Set(indexes)].map((index) => receipt.findings[index]);
		return { inputs, item, findings, basis: digestOf([inputs.baseline, inputs.sourceBasis, id, findings]) };
	};

	const runReview = async (req, res) => {
		const rejection = ctx.connection?.requestRejection?.(req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		const raw = await readBody(req);
		if (raw === null) {
			sendJson(res, 413, { ok: false, error: '请求体过大' });
			return;
		}
		let body;
		try {
			body = JSON.parse(raw || '{}');
		} catch {
			sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' });
			return;
		}
		enterScope(await scopeRequest(body));
		enterSkillScope(root);
		if (typeof body.project !== 'string' || !body.project) {
			sendJson(res, 400, { ok: false, error: '缺少项目' });
			return;
		}
		const stage = body.stage ?? 'cases';
		if (typeof stage !== 'string' || !Object.hasOwn(REVIEW_STAGES, stage)) {
			sendJson(res, 400, { ok: false, error: '不支持的审查阶段' });
			return;
		}
		const stageInfo = REVIEW_STAGES[stage];
		res.statusCode = 200;
		res.setHeader('content-type', 'text/event-stream; charset=utf-8');
		res.setHeader('cache-control', 'no-cache, no-transform');
		res.setHeader('connection', 'keep-alive');
		res.setHeader('x-accel-buffering', 'no');
		const record = activityFor(body.project, stage === 'cases' ? '独立审查用例' : '独立审查' + stageInfo.title, 'quality', stage);
		const send = (event, data) => {
			trackStream(record, event, data);
			if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};
		let aborted = false;
		const heartbeat = setInterval(() => {
			if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
		}, 15000);
		heartbeat.unref();
		res.once('close', () => {
			if (!res.writableEnded) aborted = true;
			clearInterval(heartbeat);
		});
		try {
			const inputs = await reviewInputs(body.project, stage);
			const { document, objects, key, contextFor, sourceBasis, baseline } = inputs;
			const requested = body.object_ids ?? body.case_ids;
			if (requested !== undefined && (!Array.isArray(requested) || !requested.length || requested.some((id) => typeof id !== 'string'))) {
				throw new Error('请选择需要审查的条目');
			}
			const selected = requested ? new Set(requested) : null;
			const items = selected ? objects.filter((item) => selected.has(item[key])) : objects;
			if (!items.length || (selected && items.length !== selected.size)) throw new Error('审查范围为空或存在已失效条目');
			if (body.baseline && body.baseline !== baseline) throw new Error('审查基线已变化，请重新选择');
			const model = await resolveModel(ctx, config);
			send('run.start', { kind: 'review', role: 'quality', stage, object_ids: items.map((item) => item[key]), total: items.length });
			record('progress', selected ? [...selected].join('、') : '本阶段全部条目');
			const pageSize = Math.max(1, Math.min(stage === 'cases' ? 4 : 8, Math.round(Number(body.page_size) || (stage === 'cases' ? 2 : 4))));
			const reviewer = String(body.reviewer || '质量审查 Agent');
			const reviewVision = stage === 'cases' && (config?.reviewVision === true || currentConfig().review_vision === true);
			const reviewParams = { maxTokens: 4000, reasoningEffort: 'off→low→default', visual: reviewVision };
			const promptFor = (rows) => [
				'角色：质量审查 Agent。只根据当前产物及所给依据审查。' + stageInfo.checks,
				stage === 'cases' ? reviewPrompt(rows) : compose(STAGE_SKILLS.review,
					'当前审查对象是' + stageInfo.title + '。按对象编号逐条返回 JSON',
					'{"receipts":[{"case_id":"从对象复制编号","conclusion":"通过|待修改|待证据","findings":[{"code":"REVIEW","field":"字段或义务","message":"具体问题"}]}]}',
					rows.map((item) => '[' + item[key] + '] ' + JSON.stringify(item)).join('\n')),
				'需要依据时为发现填写 evidence_ref（给出的证据编号）、quote（逐字引文）和 suggestion（处置建议）。资料不足写待证据并指出缺哪份资料。',
				'截图元数据只说明图的节点和用途。看不到实际图时，图证状态疑义应写待证据。',
				...rows.map((item) => '【' + item[key] + ' 的独立审查输入】' + JSON.stringify(contextFor(item)))
			].join('\n');
			const skeleton = promptFor([]);
			const skillVersion = skillDigests()[STAGE_SKILLS.review];
			const reviewConfig = reviewConfigKey({
				reviewer, pageSize, skill: skillVersion?.sha256,
				provider: model.provider, model: model.model, prompt: skeleton, params: reviewParams, evidence: sourceBasis
			});
			const cached = loadReviewPages(root, body.project, stage);
			const reusable = cached.baseline === baseline && cached.config === reviewConfig ? cached.pages : {};
			send('review.config', {
				reviewer, role: 'quality', stage, page_size: pageSize, config_digest: reviewConfig, baseline,
				provider: model.provider, model: model.model, skill: STAGE_SKILLS.review,
				prompt_digest: digestOf(skeleton), skill_digest: skillVersion?.sha256 || '',
				params: { ...reviewParams, temperature: '服务未提供', top_p: '服务未提供', seed: '服务未提供' },
				evidence_version: sourceBasis, cases_version: stage === 'cases' ? document.version : undefined,
				version: document.version, reused_pages: Object.keys(reusable).length
			});
			const pages = chunk(items, pageSize);
			const receipts = new Map();
			let failedPages = [];
			const reviewOnePage = async (page, pageNumber) => {
				const ids = page.map((item) => item[key]);
				const rawText = reviewVision
					? await collectCase(model, body.project, promptFor(page),
						Object.fromEntries(page.map((item) => [item.case_id, (item.image_refs || [])
							.filter((figure) => figure.expected_id || figure.role === '预期界面参考').slice(0, 2)])),
						() => send('review.visualUnavailable', { case_ids: ids }), 4000)
					: await collect(model, promptFor(page), 4000);
				const rows = validateReceipts(parseJson(rawText), ids);
				for (const row of rows) {
					const sources = contextFor(page.find((item) => item[key] === row.case_id)).sources;
					for (const finding of row.findings) {
						if (!finding.evidence_ref && !finding.quote) continue;
						const source = sources.find((entry) => entry.id === finding.evidence_ref);
						if (!source || !finding.quote?.trim() || !source.text.includes(finding.quote)) {
							delete finding.evidence_ref;
							delete finding.quote;
							finding.code = 'EVIDENCE_REQUIRED';
							row.conclusion = '待证据';
						}
					}
				}
				saveReviewPage(root, body.project, { baseline, config: reviewConfig, ids, receipts: rows }, stage);
				for (const row of rows) receipts.set(row.case_id, row);
				send('review.page', {
					page: pageNumber,
					from: (pageNumber - 1) * pageSize + 1,
					to: Math.min(pageNumber * pageSize, items.length),
					findings: rows.reduce((sum, row) => sum + row.findings.length, 0)
				});
			};
			for (let index = 0; index < pages.length; index += 1) {
				if (aborted) break;
				const page = pages[index];
				const ids = page.map((item) => item[key]);
				send('phase', { step: index + 1, total: pages.length, label: `审查 ${index * pageSize + 1}-${index * pageSize + page.length} / ${items.length}` });
				const saved = reusable[digestOf(ids)];
				if (saved) {
					for (const row of saved.receipts) receipts.set(row.case_id, row);
					send('review.pageReused', { page: index + 1, case_ids: ids });
					continue;
				}
				try {
					await reviewOnePage(page, index + 1);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failedPages.push({ page: index + 1, case_ids: ids, error: message, items: page });
					send('review.pageFailed', { page: index + 1, case_ids: ids, error: message });
				}
			}
			// 失败页自动重试最多 2 轮（成功页已缓存，仅重跑失败页）
			const maxRetryRounds = Math.max(0, Math.min(3, Number(body.retry_rounds ?? 2)));
			for (let round = 1; round <= maxRetryRounds && failedPages.length > 0 && !aborted; round += 1) {
				const retryQueue = failedPages;
				failedPages = [];
				send('review.retry', { round, pages: retryQueue.length, case_ids: retryQueue.flatMap((entry) => entry.case_ids) });
				await new Promise((resolve) => setTimeout(resolve, 1500));
				for (let idx = 0; idx < retryQueue.length; idx += 1) {
					if (aborted) {
						failedPages.push(...retryQueue.slice(idx));
						break;
					}
					const entry = retryQueue[idx];
					send('phase', { step: idx + 1, total: retryQueue.length, label: `自动重试失败页（第 ${round} 轮 · ${idx + 1}/${retryQueue.length}）` });
					try {
						await reviewOnePage(entry.items, entry.page);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						failedPages.push({ ...entry, error: message });
						send('review.pageFailed', { page: entry.page, case_ids: entry.case_ids, error: message, retry_round: round });
					}
				}
			}
			if (aborted) {
				const reviewed = receipts.size;
				send('run.end', { kind: 'review', published: false, aborted: true, reviewed, total: items.length });
				return;
			}
			// 回执不齐就不发布：缺答的用例留待重审，绝不因为「没有发现」而被当成通过。
			if (failedPages.length) {
				const pendingIds = failedPages.flatMap((entry) => entry.case_ids);
				const publicFailed = failedPages.map(({ page, case_ids, error }) => ({ page, case_ids, error }));
				send('run.end', { kind: 'review', published: false, reviewed: receipts.size, total: items.length, pending_ids: pendingIds, failed_pages: publicFailed });
				send('error', { code: 'REVIEW_INCOMPLETE', message: `评审回执不齐，未发布结果：${failedPages.length} 页失败，${pendingIds.length} 条待重审。已成功页已留档，重跑只补失败页。` });
				return;
			}
			const findings = [];
			const entries = items.map((item) => {
				const id = item[key];
				const row = receipts.get(id);
				const own = row.findings.map((finding) => ({ object_id: id, ...(stage === 'cases' ? { case_id: id } : {}), ...finding }));
				findings.push(...own);
				return {
					object_id: id, ...(stage === 'cases' ? { case_id: id, variant_id: caseVariant(item), case_digest: caseDigest(item) } : {}),
					review_kind: 'model', conclusion: row.conclusion, reviewer, findings: row.findings,
					basis: own.map((finding) => finding.code + ': ' + finding.message).join('；')
				};
			});
			const release = await acquireLock(root, body.project);
			try {
				const latest = await reviewInputs(body.project, stage);
				if (latest.baseline !== baseline || latest.sourceBasis !== sourceBasis) throw new Error('审查期间内容或资料已变化，请重新审查');
				const reportKind = 'agent-review-' + stage;
				const prior = await loadArtifact(root, body.project, reportKind);
				const kept = prior.baseline === baseline && prior.evidence_version === sourceBasis
					? prior.items.filter((item) => !receipts.has(item.object_id)) : [];
				await archiveArtifact(root, body.project, reportKind);
				await saveArtifact(root, body.project, reportKind, {
					version: prior.version, items: [...kept, ...entries], meta: { baseline, evidence_version: sourceBasis,
						role: 'quality', stage, provider: model.provider, model: model.model, prompt_digest: digestOf(skeleton),
						skill: STAGE_SKILLS.review, skill_digest: skillVersion?.sha256 || '', config_digest: reviewConfig }
				});
				if (stage === 'cases') {
					const decisions = new Map(loadReviews(root, body.project).items.map((item) => [item.case_id, item]));
					const advisory = entries.filter((item) => {
						const decision = decisions.get(item.case_id);
						return !decision || decision.review_kind === 'model' || decision.case_digest !== item.case_digest;
					});
					if (advisory.length) recordReviews(root, body.project, advisory);
					if (!selected) {
						await archiveArtifact(root, body.project, 'review');
						await saveArtifact(root, body.project, 'review', {
							version: 0, items: findings,
							meta: { cases_digest: baseline, cases_digest_kind: 'content', reviewed_cases: items.length, reviewer, receipt_kind: 'per-id' }
						});
					}
				}
			} finally {
				await release();
			}
			send('review', { stage, findings, total: findings.length });
			send('run.end', { kind: 'review', published: true, total: findings.length, reviewed: items.length, passed: entries.filter((entry) => entry.conclusion === '通过').length, returned: entries.filter((entry) => entry.conclusion !== '通过').length });
		} catch (error) {
			send('error', { code: error.code || 'REVIEW_FAILED', message: error instanceof Error ? error.message : String(error), stack: process.env.CTS_DEBUG ? error?.stack : undefined });
		} finally {
			clearInterval(heartbeat);
			res.end();
		}
	};

	const handle = async (req, res) => {
		const rejection = ctx.connection?.requestRejection?.(req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			sendJson(res, 405, { ok: false, error: '仅支持 POST' });
			return;
		}
		const raw = await readBody(req);
		if (raw === null) {
			sendJson(res, 413, { ok: false, error: '请求体过大' });
			return;
		}
		let body;
		try {
			body = JSON.parse(raw || '{}');
		} catch {
			sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' });
			return;
		}
		enterScope(await scopeRequest(body));
		enterSkillScope(root);
		let release = null;
		const action = ACTIVITY_ACTIONS.get(body.action);
		const actionDetail = [body.kind, body.stage, body.path, body.name, body.id].filter((v) => typeof v === 'string' && v.trim()).slice(0, 2).join(' · ');
		const record = action && typeof body.project === 'string' && body.project
			? activityFor(body.project, action, body.action === 'agents.run' ? 'quality' : 'platform', typeof body.kind === 'string' ? body.kind : (typeof body.stage === 'string' ? body.stage : ''))
			: null;
		if (record) {
			record('started', actionDetail);
			res[activityResult] = record;
		}
		const WRITES = new Set(['artifact.update', 'artifact.delete', 'artifact.clear', 'artifact.approve', 'artifact.reject', 'artifact.regenerate', 'binding.suggest', 'binding.confirm', 'binding.manual', 'binding.reject', 'evidence.build', 'package.freeze', 'package.fork', 'features.attach', 'cases.decorate', 'cases.images', 'ecsm.freeze', 'ecsm.export', 'questions.answer', 'ecsm.repair', 'contracts.save', 'sources.save', 'outline.save', 'outline.approve', 'outline.apply', 'deferral.save', 'conflict.save', 'cases.reviewApply', 'cases.reviewImport', 'branches.save', 'tkr.select', 'ui.build', 'ui.links.derive', 'ui.link.save', 'ui.propagate', 'ui.figures']);
		try {
			if (WRITES.has(body.action) && typeof body.project === 'string') {
				release = await acquireLock(root, body.project);
			}
			switch (body.action) {
				case 'activity.list': {
					sendJson(res, 200, { ok: true, state: listActivity(root, body.cursor, {
						project: typeof body.project === 'string' ? body.project : '',
						module: typeof body.module === 'string' ? body.module : ''
					}) });
					return;
				}
				case 'agent.review.view':
				case 'agent.review.repairPreview':
				case 'agent.review.suggest': {
					const stage = body.stage;
					if (typeof stage !== 'string' || !Object.hasOwn(REVIEW_STAGES, stage)) throw new Error('不支持的审查阶段');
					if (body.action === 'agent.review.view') {
						const inputs = await reviewInputs(body.project, stage);
						const report = await loadArtifact(root, body.project, 'agent-review-' + stage);
						sendJson(res, 200, { ok: true, state: { ...report, stale: Boolean(report.version &&
							(report.baseline !== inputs.baseline || report.evidence_version !== inputs.sourceBasis)) } });
						return;
					}
					const repair = await reviewRepairInput(body.project, stage, body.object_id, body.finding_indexes);
					const { inputs, item, findings, basis } = repair;
					const state = { basis, version: inputs.document.version, digest: inputs.document.digest, object_id: body.object_id,
						point_id: item.point_id, findings };
					if (body.action === 'agent.review.suggest') {
						if (stage === 'cases' || body.basis !== basis) throw new Error('请按当前意见重新预览');
						const model = await resolveModel(ctx, config);
						const role = authorRole(stage);
						const record = activityFor(body.project, '整理审查修订建议', role, stage);
						record('started', body.object_id);
						try {
							const fields = stage === 'contracts' ? ['title', 'condition', 'trigger', 'expected', 'verification']
								: stage === 'outline' ? ['requirement'] : ['requirement', 'condition', 'action', 'expected'];
							const prompt = compose(STAGE_SKILLS[stage],
								ROLE_INSTRUCTIONS[role],
								'只根据选中的意见和原文建议修改。输出 JSON {"patch":{}}。只允许改这些文字字段：' + fields.join('、'),
								JSON.stringify({ item, findings, context: inputs.contextFor(item) }));
							const proposed = parseJson(await collect(model, prompt, 2500))?.patch;
							if (!proposed || typeof proposed !== 'object') throw new Error('模型未返回有效修订建议');
							state.changes = fields.filter((field) => typeof proposed[field] === 'string' && proposed[field].trim()
								&& proposed[field].trim() !== item[field]).map((field) => ({
								field, before: item[field] || '', after: proposed[field].trim().slice(0, 12000)
							}));
							record('completed', `${state.changes.length} 个字段`);
						} catch (error) {
							record('failed');
							throw error;
						}
					}
					sendJson(res, 200, { ok: true, state });
					return;
				}
				case 'agent.design.coverageAdvice':
				case 'agent.review.deliverySummary': {
					const project = body.project;
					const advising = body.action === 'agent.design.coverageAdvice';
					const role = advising ? 'design' : 'quality';
					const skillName = advising ? STAGE_SKILLS.outline : STAGE_SKILLS.review;
					const [design, points, cases, delays] = await Promise.all(['outline', 'points', 'cases', 'deferrals']
						.map((kind) => loadArtifact(root, project, kind)));
					const outline = design.items[0];
					if (!outline) throw new Error('请先生成本轮测试大纲');
					const rows = outlineCoverage({ ...outline, digest: design.digest }, points, cases, delays.items);
					const counts = Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row.state)).map(([key, items]) => [key, items.length]));
					const unresolved = rows.filter((row) => row.state !== 'covered');
					const model = await resolveModel(ctx, config);
					const record = activityFor(project, advising ? '核对测试大纲范围' : '整理交付缺口', role, advising ? 'outline' : 'delivery');
					const basis = digestOf([design.digest, points.digest, cases.digest, delays.digest]);
					record('started', `大纲 v${design.version}`);
					try {
						const prompt = compose(skillName, advising
							? ROLE_INSTRUCTIONS.design + ' 根据批准需求、范围和 TKR 选用情况，核对正常、异常、边界及联动，给出供评审的建议。'
							: '角色：质量审查 Agent。用中文整理本轮交付缺口与延期影响。',
							'总数以给出的统计为准。逐项引用场景 ID，区分待办、已延期和范围外。有截断时如实说明。返回 JSON {"summary":"简短说明"}。',
							JSON.stringify({ counts, total_unresolved: unresolved.length, outside_count: outline.outside?.length || 0,
								...(advising ? { risk: outline.risk, environment: outline.environment, tkr: outline.tkr,
									scope: outline.scope, approved_requirements: outline.items.slice(0, 25).map(({ scenario_id, requirement, contract_refs, rule_ids }) =>
										({ scenario_id, requirement, contract_refs, rule_ids })) } : {}),
								rows: unresolved.slice(0, 25).map(({ scenario_id, requirement, state, point_id, deferral }) =>
									({ scenario_id, requirement, state, point_id, deferral })) }));
						const answer = parseJson(await collect(model, prompt, 2500))?.summary;
						if (typeof answer !== 'string' || !answer.trim()) throw new Error('模型未返回有效摘要');
						record('completed', `${unresolved.length} 项待对账`);
						sendJson(res, 200, { ok: true, state: { basis, counts, summary: answer.trim(), role, skill: skillName,
							versions: { outline: design.version, points: points.version, cases: cases.version } } });
					} catch (error) {
						record('failed');
						throw error;
					}
					return;
				}
				case 'settings.status': {
					const projects = await listProjects(config);
					const roots = sourceRoots(config).map((item) => ({ dir: item.dir, readonly: item.readonly }));
					const oauthFile = path.join(root, 'pixso-oauth.json');
					sendJson(res, 200, { ok: true, state: {
						dataDir: root,
						provider: config?.provider || '',
						model: config?.model || '',
						sourceRoots: roots,
						projects: projects.length,
						pixso: {
							mcpUrl: config?.pixsoMcpUrl || '',
							hasToken: Boolean(config?.pixsoToken),
							oauthStored: fsSync.existsSync(oauthFile)
						}
					} });
					return;
				}
				case 'state': {
					const projects = await listProjects(config);
					sendJson(res, 200, { ok: true, state: { projects, defaults, dataDir: root } });
					return;
				}
				case 'replay': {
					const runId = typeof body.run === 'string' && body.run ? body.run : await latestRun(config, body.project);
					const events = runId ? await readEvents(config, body.project, runId) : [];
					sendJson(res, 200, { ok: true, state: { runId, events } });
					return;
				}
				case 'ensure-data': {
					const dir = await ensureDataDir(config);
					sendJson(res, 200, { ok: true, state: { dataDir: dir } });
					return;
				}
				case 'points.transitions': {
					const model = await resolveModel(ctx, config);
					const [facts, points] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'points')
					]);
					const states = loadStates(root, body.project);
					await archiveArtifact(root, body.project, 'points');
					const factIds = new Set(facts.items.map((fact) => fact.fact_id));
					const covered = new Set(points.items.map((point) => point.transition_ref).filter(Boolean));
					const pending = states.items
						.map((machine) => ({
							machine,
							transitions: (machine.transitions || []).filter((transition) => !covered.has(transition.transition_id))
						}))
						.filter((entry) => entry.transitions.length > 0)
						.slice(0, Number(body.limit) || 8);
					let items = points.items.slice();
					for (const { machine, transitions } of pending) {
						const task = [
							`功能点：${machine.feature_id} ${machine.name || ''}`,
							'下面这些状态转移还没有对应的测试点，请为每条转移产出一条点。',
							'transition_ref 必须填对应的转移编号。',
							'',
							...transitions.map((transition) => `${transition.transition_id}: ${transition.from} → ${transition.to}；触发：${transition.trigger || '(未写明)'}；条件：${(transition.conditions || []).join('、') || '(无)'}`),
							'',
							'输出 JSON：{"points":[{"transition_ref":"AC_001.T01","requirement":"…","condition":"…","action":"…","expected":"…","type":"状态迁移","priority":"P1","fact_refs":["F-0001"]}]}'
						].join('\n');
						const rawText = await collect(model, task, 4000);
						const fresh = mergePoints(items, parseJson(rawText), factIds);
						const base = items.length;
						items = items.concat(fresh.map((point, offset) => ({
							...point,
							feature_id: machine.feature_id,
							point_id: `T-${String(base + offset + 1).padStart(4, '0')}`
						})));
					}
					const saved = await saveArtifact(root, body.project, 'points', {
						version: points.version,
						items,
						meta: { ...(points.matrix ? { matrix: points.matrix } : {}), source_facts_digest: digestOf(facts.items) }
					});
					const stillCovered = new Set(items.map((point) => point.transition_ref).filter(Boolean));
					sendJson(res, 200, {
						ok: true,
						state: {
							features: pending.length,
							added: items.length - points.items.length,
							covered: stillCovered.size,
							count: items.length,
							version: saved.version
						}
					});
					return;
				}
				case 'points.boundary': {
					const model = await resolveModel(ctx, config);
					const [facts, features] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features')
					]);
					const current = await loadArtifact(root, body.project, 'points');
					await archiveArtifact(root, body.project, 'points');
					const factIds = new Set(facts.items.map((fact) => fact.fact_id));
					const done = new Set(current.boundary_features || []);
					const targets = features.items
						.filter((feature) => !done.has(feature.feature_id))
						.map((feature) => boundaryTargets(feature, facts.items))
						.filter(Boolean)
						.slice(0, Number(body.limit) || 10);
					let items = current.items.slice();
					let added = 0;
					for (const target of targets) {
						const rawText = await collect(model, boundaryPrompt(target), 4000);
						const fresh = mergePoints(items, parseJson(rawText), factIds);
						const base = items.length;
						items = items.concat(fresh.map((point, offset) => ({
							...point,
							feature_id: target.feature.feature_id,
							point_id: `T-${String(base + offset + 1).padStart(4, '0')}`
						})));
						added += fresh.length;
						done.add(target.feature.feature_id);
					}
					const saved = await saveArtifact(root, body.project, 'points', {
						version: current.version,
						items,
						meta: {
							...(current.matrix ? { matrix: current.matrix } : {}),
							...(current.matrix_features ? { matrix_features: current.matrix_features } : {}),
							boundary_features: [...done],
							source_facts_digest: digestOf(facts.items)
						}
					});
					sendJson(res, 200, { ok: true, state: { features: targets.length, added, count: items.length, version: saved.version } });
					return;
				}
				case 'points.matrix': {
					const model = await resolveModel(ctx, config);
					const [facts, features] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features')
					]);
					let current = await loadArtifact(root, body.project, 'points');
					await archiveArtifact(root, body.project, 'points');
					if (body.reset === true) {
						current = {
							...current,
							items: current.items.filter((point) => !point.cell),
							matrix: {},
							matrix_features: []
						};
					}
					const factIds = new Set(facts.items.map((fact) => fact.fact_id));
					const done = new Set(current.matrix_features || []);
					const pending = features.items.filter((feature) => !done.has(feature.feature_id)).slice(0, Number(body.limit) || 6);
					let items = current.items.slice();
					const matrix = { ...(current.matrix || {}) };
					let cells = 0;
					let na = 0;
					for (const feature of pending) {
						const featureCells = buildCells(feature, facts.items, Number(body.cells) || 16);
						const rawText = await collect(model, matrixPrompt(feature, facts.items, featureCells), 6000);
						const parsed = parseJson(rawText);
						const added = mergePoints(items, parsed, factIds);
						const base = items.length;
						items = items.concat(added.map((point, offset) => {
							const cell = featureCells[(Number(point.cell) || offset + 1) - 1];
							return {
								...point,
								feature_id: feature.feature_id,
								cell: cell ? `${cell.entry}|${cell.state}|${cell.verify}|${cell.object}` : '',
								point_id: `T-${String(base + offset + 1).padStart(4, '0')}`
							};
						}));
						cells += featureCells.length;
						na += Array.isArray(parsed?.na) ? parsed.na.length : 0;
						matrix[feature.feature_id] = { cells: featureCells.length, filled: added.length };
						done.add(feature.feature_id);
					}
					const saved = await saveArtifact(root, body.project, 'points', {
						version: current.version,
						items,
						meta: { source_facts_digest: digestOf(facts.items), matrix, matrix_features: [...done] }
					});
					sendJson(res, 200, {
						ok: true,
						state: {
							features: pending.length,
							cells,
							added: items.length - current.items.length,
							na,
							count: items.length,
							version: saved.version,
							remaining: features.items.length - done.size
						}
					});
					return;
				}
				case 'points.expand': {
					const model = await resolveModel(ctx, config);
					const projectInfo = await findProject(config, body.project);
					const [facts, features] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features')
					]);
					const current = await loadArtifact(root, body.project, 'points');
					await archiveArtifact(root, body.project, 'points');
					const factIds = new Set(facts.items.map((fact) => fact.fact_id));
					const countByFeature = new Map();
					for (const point of current.items) {
						if (point.feature_id) countByFeature.set(point.feature_id, (countByFeature.get(point.feature_id) || 0) + 1);
					}
					const weakest = features.items
						.map((feature) => ({ feature, count: countByFeature.get(feature.feature_id) || 0 }))
						.sort((a, b) => a.count - b.count)
						.slice(0, Number(body.limit) || 8);
					let items = current.items.slice();
					for (const { feature, count } of weakest) {
						const featureFacts = facts.items.filter((fact) => (feature.fact_refs || []).includes(fact.fact_id));
						const existing = items.filter((point) => point.feature_id === feature.feature_id).map((point) => point.condition).slice(0, 12);
						const task = [
							`功能点：${feature.feature_id} ${feature.name}`,
							`现有测试点只覆盖了：${existing.join('；') || '（暂无）'}`,
							'请只补充缺失的场景，不要重复上面已有的：语音入口、报文中断/丢失、恢复、记忆、边界（最小/最大/越界）、连续帧、多个界面入口。',
							'输出 JSON：{"points":[{"requirement":"…","condition":"…","action":"…","expected":"…","type":"…","priority":"P0|P1|P2","fact_refs":["F-0001"]}]}',
							'',
							featureFacts.map((fact) => `[${fact.fact_id}]（${fact.type}）${fact.statement}`).join('\n')
						].join('\n');
						const rawText = await collect(model, task, 6000);
						const added = mergePoints(items, parseJson(rawText), factIds);
						const base = items.length;
						items = items.concat(added.map((point, offset) => ({ ...point, feature_id: feature.feature_id, point_id: `T-${String(base + offset + 1).padStart(4, '0')}` })));
					}
					const saved = await saveArtifact(root, body.project, 'points', { version: current.version, items, meta: { source_facts_digest: digestOf(facts.items) } });
					sendJson(res, 200, { ok: true, state: { count: items.length, version: saved.version, expanded: weakest.length, added: items.length - current.items.length } });
					return;
				}
				case 'debug.points': {
					const model = await resolveModel(ctx, config);
					const evidence = await loadEvidenceAll(config, body.project, root);
					const facts = await loadArtifact(root, body.project, 'facts');
					const batches = chunk(facts.items, POINT_BATCH);
					const batch = batches[Number(body.index) || 0] || [];
					const rawText = await collect(model, pointPrompt(batch, 'P-v5-test', []), 12000);
					const parsed = parseJson(rawText);
					const factIds = new Set(facts.items.map((fact) => fact.fact_id));
					const merged = mergePoints([], parsed, factIds);
					sendJson(res, 200, {
						ok: true,
						state: {
							batchFacts: batch.length,
							rawLen: rawText.length,
							rawPoints: Array.isArray(parsed?.points) ? parsed.points.length : null,
							merged: merged.length,
							sample: merged.slice(0, 3).map((point) => ({ condition: point.condition, action: point.action }))
						}
					});
					return;
				}
				case 'debug.batch': {
					const model = await resolveModel(ctx, config);
					const evidence = await loadEvidenceAll(config, body.project, root);
					const batches = chunk(evidence.items, FACT_BATCH);
					const batch = batches[Number(body.index) || 0] || [];
					const prompt = factPrompt(batch, 'debug');
					const raw = await collect(model, prompt);
					const parsed = parseJson(raw);
					sendJson(res, 200, {
						ok: true,
						state: {
							index: Number(body.index) || 0,
							ids: batch.map((item) => item.id),
							promptLen: prompt.length,
							rawLen: raw.length,
							rawHead: raw.slice(0, 400),
							rawTail: raw.slice(-200),
							factsParsed: Array.isArray(parsed?.facts) ? parsed.facts.length : null
						}
					});
					return;
				}
				case 'debug.raw': {
					const model = await resolveModel(ctx, config);
					const evidence = await loadEvidenceAll(config, body.project, root);
					const batch = evidence.items.slice(0, 3);
					const prompt = factPrompt(batch, 'debug');
					let raw = '';
					raw = await collect(model, prompt);
					sendJson(res, 200, { ok: true, state: { promptLen: prompt.length, ids: batch.map((item) => item.id), rawLen: raw.length, raw: raw.slice(0, 2500) } });
					return;
				}
				case 'artifact.clear': {
					assertWritable(body.project);
					const kind = String(body.kind || '');
					const doc = await loadArtifact(root, body.project, kind);
					const saved = await saveArtifact(root, body.project, kind, { version: doc.version, items: [] });
					sendJson(res, 200, { ok: true, state: { version: saved.version, count: 0 } });
					return;
				}
				case 'artifact.update': {
					assertWritable(body.project);
					const kind = String(body.kind || '');
					const doc = await loadArtifact(root, body.project, kind);
					if ((body.version !== undefined && body.version !== doc.version) || (body.digest !== undefined && body.digest !== doc.digest)) {
						sendJson(res, 409, { ok: false, error: '制品版本已变化，请刷新后重新提交' });
						return;
					}
					const before = kind === 'cases' ? doc.items.find((entry) => entry.case_id === String(body.id || '')) : null;
					const item = applyPatch(doc, String(body.id || ''), body.patch || {}, kind);
					if (kind === 'cases' && ['step_items', 'expected_items', 'prepare_items', 'restore_items', 'deferred_items'].some((key) => body.patch?.[key] !== undefined)) {
						// 结构化修订是人工/代理直接写入，必须当场过硬校验，不能把不可执行的判据留到审批才发现。
						const [points, facts] = await Promise.all(['points', 'facts'].map((name) => loadArtifact(root, body.project, name)));
						const hard = lint([item], new Set(points.items.map((entry) => entry.point_id)), new Set(facts.items.map((entry) => entry.fact_id)),
							new Map(points.items.map((entry) => [entry.point_id, entry]))).filter((entry) => entry.severity !== 'warning');
						if (hard.length) {
							doc.items[doc.items.findIndex((entry) => entry.case_id === body.id)] = before;
							sendJson(res, 409, { ok: false, error: '结构化修订未通过硬校验：' + hard.map((entry) => `${entry.code} ${entry.message}`).join('；'), state: { case_id: body.id, issues: hard } });
							return;
						}
					}
					if (kind === 'points') {
						const facts = await loadArtifact(root, body.project, 'facts');
						const ids = new Set(facts.items.map((fact) => fact.fact_id));
						if (Array.isArray(body.patch?.fact_refs) && item.fact_refs.some((ref) => !ids.has(ref))) throw new Error('来源事实编号不存在');
						if (body.patch?.transition_ref && !loadStates(root, body.project).items.some((machine) =>
							(machine.transitions || []).some((entry) => entry.transition_id === item.transition_ref))) throw new Error('状态转移编号不存在');
					}
					const { items, version, updatedAt, digest, ...meta } = doc;
					if (kind === 'cases') await archiveArtifact(root, body.project, kind);
					const saved = await saveArtifact(root, body.project, kind, { version, items, meta });
					sendJson(res, 200, { ok: true, state: { item, version: saved.version } });
					return;
				}
				case 'cases.imageCandidates':
				case 'cases.imageBatchPreview':
				case 'cases.imageBatchApply': {
					const projectId = body.project;
					const info = await findProject(config, projectId);
					const [doc, points] = await Promise.all(['cases', 'points'].map((kind) => loadArtifact(root, projectId, kind)));
					const item = doc.items.find((entry) => entry.case_id === body.id);
					if (!info || !item) throw new Error('找不到该用例');
					const step = Number(body.step || 0);
					const role = body.role;
					if (!['操作定位', '预期界面参考'].includes(role) || !Number.isInteger(step) || step < 0 ||
						step > (item.steps || []).length || (!step && role === '操作定位')) throw new Error('请选择有效的步骤和图片用途');
					const visuals = await moduleCaseVisuals(info, projectId, loadBindings(root, projectId));
					const revisions = await moduleDesignRevisions(projectId);
					const gap = { role, step };
					if (body.action === 'cases.imageCandidates') {
						const point = points.items.find((entry) => entry.point_id === item.point_id);
						const candidates = visuals.candidates(point, item, gap).slice(0, 20);
						sendJson(res, 200, { ok: true, state: { candidates } });
						return;
					}
					const [sourceId, nodeId] = String(body.node || '').split('/');
					const target = sourceId && nodeId && visuals.resolveNode({ source_id: sourceId, node_id: nodeId });
					if (!target?.cached) throw new Error('该节点的画板尚未缓存，请在 UI 设计中补齐截图');
					const key = figureBasis(item, role, step);
					if (!key) throw new Error('此步骤没有可用于批量复用的内容');
					const targets = doc.items.flatMap((entry) => {
						const gaps = caseGaps(projectId, entry, revisions);
						return gaps.filter((g) => g.role === role && figureBasis(entry, role, g.step) === key)
							.map((g) => ({ id: entry.case_id, title: entry.title, step: g.step }));
					});
					if (!targets.some((entry) => entry.id === item.case_id && entry.step === step)) throw new Error('该步骤已配图，请重新选择缺图步骤');
					const basis = digestOf([doc.version, doc.digest, sourceId, nodeId, target.source.revision, key]);
					if (body.action === 'cases.imageBatchApply') {
						if (info.readonly || basis !== body.basis) throw new Error('用例或设计稿已更新，请重新预览');
						const release = await acquireLock(root, projectId);
						try {
							assertWritable(projectId);
							const latest = await loadArtifact(root, projectId, 'cases');
							if (latest.version !== doc.version || latest.digest !== doc.digest) throw new Error('用例已更新，请重新预览');
							const images = await visuals.forNode({ source_id: sourceId, node_id: nodeId }, role);
							if (!images.length || (await moduleDesignRevisions(projectId)).get(sourceId) !== target.source.revision)
								throw new Error('截图或设计稿已更新，请重新预览');
							const byId = new Map(doc.items.map((entry) => [entry.case_id, entry]));
							for (const entry of targets) {
								const current = byId.get(entry.id);
								structureCase(current);
								const stepId = current.step_items[entry.step - 1]?.id || '';
								const expectedId = role === '预期界面参考' ? (current.expected_items.find((e) => e.step_index === entry.step)?.id || '') : '';
								current.image_refs = [...(current.image_refs || []).filter((f) => !(f.role === role && f.step === entry.step &&
									f.source_id && f.revision && revisions.get(f.source_id) !== f.revision)),
									...images.map((image) => ({ ...image, step: entry.step, step_id: stepId, expected_id: expectedId, manual: true, reuse: true }))];
								current.review_status = 'candidate';
							}
							const { items, version, updatedAt, digest, ...meta } = doc;
							await saveArtifact(root, projectId, 'cases', { version, items, meta });
						} finally { await release(); }
					}
					sendJson(res, 200, { ok: true, state: { basis, targets, name: target.node.name } });
					return;
				}
				case 'cases.imageAuto': {
					const projectId = body.project;
					const info = await findProject(config, projectId);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const [doc, points] = await Promise.all(['cases', 'points'].map((kind) => loadArtifact(root, projectId, kind)));
					assertWritable(projectId);
					const visuals = await moduleCaseVisuals(info, projectId, loadBindings(root, projectId));
					const reusable = confirmedFigures(doc.items);
					const byPoint = new Map(points.items.map((point) => [point.point_id, point]));
					const revisions = await moduleDesignRevisions(projectId);
					const missing = (item) => caseGaps(projectId, item, revisions);
					const before = doc.items.filter((item) => missing(item).length).length;
					const updated = [], failed = [];
					for (const item of doc.items) {
						const gaps = missing(item);
						const previous = item.image_refs || [];
						const usable = previous.some((f) => (!f.source_id || !f.revision || revisions.get(f.source_id) === f.revision) &&
							fsSync.existsSync(caseFigurePath(root, projectId, f)));
						if (!gaps.length && usable) continue;
						const point = byPoint.get(item.point_id);
						if (!point) continue;
						try {
							const found = await visuals.forPoint(point, item.steps, item.expected, item.precondition, reusable);
							const additions = found.filter((f) =>
								(f.role === '信号参考' || f.role === '需求参考' ? !usable : gaps.some((g) => g.role === f.role && g.step === f.step)) &&
								!previous.some((old) => old.file === f.file && old.role === f.role && old.step === f.step && old.revision === f.revision));
							if (!additions.length) continue;
							item.image_refs = [...previous, ...additions];
							item.review_status = 'candidate';
							updated.push(item.case_id);
						} catch (err) { failed.push({ id: item.case_id, message: err.message }); }
					}
					if (updated.length) {
						const release = await acquireLock(root, projectId);
						try {
							assertWritable(projectId);
							const latest = await loadArtifact(root, projectId, 'cases');
							const latestPoints = await loadArtifact(root, projectId, 'points');
							if (latest.digest !== doc.digest || latest.version !== doc.version ||
								latestPoints.digest !== points.digest || latestPoints.version !== points.version ||
								digestOf([...revisions]) !== digestOf([...(await moduleDesignRevisions(projectId))]))
								throw new Error('用例、测试点或设计稿已更新，请重新配图');
							const { items, version, updatedAt, digest, ...meta } = doc;
							await saveArtifact(root, projectId, 'cases', { version, items, meta });
						} finally { await release(); }
					}
					sendJson(res, 200, { ok: true, state: { updated, failed, before, remaining: doc.items.filter((item) => missing(item).length).length } });
					return;
				}
				case 'cases.images': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const [doc, points] = await Promise.all([loadArtifact(root, body.project, 'cases'), loadArtifact(root, body.project, 'points')]);
					const item = doc.items.find((entry) => entry.case_id === body.id);
					if (!item) throw new Error('找不到该用例');
					const visuals = await moduleCaseVisuals(info, body.project, loadBindings(root, body.project));
					const previous = item.image_refs || [];
					if (body.remove) {
						const index = previous.findIndex((figure) => figure.file === body.remove.file &&
							(figure.step_id && body.remove.step_id ? figure.step_id === body.remove.step_id : figure.step === body.remove.step) && figure.role === body.remove.role);
						if (index >= 0) item.image_refs = previous.filter((_figure, offset) => offset !== index);
					} else if (body.node) {
						const step = Number(body.step || 0);
						if (!Number.isInteger(step) || step < 0 || step > (item.steps || []).length) throw new Error('步骤编号超出范围');
						const role = body.role === '预期界面参考' ? body.role : '操作定位';
						const [sourceId, nodeId] = String(body.node).includes('/') ? String(body.node).split('/', 2) : ['', String(body.node)];
						const figures = await visuals.forNode({ source_id: sourceId, node_id: nodeId.trim() }, role, step);
						if (!figures.length) throw new Error('找不到唯一的节点或本地截图，请核对节点 ID，并在 UI 设计中补齐截图');
						structureCase(item);
						const stepId = item.step_items[step - 1]?.id || '';
						const expectedId = role === '预期界面参考' ? (item.expected_items.find((e) => e.step_index === step)?.id || '') : '';
						const source = figures[0];
						item.image_refs = [...previous.filter((figure) => !figures.some((next) => next.file === figure.file && next.role === figure.role && next.step === figure.step)),
							...figures.map((figure) => ({ ...figure, step_id: stepId, expected_id: expectedId, manual: true }))].filter((f) =>
							f.source_id !== source.source_id || f.node_id !== source.node_id || f.role !== role || f.step !== step || !f.revision || f.revision === source.revision);
					} else {
						const point = points.items.find((entry) => entry.point_id === item.point_id);
						const figures = await visuals.forPoint(point, item.steps, item.expected, item.precondition, confirmedFigures(doc.items));
						item.image_refs = [...previous.filter((figure) => figure.manual), ...figures];
					}
					item.review_status = 'candidate';
					const { items, version, updatedAt, digest, ...meta } = doc;
					await saveArtifact(root, body.project, 'cases', { version, items, meta });
					sendJson(res, 200, { ok: true, state: { item } });
					return;
				}
				case 'artifact.delete': {
					assertWritable(body.project);
					const kind = String(body.kind || '');
					const doc = await loadArtifact(root, body.project, kind);
					removeItem(doc, String(body.id || ''), kind);
					const { items, version, updatedAt, digest, ...meta } = doc;
					const saved = await saveArtifact(root, body.project, kind, { version, items, meta });
					sendJson(res, 200, { ok: true, state: { version: saved.version, count: doc.items.length } });
					return;
				}
				case 'artifact.approve':
				case 'artifact.reject': {
					assertWritable(body.project);
					const kind = String(body.kind || '');
					const doc = await loadArtifact(root, body.project, kind);
					const status = body.action === 'artifact.approve' ? 'approved' : 'rejected';
					const id = String(body.id || '');
					// 资料未裁决、静态核对、已排除的分支不能批准成运行测试点。
					if (kind === 'points' && status === 'approved') {
						const target = doc.items.find((entry) => entry.point_id === id);
						if (!target) throw new Error(`条目不存在：${id}`);
						if (target.classification && target.classification !== 'required') {
							sendJson(res, 409, { ok: false, error: `测试点不能批准：${target.classification} · ${target.rule_reason || '来源未确认为可运行分支'}`,
								state: { point_id: id, classification: target.classification, reason: target.rule_reason || '' } });
							return;
						}
					}
					if (kind === 'cases' && status === 'approved') {
						const target = doc.items.find((entry) => entry.case_id === id);
						if (!target) throw new Error(`条目不存在：${id}`);
						const points = await loadArtifact(root, body.project, 'points');
						const facts = await loadArtifact(root, body.project, 'facts');
						const pointById = new Map(points.items.map((entry) => [entry.point_id, entry]));
						const errors = lint([target], new Set(points.items.map((entry) => entry.point_id)), new Set(facts.items.map((entry) => entry.fact_id)), pointById)
							.map((entry) => ({ ...entry, at: `cases[${id}]` }));
						const reviews = loadReviews(root, body.project);
						const gate = approvalGate(target, { reviews, errors, point: pointById.get(target.point_id), points, cases: doc });
						if (!gate.ok) {
							sendJson(res, 409, { ok: false, error: '用例不能批准：' + gate.reasons.join('；'), state: { case_id: id, reasons: gate.reasons, lint_passed: gate.lint_passed, case_digest: gate.case_digest } });
							return;
						}
						target.review_digest = gate.case_digest;
						target.review_kind = reviews.items.find((entry) => entry.case_id === id)?.review_kind || 'content';
					}
					const item = markReview(doc, id, status, kind);
					const { items, version, updatedAt, digest, ...meta } = doc;
					const saved = await saveArtifact(root, body.project, kind, { version, items, meta });
					sendJson(res, 200, { ok: true, state: { item, version: saved.version } });
					return;
				}
				case 'artifact.approveBatch':
				case 'artifact.rejectBatch': {
					assertWritable(body.project);
					const kind = String(body.kind || '');
					if (!['facts', 'points', 'cases'].includes(kind)) throw new Error(`不支持批量评审的产物类型：${kind}`);
					const status = body.action === 'artifact.approveBatch' ? 'approved' : 'rejected';
					const idField = kind === 'facts' ? 'fact_id' : kind === 'points' ? 'point_id' : 'case_id';
					const release = await acquireLock(root, body.project);
					try {
						const doc = await loadArtifact(root, body.project, kind);
						const requestedIds = body.scope === 'all_pending'
							? doc.items.filter((entry) => entry.review_status !== status).map((entry) => entry[idField]).filter(Boolean)
							: (Array.isArray(body.ids) ? [...new Set(body.ids.map((v) => String(v || '')).filter(Boolean))] : []);
						const approved = [];
						const blocked = [];
						if (requestedIds.length) {
							const itemMap = new Map(doc.items.map((entry) => [entry[idField], entry]));
							const needCaseCtx = kind === 'cases' && status === 'approved';
							const points = needCaseCtx ? await loadArtifact(root, body.project, 'points') : null;
							const facts = needCaseCtx ? await loadArtifact(root, body.project, 'facts') : null;
							const reviews = needCaseCtx ? loadReviews(root, body.project) : null;
							const pointIds = points ? new Set(points.items.map((entry) => entry.point_id)) : null;
							const factIds = facts ? new Set(facts.items.map((entry) => entry.fact_id)) : null;
							const pointById = points ? new Map(points.items.map((entry) => [entry.point_id, entry])) : null;
							const reviewKindByCase = reviews ? new Map(reviews.items.map((entry) => [entry.case_id, entry.review_kind])) : null;
							for (const id of requestedIds) {
								const target = itemMap.get(id);
								if (!target) {
									blocked.push({ id, error: `条目不存在：${id}`, reasons: [`条目不存在：${id}`] });
									continue;
								}
								if (kind === 'points' && status === 'approved' && target.classification && target.classification !== 'required') {
									const reason = `${target.classification} · ${target.rule_reason || '来源未确认为可运行分支'}`;
									blocked.push({ id, error: `测试点不能批准：${reason}`, reasons: [reason] });
									continue;
								}
								if (needCaseCtx) {
									const errors = lint([target], pointIds, factIds, pointById)
										.map((entry) => ({ ...entry, at: `cases[${id}]` }));
									const gate = approvalGate(target, { reviews, errors, point: pointById.get(target.point_id), points, cases: doc });
									if (!gate.ok) {
										blocked.push({ id, error: '用例不能批准：' + gate.reasons.join('；'), reasons: gate.reasons });
										continue;
									}
									target.review_digest = gate.case_digest;
									target.review_kind = reviewKindByCase.get(id) || 'content';
								}
								markReview(doc, id, status, kind);
								approved.push(id);
							}
						}
						let version = doc.version;
						if (approved.length > 0) {
							const { items, version: curVer, updatedAt, digest, ...meta } = doc;
							const saved = await saveArtifact(root, body.project, kind, { version: curVer, items, meta });
							version = saved.version;
						}
						sendJson(res, 200, { ok: true, state: { approved, blocked, version } });
					} finally {
						await release();
					}
					return;
				}
				case 'artifact.regenerate': {
					assertWritable(body.project);
					const model = await resolveModel(ctx, config);
					const projectInfo = await findProject(config, body.project);
					const kind = String(body.kind || '');
					const id = String(body.id || '');
					const doc = await loadArtifact(root, body.project, kind);
					const idField = kind === 'facts' ? 'fact_id' : kind === 'points' ? 'point_id' : 'case_id';
					const index = doc.items.findIndex((entry) => entry[idField] === id);
					if (index < 0) throw new Error(`条目不存在：${id}`);
					const current = doc.items[index];
					const frozen = doc.source_ecsm_digest ? await requireFrozenModel(body.project) : null;
					if (frozen && frozen.digest !== doc.source_ecsm_digest) throw new Error('条目依据旧版模型，请先更新测试点和用例');
					let patch = null;
					let updateFigures;
					if (kind === 'facts') {
						const rawEvidence = await loadEvidenceAll(config, body.project, root);
						const prdText = (rawEvidence.items || []).filter((item) => item.kind !== 'design').map((item) => item.text || '').join('\n');
						const designMeta = { uiIndex: loadUiIndex(root, body.project), prdText, aliases: configTerms('aliases') };
						const evidence = semanticEvidenceDocument(rawEvidence, designMeta);
						const selected = evidence.items.filter((item) => (current.evidence_refs || []).includes(item.id));
						const raw = await collect(model, factPrompt(selected.length ? selected : evidence.items.slice(0, 3), projectInfo.name, { designMeta }));
						const candidate = parseJson(raw)?.facts?.[0];
						if (candidate) patch = { statement: candidate.statement, type: candidate.type, evidence_refs: candidate.evidence_refs };
					} else if (kind === 'points') {
						if (current.contract_refs?.length) throw new Error('请先修改需求合同，再从合同生成测试点');
						const facts = frozen?.inputs.facts || await loadArtifact(root, body.project, 'facts');
						const featureDoc = frozen?.inputs.features || await loadArtifact(root, body.project, 'features');
						const pointBindings = frozen?.inputs.bindings || loadBindings(root, body.project);
						const pointSigIdx = buildSignalIndex(projectInfo.dir).index;
						const resolvedCoverageMode = coverageMode();
						const resolvedIncludeSingleEntries = includeSingleEntries() || resolvedCoverageMode === 'exhaustive';
						const standardSpecText = await loadStandardSpecText(projectInfo.dir);
						const closedLoopPlan = buildClosedLoopCoveragePlan(facts.items, featureDoc.items, pointBindings.items, pointSigIdx, {
							dut: dutNode(),
							includeSingleEntries: resolvedIncludeSingleEntries
						});
						const matchedCell = current.closed_loop_cell
							? (closedLoopPlan.cells.find((c) => c.cell_id === current.closed_loop_cell.cell_id) || current.closed_loop_cell)
							: null;
						const refs = [...new Set([...(current.fact_refs || []), ...(matchedCell?.required_fact_refs || [])])];
						const selected = facts.items.filter((item) => refs.includes(item.fact_id));
						const selectedFacts = selected.length ? selected : facts.items.slice(0, 10);
						const machines = (frozen?.inputs.states || loadStates(root, body.project)).items.filter((entry) => entry.feature_id === current.feature_id);
						const raw = await collect(model, pointPrompt(selectedFacts, projectInfo.name, machines, {
							closedLoopCells: matchedCell && matchedCell.instruction ? [matchedCell] : [],
							coverageMode: resolvedCoverageMode,
							exhaustiveHints: resolvedCoverageMode === 'exhaustive'
								? buildExhaustiveExpansionHints(selectedFacts, pointSigIdx, pointBindings.items)
								: [],
							standardSpec: standardSpecText
						}));
						const candidate = parseJson(raw)?.points?.[0];
						if (candidate) {
							const allowed = new Set((selected.length ? selected : facts.items.slice(0, 10)).map((fact) => fact.fact_id));
							const factRefs = [...new Set([
								...(Array.isArray(candidate.fact_refs) ? candidate.fact_refs.filter((ref) => allowed.has(ref)) : []),
								...((matchedCell?.required_fact_refs || []).filter((ref) => allowed.has(ref)))
							])];
							if (!factRefs.length) throw new Error('重生成的测试点缺少可追溯的事实编号');
							patch = {
								requirement: candidate.requirement,
								condition: candidate.condition,
								action: candidate.action,
								expected: candidate.expected,
								type: candidate.type,
								priority: candidate.priority,
								fact_refs: factRefs,
								...(current.closed_loop_cell ? { closed_loop_cell: current.closed_loop_cell } : {})
							};
						}
					} else {
						const points = await loadArtifact(root, body.project, 'points');
						const point = points.items.find((item) => item.point_id === current.point_id);
						if (!point || frozen && doc.source_points_digest !== digestOf(points.items)) throw new Error('来源测试点已变化，请重新生成用例');
						const facts = frozen?.inputs.facts || await loadArtifact(root, body.project, 'facts');
						const featureDoc = frozen?.inputs.features || await loadArtifact(root, body.project, 'features');
						const bindings = frozen?.inputs.bindings || loadBindings(root, body.project);
						const { index: regenSigIdx } = buildSignalIndex(projectInfo.dir);
						const feedbackAttribution = resolvePointFeedbackAttribution(point, {
							facts: facts.items,
							features: featureDoc.items,
							bindings: bindings.items,
							signalIndex: regenSigIdx,
							dut: dutNode(),
							surface: defaultSurface()
						});
						const visuals = await moduleCaseVisuals(projectInfo, body.project, bindings);
						const manual = (current.image_refs || []).filter((figure) => figure.manual);
						const figures = [...manual, ...await visuals.forPoint(point).catch(() => [])];
						const raw = await collectCase(model, body.project,
							casePrompt(point ? [point] : [], projectInfo.name, { [point?.point_id]: { figures, feedbackAttribution } }),
							{ [point?.point_id]: figures });
						const candidate = parseJson(raw)?.cases?.[0];
						if (candidate) {
							patch = { title: candidate.title, type: candidate.type, priority: candidate.priority, precondition: candidate.precondition, steps: candidate.steps, expected: candidate.expected, signals: candidate.signals, basis: candidate.basis };
							updateFigures = async (item) => {
								item.controls = [];
								normalizeCaseStructure(item);
								structureCase(item);
								enrichPrepareFeedbackReadback(item, point, feedbackAttribution, defaultSurface(), bindings);
								decorateCases([item], bindings);
								// 人工图优先按稳定步骤 ID 保留；旧图没有 ID 时才比对步骤文本。
								const retained = manual.filter((figure) => figure.step_id
									? item.step_items.some((step) => step.id === figure.step_id)
									: !figure.step || current.steps[figure.step - 1] === item.steps[figure.step - 1]);
								item.image_refs = [...retained, ...await visuals.forPoint(point, item.steps, item.expected).catch(() => [])];
							};
						}
					}
					if (!patch) throw new Error('模型没有返回可用内容');
					const item = applyPatch(doc, id, patch, kind);
					if (updateFigures) await updateFigures(item);
					const { items, version, updatedAt, digest, ...meta } = doc;
					
					await saveArtifact(root, body.project, kind, { version, items, meta });
					sendJson(res, 200, { ok: true, state: { item } });
					return;
				}
				case 'coverage.diff': {
					const [facts, points, cases] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases')
					]);
					sendJson(res, 200, { ok: true, state: coverage(facts, points, cases) });
					return;
				}
				case 'history.build': {
					const stats = buildHistory(root, body.legacyRoot);
					sendJson(res, 200, { ok: true, state: stats });
					return;
				}
				case 'history.search': {
					sendJson(res, 200, { ok: true, state: searchHistory(root, String(body.query || ''), body.limit) });
					return;
				}
				case 'history.load': {
					const document = loadHistory(root);
					sendJson(res, 200, { ok: true, state: { count: document.count, builtAt: document.builtAt } });
					return;
				}
				case 'questions.list': {
					const document = loadQuestions(root, body.project);
					const scope = typeof body.scope === 'string' && body.scope !== '' ? body.scope : '';
					const items = scope === '' ? document.items : document.items.filter((item) => (item.scope || 'design') === scope);
					sendJson(res, 200, { ok: true, state: { document: { ...document, items }, open: items.filter((item) => item.status === 'open').length } });
					return;
				}
				case 'questions.build': {
					const document = await refreshQuestions(body.project);
					sendJson(res, 200, { ok: true, state: { document, open: document.items.filter((item) => item.status === 'open').length } });
					return;
				}
				case 'questions.dismiss': {
					const document = loadQuestions(root, body.project);
					const ids = body.all === true
						? document.items.filter((item) => item.status === 'open').map((item) => item.id)
						: Array.isArray(body.ids) ? body.ids : [body.id];
					let changed = 0;
					for (const id of ids) {
						const item = document.items.find((entry) => entry.id === id);
						if (!item || item.status !== 'open') continue;
						item.status = 'dismissed';
						item.dismissedAt = new Date().toISOString();
						changed += 1;
					}
					saveQuestions(root, body.project, document.items);
					sendJson(res, 200, { ok: true, state: { dismissed: changed } });
					return;
				}
				case 'questions.answer': {
					const document = loadQuestions(root, body.project);
					const item = document.items.find((entry) => entry.id === body.id);
					if (!item) throw new Error('问题不存在');
					const answer = String(body.answer || '').trim();
					if (!answer) throw new Error('请先填写答案');
					assertWritable(body.project);
					if (body.apply === true) {
						if (item.kind !== 'fact' || item.options?.includes(answer)) throw new Error('请输入新的事实陈述');
						const doc = await loadArtifact(root, body.project, 'facts');
						const fact = applyPatch(doc, item.ref, { statement: answer, review_status: 'approved' }, 'facts');
						fact.human_decision = { question: item.question, answer, applied_at: new Date().toISOString() };
						await saveArtifact(root, body.project, 'facts', { version: doc.version, items: doc.items });
					}
					item.status = 'answered';
					item.answer = answer;
					item.applied = body.apply === true;
					item.answeredAt = new Date().toISOString();
					saveQuestions(root, body.project, document.items);
					// A binding question doubles as the binding action when the answer names a candidate.
					if (item.kind === 'binding' && item.ref && answer !== '' && answer !== '跳过') {
						const bindings = loadBindings(root, body.project);
						const binding = bindings.items.find((entry) => entry.binding_id === item.ref);
						// 选项可能带页面注释（名称（页面 · 画板）），两种写法都认。
						const labelOf = (candidate) => {
							const where = [candidate.page, candidate.board].filter(Boolean).join(' · ');
							return where ? `${candidate.name || candidate.node_id}（${where}）` : (candidate.name || candidate.node_id);
						};
						const index = (binding?.candidates || []).findIndex((candidate) => (candidate.name || candidate.node_id) === answer || labelOf(candidate) === answer);
						if (index >= 0) confirmBinding(root, body.project, item.ref, index);
					}
					sendJson(res, 200, { ok: true, state: { id: item.id, status: item.status } });
					return;
				}
				case 'gate.answer': {
					const gateId = String(body.gate_id || '');
					const resolver = pendingGates.get(gateId);
					if (!resolver) throw new Error('该问题已失效或已回答');
					resolver(String(body.answer || ''));
					sendJson(res, 200, { ok: true, state: { gateId, answered: true } });
					return;
				}
				case 'issues.list': {
					const [cases, points, facts, states, bindings, review] = await Promise.all([
						loadArtifact(root, body.project, 'cases'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'facts'),
						Promise.resolve(loadStates(root, body.project)),
						Promise.resolve(loadBindings(root, body.project)),
						loadArtifact(root, body.project, 'review')
					]);
					const lintIssues = lint(cases.items, new Set(points.items.map((point) => point.point_id)), new Set(facts.items.map((fact) => fact.fact_id)))
						.map((issue) => {
							const index = Number(issue.at?.match(/\[(\d+)\]/)?.[1]);
							return { source: 'lint', severity: issue.severity || 'error', code: issue.code, message: issue.message, ref: cases.items[index]?.case_id || issue.at };
						});
					const stateIssues = states.items.flatMap((machine) => (machine.issues || []).map((issue) => ({
						source: 'state', severity: issue.code === 'UNBOUND_SIGNAL' ? 'warning' : 'error', code: issue.code, message: `${machine.feature_id}：${issue.message}`, ref: machine.feature_id
					})));
					const bindingIssues = bindings.items.filter((item) => item.status === 'ambiguous' || item.status === 'unmatched')
						.map((item) => ({ source: 'binding', severity: 'warning', code: item.status.toUpperCase(), message: `${item.kind === 'control' ? '控件' : '信号'}未确定：${item.subject.name}`, ref: item.binding_id }));
					// Old reviews with findings but no source digest need to be checked again.
					const casesDigest = reviewBasis(review, cases);
					const reviewStale = Boolean(cases.items.length > 0 && (review.cases_digest || review.items.length) && review.cases_digest !== casesDigest);
					const reviewIssues = (review.items || []).map((finding) => ({
						source: 'review', severity: 'warning', code: finding.code || 'REVIEW', message: `${finding.case_id || ''} ${finding.message || ''}`.trim(), ref: finding.case_id || ''
					}));
					const familyIssues = familyCoverage(points.items)
						.filter((family) => !family.ok)
						.map((family) => ({
							source: 'coverage',
							severity: 'warning',
							code: 'MISSING_FAMILY',
							message: `场景族「${family.family}」没有任何测试点`,
							ref: family.family
						}));
					// Collapse repeated warnings (one per case) into one entry with a count, otherwise
					// a handful of unbound controls bury everything else.
					const collapsed = new Map();
					for (const issue of [...lintIssues, ...stateIssues, ...bindingIssues, ...reviewIssues, ...familyIssues]) {
						const key = `${issue.source}|${issue.code}|${issue.message}`;
						const existing = collapsed.get(key);
						if (existing) {
							existing.count = (existing.count || 1) + 1;
							existing.refs = [...(existing.refs || [existing.ref]).filter(Boolean), issue.ref].slice(0, 5);
							continue;
						}
						collapsed.set(key, { ...issue, count: 1 });
					}
					const issues = [...collapsed.values()];
					sendJson(res, 200, {
						ok: true,
						state: {
							total: issues.length,
							bySeverity: {
								error: issues.filter((issue) => issue.severity === 'error').length,
								warning: issues.filter((issue) => issue.severity === 'warning').length
							},
							bySource: {
								lint: new Set(lintIssues.map((issue) => `${issue.code}|${issue.message}`)).size,
								state: stateIssues.length,
								binding: bindingIssues.length,
								review: reviewIssues.length,
								coverage: familyIssues.length
							},
							reviewStale,
							documents: {
								cases: digestOf(cases.items),
								reviewBasis: review.cases_digest || null
							},
							issues: issues.slice(0, 200)
						}
					});
					return;
				}
				case 'points.dedupe': {
					const points = await loadArtifact(root, body.project, 'points');
					const seen = new Set();
					const kept = [];
					for (const point of points.items) {
						const key = `${point.condition}|${point.action}|${point.expected}`.replace(/[\s，。；：、,.!?！？;:()（）【】\[\]"'“”]/g, '').slice(0, 240);
						if (seen.has(key)) continue;
						seen.add(key);
						kept.push(point);
					}
					const removed = points.items.length - kept.length;
					const saved = await saveArtifact(root, body.project, 'points', { version: points.version, items: kept });
					sendJson(res, 200, { ok: true, state: { before: points.items.length, after: kept.length, removed, version: saved.version } });
					return;
				}
				case 'integrity.stamp': {
					// Adopt the current state as the baseline for documents written before
					// digests existed; afterwards any regeneration is detectable.
					const [facts, features, points, cases] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases')
					]);
					await saveArtifact(root, body.project, 'points', { version: points.version, items: points.items, meta: { source_facts_digest: digestOf(facts.items) } });
					await saveArtifact(root, body.project, 'cases', { version: cases.version, items: cases.items, meta: { source_points_digest: digestOf(points.items) } });
					const bindings = loadBindings(root, body.project);
					saveBindings(root, body.project, bindings.items, { source_facts_digest: digestOf(facts.items) });
					saveStates(root, body.project, loadStates(root, body.project).items, { source_features_digest: digestOf(features.items) });
					sendJson(res, 200, { ok: true, state: { stamped: true } });
					return;
				}
				case 'agents.run': {
					const model = await resolveModel(ctx, config);
					const kind = String(body.kind || 'cases');
					const limit = Math.min(20, Number(body.limit) || 8);
					const evidence = await loadEvidenceAll(config, body.project, root);
					const evidenceIds = new Set((evidence?.items || []).map((item) => item.id));
					const read = (id, options) => readEvidence(config, body.project, root, String(id), options);
					const search = (query, options) => searchEvidence(config, body.project, root, String(query), options);
					void read;
					void search;
					const toolCalls = [];
					const onEvent = (event) => {
						if (event.type === 'tool') {
							toolCalls.push({ tool: event.tool, args: event.args });
							record?.('tool', event.tool);
						}
					};
					let result;
					if (kind === 'facts') {
						const facts = await loadArtifact(root, body.project, 'facts');
						const usable = facts.items.filter((fact) => (fact.evidence_refs || []).some((ref) => evidenceIds.has(ref)));
						result = await checkFacts({ model, facts: usable, readEvidence: read, limit, onEvent });
					} else {
						const cases = await loadArtifact(root, body.project, 'cases');
						result = await checkCases({ model, cases: cases.items, searchEvidence: search, readEvidence: read, limit, onEvent });
					}
					// Deterministic guard: a finding without a verbatim quote from the cited
					// evidence is dropped, because the model does misattribute signals.
					const evidenceText = new Map((evidence?.items || []).map((item) => [item.id, item.text.replace(/\s+/g, '')]));
					const validated = [];
					let dropped = 0;
					for (const finding of result.findings) {
						const refs = Array.isArray(finding.evidence_refs) ? finding.evidence_refs : [];
						const quote = String(finding.quote || '').replace(/\s+/g, '');
						const hit = quote.length >= 10 && refs.some((ref) => (evidenceText.get(ref) || '').includes(quote));
						if (hit) validated.push(finding);
						else dropped += 1;
					}
					result.findings = validated;
					result.dropped = dropped;
					const file = path.join(root, 'artifacts', body.project, 'agents.json');
					await fs.mkdir(path.dirname(file), { recursive: true });
					await fs.writeFile(file, JSON.stringify({ kind, at: new Date().toISOString(), ...result }, null, 1), 'utf8');
					sendJson(res, 200, { ok: true, state: { kind, checked: result.checked, findings: result.findings, dropped: result.dropped, toolCalls } });
					return;
				}
				case 'agents.list': {
					// Deterministic guard: a finding without a verbatim quote from the cited
					// evidence is dropped, because the model does misattribute signals.
					const evidenceText = new Map((evidence?.items || []).map((item) => [item.id, item.text.replace(/\s+/g, '')]));
					const validated = [];
					let dropped = 0;
					for (const finding of result.findings) {
						const refs = Array.isArray(finding.evidence_refs) ? finding.evidence_refs : [];
						const quote = String(finding.quote || '').replace(/\s+/g, '');
						const hit = quote.length >= 10 && refs.some((ref) => (evidenceText.get(ref) || '').includes(quote));
						if (hit) validated.push(finding);
						else dropped += 1;
					}
					result.findings = validated;
					result.dropped = dropped;
					const file = path.join(root, 'artifacts', body.project, 'agents.json');
					let document = null;
					try {
						document = JSON.parse(await fs.readFile(file, 'utf8'));
					} catch {
						document = null;
					}
					sendJson(res, 200, { ok: true, state: { document } });
					return;
				}
				case 'project.create': {
					const name = String(body.name || '').trim();
					if (name === '') throw new Error('项目名不能为空');
					const id = `P-${crypto.createHash('sha1').update(`${name}${Date.now()}`).digest('hex').slice(0, 10)}`;
					const dir = path.join(root, 'projects', id);
					for (const bucket of ['prd', 'signals', 'design', 'other']) {
						await fs.mkdir(path.join(dir, bucket), { recursive: true });
					}
					const moduleName = String(body.module || '默认模块').trim() || '默认模块';
					const meta = {
						id,
						name,
						modules: [{ id: 'M-main', name: moduleName, keywords: [moduleName], created_at: new Date().toISOString() }],
						created_at: new Date().toISOString()
					};
					if (body.quality && typeof body.quality === 'object') {
						const quality = body.quality;
						meta.quality = {
							capabilities: Array.isArray(quality.capabilities) ? quality.capabilities : ['text'],
							surfaces: Array.isArray(quality.surfaces) ? quality.surfaces : [],
							default_surface: String(quality.default_surface || ''),
							coverage_mode: quality.coverage_mode === 'exhaustive' ? 'exhaustive' : 'standard',
							include_single_entries: quality.include_single_entries === true,
							sources: quality.sources && typeof quality.sources === 'object' ? quality.sources : {}
						};
					}
					await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8');
					await fs.mkdir(path.join(root, 'artifacts', id, 'M-main'), { recursive: true });
					sendJson(res, 200, { ok: true, state: { project: meta } });
					return;
				}
				case 'project.update': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					if (info.readonly) throw new Error('只读项目不能修改');
					const projectFile = path.join(info.dir, 'project.json');
					const meta = JSON.parse(await fs.readFile(projectFile, 'utf8'));
					if (typeof body.name === 'string') {
						const name = body.name.trim();
						if (name === '') throw new Error('项目名不能为空');
						meta.name = name;
					}
					if (body.quality !== undefined) {
						const quality = body.quality && typeof body.quality === 'object' ? body.quality : {};
						if (quality.capabilities !== undefined && !Array.isArray(quality.capabilities)) throw new Error('capabilities 必须是数组');
						if (quality.surfaces !== undefined && !Array.isArray(quality.surfaces)) throw new Error('surfaces 必须是数组');
						if (quality.sources !== undefined && (typeof quality.sources !== 'object' || Array.isArray(quality.sources))) throw new Error('sources 必须是对象');
						if (quality.coverage_mode !== undefined && quality.coverage_mode !== '' && quality.coverage_mode !== 'standard' && quality.coverage_mode !== 'exhaustive') {
							throw new Error('coverage_mode 必须是 standard 或 exhaustive');
						}
						if (quality.include_single_entries !== undefined && typeof quality.include_single_entries !== 'boolean') {
							throw new Error('include_single_entries 必须是布尔值');
						}
						if (quality.export_template !== undefined && quality.export_template !== '' && !['standard', 'zentao', 'jira', 'custom'].includes(quality.export_template)) {
							throw new Error('export_template 必须是 standard / zentao / jira / custom');
						}
						if (quality.export_columns !== undefined && !Array.isArray(quality.export_columns)) {
							throw new Error('export_columns 必须是数组');
						}
						const projectRoot = path.resolve(info.dir);
						for (const relative of Object.values(quality.sources || {})) {
							if (typeof relative !== 'string' || relative.trim() === '') continue;
							const resolved = path.resolve(projectRoot, relative.trim());
							if (!resolved.startsWith(projectRoot + path.sep)) throw new Error(`来源文件路径越界：${relative}`);
							if (!fsSync.existsSync(resolved)) throw new Error(`来源文件不存在：${relative}`);
						}
						if (quality.default_surface && Array.isArray(quality.surfaces) && quality.surfaces.length && !quality.surfaces.includes(quality.default_surface)) {
							throw new Error('默认界面必须在界面词表中');
						}
						meta.quality = quality;
					}
					await fs.writeFile(projectFile, JSON.stringify(meta, null, 2), 'utf8');
					sendJson(res, 200, { ok: true, state: { project: meta } });
					return;
				}
				case 'project.diagnose': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const quality = info.quality || null;
					const issues = [];
					if (!quality) issues.push({ code: 'QUALITY_MISSING', message: '缺少项目质量声明：类型、来源文件与界面词表未配置' });
					else {
						if (!Array.isArray(quality.capabilities) || quality.capabilities.length === 0) issues.push({ code: 'CAPABILITIES_MISSING', message: '未声明项目能力（至少 text）' });
						if (!Array.isArray(quality.surfaces) || quality.surfaces.length === 0) issues.push({ code: 'SURFACES_MISSING', message: '未声明界面词表，用例步骤可能无法定位页面' });
						if ((quality.capabilities || []).includes('text') && !String(quality.sources?.prd || '').trim()) issues.push({ code: 'PRD_SOURCE_MISSING', message: '未配置 PRD 来源文件' });
						if ((quality.capabilities || []).includes('protocol') && !String(quality.sources?.dbc || '').trim()) issues.push({ code: 'DBC_SOURCE_MISSING', message: '未配置 DBC 来源文件' });
						if (quality.default_surface && Array.isArray(quality.surfaces) && quality.surfaces.length && !quality.surfaces.includes(quality.default_surface)) {
							issues.push({ code: 'DEFAULT_SURFACE_INVALID', message: '默认界面不在界面词表中' });
						}
						for (const [role, relative] of Object.entries(quality.sources || {})) {
							if (typeof relative !== 'string' || relative.trim() === '') continue;
							if (!fsSync.existsSync(path.join(info.dir, relative.trim()))) issues.push({ code: 'SOURCE_MISSING', message: `来源文件不存在：${relative}` });
						}
						if ((quality.capabilities || []).includes('protocol') && !String(quality.sources?.dbc || '').trim()) {
							issues.push({ code: 'DBC_MISSING', message: '声明了协议能力但未配置 DBC 来源' });
						}
					}
					sendJson(res, 200, { ok: true, state: { quality, issues, readonly: info.readonly } });
					return;
				}
				case 'project.suggestQuality': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const buckets = [
						['prd', /\.(md|markdown|docx?|pdf|html?)$/i],
						['signals', /\.(dbc|xlsx)$/i],
						['design', /\.(pix|png|jpe?g|webp)$/i]
					];
					const found = {};
					for (const [bucket, pattern] of buckets) {
						const entries = await fs.readdir(path.join(info.dir, bucket)).catch(() => []);
						const name = entries.find((entry) => !entry.startsWith('.') && pattern.test(entry));
						if (name) found[bucket] = `${bucket}/${name}`;
					}
					const base = info.quality || {};
					const capabilities = new Set(base.capabilities || ['text']);
					capabilities.add('text');
					if (found.signals) capabilities.add('protocol');
					if (found.design) capabilities.add('design');
					const sources = { ...(base.sources || {}) };
					if (found.prd) sources.prd = found.prd;
					if (found.signals) sources.dbc = found.signals;
					if (found.design) sources.design = found.design;
					const surfaces = Array.isArray(base.surfaces) && base.surfaces.length ? [...base.surfaces] : ['页面'];
					sendJson(res, 200, { ok: true, state: {
						capabilities: [...capabilities], sources, surfaces,
						default_surface: base.default_surface && surfaces.includes(base.default_surface) ? base.default_surface : surfaces[0],
						found
					} });
					return;
				}
				case 'project.autoConfig': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					if (info.readonly) return sendJson(res, 200, { ok: true, state: { updated: false, reason: '只读项目' } });
					const moduleId = resolveModule(info, body.module);
					const suggestion = await suggestModuleQuality(info.id, moduleId);
					if (suggestion.updated) {
						const file = path.join(info.dir, 'project.json');
						const doc = JSON.parse(await fs.readFile(file, 'utf8'));
						doc.quality = suggestion.quality;
						await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
					}
					sendJson(res, 200, { ok: true, state: {
						updated: suggestion.updated, quality: suggestion.quality, module: moduleId,
						candidates: suggestion.candidates, missing: suggestion.missing,
						invalid_overrides: suggestion.invalidOverrides, sibling: suggestion.sibling,
						rows: suggestion.resolved.rows, counts: suggestion.resolved.counts
					} });
					return;
				}
				case 'project.delete': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					if (info.readonly) throw new Error('只读项目不能删除');
					const projectId = info.id;
					const tagDoc = await readAssetTags();
					if (tagDoc.projects?.[projectId]) { delete tagDoc.projects[projectId]; await writeAssetTags(tagDoc); }
					await fs.rm(info.dir, { recursive: true, force: true });
					await fs.rm(path.join(root, 'artifacts', projectId), { recursive: true, force: true });
					await fs.rm(path.join(root, 'evidence', projectId), { recursive: true, force: true });
					await fs.rm(path.join(root, 'locks', `${projectId}.lock`), { force: true });
					const exportDir = path.join(root, 'exports');
					const entries = await fs.readdir(exportDir).catch(() => []);
					for (const entry of entries) {
						if (!entry.startsWith(projectId + '-') && !entry.startsWith(projectId + '_')) continue;
						await fs.rm(path.join(exportDir, entry), { recursive: true, force: true });
					}
					sendJson(res, 200, { ok: true, state: { deleted: projectId } });
					return;
				}
				case 'evidence.module': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const evidence = await loadEvidenceAll(config, body.project, root);
					const moduleMeta = (info.modules || []).find((item) => item.id === resolveModule(info, body.module)) || {};
					const keywords = (moduleMeta.keywords || []).filter(Boolean);
					const all = evidence?.items || [];
					const matched = keywords.length === 0 ? all : all.filter((item) => keywords.some((word) => String(item.text).includes(word) || String(item.location).includes(word)));
					const use = matched.length >= 5 ? matched : all;
					sendJson(res, 200, {
						ok: true,
						state: {
							module: moduleMeta.name || '',
							keywords,
							total: all.length,
							matched: matched.length,
							fallback: matched.length < 5,
							items: use.slice(0, 30).map((item) => ({ id: item.id, location: item.location, source: item.source, excerpt: String(item.text).slice(0, 90) }))
						}
					});
					return;
				}
				case 'module.list': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const modules = (info.modules || []).map((item) => {
						const dir = path.join(root, 'artifacts', body.project, item.id);
						const stat = fsSync.existsSync(dir) ? fsSync.statSync(dir) : null;
						return { ...item, dir, hasArtifacts: Boolean(stat) };
					});
					sendJson(res, 200, { ok: true, state: { modules, current: resolveModule(info, body.module) } });
					return;
				}
				case 'module.create': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const name = String(body.name || '').trim();
					if (name === '') throw new Error('模块名不能为空');
					const meta = JSON.parse(await fs.readFile(path.join(info.dir, 'project.json'), 'utf8'));
					meta.modules = Array.isArray(meta.modules) ? meta.modules : [];
					if (meta.modules.some((item) => item.name === name)) throw new Error('模块已存在');
					const id = `M-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 6)}`;
					const module = {
						id,
						name,
						keywords: Array.isArray(body.keywords) && body.keywords.length > 0 ? body.keywords : [name],
						created_at: new Date().toISOString()
					};
					meta.modules.push(module);
					await fs.writeFile(path.join(info.dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8');
					await fs.mkdir(path.join(root, 'artifacts', body.project, id), { recursive: true });
					sendJson(res, 200, { ok: true, state: { module, modules: meta.modules } });
					return;
				}
				case 'module.update': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const meta = JSON.parse(await fs.readFile(path.join(info.dir, 'project.json'), 'utf8'));
					const module = (meta.modules || []).find((item) => item.id === body.id);
					if (!module) throw new Error('模块不存在');
					if (typeof body.name === 'string' && body.name.trim() !== '') module.name = body.name.trim();
					if (Array.isArray(body.keywords)) module.keywords = body.keywords.filter((word) => typeof word === 'string' && word.trim() !== '');
					await fs.writeFile(path.join(info.dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8');
					sendJson(res, 200, { ok: true, state: { module } });
					return;
				}
				case 'module.delete': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const meta = JSON.parse(await fs.readFile(path.join(info.dir, 'project.json'), 'utf8'));
					const modules = Array.isArray(meta.modules) ? meta.modules : [];
					if (modules.length <= 1) throw new Error('至少要保留一个模块');
					const target = modules.find((item) => item.id === body.id);
					if (!target) throw new Error('模块不存在');
					meta.modules = modules.filter((item) => item.id !== body.id);
					await fs.writeFile(path.join(info.dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8');
					const tagDoc = await readAssetTags();
					if (tagDoc.projects?.[body.project]) {
						for (const entry of Object.values(tagDoc.projects[body.project])) {
							entry.tags = (entry.tags || []).filter((tag) => tag !== body.id);
						}
						await writeAssetTags(tagDoc);
					}
					const trash = path.join(root, 'artifacts', body.project, '.trash', `${body.id}-${Date.now()}`);
					await fs.mkdir(path.dirname(trash), { recursive: true });
					await fs.rename(path.join(root, 'artifacts', body.project, target.id), trash).catch(() => {});
					sendJson(res, 200, { ok: true, state: { removed: target, modules: meta.modules, trash } });
					return;
				}
				case 'assets.library': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const rootDir = path.join(info.dir, 'design', 'library');
					const dirs = await fs.readdir(rootDir).catch(() => []);
					const libraries = [];
					for (const dir of dirs) {
						const indexFile = path.join(rootDir, dir, 'index.json');
						let index;
						try {
							index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
						} catch {
							continue;
						}
						const components = Object.entries(index.components || {}).map(([nodeId, entry]) => ({
							nodeId,
							name: entry.name,
							page: entry.page || '',
							file: entry.file,
							width: Math.round(entry.width || 0),
							height: Math.round(entry.height || 0),
							bytes: entry.bytes || 0
						}));
						const pages = [...new Set(components.map((item) => item.page))].map((page) => ({
							name: page,
							count: components.filter((item) => item.page === page).length
						}));
						libraries.push({ fileKey: index.fileKey || dir, pages, components, total: components.length });
					}
					sendJson(res, 200, { ok: true, state: { libraries } });
					return;
				}
				case 'skills.list':
					sendJson(res, 200, { ok: true, state: { items: listSkills(root) } });
					return;
				case 'skills.replace':
				case 'skills.restore': {
					const upload = body.action === 'skills.replace' ? { filename: body.filename, content: body.content } : null;
					const items = updateSkill(root, body.name, upload);
					sendJson(res, 200, { ok: true, state: { items } });
					return;
				}
				case 'assets.pool.list': {
					const state = await poolAssetList();
					sendJson(res, 200, { ok: true, state });
					return;
				}
				case 'assets.compare': {
					const left = await resolveAssetRef(body.project, body.left);
					const right = await resolveAssetRef(body.project, body.right);
					const leftHash = await fileHash(left.file).catch(() => '');
					const rightHash = await fileHash(right.file).catch(() => '');
					const leftStat = await fs.stat(left.file).catch(() => null);
					const rightStat = await fs.stat(right.file).catch(() => null);
					sendJson(res, 200, { ok: true, state: {
						same: leftHash === rightHash, left: { ...left, file: undefined, hash: leftHash, bytes: leftStat?.size || 0 },
						right: { ...right, file: undefined, hash: rightHash, bytes: rightStat?.size || 0 },
						impact: await assetImpact(body.project, right.path).catch(() => null)
					} });
					return;
				}
				case 'assets.adopt': {
					assertWritable(body.project);
					const target = await resolveAssetRef(body.project, { storage: 'project', project_id: body.project, path: body.target_path || body.path });
					const source = await resolveAssetRef(body.project, body.source);
					if (!target.file || !source.file) throw new Error('目标或来源不存在');
					const release = await acquireLock(root, body.project);
					try {
						const sourceHash = await fileHash(source.file);
						if (body.source_hash && body.source_hash !== sourceHash) throw new Error('来源版本已变化，请重新选择');
						const targetHash = await fileHash(target.file).catch(() => '');
						if (sourceHash === targetHash) throw new Error('来源与目标内容相同');
						const backup = target.file + '.' + crypto.randomUUID() + '.bak';
						await fs.copyFile(target.file, backup);
						try {
							await fs.copyFile(source.file, target.file);
							const tagDoc = await readAssetTags();
							const tags = tagDoc.projects?.[body.project]?.[target.path]?.tags || [];
							await registerProjectAsset(await findProject(config, body.project), target.path, tags).catch(() => {});
							const impact = await assetImpact(body.project, target.path);
							sendJson(res, 200, { ok: true, state: { adopted: target.path, from: source.path,
								hash: sourceHash, content_version: sourceHash.slice(0, 18), tags, impact } });
						} catch (error) {
							await fs.copyFile(backup, target.file).catch(() => {});
							throw error;
						} finally { await fs.unlink(backup).catch(() => {}); }
					} finally { await release(); }
					return;
				}
				case 'assets.pool.batch': {
					assertWritable(body.project);
					const preview = await batchImportPlan(body);
					if (body.commit !== true) {
						sendJson(res, 200, { ok: true, state: { preview: true, project: preview.info.id, module: preview.moduleId, items: preview.plans } });
						return;
					}
					const release = await acquireLock(root, body.project);
					try {
						const results = [];
						for (const plan of preview.plans) {
							if (plan.action === 'error') { results.push({ ...plan, ok: false }); continue; }
							try {
								const result = await poolImport({ project: preview.info.id, module: preview.moduleId,
									storage: plan.storage, source_project: plan.source_project, path: plan.source_path,
									asset_hash: plan.hash });
								results.push({ ...plan, ok: true, target: result.path, reused: result.reused });
							} catch (error) {
								results.push({ ...plan, ok: false, reason: error.message });
							}
						}
						sendJson(res, 200, { ok: true, state: { project: preview.info.id, module: preview.moduleId,
							results, failed: results.filter((item) => !item.ok).map((item) => item.id) } });
					} finally { await release(); }
					return;
				}
				case 'assets.pool.import': {
					assertWritable(body.project);
					const release = await acquireLock(root, body.project);
					try {
						const result = await poolImport(body);
						sendJson(res, 200, { ok: true, state: result });
					} finally { await release(); }
					return;
				}
				case 'assets.tags.view': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const moduleId = body.module ? resolveModule(info, body.module) : '';
					const assets = await projectTagList(info, moduleId);
					sendJson(res, 200, { ok: true, state: { assets, modules: info.modules || [], project: info.id, module: moduleId } });
					return;
				}
				case 'assets.tags.update': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					if (info.readonly) throw new Error('只读项目不能修改标签');
					const relative = String(body.path || '');
					if (!relative || relative.includes('..')) throw new Error('非法资产路径');
					const moduleId = body.module ? resolveModule(info, body.module) : '';
					if (moduleId && !(info.modules || []).some((item) => item.id === moduleId)) throw new Error('模块不存在');
					if (relative.startsWith('design/') && moduleId) {
						const sourceId = relative.slice('design/'.length);
						if (body.add === true) {
							const src = layerSources(root, info.id).find((s) => s.store && s.id === sourceId);
							if (src) await rememberDesignSource(info, info.id, moduleId, src);
						} else {
							const designDoc = await withModule(moduleId, () => loadArtifact(root, info.id, 'design-sources'));
							const nextDesign = (designDoc.items || []).filter((item) => item.source_id !== sourceId);
							if (nextDesign.length !== (designDoc.items || []).length) {
								await withModule(moduleId, () => saveArtifact(root, info.id, 'design-sources', { ...designDoc, items: nextDesign }));
							}
							const scopeDoc = await withModule(moduleId, () => loadArtifact(root, info.id, 'source-scope'));
							const nextScope = (scopeDoc.items || []).filter((item) => item.path !== relative);
							if (nextScope.length !== (scopeDoc.items || []).length) {
								await withModule(moduleId, () => saveArtifact(root, info.id, 'source-scope', { ...scopeDoc, items: nextScope }));
							}
							const selDoc = await withModule(moduleId, () => loadArtifact(root, info.id, 'material-selection'));
							const nextSel = (selDoc.items || []).filter((item) => item.path !== relative);
							if (nextSel.length !== (selDoc.items || []).length) {
								await withModule(moduleId, () => saveArtifact(root, info.id, 'material-selection', { ...selDoc, items: nextSel }));
							}
						}
						sendJson(res, 200, { ok: true, state: { path: relative, tags: body.add === true ? [moduleId] : [] } });
						return;
					}
					const entry = await updateProjectAssetTag(info, relative, moduleId, body.add === true ? 'add' : 'remove');
					sendJson(res, 200, { ok: true, state: { path: relative, tags: entry.tags } });
					return;
				}
				case 'assets.center': {
					const info = body.project ? await findProject(config, body.project) : null;
					if (body.project && !info) throw new Error(`项目不存在：${body.project}`);
					const moduleId = info ? resolveModule(info, body.module) : '';
					const global = await globalAssets();
					const allProjects = await listProjects(config);
					const projectSummaries = [];
					const allAssets = [];
					for (const item of allProjects) {
						const tags = await syncProjectAssetTags(item).catch(() => null);
						const files = await projectAssets(item);
						projectSummaries.push({ id: item.id, name: item.name, readonly: item.readonly, count: files.length });
						for (const asset of files) {
							allAssets.push({ ...asset, project_id: item.id, project_name: item.name,
								tags: tags?.[asset.path]?.tags || [] });
						}
					}
					const project = info ? (await projectAssets(info)).map((item) => ({ ...item, editable: !info.readonly })) : [];
					const modules = info ? (info.modules || []) : [];
					const modulePrivate = info && moduleId ? (await moduleAssets(info, moduleId)).map((item) => ({ ...item, editable: !info.readonly })) : [];
					const scopeDoc = info ? await loadArtifact(root, body.project, 'source-scope') : { items: [] };
					const selected = new Set(scopeDoc.items.map((item) => item.path));
					const defaultVisible = scopeDoc.mode === 'all' ? true : scopeDoc.mode === 'selected' ? false : selected.size === 0;
					const annotated = project.map((item) => ({ ...item, visible: defaultVisible || selected.has(item.path) }));
					const effective = info ? [...global, ...annotated.filter((item) => item.visible), ...modulePrivate] : [...global];
					sendJson(res, 200, { ok: true, state: {
						scope: body.scope || 'global', project: info?.id || '', module: moduleId,
						projectName: info?.name || '', modules, projectSummaries, allAssets,
						global, project: annotated, moduleAssets: modulePrivate,
						effective, visibilityDefault: defaultVisible
					} });
					return;
				}
				case 'assets.visibility': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					if (info.readonly) throw new Error('只读项目不能修改可见性');
					const moduleId = resolveModule(info, body.module);
					const release = await acquireLock(root, body.project);
					try {
						const project = await projectAssets(info);
						const target = project.find((item) => item.path === String(body.path || ''));
						if (!target) throw new Error('项目资产不存在');
						const doc = await withModule(moduleId, () => loadArtifact(root, body.project, 'source-scope'));
						const existing = new Map((doc.items || []).map((item) => [item.path, item]));
						const current = new Set(doc.mode === 'selected' ? doc.items.map((item) => item.path) : project.map((item) => item.path));
						if (body.visible === false) current.delete(target.path);
						else current.add(target.path);
						const items = project.filter((item) => current.has(item.path)).map((item) => {
							const prior = existing.get(item.path);
							return { ...(prior || {}), path: item.path, role: prior?.role || DEFAULT_USAGE(item.path, item.kind) };
						});
						const mode = current.size === project.length ? 'all' : 'selected';
						const state = await withModule(moduleId, () => saveArtifact(root, body.project, 'source-scope', { ...doc, meta: { ...(doc.meta || {}), mode }, items }));
						sendJson(res, 200, { ok: true, state });
					} finally { await release(); }
					return;
				}
				case 'assets.trash': {
					if (body.scope !== 'global') assertWritable(body.project);
					const scope = String(body.scope || 'project');
					const relative = String(body.path || '');
					if (!relative || relative.includes('..')) throw new Error('非法路径');
					let base;
					let info = null;
					if (scope === 'global') base = path.join(root, 'assets', 'global');
					else {
						info = await findProject(config, body.project);
						if (!info) throw new Error(`项目不存在：${body.project}`);
						if (info.readonly) throw new Error('只读项目不能删除资产');
						if (scope === 'module') {
							const moduleId = resolveModule(info, body.module);
							base = path.join(info.dir, 'modules', moduleId, 'assets');
						} else base = info.dir;
					}
					const file = path.join(base, relative);
					if (!fsSync.existsSync(file)) throw new Error('资产不存在');
					const moduleId = scope === 'module' ? resolveModule(info, body.module) : '';
					const trashRoot = assetTrashRoot(scope, info, moduleId);
					const stamp = new Date().toISOString().replace(/[:.]/g, '-');
					const trash = path.join(trashRoot, stamp, relative);
					await fs.mkdir(path.dirname(trash), { recursive: true });
					await fs.rename(file, trash);
					if (scope === 'project' && info) {
						const doc = await readAssetTags();
						const entry = doc.projects?.[info.id]?.[relative] || null;
						const metaRoot = path.join(trashRoot, '.meta');
						const metaFile = path.join(metaRoot, path.relative(trashRoot, trash) + '.json');
						await fs.mkdir(path.dirname(metaFile), { recursive: true });
						await fs.writeFile(metaFile, JSON.stringify({ original: relative, entry }, null, 1), 'utf8');
						if (doc.projects?.[info.id]) { delete doc.projects[info.id][relative]; await writeAssetTags(doc); }
					}
					sendJson(res, 200, { ok: true, state: { removed: relative, trash: path.relative(trashRoot, trash), scope } });
					return;
				}
				case 'assets.trashList': {
					const scope = String(body.scope || 'project');
					let info = null;
					let moduleId = '';
					if (scope !== 'global') {
						info = await findProject(config, body.project);
						if (!info) throw new Error(`项目不存在：${body.project}`);
						moduleId = scope === 'module' ? resolveModule(info, body.module) : '';
					}
					const trashRoot = assetTrashRoot(scope, info, moduleId);
					const files = await walkAssetFiles(trashRoot);
					const items = [];
					for (const relative of files) {
						const file = path.join(trashRoot, relative);
						const stat = await fs.stat(file).catch(() => null);
						if (!stat || !stat.isFile()) continue;
						const parts = relative.split(path.sep);
						items.push({
							trash: relative, name: path.basename(relative),
							original_path: parts.slice(1).join(path.sep),
							trashed_at: parts[0], bytes: stat.size,
							scope, project_id: info?.id || '', module_id: moduleId
						});
					}
					items.sort((a, b) => String(b.trashed_at).localeCompare(String(a.trashed_at)));
					sendJson(res, 200, { ok: true, state: { scope, items } });
					return;
				}
				case 'assets.restore': {
					if (body.scope !== 'global') assertWritable(body.project);
					const scope = String(body.scope || 'project');
					const relative = String(body.trash || '');
					if (!relative || relative.includes('..')) throw new Error('非法回收站路径');
					let info = null;
					let moduleId = '';
					if (scope !== 'global') {
						info = await findProject(config, body.project);
						if (!info) throw new Error(`项目不存在：${body.project}`);
						if (info.readonly) throw new Error('只读项目不能恢复资产');
						moduleId = scope === 'module' ? resolveModule(info, body.module) : '';
					}
					const trashRoot = assetTrashRoot(scope, info, moduleId);
					const source = path.join(trashRoot, relative);
					if (!fsSync.existsSync(source)) throw new Error('回收站条目不存在');
					const parts = relative.split(path.sep);
					const original = parts.slice(1).join(path.sep);
					if (!original || original.includes('..')) throw new Error('回收站条目缺少原路径');
					const target = path.join(assetBase(scope, info, moduleId), original);
					if (fsSync.existsSync(target)) throw new Error('原位置已有同名资产，请先处理');
					await fs.mkdir(path.dirname(target), { recursive: true });
					await fs.rename(source, target);
					let restoredEntry = null;
					if (scope === 'project' && info) {
						const metaFile = path.join(trashRoot, '.meta', relative + '.json');
						try { restoredEntry = JSON.parse(await fs.readFile(metaFile, 'utf8'))?.entry || null; } catch {}
						await registerProjectAsset(info, original, restoredEntry?.tags || []).catch(() => {});
						await fs.unlink(metaFile).catch(() => {});
					}
					sendJson(res, 200, { ok: true, state: { restored: original, scope, tags: restoredEntry?.tags || [] } });
					return;
				}
				case 'assets.refs': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const relative = String(body.path || '');
					if (!relative || relative.includes('..')) throw new Error('非法资产路径');
					const modules = [];
					for (const item of info.modules || []) {
						const doc = await withModule(item.id, () => loadArtifact(root, body.project, 'source-scope'));
						const explicit = doc.mode === 'selected';
						const visible = explicit ? doc.items.some((entry) => entry.path === relative) : true;
						modules.push({ id: item.id, name: item.name, visible });
					}
					const evidence = await loadEvidenceAll(config, body.project, root).catch(() => ({ items: [] }));
					const matchedEvidence = evidence.items.filter((item) => item.source === relative);
					const evidenceIds = new Set(matchedEvidence.map((item) => item.id));
					const facts = await loadArtifact(root, body.project, 'facts');
					const relatedFacts = facts.items.filter((fact) => (fact.evidence_refs || []).some((id) => evidenceIds.has(id)));
					const factIds = new Set(relatedFacts.map((fact) => fact.fact_id));
					const contracts = await loadArtifact(root, body.project, 'contracts');
					const relatedContracts = contracts.items.filter((item) => (item.fact_refs || []).some((id) => factIds.has(id)));
					sendJson(res, 200, { ok: true, state: {
						path: relative, modules, visibility: modules.filter((item) => item.visible).length,
						evidence: matchedEvidence.length, facts: relatedFacts.length, contracts: relatedContracts.length
					} });
					return;
				}
				case 'assets.transfer': {
					const sourceScope = String(body.scope || 'module');
					const targetScope = String(body.target_scope || 'project');
					const relative = String(body.path || '');
					if (!relative || relative.includes('..')) throw new Error('非法资产路径');
					if (sourceScope === targetScope && (body.module || '') === (body.target_module || '')) throw new Error('源和目标相同');
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					if (info.readonly) throw new Error('只读项目不能移动资产');
					const sourceModule = sourceScope === 'module' ? resolveModule(info, body.module) : '';
					const targetModule = targetScope === 'module' ? resolveModule(info, body.target_module || body.module) : '';
					const sourceBase = assetBase(sourceScope, info, sourceModule);
					const targetBase = assetBase(targetScope, info, targetModule);
					const source = path.join(sourceBase, relative);
					if (!fsSync.existsSync(source)) throw new Error('源资产不存在');
					const target = path.join(targetBase, relative);
					if (fsSync.existsSync(target)) throw new Error('目标位置已有同名资产');
					await fs.mkdir(path.dirname(target), { recursive: true });
					if (body.mode === 'copy') await fs.copyFile(source, target);
					else await fs.rename(source, target);
					sendJson(res, 200, { ok: true, state: { from: sourceScope, to: targetScope, path: relative, mode: body.mode === 'copy' ? 'copy' : 'move' } });
					return;
				}
				case 'assets.list': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const buckets = [
						{ dir: 'prd', kind: 'PRD' },
						{ dir: 'signals', kind: '信号矩阵' },
						{ dir: 'design', kind: 'UI 设计' },
						{ dir: 'other', kind: '其他' }
					];
					const assets = [];
					for (const bucket of buckets) {
						const full = path.join(info.dir, bucket.dir);
						const entries = await fs.readdir(full).catch(() => []);
						for (const entry of entries) {
							if (entry.startsWith('.')) continue;
							const file = path.join(full, entry);
							const stat = await fs.stat(file).catch(() => null);
							if (!stat || !stat.isFile()) continue;
							assets.push({
								name: entry,
								path: path.join(bucket.dir, entry),
								kind: bucket.kind,
								dir: bucket.dir,
								bytes: stat.size,
								modified: stat.mtime.toISOString()
							});
						}
					}
					sendJson(res, 200, { ok: true, state: { assets, modules: info.modules || [] } });
					return;
				}
				case 'assets.add': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					let source = String(body.path || '').trim().replace(/^file:\/\//, '');
					if (/^['"].*['"]$/.test(source)) source = source.slice(1, -1).trim();
					if (source.startsWith('~/')) source = path.join(process.env.HOME || '', source.slice(2));
					if (source === '') throw new Error('路径为空');
					if (!fsSync.existsSync(source)) throw new Error(`源文件不存在：${source}`);
					if (fsSync.statSync(source).isDirectory()) throw new Error(`这是一个文件夹，请选择具体文件：${source}`);
					const bucket = ['prd', 'signals', 'design', 'other'].includes(body.dir) ? body.dir : inferBucket(source);
					const dir = path.join(info.dir, bucket);
					await fs.mkdir(dir, { recursive: true });
					const name = path.basename(source);
					const target = path.join(dir, name);
					await fs.copyFile(source, target);
					await registerProjectAsset(info, path.join(bucket, name), []).catch(() => {});
					sendJson(res, 200, { ok: true, state: { added: path.join(bucket, name) } });
					return;
				}
				case 'assets.remove': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const relative = String(body.path || '');
					if (relative.includes('..')) throw new Error('非法路径');
					const file = path.join(info.dir, relative);
					if (!fsSync.existsSync(file)) throw new Error('文件不存在');
					const trash = path.join(info.dir, '.trash', `${Date.now()}-${path.basename(file)}`);
					await fs.mkdir(path.dirname(trash), { recursive: true });
					await fs.rename(file, trash);
					sendJson(res, 200, { ok: true, state: { removed: relative, trash } });
					return;
				}
				case 'workbench.state': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const moduleId = resolveModule(info, body.module);
					const resolved = await resolveMaterials(info.id, moduleId);
					const moduleDoc = await withModule(moduleId, async () => {
						const [facts, features, points, cases, outline, review] = await Promise.all(
							['facts', 'features', 'points', 'cases', 'outline', 'review'].map((kind) => loadArtifact(root, info.id, kind)));
						const states = loadStates(root, info.id);
						const bindings = loadBindings(root, info.id, moduleId);
						const contracts = await modelContracts(info.id, facts.items, features.items, resolved.evidence);
						const model = buildEcsm(root, info.id, { facts, features, states, bindings, points, cases, contracts });
						const current = currentEcsmVersion(root, info.id);
						const frozenPackage = isFrozen(root, info.id);
						const outlineBranchesStale = await branchOutlineStale(info.id, outline.items[0]);
						return { facts, features, points, cases, outline, review, states, bindings, contracts, model, current, frozenPackage, outlineBranchesStale };
					});
					const evidence = resolved.evidence;
					const blockers = [];
					const parseFailures = resolved.rows.filter((row) => row.selected && /解析失败/.test(row.exclusion || ''));
					for (const row of parseFailures) blockers.push({ code: 'SOURCE_PARSE_FAILED', reason: `资料解析失败：${row.path}`, object_id: row.path, target: { view: 'center', tab: 'materials', filter: { path: row.path } } });
					for (const row of resolved.rows.filter((entry) => entry.selected && entry.design_issue)) {
						blockers.push({ code: row.design_issue, reason: row.exclusion, object_id: row.path,
							target: { view: 'center', tab: 'design', filter: { path: row.path } } });
					}
					const unapproved = (moduleDoc.contracts || []).filter((item) => item.status !== 'approved');
					const outlineItem = moduleDoc.outline.items?.[0] || null;
					const pointsDigest = digestOf(moduleDoc.points.items);
					const stale = [];
					if (moduleDoc.outlineBranchesStale || (moduleDoc.current && outlineItem?.source_ecsm_digest && outlineItem.source_ecsm_digest !== moduleDoc.current.digest)) {
						stale.push({ code: 'OUTLINE_STALE', reason: moduleDoc.outlineBranchesStale ? staleBranchOutlineMessage : '资料或模型更新后，当前大纲基于旧版本', object_id: outlineItem.outline_id || '', target: { view: 'design', tab: 'outline' } });
					}
					if (moduleDoc.points.items.length && ((moduleDoc.current && moduleDoc.points.source_ecsm_digest && moduleDoc.points.source_ecsm_digest !== moduleDoc.current.digest)
						|| (moduleDoc.points.source_outline_digest && moduleDoc.points.source_outline_digest !== moduleDoc.outline.digest))) {
						stale.push({ code: 'POINTS_STALE', reason: '测试点基于旧版模型或大纲', object_id: '', target: { view: 'design', tab: 'points' } });
					}
					if (moduleDoc.points.items.length && moduleDoc.cases.items.length && moduleDoc.cases.source_points_digest && moduleDoc.cases.source_points_digest !== pointsDigest) stale.push({ code: 'CASES_STALE', reason: '测试点更新后，用例基于旧版本', object_id: '', target: { view: 'design', tab: 'cases' } });
					for (const item of stale) blockers.push(item);
					const deferrals = (await withModule(moduleId, () => loadArtifact(root, info.id, 'deferrals'))).items;
					const pendingDeferrals = waitingDeferrals(deferrals);
					for (const item of pendingDeferrals.slice(0, 8)) blockers.push({ code: 'DEFERRAL_PENDING', reason: `待处理延期：${item.title || item.id}`, object_id: item.id, target: { view: 'delivery', tab: 'delivery' } });
					let phase = 'materials';
					let state = 'blocked';
					let next = { id: 'select_materials', label: '选择本轮需求资料', target: { view: 'module', tab: 'materials' } };
					if (moduleDoc.frozenPackage) {
						phase = 'delivery'; state = 'frozen'; next = { id: 'delivery', label: '查看冻结交付包', target: { view: 'delivery', tab: 'delivery' } };
						blockers.length = 0;
					} else if (!resolved.counts.used) {
						blockers.push({ code: 'MATERIAL_SOURCE_MISSING', reason: '本模块还没有可用的需求资料', object_id: '', target: { view: 'module', tab: 'materials' } });
					} else if (!evidence.items.length) {
						phase = 'evidence'; next = { id: 'build_evidence', label: '解析资料', target: { view: 'ecsm', tab: 'materials' } };
					} else if (!moduleDoc.facts.items.length || !moduleDoc.features.items.length) {
						phase = 'upstream'; next = { id: 'generate_upstream', label: '生成需求草稿', target: { view: 'ecsm', tab: 'model' } };
					} else if (!moduleDoc.contracts.length) {
						phase = 'contracts'; next = { id: 'generate_contracts', label: '生成需求合同', target: { view: 'ecsm', tab: 'model', filter: { section: 'contracts' } } };
					} else if (unapproved.length && moduleDoc.current?.digest !== moduleDoc.model.digest) {
						phase = 'contract_review'; state = 'in_progress';
						next = { id: 'review_contract', label: '核对需求合同', target: { view: 'ecsm', tab: 'model', filter: { section: 'contracts', contract_id: unapproved[0].contract_id } }, object_id: unapproved[0].contract_id };
						for (const item of unapproved.slice(0, 8)) blockers.push({ code: 'CONTRACT_UNAPPROVED', reason: `合同待确认：${item.title || item.contract_id}`, object_id: item.contract_id, target: { view: 'ecsm', tab: 'model', filter: { contract_id: item.contract_id } } });
					} else if (!moduleDoc.current || moduleDoc.current.digest !== moduleDoc.model.digest) {
						phase = 'freeze'; state = 'ready'; next = { id: 'freeze_model', label: '冻结产品模型', target: { view: 'ecsm', tab: 'model', filter: { section: 'contracts' } } };
					} else if (!outlineItem) {
						phase = 'outline'; state = 'ready'; next = { id: 'design_outline', label: '进入测试设计', target: { view: 'design', tab: 'outline' } };
					} else if (stale.some((item) => item.code === 'OUTLINE_STALE')) {
						phase = 'outline'; state = 'in_progress'; next = { id: 'review_outline', label: '更新测试大纲', target: { view: 'design', tab: 'outline', filter: { object_id: outlineItem.outline_id || '' } }, object_id: outlineItem.outline_id || '' };
					} else if (!outlineItem.items?.length || outlineItem.status !== 'approved') {
						phase = 'outline'; state = 'in_progress'; next = { id: 'review_outline', label: '核对测试大纲', target: { view: 'design', tab: 'outline', filter: { object_id: outlineItem.outline_id || '' } }, object_id: outlineItem.outline_id || '' };
					} else if (!moduleDoc.points.items.length || stale.some((item) => item.code === 'POINTS_STALE')) {
						phase = 'points'; state = 'ready'; next = { id: 'generate_points', label: moduleDoc.points.items.length ? '更新测试点' : '生成测试点', target: { view: 'design', tab: 'points' } };
					} else if (!moduleDoc.cases.items.length || stale.some((item) => item.code === 'CASES_STALE')) {
						phase = 'cases'; state = 'ready'; next = { id: 'generate_cases', label: moduleDoc.cases.items.length ? '更新用例' : '生成用例', target: { view: 'design', tab: 'cases' } };
					} else {
						const { blocker, failed } = await withModule(moduleId, async () => {
							const { points, cases, outline, review, model } = moduleDoc;
							const status = await deliveryState(info.id, { points, cases, review }, model);
							status.deferralsPending = pendingDeferrals.length;
							const rows = outlineCoverage({ ...outlineItem, digest: outline.digest }, points, cases, deferrals);
							const signedCases = deliveryCases(cases, rows);
							status.approvals = approvalAudit(info.id, { points, cases: signedCases }, new Set(model.inputs.facts.items.map((item) => item.fact_id)));
							const missing = new Set(rows.filter((row) => row.state === 'case_missing').map((row) => row.point_id));
							return {
								blocker: deliveryBlocker({ points, cases: signedCases }, model, outline, rows, status),
								failed: status.failedPoints.filter((entry) => missing.has(entry.point_id))
							};
						});
						if (blocker?.step === 'cases' && failed.length) {
							phase = 'cases'; state = 'partial';
							next = { id: 'retry_failed_cases', label: '查看并重试失败用例', target: { view: 'design', tab: 'cases' } };
							for (const item of failed.slice(0, 8)) blockers.push({ code: 'CASE_GENERATION_FAILED', reason: item.error, object_id: item.point_id, target: next.target });
						} else if (blocker) {
							phase = blocker.step; state = 'in_progress';
							next = { id: 'address_delivery_blocker', label: blocker.message, target: { view: 'design', tab: blocker.step } };
							blockers.push({ code: 'DELIVERY_BLOCKED', reason: blocker.message, target: next.target });
						} else {
							phase = 'delivery'; state = 'ready'; next = { id: 'delivery', label: '进入交付', target: { view: 'delivery', tab: 'delivery' } };
						}
					}
					sendJson(res, 200, { ok: true, state: {
						module_id: moduleId, phase, state, basis: {
							materials: resolved.counts, evidence_items: evidence.items.length,
							model_digest: moduleDoc.model.digest, frozen: moduleDoc.current?.version || null,
							outline_digest: moduleDoc.outline.digest || null, points: moduleDoc.points.items.length, cases: moduleDoc.cases.items.length
						}, blockers: blockers.slice(0, 20), next_action: next
					} });
					return;
				}
				case 'pipeline.refresh':
				case 'pipeline.status': {
					const [facts, features, points, cases, review] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases'),
						loadArtifact(root, body.project, 'review')
					]);
					const states = loadStates(root, body.project);
					const bindings = loadBindings(root, body.project);
					const ecsmCurrent = currentEcsmVersion(root, body.project);
					const contracts = await modelContracts(body.project, facts.items, features.items);
					const model = buildEcsm(root, body.project, { facts, features, states, bindings, contracts });
					const exportsDir = path.join(root, 'exports');
					const exportFiles = await fs.readdir(exportsDir).catch(() => []);
					const candidates = exportFiles
						.filter((name) => name.startsWith(`${body.project}`) && name.endsWith('.xlsx'))
						.map((name) => ({ name, mtime: fsSync.statSync(path.join(exportsDir, name)).mtimeMs }))
						.sort((a, b) => b.mtime - a.mtime);
					const latestExport = candidates[0]?.name || null;
					let exportTime = null;
					if (latestExport) {
						const stat = await fs.stat(path.join(exportsDir, latestExport)).catch(() => null);
						exportTime = stat ? new Date(stat.mtimeMs).toISOString() : null;
					}
					const casesDigest = reviewBasis(review, cases);
					const stages = [
						{ key: 'facts', count: facts.items.length, updatedAt: facts.updatedAt || null, digest: facts.digest || null },
						{ key: 'features', count: features.items.length, updatedAt: features.updatedAt || null, digest: features.digest || null },
						{ key: 'states', count: states.items.length, updatedAt: states.updatedAt || null },
						{ key: 'bindings', count: bindings.items.length, updatedAt: bindings.updatedAt || null },
						{ key: 'points', count: points.items.length, updatedAt: points.updatedAt || null, stale: Boolean(points.items.length && (
							points.source_facts_digest !== digestOf(facts.items) ||
							points.source_features_digest && points.source_features_digest !== digestOf(features.items) ||
							points.source_states_digest && points.source_states_digest !== digestOf(states.items) ||
							points.source_ecsm_digest && points.source_ecsm_digest !== model.digest)) },
						{ key: 'cases', count: cases.items.length, updatedAt: cases.updatedAt || null, stale: Boolean(cases.source_points_digest && cases.source_points_digest !== digestOf(points.items)) },
						{ key: 'review', count: review.items.length, updatedAt: review.updatedAt || null, stale: Boolean(review.cases_digest && review.cases_digest !== casesDigest) },
						{ key: 'export', count: latestExport ? 1 : 0, updatedAt: exportTime, stale: Boolean(latestExport && cases.updatedAt && exportTime && new Date(exportTime) < new Date(cases.updatedAt)) },
						{ key: 'ecsm', count: ecsmCurrent ? 1 : 0, updatedAt: ecsmCurrent?.frozen_at || null, stale: ecsmCurrent?.digest !== model.digest }
					];
					sendJson(res, 200, { ok: true, state: { stages, stale: stages.filter((stage) => stage.stale).map((stage) => stage.key) } });
					return;
				}
				case 'cases.reviewImport':
				case 'cases.reviewPreview':
				case 'cases.reviewApply': {
					const cases = await loadArtifact(root, body.project, 'cases');
					const applying = body.action === 'cases.reviewApply';
					let rows = body.rows;
					// 直接提交意见（web/脚本）也要能预览，不必先造一个 Excel。
					if (!applying && !Array.isArray(rows)) {
						const file = String(body.file || '');
						if (!file || path.extname(file).toLowerCase() !== '.xlsx' || !fsSync.existsSync(file) || (await fs.stat(file)).size > 20 * 1024 * 1024) throw new Error('请选择 20 MB 以内的 Excel 评审文件');
						const content = await fs.readFile(file);
						if ([...listEntries(content).values()].reduce((size, entry) => size + entry.size, 0) > 80 * 1024 * 1024) throw new Error('评审文件解压后过大');
						const sheets = parseXlsx(content);
						const lock = sheets.find((entry) => entry.name === '评审基线')?.rows[1];
						if (!lock || String(lock[0]) !== String(cases.version) || lock[1] !== digestOf(cases.items)) throw new Error('Excel 评审基线与当前用例不一致');
						const sheet = sheets.find((entry) => entry.name === '测试用例') || sheets[0];
						const [header, ...records] = sheet?.rows || [[]];
						const column = new Map(header.map((name, index) => [name, index]));
						if (!column.has('用例ID')) throw new Error('找不到用例ID列');
						rows = records.filter((row) => row[column.get('用例ID')]).map((row) => {
							const id = String(row[column.get('用例ID')]);
							// 同码多条必须逐条留档：只靠「修改意见」一栏会把它们压成一句话。
							const raw = String(row[column.get('逐条发现')] ?? '').trim();
							let findings = [];
							if (raw) {
								try { findings = JSON.parse(raw); } catch { throw new Error(`用例 ${id} 的「逐条发现」不是合法 JSON`); }
								if (!Array.isArray(findings)) throw new Error(`用例 ${id} 的「逐条发现」须为数组`);
							}
							return { case_id: id, review_conclusion: row[column.get('评审结论')],
								review_comment: row[column.get('修改意见')], reviewer: row[column.get('评审人')], findings };
						});
					}
					if (!Array.isArray(rows)) throw new Error('评审内容无效');
					// 两个入口共用一次归一：按错误码做键的 fields 会把同码多项压成一条。
					for (const row of rows) {
						const listed = Array.isArray(row.findings) ? row.findings : [];
						row.findings = listed.map((entry) => ({ code: String(entry?.code || 'REVIEW'), field: String(entry?.field || ''), message: String(entry?.message || '') })).filter((entry) => entry.message.trim());
						if (listed.length && !row.findings.length) throw new Error(`用例 ${row.case_id} 的逐条发现没有一条含 message`);
					}
					const changes = reviewChanges(cases, rows);
					if (applying) {
						assertWritable(body.project);
						if (body.version !== cases.version || body.digest !== cases.digest) throw new Error('用例版本已变化，评审意见基于旧基线，请重新预览');
						const patches = new Map(changes.map((entry) => [entry.case_id, entry.patch]));
						const { items, version, digest, updatedAt, ...meta } = cases;
						const kind = body.action === 'cases.reviewImport' ? 'human' : String(body.review_kind || 'content');
						const byId = new Map(items.map((item) => [item.case_id, item]));
						for (const row of rows) {
							const item = byId.get(String(row.case_id));
							if (!item) continue;
							recordReview(root, body.project, {
								case_id: item.case_id,
								variant_id: caseVariant(item),
								case_digest: caseDigest(item),
								review_kind: kind,
								conclusion: String(row.review_conclusion || '').trim(),
								reviewer: String(row.reviewer || '').trim() || '未署名',
								basis: String(row.review_comment || '').trim(),
								findings: row.findings || [],
								fields: row.fields || {}
							});
						}
						await archiveArtifact(root, body.project, 'cases');
						await saveArtifact(root, body.project, 'cases', { version, meta, items: items.map((item) =>
							patches.has(item.case_id) ? { ...item, ...patches.get(item.case_id), review_status: 'candidate' } : item) });
					}
					sendJson(res, 200, { ok: true, state: { version: cases.version, digest: cases.digest, changes, rows } });
					return;
				}
				case 'signals.audit': {
					const [cases, points] = await Promise.all([
						loadArtifact(root, body.project, 'cases'),
						loadArtifact(root, body.project, 'points')
					]);
					const bindings = loadBindings(root, body.project);
					const known = new Map();
					for (const binding of bindings.items.filter((item) => item.kind === 'signal')) {
						known.set(binding.subject.name, binding);
					}
					const messageNames = new Set(bindings.items
						.filter((item) => item.kind === 'signal' && item.target?.message)
						.map((item) => item.target.message));
					const normalize = (name) => name.replace(/[\s_]/g, '').toLowerCase();
					const suggest = (token) => {
						const key = normalize(token);
						let best = { score: 0, name: '' };
						for (const name of known.keys()) {
							const target = normalize(name);
							let hit = 0;
							const size = Math.max(key.length, target.length);
							for (let index = 0; index < Math.min(key.length, target.length); index += 1) if (key[index] === target[index]) hit += 1;
							const score = hit / Math.max(1, size);
							if (score > best.score) best = { score, name };
						}
						return best.score >= 0.6 ? best.name : '';
					};
					const byNormalized = new Map([...known.keys()].map((name) => [normalize(name), name]));
					const tokens = new Set();
					const scan = (item) => {
						const text = JSON.stringify(item);
						const prefixes = signalPrefixes().map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
						if (!prefixes) return;
						for (const match of text.matchAll(new RegExp(`(?:${prefixes})[A-Za-z0-9_]+`, 'g'))) tokens.add(match[0]);
					};
					cases.items.forEach(scan);
					points.items.forEach(scan);
					const unknown = [];
					const remapped = [];
					for (const token of tokens) {
						if (known.has(token) || messageNames.has(token)) continue;
						const canonical = byNormalized.get(normalize(token));
						if (canonical) remapped.push({ from: token, to: canonical });
						else unknown.push(token);
					}
					// Signals that really are absent from the DBC become human questions.
					const document = loadQuestions(root, body.project);
					const existing = new Set(document.items.map((item) => `${item.kind}:${item.subject}`));
					let created = 0;
					for (const token of unknown) {
						if (existing.has(`signal:${token}`)) continue;
						document.items.push({
							id: '',
							scope: 'design',
							kind: 'signal',
							subject: token,
							ref: '',
							question: `用例/测试点里写了信号「${token}」，但 DBC 里没有这个信号。是笔误、还是需要补 DBC？`,
							options: (() => {
								const guess = suggest(token);
								return guess
									? [`改为 ${guess}`, '忽略这条信号', '我提供正确信号名']
									: ['忽略这条信号', '我提供正确信号名', '先记为待定'];
							})(),
							status: 'open',
							answer: ''
						});
						created += 1;
					}
					// Drop stale signal questions that are now resolved (message names or known signals).
					document.items = document.items.filter((item) => !(item.kind === 'signal' && (known.has(item.subject) || messageNames.has(item.subject))));
					document.items.forEach((item, index) => { item.id = `Q-${String(index + 1).padStart(3, '0')}`; });
					saveQuestions(root, body.project, document.items);
					sendJson(res, 200, {
						ok: true,
						state: { seen: tokens.size, known: known.size, unknown: unknown.length, remappable: remapped.length, created, samples: unknown.slice(0, 12) }
					});
					return;
				}
				case 'signals.enrich': {
					const [cases, points] = await Promise.all([
						loadArtifact(root, body.project, 'cases'),
						loadArtifact(root, body.project, 'points')
					]);
					const bindings = loadBindings(root, body.project);
					const caseChanges = enrichSignals(cases.items, bindings);
					const pointChanges = enrichSignals(points.items, bindings);
					await saveArtifact(root, body.project, 'cases', { version: cases.version, items: cases.items, meta: { source_points_digest: cases.source_points_digest || digestOf(points.items) } });
					await saveArtifact(root, body.project, 'points', { version: points.version, items: points.items, meta: { source_facts_digest: points.source_facts_digest || null } });
					sendJson(res, 200, { ok: true, state: { cases: caseChanges, points: pointChanges } });
					return;
				}
				case 'integrity.check': {
					const [facts, features, points, cases, bindings] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases'),
						Promise.resolve(loadBindings(root, body.project))
					]);
					const states = loadStates(root, body.project);
					const checks = [];
					const compare = (name, basis, current) => {
						const stale = Boolean(basis && current && basis !== current);
						checks.push({ name, basis: basis || null, current: current || null, stale });
					};
					compare('points ← facts', points.source_facts_digest, digestOf(facts.items));
					compare('cases ← points', cases.source_points_digest, digestOf(points.items));
					compare('bindings ← facts', bindings.source_facts_digest, digestOf(facts.items));
					compare('states ← features', states.source_features_digest, digestOf(features.items));
					const review = await loadArtifact(root, body.project, 'review');
					compare('review ← cases', review.cases_digest, reviewBasis(review, cases));
					sendJson(res, 200, { ok: true, state: { checks, stale: checks.filter((check) => check.stale).length } });
					return;
				}
				case 'compile.check': {
					const cases = await loadArtifact(root, body.project, 'cases');
					const points = await loadArtifact(root, body.project, 'points');
					const facts = await loadArtifact(root, body.project, 'facts');
					const issues = lint(cases.items, new Set(points.items.map((point) => point.point_id)), new Set(facts.items.map((fact) => fact.fact_id)));
					const serious = issues.filter((issue) => issue.severity !== 'warning');
					sendJson(res, 200, { ok: true, state: { issues: issues.slice(0, 50), errorCount: serious.length, warningCount: issues.length - serious.length } });
					return;
				}
				case 'sources.selection.remove': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const moduleId = resolveModule(info, body.module);
					const pathToRemove = String(body.path || '');
					if (!pathToRemove || pathToRemove.includes('..')) throw new Error('非法资料路径');
					const release = await acquireLock(root, body.project);
					try {
						const doc = await withModule(moduleId, () => loadArtifact(root, body.project, 'material-selection'));
						const items = (doc.items || []).filter((item) => item.path !== pathToRemove);
						await withModule(moduleId, () => saveArtifact(root, body.project, 'material-selection', { ...doc, items }));
						// MCP 设计来源的“移出本轮”同时解除当前模块来源绑定；源库与冻结包不动。
						const designMatch = /^design\/(.+)$/.exec(pathToRemove);
						if (designMatch) {
							const sourceId = designMatch[1];
							const designDoc = await withModule(moduleId, () => loadArtifact(root, body.project, 'design-sources'));
							const designItems = (designDoc.items || []).filter((item) => item.source_id !== sourceId);
							await withModule(moduleId, () => saveArtifact(root, body.project, 'design-sources', { ...designDoc, items: designItems }));
							const scopeDoc = await withModule(moduleId, () => loadArtifact(root, body.project, 'source-scope'));
							const scopeItems = (scopeDoc.items || []).filter((item) => item.path !== pathToRemove);
							await withModule(moduleId, () => saveArtifact(root, body.project, 'source-scope', { ...scopeDoc,
								meta: { ...(scopeDoc.meta || {}), mode: scopeDoc.mode === 'selected' ? 'selected' : 'all' }, items: scopeItems }));
						}
						sendJson(res, 200, { ok: true, state: { removed: pathToRemove, remaining: items.length, design_scope_removed: Boolean(designMatch) } });
					} finally { await release(); }
					return;
				}
				case 'sources.resolve': {
					const resolved = await resolveMaterials(body.project, body.module);
					sendJson(res, 200, { ok: true, state: {
						project_id: resolved.project_id, project_name: resolved.project_name, module_id: resolved.module_id,
						explicit_selection: resolved.explicit_selection, scope_version: resolved.scope_version,
						rows: resolved.rows, selection: resolved.selection, counts: resolved.counts
					} });
					return;
				}
				case 'sources.view':
				case 'sources.save': {
					const doc = await withModule(body.module ? resolveModule(await findProject(config, body.project), body.module) : currentModule(), () => loadArtifact(root, body.project, 'source-scope'));
					const index = await loadEvidence(config, body.project, root);
					const sources = index?.stats.sources || [];
					let state = doc;
					if (body.action === 'sources.save') {
						assertWritable(body.project);
						if (body.version !== doc.version) throw new Error('资料范围已变化，请刷新');
						const roles = ['requirement', 'interface', 'design', 'reference'];
						if (!Array.isArray(body.items) || body.items.some((item) => !item || !roles.includes(item.role) || !sources.some((source) => source.path === item.path))
							|| new Set(body.items.map((item) => item.path)).size !== body.items.length) throw new Error('请选择有效的资料及用途');
						const mode = body.mode === 'selected' || body.mode === 'all' ? body.mode
							: (body.items.length ? 'selected' : 'all');
						state = await withModule(body.module ? resolveModule(await findProject(config, body.project), body.module) : currentModule(), () =>
							saveArtifact(root, body.project, 'source-scope', { ...doc, meta: { ...(doc.meta || {}), mode }, items: body.items.map(({ path, role }) => ({ path, role })) }));
					}
					const resolved = await resolveMaterials(body.project, body.module).catch(() => null);
					sendJson(res, 200, { ok: true, state: { ...state, sources, materials: resolved?.rows || [], counts: resolved?.counts || null,
						unresolved: (await loadArtifact(root, body.project, 'facts')).items.filter((fact) =>
						(fact.evidence_refs || []).some((id) => !index?.items.some((item) => item.id === id))).map((fact) => ({ id: fact.fact_id, statement: fact.statement })) } });
					return;
				}
				case 'outline.export':
				case 'outline.reviewPreview':
				case 'outline.apply': {
					const projectId = body.project;
					const doc = await loadArtifact(root, projectId, 'outline');
					const outline = doc.items[0];
					if (!outline) throw new Error('请先生成测试大纲');
					const base = doc.digest;
					if (body.action === 'outline.export') {
						const dir = path.join(root, 'exports');
						await fs.mkdir(dir, { recursive: true });
						const folder = await fs.mkdtemp(path.join(dir, 'outline-'));
						const workbook = buildWorkbook([
							{ name: '场景与覆盖', headers: ['场景ID', '功能ID', '标题', '条件', '动作', '预期', '需求', '测试方法'],
								rows: outline.items.map((row) => [row.scenario_id, row.feature_id, row.requirement, row.condition, row.action, row.expected, row.contract_refs.join('、'), row.rule_ids.join('、')]) },
							{ name: '评审意见', headers: ['场景ID', '操作', '意见', '目标功能ID'], rows: [] },
							{ name: '评审基线', headers: ['内容摘要'], rows: [[base]] }
						]);
						const topics = outline.scope.map((id) => ({ id, title: outline.feature_names?.[id] || id, children: { attached:
							outline.items.filter((row) => row.feature_id === id).map((row) => ({ id: row.scenario_id, title: row.requirement + ' 〔' + row.scenario_id + '〕' })) } }));
						const xmind = zip([
							{ name: 'content.json', content: JSON.stringify([{ id: 'sheet', class: 'sheet', title: '测试大纲', rootTopic: { id: 'root', title: '测试大纲 · ' + base, children: { attached: topics } } }]) },
							{ name: 'metadata.json', content: JSON.stringify({ creator: { name: 'DSH 测试 Agent' } }) },
							{ name: 'manifest.json', content: JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }) }
						]);
						const xlsx = path.join(folder, '测试大纲.xlsx');
						const mind = path.join(folder, '测试大纲.xmind');
						await Promise.all([fs.writeFile(xlsx, workbook), fs.writeFile(mind, xmind)]);
						sendJson(res, 200, { ok: true, state: { xlsx, xmind: mind, dir: folder } });
						return;
					}
					let changes = body.changes;
					if (body.action === 'outline.reviewPreview' && body.file) {
						const file = String(body.file);
						const stat = await fs.stat(file);
						if (stat.size > 20 * 1024 * 1024) throw new Error('评审文件过大');
						const content = await fs.readFile(file);
						const entries = listEntries(content);
						if ([...entries.values()].reduce((size, entry) => size + entry.size, 0) > 80 * 1024 * 1024) throw new Error('评审文件解压后过大');
						if (path.extname(file).toLowerCase() === '.xmind') {
							const sheets = JSON.parse(readText(content, entries, 'content.json'));
							const tree = sheets[0]?.rootTopic;
							if (!tree?.title.endsWith(base)) throw new Error('导图基线已变化');
							const current = new Map(outline.items.map((row) => [row.scenario_id, row]));
							const encountered = new Set();
							changes = (tree.children?.attached || []).flatMap((group) => (group.children?.attached || []).flatMap((topic) => {
								const id = /〔(SC-[a-f0-9]+)〕/.exec(topic.title)?.[1];
								const row = current.get(id);
								if (!row) return [{ action: 'add', comment: topic.title, feature_id: group.id }];
								encountered.add(id);
								const title = topic.title.replace(/\s*〔SC-[a-f0-9]+〕/, '');
								return [...(title !== row.requirement ? [{ id, action: 'edit', comment: title }] : []),
									...(group.id !== row.feature_id ? [{ id, action: 'move', feature_id: group.id }] : [])];
							}));
							changes.push(...outline.items.filter((row) => !encountered.has(row.scenario_id)).map((row) => ({ id: row.scenario_id, action: 'delete' })));
						} else {
							const sheets = parseXlsx(content);
							if (sheets.find((entry) => entry.name === '评审基线')?.rows[1]?.[0] !== base) throw new Error('Excel 基线已变化');
							changes = (sheets.find((entry) => entry.name === '评审意见')?.rows || []).slice(1).filter((row) => row[1])
								.map(([id, action, comment, feature_id]) => ({ id, action, comment, feature_id }));
						}
					}
					const operations = ['accept', 'edit', 'move', 'add', 'delete', 'split', 'merge', 'conflict', 'required', 'optional', 'not_applicable', 'needs_evidence'];
					if (!Array.isArray(changes) || changes.some((item) => !item || !operations.includes(item.action) ||
						(item.action !== 'add' && !outline.items.some((row) => row.scenario_id === item.id)))) throw new Error('含无效的评审动作或场景编号');
					if (body.action === 'outline.apply') {
						assertWritable(projectId);
						const frozen = await requireFrozenModel(projectId);
						const reviewer = String(body.reviewer || '').trim();
						if (base !== body.digest || outline.source_ecsm_digest !== frozen.digest || !reviewer) throw new Error('评审基线已变化，或缺少评审人');
						const item = { ...outline, status: 'draft', decisions: [...(outline.decisions || []), ...changes.map((change) =>
							({ ...change, reviewer, decided_at: new Date().toISOString() }))] };
						item.items = outline.items.map((row) => {
							const related = changes.filter((change) => change.id === row.scenario_id);
							const category = related.findLast((change) => ['required', 'optional', 'not_applicable', 'needs_evidence'].includes(change.action));
							if (category && category.action !== 'required' && !String(category.comment || '').trim()) throw new Error('请填写范围调整理由');
							const title = String(related.find((change) => change.action === 'edit')?.comment || '').trim();
							const target = related.find((change) => change.action === 'move')?.feature_id;
							if (target && !outline.scope.includes(target)) throw new Error('目标功能不在本轮范围内');
							return { ...row, ...(category ? {
								classification: category.action, scope_reason: String(category.comment || '').trim(),
								required: ['required', 'needs_evidence'].includes(category.action)
							} : {}), ...(title ? { requirement: title } : {}), ...(target ? { group_id: target } : {}),
								...(related.some((change) => change.action === 'delete') ? { omitted: true } : {}),
								...(related.some((change) => change.action === 'accept') ? { omitted: false } : {}) };
						});
						const followUps = changes.filter((change) => ['split', 'merge', 'add', 'conflict'].includes(change.action));
						for (const change of followUps) if (!String(change.comment || '').trim()) throw new Error('请说明建议内容');
						if (followUps.length) {
							const issues = await loadArtifact(root, projectId, 'conflicts');
							const entries = followUps.flatMap((change) => {
								const scenario = outline.items.find((row) => row.scenario_id === change.id);
								return (scenario?.contract_refs || []).map((id) => ({
									id: 'ISS-' + crypto.randomUUID(), contract_id: id,
									kind: change.action === 'conflict' ? 'conflict' : 'design_review', reason: String(change.comment),
									evidence_refs: [], status: 'open', origin: change.id, reviewer
								}));
							});
							if (entries.length) await saveArtifact(root, projectId, 'conflicts', { ...issues, items: [...issues.items, ...entries] });
						}
						await archiveArtifact(root, projectId, 'outline');
						await saveArtifact(root, projectId, 'outline', { ...doc, items: [item] });
					}
					sendJson(res, 200, { ok: true, state: { digest: base, changes } });
					return;
				}
				case 'outline.view':
				case 'outline.save':
				case 'outline.approve': {
					const projectId = body.project;
					const [doc, points, cases, deferrals] = await Promise.all(['outline', 'points', 'cases', 'deferrals'].map((kind) => loadArtifact(root, projectId, kind)));
					const model = await loadModel(projectId);
					let state = doc;
					if (body.action !== 'outline.view') {
						assertWritable(projectId);
						if (body.version !== doc.version || body.model_digest !== model.digest) throw new Error('模型或大纲已变化，请刷新后重试');
						const frozen = await requireFrozenModel(projectId);
						let item;
						if (body.action === 'outline.save') {
							if (body.from_branches === true) {
								const branches = await loadArtifact(root, projectId, 'branches');
								const facts = frozen.inputs.facts;
								const factToFeature = new Map();
								for (const feature of frozen.inputs.features.items) {
									for (const ref of feature.fact_refs || []) factToFeature.set(ref, feature.feature_id);
								}
								const picked = await loadArtifact(root, projectId, 'tkr-selection');
								let tkr = null;
								if (picked.items.length) {
									if (picked.source_branches_digest !== branches.digest) throw new Error('选规记录对应当前分支清单已过期，请重新运行 tkr.select');
									const annotated = annotateSelection(picked.items);
									tkr = { ...annotated, selection_digest: digestOf(picked.items), bundle_ref: picked.bundle_ref, bundle_digest: picked.bundle_digest, pack_status: picked.pack_status };
								}
								item = buildOutlineFromBranches(frozen, branches.items, doc, { ...branchResolvers(facts.items, factToFeature), tkr });
							} else {
								item = buildOutline(frozen, body.scope, doc, body.budget);
							}
							item.environment = String(body.environment || '').trim();
							item.risk = String(body.risk || '').trim();
						} else {
							item = doc.items[0];
							if (await branchOutlineStale(projectId, item)) throw new Error(staleBranchOutlineMessage);
							if (!item || item.source_ecsm_digest !== frozen.digest || !item.items.length || item.pending?.length || item.empty?.length) {
								throw new Error('请基于已确认需求更新大纲草稿后再批准');
							}
							if (!String(body.reviewer || '').trim()) throw new Error('请填写评审人');
							item = { ...item, status: 'approved', reviewed_at: new Date().toISOString(), reviewer: String(body.reviewer || '').trim() };
						}
						await archiveArtifact(root, projectId, 'outline');
						state = await saveArtifact(root, projectId, 'outline', { ...doc, items: [item] });
					}
					const outline = state.items[0];
					const branchesStale = await branchOutlineStale(projectId, outline);
					const stale = Boolean(outline && (outline.source_ecsm_digest !== model.digest || branchesStale));
					const tkrPack = branchesStale && outline.tkr ? (await loadArtifact(root, projectId, 'tkr-selection')).pack : null;
					const rows = outline ? outlineCoverage({ ...outline, digest: state.digest }, points, cases, deferrals.items) : [];
					sendJson(res, 200, { ok: true, state: {
						version: state.version, digest: state.digest, model_digest: model.digest,
						features: outlineFeatures(model).map(({ feature_id, name }) => ({ id: feature_id, name })),
						stale, branchesStale, tkrPack, outline, rows,
						outlineStatus: summarizeOutline(outline, stale),
						generatable: outline?.items.filter(generatableScenario).length || 0,
						points_current: !stale && points.source_outline_digest === state.digest && !!state.digest,
						cases_current: !stale && cases.source_points_digest === digestOf(points.items) && cases.source_ecsm_digest === model.digest
					} });
					return;
				}
				case 'tkr.verify':
				case 'tkr.select': {
					const projectId = body.project;
					const info = await findProject(config, projectId);
					const quality = info?.quality || {};
					const packName = String(body.pack || 'pilot_registry.v0.3.manifest.json');
					const bundle = loadBundle(packName);
					const { rules, errors } = loadRules(bundle);
					const report = {
						pack: packName, bundle_id: bundle.bundle_id, revision: bundle.revision, status: bundle.status,
						members: bundle.objects.length, loaded: rules.length, errors,
						bundle_digest: bundle.bundle_digest_sha256,
						digest_valid: digestFieldValid(bundle, 'bundle_digest_sha256'),
						approved_pack_members: loadBundle('approved_registry.v0.1.manifest.json').objects.length
					};
					if (body.action === 'tkr.verify') { sendJson(res, 200, { ok: true, state: report }); return; }
					assertWritable(projectId);
					const frozen = await requireFrozenModel(projectId);
					const [branches, points, states, uiLinks, design] = await Promise.all(
						['branches', 'points', 'states', 'ui-links', 'outline'].map((kind) => loadArtifact(root, projectId, kind)));
					const capabilities = quality.tkr_capabilities || [];
					if (!capabilities.length) throw new Error('项目未声明 quality.tkr_capabilities，无法派生能力画像');
					const policy = derivePolicy(projectId, currentModule(), quality);
					const entries = [];
					for (const capability of capabilities) {
						const { profile } = deriveProfile({ capability, branches: branches.items, points: points.items, states: states.items, uiLinks: uiLinks.items, frozen, outline: design.items[0], config: quality });
						const selection = makeSelection(profile, rules, bundle, policy, 'candidate_dry_run', { bundleErrors: errors });
						entries.push({ capability, profile, selection });
					}
					const annotated = annotateSelection(entries);
					await archiveArtifact(root, projectId, 'tkr-selection');
					const saved = await saveArtifact(root, projectId, 'tkr-selection', {
						version: 0, items: entries.map(({ capability, profile, selection }) => ({ capability, profile, selection })),
						meta: { pack: packName, bundle_ref: bundle.bundle_id, bundle_digest: bundle.bundle_digest_sha256, pack_status: bundle.status,
							policy, policy_digest: policy.object_digest_sha256, source_ecsm_digest: frozen.digest, source_branches_digest: branches.digest,
							errors, mode: 'candidate_dry_run' }
					});
					sendJson(res, 200, { ok: true, state: { ...report, version: saved.version, digest: saved.digest,
						capabilities: annotated.capabilities.map(({ capability_id, name, profile_id, selection_id, status, matched_branches, applied_rules, not_applied_rules, gaps, findings }) =>
							({ capability_id, name, profile_id, selection_id, status, matched_branches, applied: applied_rules.length, excluded: not_applied_rules.length, gaps: gaps.length, findings: findings.length })),
						coverage_targets: [...annotated.byBranch.values()].reduce((sum, list) => sum + list.length, 0) } });
					return;
				}
				case 'conflicts.view':
				case 'conflict.save': {
					const projectId = body.project;
					const doc = await loadArtifact(root, projectId, 'conflicts');
					let state = doc;
					if (body.action === 'conflict.save') {
						assertWritable(projectId);
						if (body.version !== doc.version) throw new Error('问题清单已变化，请刷新');
						const prior = doc.items.find((item) => item.id === body.id);
						if (body.id && !prior) throw new Error('找不到待处理的问题');
						let item;
						if (prior) {
							const conclusion = String(body.conclusion || '').trim();
							const reviewer = String(body.reviewer || '').trim();
							if (prior.status !== 'open' || !conclusion || !reviewer) throw new Error('请填写裁决结论与评审人');
							item = { ...prior, conclusion, rationale: String(body.rationale || '').trim(), reviewer, status: 'resolved', resolved_at: new Date().toISOString() };
						} else {
							const contracts = await loadArtifact(root, projectId, 'contracts');
							const contract = contracts.items.find((item) => item.contract_id === body.contract_id);
							const refs = [...new Set(Array.isArray(body.evidence_refs) ? body.evidence_refs : [])];
							const kind = String(body.kind || 'conflict');
							const reason = String(body.reason || '').trim();
							if (!contract || !reason || !['conflict', 'missing_evidence', 'binding'].includes(kind) || (kind === 'conflict' && refs.length < 2)) {
								throw new Error('请选择需求并填写问题。资料冲突需要两条证据');
							}
							for (const ref of refs) await readEvidence(config, projectId, root, String(ref));
							item = { id: 'ISS-' + crypto.randomUUID(), contract_id: contract.contract_id, kind, reason, evidence_refs: refs, status: 'open' };
							const related = contracts.items.find((entry) => entry.contract_id === body.related?.id && entry.contract_id !== contract.contract_id);
							if (related) item.related = { id: related.contract_id, title: related.title, expected: related.expected };
						}
						await archiveArtifact(root, projectId, 'conflicts');
						state = await saveArtifact(root, projectId, 'conflicts', { ...doc, items: [...doc.items.filter((entry) => entry.id !== item.id), item] });
					}
					const [points, cases] = await Promise.all(['points', 'cases'].map((kind) => loadArtifact(root, projectId, kind)));
					const [contracts, facts, evidence] = await Promise.all([
						loadArtifact(root, projectId, 'contracts'), loadArtifact(root, projectId, 'facts'),
						scopedEvidence(projectId).catch(() => null)
					]);
					const evidenceIds = new Set((evidence?.items || []).map((item) => item.id));
					const factsById = new Map(facts.items.map((item) => [item.fact_id, item]));
					const evidenceFor = (contract) => (contract.fact_refs || []).flatMap((id) => factsById.get(id)?.evidence_refs || []);
					const scenarioKey = (contract) => JSON.stringify([contract.feature_id, contract.condition?.trim(), contract.trigger?.trim()]);
					const scenarios = new Map();
					for (const contract of contracts.items) {
						if (!contract.condition?.trim() || !contract.trigger?.trim() || !contract.expected?.trim()) continue;
						const key = scenarioKey(contract);
						if (!scenarios.has(key)) scenarios.set(key, []);
						scenarios.get(key).push(contract);
					}
					const suggestions = contracts.items.flatMap((contract) => {
						const findings = new Map();
						const suggest = (reason, refs = [], kind = 'missing_evidence', related = null) => {
							if (!state.items.some((item) => item.contract_id === contract.contract_id && item.reason === reason)) {
								findings.set(reason, { contract_id: contract.contract_id, kind, reason, related,
									evidence_refs: [...new Set(refs.filter((id) => evidenceIds.has(id)))] });
							}
						};
						const fields = [['condition', '前置条件'], ['trigger', '触发动作'], ['expected', '可观察预期']]
							.filter(([key]) => !contract[key]?.trim()).map(([, label]) => label);
						if (fields.length) suggest('合同待补充 · ' + fields.join('、'));
						if (!contract.fact_refs?.length) suggest('合同没有关联来源事实');
						for (const id of contract.fact_refs || []) {
							const fact = factsById.get(id);
							const refs = fact?.evidence_refs || [];
							const missing = refs.filter((ref) => !evidenceIds.has(ref));
							if (!fact) suggest(id + ' · 找不到关联事实，请重新选择来源');
							else if (!refs.length) suggest(id + ' · 来源事实没有引用原文');
							else if (evidence && missing.length) suggest(id + ' · 当前资料范围找不到证据 ' + missing.join('、'), refs);
							if (fact && /待确认|待定|冲突|\bTBD\b/i.test(fact.statement)) {
								suggest(id + ' · 来源事实含待确认口径，请核对原文', refs);
							}
						}
						for (const other of scenarios.get(scenarioKey(contract)) || []) {
							if (contract.contract_id >= other.contract_id || !contract.expected?.trim() || contract.expected.trim() === other.expected.trim()) continue;
							const refs = [...new Set([...evidenceFor(contract), ...evidenceFor(other)].filter((id) => evidenceIds.has(id)))];
							suggest(`相同条件和动作的预期不同，请对照「${contract.title}」与「${other.title}」`, refs,
								refs.length >= 2 ? 'conflict' : 'missing_evidence', { id: other.contract_id, title: other.title, expected: other.expected });
						}
						return [...findings.values()];
					});
					const factQuestions = loadQuestions(root, projectId).items.filter((item) =>
						item.scope === 'ecsm' && item.status === 'open' && factsById.has(item.ref))
						.map((item) => ({ id: item.id, question: item.question, fact_id: item.ref,
							evidence_refs: (factsById.get(item.ref).evidence_refs || []).filter((id) => evidenceIds.has(id)) }));
					sendJson(res, 200, { ok: true, state: { ...state, suggestions, factQuestions, items: state.items.map((item) => {
						const affected = points.items.filter((point) => (point.contract_refs || []).includes(item.contract_id));
						const ids = new Set(affected.map((point) => point.point_id));
						return { ...item, points: affected.map((point) => ({ id: point.point_id, title: point.requirement })),
							cases: cases.items.filter((entry) => ids.has(entry.point_id)).map((entry) => ({ id: entry.case_id, title: entry.title })) };
					}) } });
					return;
				}
				case 'deferral.save': {
					assertWritable(body.project);
					const [points, outline, doc] = await Promise.all(['points', 'outline', 'deferrals'].map((kind) => loadArtifact(root, body.project, kind)));
					const reason = String(body.reason || '').trim();
					const scenario = outline.items[0]?.items.find((item) => item.scenario_id === body.scenario_id && (item.budget_exceeded || item.omitted || item.classification === 'needs_evidence'));
					const reviewer = String(body.reviewer || '').trim();
					const owner = String(body.owner || '').trim();
					if (body.outline_digest !== outline.digest || points.source_outline_digest !== outline.digest || !outline.digest ||
						(!scenario && !points.items.some((item) => item.point_id === body.point_id && item.review_status === 'approved')) || !reason || !reviewer || !owner) {
						throw new Error('请在当前测试设计中填写延期原因、责任人和评审人');
					}
					const impact = String(body.impact || '').trim();
					const entry = { point_id: body.point_id, scenario_id: scenario?.scenario_id, outline_digest: outline.digest, points_digest: digestOf(points.items), reason, impact, reviewer, owner, reviewed_at: new Date().toISOString() };
					const state = await saveArtifact(root, body.project, 'deferrals', { ...doc, items: [...doc.items.filter((item) => (item.scenario_id || item.point_id) !== (entry.scenario_id || entry.point_id)), entry] });
					sendJson(res, 200, { ok: true, state });
					return;
				}
				case 'contracts.approveAll': {
					assertWritable(body.project);
					const [doc, facts, features, evidence, conflicts] = await Promise.all([
						loadArtifact(root, body.project, 'contracts'),
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features'),
						scopedEvidence(body.project).catch(() => null),
						loadArtifact(root, body.project, 'conflicts')
					]);
					const states = loadStates(root, body.project);
					const approved = [];
					const blocked = [];
					for (let index = 0; index < doc.items.length; index += 1) {
						const item = doc.items[index];
						if (item.status === 'approved') continue;
						const conflict = conflicts.items.find((entry) => entry.status === 'open' && entry.contract_id === item.contract_id);
						if (conflict) { blocked.push({ id: item.contract_id, title: item.title, error: '存在未处理的冲突：' + (conflict.message || conflict.conflict_id || '') }); continue; }
						const missing = [!item.trigger && '触发动作', !item.condition && '前置条件', !item.expected && '可观察预期'].filter(Boolean);
						if (missing.length) { blocked.push({ id: item.contract_id, title: item.title, error: '缺字段：' + missing.join('、') }); continue; }
						try {
							doc.items[index] = editContract(item, { ...item }, features.items, facts.items, evidence?.items || [], true, states.items);
							approved.push(item.contract_id);
						} catch (error) {
							blocked.push({ id: item.contract_id, title: item.title, error: error.message });
						}
					}
					if (approved.length) {
						await saveArtifact(root, body.project, 'contracts', doc);
						await refreshUiLinks(body.project).catch(() => null);
					}
					sendJson(res, 200, { ok: true, state: { approved, blocked, total: doc.items.length } });
					return;
				}
				case 'contracts.save': {
					assertWritable(body.project);
					const [doc, facts, features, evidence] = await Promise.all([
						loadArtifact(root, body.project, 'contracts'), loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features'), scopedEvidence(body.project).catch(() => null)
					]);
					if (body.approve && (await loadArtifact(root, body.project, 'conflicts')).items.some((item) => item.status === 'open' && item.contract_id === body.id)) {
						throw new Error('请先处理这条需求关联的冲突');
					}
					const index = doc.items.findIndex((item) => item.contract_id === body.id);
					if (body.id && index < 0) throw new Error('需求合同不存在');
					if (body.version !== undefined && body.version !== doc.version) throw new Error('需求合同已变化，请刷新');
					const item = editContract(doc.items[index], body.patch || {}, features.items, facts.items, evidence?.items || [], body.approve === true,
						loadStates(root, body.project).items);
					if (index < 0) doc.items.push(item);
					else doc.items[index] = item;
					await saveArtifact(root, body.project, 'contracts', doc);
					await refreshUiLinks(body.project).catch(() => null);
					sendJson(res, 200, { ok: true, state: { item } });
					return;
				}
				case 'ecsm.repair': {
					assertWritable(body.project);
					const patch = body.patch || {};
					if (body.kind === 'fact' || body.kind === 'feature') {
						const kind = body.kind === 'fact' ? 'facts' : 'features';
						const doc = await loadArtifact(root, body.project, kind);
						const key = body.kind === 'fact' ? 'fact_id' : 'feature_id';
						const item = doc.items.find((entry) => entry[key] === body.id);
						if (!item) throw new Error('模型条目不存在');
						if (body.kind === 'fact') {
							const statement = String(patch.statement || '').trim();
							if (!statement) throw new Error('事实内容不能为空');
							const refs = [...new Set((Array.isArray(patch.evidence_refs) ? patch.evidence_refs : []).map(String))];
							if (refs.some((id) => !/^E-\d+$/.test(id))) throw new Error('请填写有效的证据编号，例如 E-0001');
							const evidence = await loadEvidenceAll(config, body.project, root).catch(() => null);
							if (evidence) {
								const ids = new Set(evidence.items.map((entry) => entry.id));
								const added = refs.filter((id) => !(item.evidence_refs || []).includes(id));
								if (added.some((id) => !ids.has(id))) throw new Error('新增的来源编号在当前证据库中不存在');
							}
							const features = await loadArtifact(root, body.project, 'features');
							const feature = features.items.find((entry) => entry.feature_id === patch.feature_id);
							if (patch.feature_id && !feature) throw new Error('功能点不存在');
							const assigned = features.items.filter((entry) => entry.fact_refs?.includes(item.fact_id));
							if (feature && !assigned.includes(feature)) {
								for (const owner of assigned) owner.fact_refs = owner.fact_refs.filter((id) => id !== item.fact_id);
								feature.fact_refs = [...(feature.fact_refs || []), item.fact_id];
								await saveArtifact(root, body.project, 'features', features);
							}
							Object.assign(item, { statement, evidence_refs: refs, review_status: 'candidate' });
						} else {
							const facts = await loadArtifact(root, body.project, 'facts');
							const ids = new Set(facts.items.map((fact) => fact.fact_id));
							item.fact_refs = (item.fact_refs || []).filter((id) => ids.has(id));
						}
						const { version, items, updatedAt, digest, ...meta } = doc;
						await saveArtifact(root, body.project, kind, { version, items, meta });
					} else if (body.kind === 'transition' || body.kind === 'state') {
						const doc = loadStates(root, body.project);
						const features = await loadArtifact(root, body.project, 'features');
						const feature = features.items.find((item) => item.feature_id === body.feature_id);
						if (!feature) throw new Error('功能点不存在');
						let machine = doc.items.find((item) => item.feature_id === feature.feature_id);
						if (!machine) {
							machine = { feature_id: feature.feature_id, name: feature.name, states: [], transitions: [], rejected: [] };
							doc.items.push(machine);
						}
						const parts = (value) => Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
						if (body.kind === 'state') {
							const name = String(patch.name || '').trim();
							if (!name || machine.states.some((state) => state.name === name)) throw new Error('请输入未使用的状态名称');
							let id = 1;
							while (machine.states.some((state) => state.state_id === `${feature.feature_id}.S${String(id).padStart(2, '0')}`)) id++;
							machine.states.push({ state_id: `${feature.feature_id}.S${String(id).padStart(2, '0')}`, name });
						} else {
							const ids = new Set(machine.states.map((item) => item.state_id));
							const trigger = String(patch.trigger || '').trim();
							if (!ids.has(patch.from) || !ids.has(patch.to) || !trigger) throw new Error('请选择起点、终点并填写触发条件');
							const prior = machine.transitions.find((item) => item.transition_id === body.id);
							if (body.id && !prior) throw new Error('转移不存在');
							let n = 1;
							while (machine.transitions.some((item) => item.transition_id === `${feature.feature_id}.T${String(n).padStart(2, '0')}`)) n++;
							const actions = parts(patch.actions);
							const names = loadBindings(root, body.project).items.filter((item) => item.status === 'bound' && item.kind === 'signal')
								.flatMap((item) => [item.subject?.name, item.target?.name]).filter(Boolean);
							const transition = { transition_id: prior?.transition_id || `${feature.feature_id}.T${String(n).padStart(2, '0')}`,
								from: patch.from, to: patch.to, trigger, conditions: parts(patch.conditions), actions,
								evidence_refs: prior?.evidence_refs || feature.fact_refs || [],
								unbound_signals: actions.filter((action) => /[A-Z][A-Za-z0-9_]{4,}/.test(action) && !names.some((name) => action.includes(name))) };
							if (prior) Object.assign(prior, transition);
							else machine.transitions.push(transition);
							if (Number.isInteger(body.rejected_index) && body.rejected_index >= 0) {
								machine.rejected?.splice(body.rejected_index, 1);
							}
						}
						machine.issues = validateState(machine);
						const { items, version, updatedAt, ...meta } = doc;
						saveStates(root, body.project, items, meta);
					} else throw new Error('未知修正类型');
					sendJson(res, 200, { ok: true, state: {} });
					return;
				}
				case 'ecsm.view': {
					const [facts, features, points, cases] = await Promise.all([
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'features'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases')
					]);
					const evidence = await scopedEvidence(body.project).catch(() => null);
					const contracts = await modelContracts(body.project, facts.items, features.items, evidence);
					const states = loadStates(root, body.project);
					const model = buildEcsm(root, body.project, { facts, features, states, bindings: loadBindings(root, body.project), points, cases, contracts });
					const current = currentEcsmVersion(root, body.project);
					const covered = points.items.length ? new Set(points.items.map((point) => point.transition_ref)) : null;
					const issues = modelIssues(model, evidence ? new Set(evidence.items.map((item) => item.id)) : null, covered);
					sendJson(res, 200, {
						ok: true,
						state: {
							model, issues,
							current,
							changedStateSources: changedStateSources(model, states),
							drifted: Boolean(current && current.digest !== model.digest),
							versions: ecsmVersions(root, body.project).map(({ version, digest, frozen_at }) => ({ version, digest, frozen_at }))
						}
					});
					return;
				}
				case 'ecsm.version': {
					const model = frozenModel(root, body.project, Number(body.version));
					if (!model) throw new Error('找不到该 ECSM 版本');
					sendJson(res, 200, { ok: true, state: { ...model, issues: modelIssues(model) } });
					return;
				}
				case 'ecsm.export':
				case 'ecsm.freeze': {
					const [points, cases] = await Promise.all(['points', 'cases'].map((kind) => loadArtifact(root, body.project, kind)));
					const live = await loadModel(body.project, { points, cases });
					const model = body.frozen === true ? frozenModel(root, body.project, body.version === undefined ? undefined : Number(body.version)) : live;
					if (!model) throw new Error('还没有冻结版本');
					if (body.action === 'ecsm.freeze') {
						assertWritable(body.project);
						if (!live.stats.features || !live.stats.facts) throw new Error('请先生成事实和功能点');
						const changed = changedStateSources(live, loadStates(root, body.project));
						if (changed.length) throw new Error(`${changed.join('、')}已更新，请重新推导状态后冻结产品模型`);
					}
					const record = body.action === 'ecsm.freeze' ? freezeEcsm(root, body.project, live) : null;
					const file = record
						? path.join(root, 'artifacts', body.project, currentModule(), 'ecsm-versions', `ecsm-v${record.version}-${record.digest.slice(0, 8)}.json`)
						: path.join(root, 'artifacts', body.project, currentModule(), body.frozen === true ? `ecsm-v${model.version}.json` : 'ecsm.json');
					if (!record) {
						await fs.mkdir(path.dirname(file), { recursive: true });
						await fs.writeFile(file, JSON.stringify(model, null, 1), 'utf8');
					}
					const stateDoc = loadStates(root, body.project);
					const stateIssues = stateDoc.items.reduce((sum, machine) => sum + (machine.issues || []).length, 0);
					const issueMachines = stateDoc.items
						.filter((machine) => (machine.issues || []).length)
						.map((machine) => ({ feature_id: machine.feature_id, count: machine.issues.length,
							codes: [...new Set(machine.issues.map((issue) => issue.code))] }));
					sendJson(res, 200, {
						ok: true,
						state: {
							file,
							digest: model.digest,
							stats: model.stats,
							version: record?.version || model.version || currentEcsmVersion(root, body.project)?.version || 0,
							frozen: Boolean(record),
							stateIssues: { count: stateIssues, machines: issueMachines.slice(0, 20) }
						}
					});
					return;
				}
				case 'ecsm.versions': {
					sendJson(res, 200, { ok: true, state: { current: currentEcsmVersion(root, body.project), versions: ecsmVersions(root, body.project) } });
					return;
				}
				case 'ecsm.impact': {
					const [points, cases] = await Promise.all([
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases')
					]);
					sendJson(res, 200, { ok: true, state: ecsmImpact(root, body.project, String(body.fact_id || ''), { points, cases, transitionId: String(body.transition_id || '') }) });
					return;
				}
				case 'impact.sourceChanges': {
					const [evidence, facts, points, cases] = await Promise.all([
						scopedEvidence(body.project).catch(() => ({ items: [] })),
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases')
					]);
					const evItems = evidence.items || [];
					const evIdsAll = new Set(evItems.map((e) => e.id));
					const evBySource = new Map();
					for (const e of evItems) {
						const src = String(e.source || '').trim();
						if (!src) continue;
						if (!evBySource.has(src)) evBySource.set(src, new Set());
						evBySource.get(src).add(e.id);
					}
					const traceFromEvIds = (evSet, includeOrphans = false) => {
						const affFacts = (facts.items || []).filter((f) => {
							const refs = f.evidence_refs || [];
							if (refs.some((id) => evSet.has(id))) return true;
							if (includeOrphans && refs.length > 0 && refs.some((id) => !evIdsAll.has(id))) return true;
							return false;
						});
						const affFactIds = new Set(affFacts.map((f) => f.fact_id));
						const affPoints = (points.items || []).filter((p) =>
							(p.fact_refs || []).some((id) => affFactIds.has(id)) || (p.source?.evidence_id && evSet.has(p.source.evidence_id))
						);
						const affPointIds = new Set(affPoints.map((p) => p.point_id));
						const affCases = (cases.items || []).filter((c) => affPointIds.has(c.point_id));
						return { affFacts, affPoints, affCases };
					};
					const sourcesSummary = [...evBySource.entries()].map(([src, evSet]) => {
						const { affFacts, affPoints, affCases } = traceFromEvIds(evSet, false);
						return {
							source: src,
							evidence_count: evSet.size,
							fact_count: affFacts.length,
							point_count: affPoints.length,
							case_count: affCases.length
						};
					}).sort((a, b) => b.case_count - a.case_count || b.point_count - a.point_count);
					const targetPath = String(body.path || '').trim();
					const targetEvIds = new Set(Array.isArray(body.evidence_ids) ? body.evidence_ids : []);
					if (targetPath) {
						const baseName = path.basename(targetPath);
						for (const [src, set] of evBySource.entries()) {
							if (src === targetPath || src.endsWith('/' + baseName) || path.basename(src) === baseName) {
								for (const id of set) targetEvIds.add(id);
							}
						}
					}
					const { affFacts, affPoints, affCases } = traceFromEvIds(targetEvIds, true);
					const affCaseIds = new Set(affCases.map((c) => c.case_id));
					const untouchedApproved = (cases.items || []).filter((c) => c.review_status === 'approved' && !affCaseIds.has(c.case_id)).length;
					sendJson(res, 200, {
						ok: true,
						state: {
							path: targetPath,
							sources_summary: sourcesSummary,
							affected_facts: affFacts.map((f) => ({ fact_id: f.fact_id, statement: String(f.statement || '').slice(0, 90) })),
							affected_points: affPoints.map((p) => ({ point_id: p.point_id, requirement: p.requirement || '', review_status: p.review_status || 'candidate' })),
							affected_cases: affCases.map((c) => ({ case_id: c.case_id, point_id: c.point_id, title: c.title || '', review_status: c.review_status || 'candidate' })),
							untouched_approved_cases: untouchedApproved,
							total_cases: (cases.items || []).length
						}
					});
					return;
				}
				case 'export.templates': {
					sendJson(res, 200, { ok: true, state: { templates: EXPORT_TEMPLATES, columns: CASE_COLUMN_KEYS } });
					return;
				}
				case 'package.freeze': {
					const model = await requireFrozenModel(body.project);
					const [points, cases, review] = await Promise.all(['points', 'cases', 'review'].map((kind) => loadArtifact(root, body.project, kind)));
					const status = await deliveryState(body.project, { points, cases, review }, model);
					const [design, delay, tkrSelection] = await Promise.all(['outline', 'deferrals', 'tkr-selection'].map((kind) => loadArtifact(root, body.project, kind)));
					const outline = design.items[0];
					status.outlineBranchesStale = await branchOutlineStale(body.project, outline);
					if (outline?.tkr?.selection_digest && outline.tkr.selection_digest !== digestOf(tkrSelection.items)) {
						throw new Error('大纲引用的 TKR 选规版本已变化，请用本轮选规重新确认大纲');
					}
					const accounting = outline ? outlineCoverage({ ...outline, digest: design.digest }, points, cases, delay.items) : [];
					status.deferralsPending = outline ? waitingDeferrals(delay.items).length : 0;
					const signedCases = deliveryCases(cases, accounting);
					status.approvals = approvalAudit(body.project, { points, cases: signedCases }, new Set(model.inputs.facts.items.map((item) => item.fact_id)));
					const blocker = deliveryBlocker({ points, cases: signedCases }, model, design, accounting, status);
					if (blocker) throw new Error(blocker.message);
					const info = await findProject(config, body.project);
					const moduleName = info?.modules?.find((item) => item.id === currentModule())?.name || currentModule();
					const evidenceIds = new Set(model.inputs.facts.items.flatMap((fact) => fact.evidence_refs || []));
					const resolvedMaterials = await resolveMaterials(body.project, currentModule()).catch(() => null);
					const evidence = resolvedMaterials?.evidence || await scopedEvidence(body.project).catch(() => null);
					const evidenceSnapshot = (evidence?.items || []).filter((item) => evidenceIds.has(item.id));
					const materialSnapshot = (resolvedMaterials?.rows || []).filter((row) => row.used)
						.map((row) => ({ path: row.path, content_version: row.content_version, usage: row.usage, tag_scope: row.tag_scope, items: row.items }));
					const record = freezePackage(root, body.project, String(body.note || ''), {
						model, points, cases: signedCases, review: status.reviewStale ? null : review, moduleName,
						materials: materialSnapshot,
						status: 'frozen', bench_verified: false, design_evidence_applicable: designEvidenceApplicable(),
						...(outline?.tkr?.selection_digest ? { tkrSelection } : {}),
						// 冻结包同时保存本轮 UI 关联与索引版本，导出后仍可追溯图文来源。
						uiLinks: loadUiLinks(root, body.project),
						uiIndex: (({ digest, builtAt, sources, version }) => ({ digest, builtAt, sources, version }))(loadUiIndex(root, body.project)),
						...(outline ? { outline, accounting, evidence: evidenceSnapshot } : {}),
						run: listRuns(root, body.project).at(-1) || null,
						approvals: status.approvals,
						project: body.project, module: currentModule()
					});
					sendJson(res, 200, { ok: true, state: record });
					return;
				}
				case 'package.export': {
					const packageId = String(body.package_id || '');
					const snapshot = readSnapshot(root, body.project, packageId);
					if (!snapshot) throw new Error('此交付包没有可导出的历史快照');
					const expOpts = {
						template: body.export_template || currentConfig().export_template || 'standard',
						columns: Array.isArray(body.export_columns) && body.export_columns.length ? body.export_columns : currentConfig().export_columns
					};
					const file = await exportCases(root, body.project, snapshot.cases.items, snapshot.moduleName, `${snapshot.moduleName}-${currentModule()}-${packageId}`, snapshot.imagesDir, snapshot.cases.version, undefined, snapshot.accounting, expOpts);
					const bundle = body.bundle ? await exportDelivery(root, body.project, snapshot, file) : null;
					const download_url = exportDownloadUrl(bundle?.xlsx || file);
					const downloads = bundle ? [
						{ key: 'xlsx', label: 'Excel 用例', name: path.basename(bundle.xlsx), url: exportDownloadUrl(bundle.xlsx) },
						{ key: 'html', label: '图文 HTML', name: path.basename(bundle.html), url: exportDownloadUrl(bundle.html) },
						{ key: 'md', label: 'Markdown', name: path.basename(bundle.md), url: exportDownloadUrl(bundle.md) },
						{ key: 'json', label: '结构化 JSON', name: path.basename(bundle.json), url: exportDownloadUrl(bundle.json) }
					].filter((d) => d.url) : [{ key: 'xlsx', label: 'Excel 用例', name: path.basename(file), url: download_url }].filter((d) => d.url);
					sendJson(res, 200, { ok: true, state: { file, count: snapshot.cases.items.length, ...(bundle || {}), download_url, downloads } });
					return;
				}
				case 'package.fork': {
					const record = forkPackage(root, body.project, String(body.note || ''));
					sendJson(res, 200, { ok: true, state: record });
					return;
				}
				case 'package.diff': {
					const packages = listPackages(root, body.project);
					const from = packages.find((item) => item.package_id === body.from);
					const current = currentPackage(root, body.project);
					const to = packages.find((item) => item.package_id === body.to)
						|| (current && current.status === 'draft' ? { ...current, artifacts: snapshotArtifacts(root, body.project) } : null);
					if (!from || !to) throw new Error('需要两个包：from / to');
					const changed = [];
					for (const name of new Set([...Object.keys(from.artifacts || {}), ...Object.keys(to.artifacts || {})])) {
						const before = from.artifacts?.[name];
						const after = to.artifacts?.[name];
						if (!before || !after) changed.push({ name, status: before ? 'removed' : 'added', before: before?.count ?? null, after: after?.count ?? null });
						else if (before.digest !== after.digest) changed.push({ name, status: before.count === after.count ? 'modified' : 'count_changed', before: before.count, after: after.count });
					}
					sendJson(res, 200, { ok: true, state: { from: from.package_id, to: to.package_id, changed } });
					return;
				}
				case 'package.list': {
					sendJson(res, 200, { ok: true, state: { current: currentPackage(root, body.project), packages: listPackages(root, body.project) } });
					return;
				}
				case 'binding.suggest': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					const facts = await loadArtifact(root, body.project, 'facts');
					if (facts.items.length === 0) throw new Error('先生成产品事实');
					const document = suggestBindings(info.dir, body.project, root, facts, { source_facts_digest: digestOf(facts.items) });
					await refreshQuestions(body.project).catch(() => null);
					sendJson(res, 200, { ok: true, state: { stats: bindingStats(document), version: document.version } });
					return;
				}
				case 'binding.list': {
					const document = loadBindings(root, body.project);
					sendJson(res, 200, { ok: true, state: { document, stats: bindingStats(document) } });
					return;
				}
				case 'binding.confirm': {
					assertWritable(body.project);
					const document = confirmBinding(root, body.project, String(body.binding_id || ''), Number(body.candidate) || 0);
					sendJson(res, 200, { ok: true, state: { stats: bindingStats(document) } });
					return;
				}
				case 'binding.manual': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					const design = designState(info.dir, body.project, root);
					if (!design.available) throw new Error('设计稿还没解析，无法按节点 id 绑定');
					const requested = String(body.node_id || '').trim();
					const [sourceName, nodeId] = requested.includes('/') ? requested.split('/', 2) : [body.source || '', requested];
					if (nodeId === '') throw new Error('需要 node_id');
					const candidates = layerSources(root, body.project)
						.filter((source) => !sourceName || source.id === sourceName || source.name === sourceName)
						.filter((source) => previewNode(source, nodeId));
					if (candidates.length > 1) throw new Error('节点出现在多份设计稿，请输入 设计稿名/GUID');
					const sourceId = candidates[0]?.id || sourceName || design.sources[0].logical_file_id;
					const detail = designNode(design.store, sourceId, nodeId);
					if (!detail || detail.status === 'error' || !detail.node_id) {
						throw new Error(`设计节点不存在：${nodeId}`);
					}
					const document = manualBinding(root, body.project, String(body.binding_id || ''), {
						node_id: detail.node_id || nodeId,
						source_id: sourceId,
						name: detail.name || '',
						page: detail.page_id || '',
						board: detail.board_id || ''
					});
					sendJson(res, 200, { ok: true, state: { stats: bindingStats(document) } });
					return;
				}
				case 'binding.reject': {
					assertWritable(body.project);
					const current = loadBindings(root, body.project);
					const entry = current.items.find((item) => item.binding_id === String(body.binding_id || ''));
					const rejected = body.rejected && typeof body.rejected === 'object' ? body.rejected
						: (body.candidate !== undefined ? entry?.candidates?.[Number(body.candidate)] : null) || null;
					const document = rejectBinding(root, body.project, String(body.binding_id || ''), rejected);
					sendJson(res, 200, { ok: true, state: { stats: bindingStats(document) } });
					return;
				}
				case 'design.openAuthorize': {
					// Network to pixso.cn can be flaky; when registration is impossible but
					// a client already exists, still hand out the authorize URL.
					// The DSH webview blocks window.open for external origins, so the
					// browser is launched from the host process instead.
					const callback = `http://127.0.0.1:${OAUTH_PORT}/callback`;
					let url;
					try {
						url = await startPixsoOAuth(root, callback);
					} catch (error) {
						sendJson(res, 200, { ok: true, state: { opened: false, error: error instanceof Error ? error.message : String(error), url: '' } });
						return;
					}
					const platform = process.platform;
					const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
					try {
						await run(command, [url], { timeout: 10000 });
						sendJson(res, 200, { ok: true, state: { url, opened: true, command } });
					} catch (error) {
						sendJson(res, 200, { ok: true, state: { url, opened: false, command, error: error instanceof Error ? error.message : String(error) } });
					}
					return;
				}
				case 'design.oauthStatus': {
					const stored = await loadPixsoToken(root).catch(() => null);
					const listening = oauthListening();
					sendJson(res, 200, {
						ok: true,
						state: {
							hasToken: Boolean(stored?.access_token),
							clientRegistered: Boolean(stored?.client_id),
							redirectUri: stored?.redirect_uri || '',
							pending: Boolean(stored?.pending),
							lastCallback: stored?.last_callback || null,
							callbackListening: listening
						}
					});
					return;
				}
				case 'design.oauthUrl': {
					const redirectUri = `http://127.0.0.1:${OAUTH_PORT}/callback`;
					const url = await startPixsoOAuth(root, redirectUri);
					sendJson(res, 200, { ok: true, state: { url } });
					return;
				}
				case 'ui.build': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					if (info.readonly) throw new Error('请选择可编辑的项目');
					const index = buildUiIndex(info.dir, body.project, root, { sources: await moduleLayerSources(body) });
					sendJson(res, 200, { ok: true, state: { stats: index.stats, digest: index.digest, builtAt: index.builtAt, sources: index.sources } });
					return;
				}
				case 'ui.state': {
					sendJson(res, 200, { ok: true, state: uiState(root, body.project) });
					return;
				}
				case 'ui.objects': {
					const index = loadUiIndex(root, body.project);
					if (!index.digest) throw new Error('还没有 UI 索引');
					sendJson(res, 200, { ok: true, state: queryUi(index, body) });
					return;
				}
				case 'ui.match': {
					const index = loadUiIndex(root, body.project);
					if (!index.digest) throw new Error('还没有 UI 索引');
					sendJson(res, 200, { ok: true, state: matchUi(index, { text: body.text, name: body.name, roleHint: body.role, stateHint: body.state, themeHint: body.theme, source: body.source }, { projectDir: path.join(root, 'projects', body.project), purpose: body.purpose || 'reference', source: body.source, exclude: body.exclude }) });
					return;
				}
				case 'ui.variants': {
					const index = loadUiIndex(root, body.project);
					if (!index.digest) throw new Error('还没有 UI 索引');
					sendJson(res, 200, { ok: true, state: uiVariants(index, String(body.id || '')) });
					return;
				}
				case 'ui.links': {
					sendJson(res, 200, { ok: true, state: loadUiLinks(root, body.project) });
					return;
				}
				case 'ui.links.derive': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const result = await refreshUiLinks(body.project, { figures: body.figures === true });
					sendJson(res, 200, { ok: true, state: result || { stats: {} } });
					return;
				}
				case 'ui.link.save': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const [facts, contracts, points, cases] = await Promise.all(['facts', 'contracts', 'points', 'cases'].map((kind) => loadArtifact(root, body.project, kind)));
					validateUiDecision(root, body.project, info.dir, {
						subject: body.subject, purpose: body.purpose, target: body.target || null,
						status: body.status || 'confirmed'
					}, { facts, contracts, points, cases });
					const document = recordUiDecision(root, body.project, {
						subject: body.subject, purpose: body.purpose, target: body.target || null,
						status: body.status || 'confirmed', rejected_ui_id: body.rejected_ui_id
					});
					sendJson(res, 200, { ok: true, state: { items: document.items.length } });
					return;
				}
				case 'ui.propagate': {
					// 一次纠正：预览或应用，只传给有继承证据或真实合同/测试点/用例关系的下游。
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const priorLink = loadUiLinks(root, body.project).items.find((item) =>
						item.subject.kind === body.subject?.kind && item.subject.id === body.subject?.id && item.purpose === body.purpose);
					if (!priorLink) throw new Error('原关联不存在');
					const [facts, contracts, points, cases] = await Promise.all(['facts', 'contracts', 'points', 'cases'].map((kind) => loadArtifact(root, body.project, kind)));
					if (body.preview !== true && body.status !== 'rejected' && body.target) {
						validateUiDecision(root, body.project, info.dir, {
							subject: body.subject, purpose: body.purpose, target: body.target, status: 'confirmed'
						}, { facts, contracts, points, cases });
					}
					if (body.status !== 'rejected' && body.preview !== true) {
						recordUiDecision(root, body.project, { subject: body.subject, purpose: body.purpose, target: body.target, status: 'confirmed' });
					}
					const document = propagateUi(root, body.project, {
						from_subject: body.subject, purpose: body.purpose, target: body.target,
						old_ui_id: body.old_ui_id || priorLink.ui_id || '',
						documents: { contracts, points, cases },
						preview: body.preview === true, baseline: body.baseline || ''
					});
					const refreshed = body.figures === true && !document.conflict && body.preview !== true
						? await refreshUiLinks(body.project, { figures: true }).catch(() => null) : null;
					sendJson(res, 200, { ok: true, state: {
						items: document.items.length, affected: document.affected || 0,
						preview: document.preview === true || undefined, conflict: document.conflict || undefined,
						baseline: document.baseline || undefined,
						affected_items: (document.affected_items || []).slice(0, 50),
						figures: refreshed?.summary || null
					} });
					return;
				}
				case 'ui.coverage': {
					const [contracts, points, cases] = await Promise.all(['contracts', 'points', 'cases'].map((kind) => loadArtifact(root, body.project, kind)));
					sendJson(res, 200, { ok: true, state: uiCoverage(root, body.project, { contracts, points, cases }) });
					return;
				}
				case 'ui.figures': {
					assertWritable(body.project);
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const index = loadUiIndex(root, body.project);
					if (!index.digest) throw new Error('还没有 UI 索引');
					const links = loadUiLinks(root, body.project);
					const cases = await loadArtifact(root, body.project, 'cases');
					const targets = body.id ? cases.items.filter((item) => item.case_id === body.id) : cases.items;
					const allowedDesigns = await moduleDesignRevisions(body.project);
					let built = 0;
					for (const item of targets) built += (await attachCaseFigures({ projectDir: info.dir, index, links, caseItem: item, allowedDesigns })).length;
					const { items, version, updatedAt, digest, ...meta } = cases;
					await saveArtifact(root, body.project, 'cases', { version, items, meta });
					sendJson(res, 200, { ok: true, state: { cases: targets.length, figures: built } });
					return;
				}
				case 'design.mcp': {
					const resolved = await pixsoToken(config);
					const wantLocal = body.mode === 'local';
					const url = wantLocal
						? (isRemote(config?.pixsoMcpUrl) ? DEFAULT_URL : (config?.pixsoMcpUrl || DEFAULT_URL))
						: (typeof config?.pixsoMcpUrl === 'string' && config.pixsoMcpUrl
							? config.pixsoMcpUrl
							: (resolved.token ? REMOTE_URL : 'http://127.0.0.1:3667/mcp'));
					const token = wantLocal ? '' : resolved.token;
					const client = new PixsoMcp(url, 10000, token);
					const importedSources = layerSources(root, body.project ? String(body.project) : POOL_DESIGN_KEY).map((source) => ({
						id: source.id, name: source.name, revision: source.revision || '', fileKey: source.fileKey || '', kind: source.kind || ''
					}));
					try {
						await client.connect();
						let tools = [];
						let document = null;
						try {
							tools = await client.listTools();
						} catch {
							tools = [];
						}
						document = await inspectMcpDocument(client);
						const status = document ? 'ready' : 'no_document';
						sendJson(res, 200, {
							ok: true,
							state: {
								url,
								mode: /^https:/.test(url) ? 'remote' : 'local',
								connected: true,
								status,
								token: token ? resolved.source : 'none',
								oauth: await loadPixsoToken(root).then((value) => ({
									hasToken: Boolean(value?.access_token),
									lastCallback: value?.last_callback || null
								})).catch(() => null),
								server: client.serverInfo,
								tools: tools.map((tool) => tool.name),
								document,
								importedSources,
								...(status === 'no_document' ? {
									hint: 'Pixso 本地 MCP 已连接，但当前未打开设计稿页签；请在 Pixso 客户端打开对应原型文件后点「刷新」'
								} : {})
							}
						});
					} catch (error) {
						sendJson(res, 200, {
							ok: true,
							state: {
								url,
								mode: /^https:/.test(url) ? 'remote' : 'local',
								connected: false,
								status: 'disconnected',
								token: token ? resolved.source : 'none',
								importedSources,
								error: error instanceof Error ? error.message : String(error),
								wwwAuthenticate: error?.wwwAuthenticate || '',
								hint: error?.code === 'PIXSO_UNAUTHORIZED'
									? '云端需 OAuth 2.1 或访问令牌：https://pixso.cn/developer/zh/mcp/remote-mcp.html'
									: '本地需开启 Pixso 桌面端并启用 Local MCP（默认 3667 端口）'
							}
						});
					}
					return;
				}
				case 'design.render': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const link = String(body.link || '');
					// A Pixso link carries both the file key and the node id:
					// https://pixso.cn/app/design/<fileKey>?item-id=<guid>
					const linkMatch = link.match(/\/app\/design\/([^/?#]+)/);
					const fileKey = String(body.file_key || body.fileKey || (linkMatch ? linkMatch[1] : ''));
					const itemMatch = link.match(/item-id=([^&]+)/);
					const guid = String(body.guid || body.node_id || (itemMatch ? decodeURIComponent(itemMatch[1]) : ''));
					if (guid === '' && fileKey === '') throw new Error('需要节点 guid 或 Pixso 图层链接');
					const resolved = await pixsoToken(config);
					const url = typeof config?.pixsoMcpUrl === 'string' && config.pixsoMcpUrl
						? config.pixsoMcpUrl
						: (resolved.token ? REMOTE_URL : 'http://127.0.0.1:3667/mcp');
					const token = resolved.token;
					const client = new PixsoMcp(url, 120000, token);
					await client.connect();
					let shot;
					try {
						shot = await client.screenshot(guid, { fileKey, link, remote: /^https:/.test(url) });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (message.includes('-32008') || message.includes('Access to this design file is denied')) {
							throw new Error('Pixso 拒绝了访问：当前授权账号对这个设计文件没有查看权限。请用同一账号在 Pixso 打开该文件，或把它复制/保存到你的空间后再用新链接。');
						}
						if (message.includes('-32004') || message.includes('file not found')) {
							throw new Error('文件不存在：检查链接里的 fileKey 是否正确，或文件已被删除。');
						}
						throw error;
					}
					const dir = path.join(info.dir, 'design', 'images');
					const file = await savePng(dir, guid.replace(/[^0-9A-Za-z_-]/g, '_'), shot.buffer);
					let dslFile = null;
					if (body.dsl === true) {
						const text = await client.dsl(guid, { fileKey, link });
						dslFile = path.join(dir, `${guid.replace(/[^0-9A-Za-z_-]/g, '_')}.dsl.json`);
						await fs.writeFile(dslFile, text, 'utf8');
					}
					sendJson(res, 200, { ok: true, state: { file, bytes: shot.buffer.length, mimeType: shot.mimeType, dsl: dslFile } });
					return;
				}
				case 'design.layerPages': {
					const sources = await moduleLayerSources(body);
					const grouped = sources.map((source) => ({
						id: source.id,
						name: source.name,
						file: source.file,
						revision: source.revision,
						pages: layerPagesOfFile(source.db, source.id)
					}));
					const flat = grouped.flatMap((group) => group.pages);
					const removed = [...removedDesigns(root, body.project)].map(([id, name]) => ({ id, name }));
					sendJson(res, 200, { ok: true, state: { sources: grouped, pages: flat, removed } });
					return;
				}
				case 'design.sourceVisibility': {
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					assertWritable(body.project);
					if (previewJobs.get(body.project)?.running) throw new Error('请等待设计稿导入或截图缓存完成');
					const source = layerSources(root, body.project, true).find((entry) => entry.id === body.source);
					if (!source) throw new Error('设计稿不存在');
					if (body.restore !== true) deletePreviewCache(root, body.project, info.dir, source);
					setDesignRemoved(root, body.project, source, body.restore !== true);
					previewJobs.delete(body.project);
					sendJson(res, 200, { ok: true, state: designState(info.dir, body.project, root) });
					return;
				}
				case 'design.nodeInfo': {
					const info = layerNodeInfo(root, body.project, String(body.id || ''), String(body.source || ''), await moduleLayerSources(body));
					if (!info) throw new Error('节点不存在');
					sendJson(res, 200, { ok: true, state: info });
					return;
				}
				case 'design.layerChildren': {
					const parent = String(body.parent || '');
					if (parent === '') throw new Error('需要 parent');
					sendJson(res, 200, { ok: true, state: { children: layerChildren(root, body.project, parent, String(body.source || ''), await moduleLayerSources(body)) } });
					return;
				}
				case 'design.importLibrary': {
					// Pull every component of the open file: export PNG + write an index
					// that later becomes design evidence.
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const url = typeof config?.pixsoMcpUrl === 'string' && config.pixsoMcpUrl ? config.pixsoMcpUrl : 'http://127.0.0.1:3667/mcp';
					const client = new PixsoMcp(url, 120000);
					await client.connect();
					const tools = await client.listTools();
					if (!tools.some((tool) => tool.name === 'get_all_components')) throw new Error('当前 MCP 不支持 get_all_components');
					const parseAll = (text) => {
						const values = [];
						let depth = 0; let start = -1; let inStr = false; let esc = false;
						for (let index = 0; index < text.length; index += 1) {
							const ch = text[index];
							if (inStr) {
								if (esc) esc = false;
								else if (ch === '\\') esc = true;
								else if (ch === '"') inStr = false;
								continue;
							}
							if (ch === '"') { inStr = true; continue; }
							if (ch === '[' || ch === '{') { if (depth === 0) start = index; depth += 1; }
							else if (ch === ']' || ch === '}') {
								depth -= 1;
								if (depth === 0 && start >= 0) {
									try { values.push(JSON.parse(text.slice(start, index + 1))); } catch { /* skip */ }
									start = -1;
								}
							}
						}
						return values;
					};
					const listed = await client.callTool('get_all_components', {});
					const text = (listed.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
					const components = parseAll(text).flatMap((value) => (Array.isArray(value) ? value : [value]))
						.filter((item) => item && item.node_id && item.name);
					const pageFilter = String(body.page || '');
					const pool = pageFilter ? components.filter((item) => (item.containing_frame?.pageName || '') === pageFilter) : components;
					const limit = Math.min(300, Number(body.limit) || 40);
					const scale = Number(body.scale) || 1;
					const fileKey = components[0]?.file_key || 'unknown';
					const rootDir = path.join(info.dir, 'design', 'library', String(fileKey).replace(/[^0-9A-Za-z_-]/g, '_'));
					await fs.mkdir(rootDir, { recursive: true });
					let index = {};
					try {
						index = JSON.parse(await fs.readFile(path.join(rootDir, 'index.json'), 'utf8'));
					} catch {
						index = { fileKey, at: null, components: {} };
					}
					const rendered = [];
					const failed = [];
					const skipped = [];
					for (const item of pool) {
						// Already-exported entries must not consume the batch budget,
						// otherwise a second run keeps skipping the same first N.
						if (rendered.length + failed.length >= limit) break;
						const nodeId = String(item.node_id);
						const safeName = `${(item.containing_frame?.pageName || 'page')}__${item.name}`.replace(/[\s/\\:*?"<>|]/g, '_').slice(0, 80);
						const file = path.join(rootDir, `${safeName}__${nodeId.replace(/[^0-9A-Za-z_-]/g, '_')}.png`);
						if (fsSync.existsSync(file)) {
							skipped.push(nodeId);
							index.components[nodeId] = { ...(index.components[nodeId] || {}), name: item.name, page: item.containing_frame?.pageName || '', file: path.relative(info.dir, file), width: item.min_node_width, height: item.min_node_height, componentKey: item.component_key };
							continue;
						}
						try {
							const exported = await client.callTool('get_export_image', {
								guid: nodeId,
								exportSettings: { constraint: { type: 1, value: scale }, imageType: 1 }
							});
							const payload = (exported.content || []).find((block) => block.type === 'text')?.text || '';
							const match = payload.match(/https?:\/\/[^\s"']+?\.png/);
							if (!match) throw new Error('导出未返回图片地址');
							const response = await fetch(match[0]);
							if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
							const buffer = Buffer.from(await response.arrayBuffer());
							await fs.mkdir(path.dirname(file), { recursive: true });
							await fs.writeFile(file, buffer);
							index.components[nodeId] = { name: item.name, page: item.containing_frame?.pageName || '', file: path.relative(info.dir, file), width: item.min_node_width, height: item.min_node_height, componentKey: item.component_key, bytes: buffer.length };
							rendered.push({ nodeId, name: item.name, page: item.containing_frame?.pageName || '', bytes: buffer.length });
						} catch (error) {
							failed.push({ nodeId, name: item.name, error: error instanceof Error ? error.message : String(error) });
						}
					}
					index.at = new Date().toISOString();
					index.fileKey = fileKey;
					index.pages = [...new Set(Object.values(index.components).map((entry) => entry.page))].sort();
					await fs.writeFile(path.join(rootDir, 'index.json'), JSON.stringify(index, null, 1), 'utf8');
					const md = ['# 组件库索引', '', `文件：${fileKey}`, `组件数：${Object.keys(index.components).length}`, '', '| 页面 | 组件 | 尺寸 | 文件 |', '| --- | --- | --- | --- |', ...Object.values(index.components).map((entry) => `| ${entry.page} | ${entry.name} | ${Math.round(entry.width || 0)}×${Math.round(entry.height || 0)} | ${entry.file} |`)].join('\n');
					await fs.writeFile(path.join(rootDir, 'components.md'), md, 'utf8');
					sendJson(res, 200, { ok: true, state: { total: components.length, pool: pool.length, rendered: rendered.length, skipped: skipped.length, failed: failed.length, dir: path.relative(info.dir, rootDir), samples: rendered.slice(0, 3), errors: failed.slice(0, 3) } });
					return;
				}
				case 'design.componentDetail': {
					// Fetch one node's DSL, flatten it with absolute coordinates, cache it.
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const nodeId = String(body.nodeId || body.node_id || '');
					if (nodeId === '') throw new Error('需要 nodeId');
					const cacheDir = path.join(info.dir, 'design', 'details');
					const cacheFile = path.join(cacheDir, `${nodeId.replace(/[^0-9A-Za-z_-]/g, '_')}.json`);
					if (body.cache !== false && fsSync.existsSync(cacheFile)) {
						const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
						sendJson(res, 200, { ok: true, state: { ...cached, cached: true } });
						return;
					}
					// Prefer the compiled index: it works offline and for every .pix,
					// not just the file currently open in Pixso.
					if (body.dsl !== true) {
						const local = layerDetailLocal(root, body.project, nodeId);
						if (local) {
							local.engine = 'local';
							await fs.mkdir(cacheDir, { recursive: true });
							await fs.writeFile(cacheFile, JSON.stringify(local, null, 1), 'utf8');
							sendJson(res, 200, { ok: true, state: { ...local, cached: false } });
							return;
						}
					}
					const url = typeof config?.pixsoMcpUrl === 'string' && config.pixsoMcpUrl ? config.pixsoMcpUrl : 'http://127.0.0.1:3667/mcp';
					const client = new PixsoMcp(url, 120000);
					await client.connect();
					const result = await client.callTool('get_node_dsl', { guid: nodeId, simplify: false });
					const text = (result.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
					let dsl;
					try {
						dsl = JSON.parse(text);
					} catch {
						throw new Error('DSL 不是合法 JSON');
					}
					const dslRoot = (dsl.pixComponentTreeDslNodes || [])[0] || (dsl.pixTreeNodes || [])[0];
					if (!dslRoot) throw new Error('DSL 里没有节点');
					const nodes = [];
					const colorOf = (node) => {
						const paint = (node.fillPaints || []).find((entry) => entry.visible !== false && entry.type === 'SOLID' && entry.color);
						if (!paint) return '';
						const { r, g, b, a } = paint.color;
						const hex = [r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('');
						return `#${hex}${a !== undefined && a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : ''}`;
					};
					const walk = (node, parentId, depth, baseX, baseY, parentPath) => {
						const x = baseX + (Number(node.left) || 0);
						const y = baseY + (Number(node.top) || 0);
						const id = String(node.guid || '').replace(/^I/, '');
						const label = node.name || (typeof node.nodeText === 'string' ? node.nodeText : '') || `(${String(node.type || '').toLowerCase()})`;
						const pathText = parentPath ? `${parentPath} / ${label}` : label;
						nodes.push({
							id,
							parent: parentId,
							depth,
							type: node.type || '',
							name: node.name || '',
							layerType: node.layerType || '',
							text: typeof node.nodeText === 'string' ? node.nodeText : '',
							fontSize: Number(node.fontSize) || 0,
							fontFamily: node.fontFamily || '',
							fontStyle: node.fontStyle || '',
							fontWeight: node.fontWeight || '',
							x: Math.round(x * 100) / 100,
							y: Math.round(y * 100) / 100,
							w: Math.round((Number(node.width) || 0) * 100) / 100,
							h: Math.round((Number(node.height) || 0) * 100) / 100,
							angle: Number(node.angle) || 0,
							visible: node.visible !== false,
							mask: node.mask === true,
							color: colorOf(node),
							constraintX: node.horizontalConstraint || '',
							constraintY: node.verticalConstraint || '',
							autoLayout: node.autoLayout ? JSON.stringify(node.autoLayout).slice(0, 120) : '',
							component: node.componentNormName || '',
							isFromComponent: node.isFromComponent === true,
							mainComponent: node.mainComponent || '',
							mainStateGroup: node.mainStateGroup || '',
							props: Array.isArray(node.props) ? node.props.map((entry) => `${entry.name || entry.pathString || ''}=${entry.value || entry.text || ''}`).filter(Boolean).join('; ') : '',
							styleId: node.inheritFillStyleID || '',
							version: node.version || '',
							path: pathText
						});
						for (const child of node.childNode || []) walk(child, id, depth + 1, x, y, pathText);
					};
					walk(dslRoot, '', 0, 0, 0, '');
					// Normalise to the component's own origin so overlays align with its PNG.
					const originX = nodes[0]?.x || 0;
					const originY = nodes[0]?.y || 0;
					for (const node of nodes) {
						node.x = Math.round((node.x - originX) * 100) / 100;
						node.y = Math.round((node.y - originY) * 100) / 100;
					}
					for (const entry of nodes) {
						if (entry.text) entry.text = entry.text;
					}
					const byParent = new Map();
					for (const node of nodes) {
						if (!byParent.has(node.parent)) byParent.set(node.parent, []);
						byParent.get(node.parent).push(node);
					}
					for (const [parentId, group] of byParent) {
						group.forEach((node, index) => {
							node.siblingIndex = index + 1;
							node.siblingCount = group.length;
						});
					}
					const detail = {
						nodeId,
						engine: 'mcp',
						name: dslRoot.name || '',
						w: Math.round((Number(dslRoot.width) || 0) * 100) / 100,
						h: Math.round((Number(dslRoot.height) || 0) * 100) / 100,
						count: nodes.length,
						depth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
						nodes,
						texts: nodes.filter((node) => node.text !== '').map((node) => ({ id: node.id, text: node.text, fontSize: node.fontSize, x: node.x, y: node.y })),
						fetchedAt: new Date().toISOString()
					};
					await fs.mkdir(cacheDir, { recursive: true });
					await fs.writeFile(cacheFile, JSON.stringify(detail, null, 1), 'utf8');
					sendJson(res, 200, { ok: true, state: { ...detail, cached: false } });
					return;
				}
				case 'design.renderNodes': {
					// Render a set of node ids and hand back their PNG paths.
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const ids = Array.isArray(body.nodes) ? body.nodes.map(String).filter(Boolean).slice(0, 40) : [];
					if (ids.length === 0) throw new Error('需要 nodes 列表');
					if (body.source) {
						const sources = await moduleLayerSources(body);
						const source = sources.find((entry) => entry.id === body.source);
						if (!source) throw new Error('设计稿不存在');
						const rendered = {};
						const failed = {};
						let connection;
						for (const id of ids) {
							const cached = previewFile(info.dir, source, id, !source.historical && sources.filter((entry) => previewNode(entry, id)).length === 1);
							if (cached.cached) {
								rendered[id] = path.relative(info.dir, cached.file);
								continue;
							}
							if (source.historical) {
								failed[id] = '旧版设计稿缺少该节点截图，请补回旧版缓存或确认采用新版';
								continue;
							}
							if (body.cacheOnly || previewJobs.get(body.project)?.running) continue;
							try {
								const client = await (connection ||= localPixso().connect());
								const pages = layerPagesOfFile(source.db, source.id);
								const verify = async () => {
									if (!sameDocument(await activeDocument(client), source, pages)) throw new Error(`请在 Pixso 打开 ${source.name} 后补图`);
								};
								await verify();
								const file = await cachePreview(client, body.project, info.dir, source, id, verify, previewNode(source, id)?.node);
								rendered[id] = path.relative(info.dir, file);
							} catch (error) {
								failed[id] = error.message;
							}
						}
						sendJson(res, 200, { ok: true, state: { rendered, failed, count: Object.keys(rendered).length } });
						return;
					}
					const url = typeof config?.pixsoMcpUrl === 'string' && config.pixsoMcpUrl ? config.pixsoMcpUrl : 'http://127.0.0.1:3667/mcp';
					const client = new PixsoMcp(url, 120000);
					let connection;
					const dir = path.join(info.dir, 'design', 'images');
					await fs.mkdir(dir, { recursive: true });
					const rendered = {};
					const failed = {};
					for (const id of ids) {
						const safe = id.replace(/[^0-9A-Za-z_-]/g, '_');
						const existing = path.join(dir, `${safe}.png`);
						if (fsSync.existsSync(existing)) {
							rendered[id] = path.relative(info.dir, existing);
							continue;
						}
						try {
							await (connection ||= client.connect());
							const shot = await client.screenshot(id, { scale: Number(body.scale) || 1 });
							await fs.writeFile(existing, shot.buffer);
							rendered[id] = path.relative(info.dir, existing);
						} catch (error) {
							failed[id] = error instanceof Error ? error.message : String(error);
						}
					}
					sendJson(res, 200, { ok: true, state: { rendered, failed, count: Object.keys(rendered).length } });
					return;
				}
				case 'design.renderAll': {
					// Batch-render top-level frames of the open file through the local
					// bridge; each frame becomes design/images/<nodeId>.png.
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const url = typeof config?.pixsoMcpUrl === 'string' && config.pixsoMcpUrl ? config.pixsoMcpUrl : 'http://127.0.0.1:3668/mcp';
					const client = new PixsoMcp(url, 120000);
					await client.connect();
					const tools = await client.listTools();
					const has = (name) => tools.some((tool) => tool.name === name);
					if (!has('list_pages') || !has('list_frames')) throw new Error('当前 MCP 不支持列出页面/画板（需要 Advanced bridge）');
					const parseText = (result) => {
						const text = (result.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
						try {
							return JSON.parse(text);
						} catch {
							return text;
						}
					};
					const pages = parseText(await client.callTool('list_pages', {}));
					const pageList = Array.isArray(pages) ? pages : pages?.pages || [];
					const limit = Math.min(200, Number(body.limit) || 40);
					const scale = Number(body.scale) || 1;
					const dir = path.join(info.dir, 'design', 'images');
					await fs.mkdir(dir, { recursive: true });
					const rendered = [];
					const failed = [];
					for (const page of pageList) {
						if (rendered.length >= limit) break;
						const pageId = page.id || page.pageId || page.nodeId;
						let frames;
						try {
							const listed = parseText(await client.callTool('list_frames', pageId ? { pageId } : {}));
							frames = Array.isArray(listed) ? listed : listed?.frames || [];
						} catch (error) {
							failed.push({ page: page.name || pageId, error: error instanceof Error ? error.message : String(error) });
							continue;
						}
						for (const frame of frames) {
							if (rendered.length >= limit) break;
							const nodeId = frame.id || frame.nodeId;
							if (!nodeId) continue;
							try {
								const shot = await client.screenshot(nodeId, { scale });
								const file = await savePng(dir, String(nodeId).replace(/[^0-9A-Za-z_-]/g, '_'), shot.buffer);
								rendered.push({ nodeId, page: page.name || pageId, name: frame.name || '', file: path.relative(info.dir, file), bytes: shot.buffer.length });
							} catch (error) {
								failed.push({ nodeId, name: frame.name || '', error: error instanceof Error ? error.message : String(error) });
							}
						}
					}
					await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), rendered, failed }, null, 1), 'utf8');
					sendJson(res, 200, { ok: true, state: { rendered: rendered.length, failed: failed.length, samples: rendered.slice(0, 5), errors: failed.slice(0, 3) } });
					return;
				}
				case 'design.images': {
					const info = await findProject(config, body.project);
					if (!info) throw new Error(`项目不存在：${body.project}`);
					const dir = path.join(info.dir, 'design', 'images');
					const files = await fs.readdir(dir).catch(() => []);
					const images = await Promise.all(files.filter((name) => name.endsWith('.png')).map(async (name) => {
						const stat = await fs.stat(path.join(dir, name));
						return { name, node_id: name.replace(/\.png$/, ''), bytes: stat.size, path: path.join('design/images', name) };
					}));
					sendJson(res, 200, { ok: true, state: { images } });
					return;
				}
				case 'design.state': {
					const info = await findProject(config, body.project);
					sendJson(res, 200, { ok: true, state: designState(info.dir, body.project, root) });
					return;
				}
				case 'design.compile': {
					const info = await findProject(config, body.project);
					if (previewJobs.get(body.project)?.running) throw new Error('设计稿正在解析或缓存截图');
					const result = designCompile(info.dir, body.project, root, { force: body.force === true });
					sendJson(res, 200, { ok: true, state: { ...result, files: result.sources.length } });
					return;
				}
				case 'design.previewStatus': {
					const targetKey = body.scope === 'pool' || !body.project || body.project === POOL_DESIGN_KEY ? POOL_DESIGN_KEY : body.project;
					const job = previewJobs.get(targetKey);
					sendJson(res, 200, { ok: true, state: job && (targetKey === POOL_DESIGN_KEY || !body.module || job.module === currentModule()) ? job : null });
					return;
				}
				case 'design.cachePreviews': {
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const running = previewJobs.get(body.project);
					if (running?.running && running.module !== currentModule()) throw new Error('另一模块正在缓存截图，请等待任务完成');
					sendJson(res, 200, { ok: true, state: startPreviews(info, body.project) });
					return;
				}
				case 'design.importCurrent': {
					const selectedPages = Array.isArray(body.pages) && body.pages.length ? body.pages.map(String) : null;
					if (body.scope === 'pool' || !body.project || body.project === POOL_DESIGN_KEY) {
						const running = previewJobs.get(POOL_DESIGN_KEY);
						if (running?.running) return sendJson(res, 200, { ok: true, state: running });
						sendJson(res, 200, { ok: true, state: startPreviews({ id: POOL_DESIGN_KEY, dir: poolDesignDir() }, POOL_DESIGN_KEY, '', true, '', selectedPages) });
						return;
					}
					const info = await findProject(config, body.project);
					if (!info || info.readonly) throw new Error('请选择可编辑的项目');
					const moduleId = currentModule();
					const running = previewJobs.get(body.project);
					if (running?.running && running.module && running.module !== moduleId) {
						throw new Error(`该项目正在为模块 ${running.module} 导入设计稿，请等待完成或重试`);
					}
					if (running?.running && running.module === moduleId) return sendJson(res, 200, { ok: true, state: running });
					sendJson(res, 200, { ok: true, state: startPreviews(info, body.project, '', true, moduleId, selectedPages) });
					return;
				}
				case 'design.pages': {
					const info = await findProject(config, body.project);
					const current = designState(info.dir, body.project, root);
					if (!current.available) throw new Error('设计稿还没解析');
					sendJson(res, 200, { ok: true, state: designPages(current.store, body.source || current.sources[0].logical_file_id) });
					return;
				}
				case 'design.search': {
					if (body.module) {
						const allowed = await moduleDesignRevisions(body.project);
						const sources = layerSources(root, body.project, false, allowed).filter((source) => allowed.get(source.id) === source.revision);
						sendJson(res, 200, { ok: true, state: queryLayers(sources, { action: 'search', source: body.source, text: String(body.query || ''), limit: body.limit }) });
						return;
					}
					const info = await findProject(config, body.project);
					const current = designState(info.dir, body.project, root);
					if (!current.available) throw new Error('设计稿还没解析');
					sendJson(res, 200, { ok: true, state: designSearch(current.store, String(body.query || ''), { source: body.source, limit: body.limit }) });
					return;
				}
				case 'features.assign': {
					const [features, facts] = await Promise.all([
						loadArtifact(root, body.project, 'features'),
						loadArtifact(root, body.project, 'facts')
					]);
					const result = assignUnassigned(features.items, facts.items);
					const saved = await saveArtifact(root, body.project, 'features', { version: features.version, items: features.items });
					// Points and cases inherit through facts, so refresh them too.
					const points = await loadArtifact(root, body.project, 'points');
					const cases = await loadArtifact(root, body.project, 'cases');
					const pointsDigestNow = digestOf(points.items);
					const casesWereStale = Boolean(cases.source_points_digest && cases.source_points_digest !== pointsDigestNow);
					attachFeatures(points.items, facts.items, features.items);
					await saveArtifact(root, body.project, 'points', { version: points.version, items: points.items });
					const byPoint = new Map(points.items.map((point) => [point.point_id, point.feature_id || '']));
					for (const item of cases.items) item.feature_id = byPoint.get(item.point_id) || item.feature_id || '';
					attachReviewCard(points.items);
					const evidence = await loadEvidenceAll(config, body.project, root).catch(() => null);
					const evidenceById = new Map((evidence?.items || []).map((item) => {
						const source = String(item.source || '');
						const kind = /dbc|signal|cnmatrix/i.test(source) ? 'dbc'
							: /pix|design|ui/i.test(source) ? 'design'
							: /history|legacy/i.test(source) ? 'history'
							: 'prd';
						return [item.id, { ...item, kind }];
					}));
					applyAuthority(facts.items, evidenceById);
					await saveArtifact(root, body.project, 'facts', { version: facts.version, items: facts.items });
					await saveArtifact(root, body.project, 'points', { version: points.version, items: points.items, meta: { source_facts_digest: digestOf(facts.items), ...(points.matrix ? { matrix: points.matrix } : {}) } });
					let structured = 0;
					for (const item of cases.items) {
						normalizeCaseStructure(item);
						buildRestore(item);
						item.prepare_detail = item.prepare_detail || `1. 整车电源：${/上电|ON|KL15/i.test(item.precondition || '') ? '按前置条件设置' : '整车上电'}\n2. 页面：${(item.steps || [])[0] ? '按步骤进入' : '未知'}\n3. 初始信号：见前置条件`;
						const rendered = (item.controls || [])
							.map((entry) => path.join(root, 'projects', body.project, 'design', 'images', `${String(entry.node_id).replace(/[^0-9A-Za-z_-]/g, '_')}.png`))
							.filter((file) => fsSync.existsSync(file));
						item.image_ref = rendered.length > 0
							? rendered.map((file) => path.relative(root, file)).join('；')
							: (item.controls || []).length > 0
								? item.controls.map((entry) => `${entry.page || '页面未知'} / ${entry.node_id}`).join('；')
								: '未绑定';
						item.review_conclusion = item.review_conclusion || '待评审';
						item.review_comment = item.review_comment || '';
						item.reviewer = item.reviewer || '';
						item.signals = [...new Set((item.signals || []).map((signal) => String(signal).split('.').pop().split('=')[0]))];
						item.gaps = buildGaps(item);
						structured += 1;
					}
					applyCaseIds(cases.items);
					await saveArtifact(root, body.project, 'cases', { version: cases.version, items: cases.items });
					sendJson(res, 200, { ok: true, state: { ...result, version: saved.version } });
					return;
				}
				case 'features.attach': {
					const features = await loadArtifact(root, body.project, 'features');
					const facts = await loadArtifact(root, body.project, 'facts');
					if (features.items.length === 0) throw new Error('还没有功能点');
					const points = await loadArtifact(root, body.project, 'points');
					attachFeatures(points.items, facts.items, features.items);
					await saveArtifact(root, body.project, 'points', { version: points.version, items: points.items });
					const cases = await loadArtifact(root, body.project, 'cases');
					const byPoint = new Map(points.items.map((point) => [point.point_id, point.feature_id || '']));
					let changed = false;
					for (const item of cases.items) {
						const featureId = byPoint.get(item.point_id) || '';
						if (item.feature_id !== featureId) {
							item.feature_id = featureId;
							changed = true;
						}
					}
					if (changed) await saveArtifact(root, body.project, 'cases', { version: cases.version, items: cases.items });
					sendJson(res, 200, { ok: true, state: { points: points.items.filter((point) => point.feature_id).length, cases: changed } });
					return;
				}
				case 'cases.decorate': {
					const cases = await loadArtifact(root, body.project, 'cases');
					const bindings = loadBindings(root, body.project);
					decorateCases(cases.items, bindings);
					const facts = await loadArtifact(root, body.project, 'facts');
					const points = await loadArtifact(root, body.project, 'points');
					const errors = lint(cases.items, new Set(points.items.map((point) => point.point_id)), new Set(facts.items.map((fact) => fact.fact_id)));
					await saveArtifact(root, body.project, 'cases', { version: cases.version, items: cases.items });
					const serious = errors.filter((error) => error.severity !== 'warning');
					sendJson(res, 200, {
						ok: true,
						state: {
							decorated: cases.items.filter((item) => (item.controls || []).length > 0).length,
							enriched,
							refilled,
							structured,
							errorCount: serious.length,
							warningCount: errors.length - serious.length
						}
					});
					return;
				}
				case 'artifacts.load': {
					const [features, facts, points, cases, review] = await Promise.all([
						loadArtifact(root, body.project, 'features'),
						loadArtifact(root, body.project, 'facts'),
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'cases'),
						loadArtifact(root, body.project, 'review')
					]);
					const states = loadStates(root, body.project);
					// structureCase 对结构化用例只刷新序号与来源缺口，不会由字符串反推覆盖锚点。
					for (const item of cases.items) structureCase(item);
					const pointQuality = checkPointQuality(points.items, new Set(facts.items.map((item) => item.fact_id)),
						new Set(states.items.flatMap((machine) => (machine.transitions || []).map((entry) => entry.transition_id))));
					const frozen = frozenModel(root, body.project);
					const delivery = await deliveryState(body.project, { points, cases, review }, frozen);
					const outline = await loadArtifact(root, body.project, 'outline');
					const design = outline.items[0];
					let rows = [];
					if (outline.items.length) {
						delivery.outlineBranchesStale = await branchOutlineStale(body.project, design);
						delivery.pointsStale ||= delivery.outlineBranchesStale || points.source_outline_digest !== outline.digest || design.status !== 'approved' || design.source_ecsm_digest !== frozen?.digest;
						delivery.casesStale ||= delivery.pointsStale;
						const deferred = await loadArtifact(root, body.project, 'deferrals');
						delivery.deferralsPending = waitingDeferrals(deferred.items).length;
						rows = outlineCoverage({ ...design, digest: outline.digest }, points, cases, deferred.items);
						delivery.missingCases = rows.filter((row) => row.state === 'case_missing').length;
						delivery.incompleteCases = rows.filter((row) => row.state === 'case_incomplete').length;
						delivery.assertions = rows.reduce((sum, row) => ({ required: sum.required + (row.assertions_required || 0), covered: sum.covered + (row.assertions_covered || 0), deferred: sum.deferred + (row.assertions_deferred || 0) }), { required: 0, covered: 0, deferred: 0 });
					}
					const signedCases = deliveryCases(cases, rows);
					delivery.pendingCaseIds = signedCases.items.filter((item) => item.review_status !== 'approved').map((item) => item.case_id);
					delivery.casesPending = delivery.pendingCaseIds.length;
					delivery.scopedGaps = Object.fromEntries(signedCases.items.filter((item) => delivery.gaps[item.case_id])
						.map((item) => [item.case_id, delivery.gaps[item.case_id]]));
					delivery.approvals = approvalAudit(body.project, { points, cases: signedCases }, new Set(facts.items.map((item) => item.fact_id)));
					delivery.blocker = frozen?.inputs
						? deliveryBlocker({ points, cases: signedCases }, frozen, outline, rows, delivery)
						: { step: 'model', message: '请先在 ECSM 确认需求并冻结产品模型。' };
					const variantOf = new Map(cases.items.map((item) => [item.case_id, caseVariant(item)]));
					const firstReview = firstReviewStats(loadReviews(root, body.project), variantOf, new Set(variantOf.values()));
					delivery.first_review = { denominator: firstReview.denominator, reviewed: firstReview.reviewed,
						passed: firstReview.passed, returned: firstReview.returned, anchor: 'variant' };
					delivery.runs = listRuns(root, body.project).slice(-5).map(({ run_id, started_at, finished_at, baseline_digest, completed_ids, failed_ids, pending_ids, stopped }) =>
						({ run_id, started_at, finished_at, baseline_digest, completed: completed_ids.length, failed: failed_ids.length, pending: pending_ids.length, stopped }));
					const outlineStatus = summarizeOutline(design, Boolean(delivery.outlineBranchesStale));
					sendJson(res, 200, { ok: true, state: { features, facts, points, cases, review, states, pointQuality, delivery, outlineStatus } });
					return;
				}
				case 'branches.save': {
					assertWritable(body.project);
					if (!Array.isArray(body.items) || !body.items.length) throw new Error('分支清单为空');
					const current = await loadArtifact(root, body.project, 'branches');
					if ((body.version != null && body.version !== current.version) || (body.digest != null && body.digest !== current.digest)) {
						throw new Error('分支清单已变化，请刷新后重新提交');
					}
					await archiveArtifact(root, body.project, 'branches');
					const saved = await saveArtifact(root, body.project, 'branches', {
						version: current.version, items: body.items,
						meta: { prd: body.prd || null, dbc: body.dbc || null, counts: body.counts || null }
					});
					sendJson(res, 200, { ok: true, state: { version: saved.version, digest: saved.digest, count: saved.items.length } });
					return;
				}
				case 'cases.runs': {
					const runs = listRuns(root, body.project);
					const run = body.run_id ? loadRun(root, body.project, String(body.run_id)) : runs.at(-1) || null;
					sendJson(res, 200, { ok: true, state: { run, runs: runs.map(({ run_id, started_at, finished_at, stopped }) => ({ run_id, started_at, finished_at, stopped })) } });
					return;
				}
				case 'artifacts.export': {
					const cases = await loadArtifact(root, body.project, 'cases');
					if (cases.items.length === 0) throw new Error('还没有用例可导出');
					const info = await findProject(config, body.project);
					const moduleName = info?.modules?.[0]?.name || '';
					// Last chance to fill 功能点ID: resolve through points when the case lacks it.
					const [pointsDoc, featuresDoc] = await Promise.all([
						loadArtifact(root, body.project, 'points'),
						loadArtifact(root, body.project, 'features')
					]);
					const factFeature = new Map();
					for (const feature of featuresDoc.items) for (const ref of feature.fact_refs || []) factFeature.set(ref, feature.feature_id);
					const pointMap = new Map(pointsDoc.items.map((point) => [point.point_id, point]));
					for (const item of cases.items) {
						if (item.feature_id) continue;
						const point = pointMap.get(item.point_id);
						item.feature_id = (point?.fact_refs || []).map((ref) => factFeature.get(ref)).find(Boolean) || point?.feature_id || '';
					}
					const stale = Boolean(cases.source_points_digest && cases.source_points_digest !== digestOf(pointsDoc.items));
					const moduleLabel = info?.modules?.find((item) => item.id === currentModule())?.name || currentModule();
					const expOpts = {
						template: body.export_template || currentConfig().export_template || 'standard',
						columns: Array.isArray(body.export_columns) && body.export_columns.length ? body.export_columns : currentConfig().export_columns
					};
					const file = await exportCases(root, body.project, cases.items, moduleLabel || moduleName, `${moduleLabel}-${currentModule()}-draft`, '', cases.version, cases.digest, [], expOpts);
					const download_url = exportDownloadUrl(file);
					sendJson(res, 200, { ok: true, state: { file, download_url, name: path.basename(file), count: cases.items.length, stale, warning: stale ? '用例基于旧版测试点，建议重跑用例后再导出' : null } });
					return;
				}
				case 'artifacts.exportBundle': {
					const [cases, points, review, outline, deferrals] = await Promise.all(['cases', 'points', 'review', 'outline', 'deferrals'].map((kind) => loadArtifact(root, body.project, kind)));
					if (cases.items.length === 0) throw new Error('还没有用例可导出');
					const info = await findProject(config, body.project);
					const moduleLabel = info?.modules?.find((item) => item.id === currentModule())?.name || currentModule();
					const selected = Array.isArray(body.case_ids) && body.case_ids.length
						? cases.items.filter((item) => body.case_ids.includes(item.case_id)) : cases.items;
					if (!selected.length) throw new Error('筛选后没有可导出的用例');
					const doc = { ...cases, items: selected };
					for (const item of doc.items) structureCase(item);
					const model = frozenModel(root, body.project);
					const accounting = outline.items[0] ? outlineCoverage({ ...outline.items[0], digest: outline.digest }, points, doc, deferrals.items) : [];
					const expOpts = {
						template: body.export_template || currentConfig().export_template || 'standard',
						columns: Array.isArray(body.export_columns) && body.export_columns.length ? body.export_columns : currentConfig().export_columns
					};
					const file = await exportCases(root, body.project, doc.items, moduleLabel, `${moduleLabel}-${currentModule()}-${body.label || 'draft'}`, '', doc.version, doc.digest, [], expOpts);
					const snapshot = {
						project: body.project, module: currentModule(), moduleName: moduleLabel,
						cases: doc, points, review, outline: outline.items[0] || null, accounting,
						run: listRuns(root, body.project).at(-1) || null,
						approvals: approvalAudit(body.project, { points, cases: doc }),
						ecsm: model ? { version: model.version, digest: model.digest } : null,
						status: 'candidate', bench_verified: false, design_evidence_applicable: designEvidenceApplicable(),
						imagesDir: path.join(info.dir, 'design', 'case-images')
					};
					const bundle = await exportDelivery(root, body.project, snapshot, file);
					const download_url = exportDownloadUrl(bundle.xlsx);
					const downloads = [
						{ key: 'xlsx', label: 'Excel 用例', name: path.basename(bundle.xlsx), url: exportDownloadUrl(bundle.xlsx) },
						{ key: 'html', label: '图文 HTML', name: path.basename(bundle.html), url: exportDownloadUrl(bundle.html) },
						{ key: 'md', label: 'Markdown', name: path.basename(bundle.md), url: exportDownloadUrl(bundle.md) },
						{ key: 'json', label: '结构化 JSON', name: path.basename(bundle.json), url: exportDownloadUrl(bundle.json) }
					].filter((d) => d.url);
					sendJson(res, 200, { ok: true, state: { ...bundle, download_url, downloads, count: selected.length, status: 'candidate', bench_verified: false } });
					return;
				}
				case 'evidence.build': {
					const item = await findProject(config, body.project);
					if (!item) throw new Error(`项目不存在：${body.project}`);
					const { document } = await buildEvidence(config, item, root);
					sendJson(res, 200, { ok: true, state: { stats: document.stats, builtAt: document.builtAt } });
					return;
				}
				case 'evidence.index': {
					const evidence = body.module ? await scopedEvidence(body.project) : null;
					const index = evidence ? { ...evidence, items: evidence.items.map(({ text, ...item }) => item) } : await loadEvidence(config, body.project, root);
					sendJson(res, 200, { ok: true, state: { index } });
					return;
				}
				case 'evidence.search': {
					const result = await searchEvidence(config, body.project, root, String(body.query || ''), { limit: body.limit,
						document: body.module ? await scopedEvidence(body.project) : undefined });
					sendJson(res, 200, { ok: true, state: result });
					return;
				}
				case 'evidence.read': {
					const item = await readEvidence(config, body.project, root, String(body.id || ''), { offset: body.offset, limit: body.limit });
					sendJson(res, 200, { ok: true, state: item });
					return;
				}
				default:
					sendJson(res, 400, { ok: false, error: `未知操作：${String(body.action)}` });
			}
		} catch (error) {
			sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (release) await release();
		}
	};

	ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: handle }), `cts-agent: POST ${API}`);
	ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: CHAT, handler: runChat }), `cts-agent: POST ${CHAT}`);
	ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: GENERATE, handler: runGenerate }), `cts-agent: POST ${GENERATE}`);
	ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: REVIEW, handler: runReview }), `cts-agent: POST ${REVIEW}`);
		ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: UPLOAD, handler: runUpload }), `cts-agent: POST ${UPLOAD}`);

		const exportsRoot = path.resolve(path.join(root, 'exports'));
		const exportDownloadUrl = (absFile) => {
			if (!absFile) return '';
			const resolved = path.resolve(absFile);
			if (!resolved.startsWith(exportsRoot + path.sep)) return '';
			const rel = path.relative(exportsRoot, resolved).split(path.sep).join('/');
			return `${DOWNLOAD}?path=${encodeURIComponent(rel)}`;
		};
		const runDownload = async (req, res) => {
			const rejection = ctx.connection?.requestRejection?.(req);
			if (rejection !== undefined) {
				res.statusCode = rejection;
				res.end();
				return;
			}
			const url = new URL(req.url || '/', 'http://127.0.0.1');
			const relative = url.searchParams.get('path') || '';
			if (!relative || relative.includes('..') || relative.includes('\0')) {
				res.statusCode = 400;
				res.end('bad path');
				return;
			}
			const resolved = path.resolve(exportsRoot, relative);
			if (!resolved.startsWith(exportsRoot + path.sep)) {
				res.statusCode = 403;
				res.end('forbidden');
				return;
			}
			const ext = path.extname(resolved).toLowerCase();
			const mime = ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
				: ext === '.html' ? 'text/html; charset=utf-8'
					: ext === '.json' ? 'application/json; charset=utf-8'
						: ext === '.md' ? 'text/markdown; charset=utf-8'
							: ext === '.png' ? 'image/png'
								: 'application/octet-stream';
			try {
				const buffer = await fs.readFile(resolved);
				const filename = path.basename(resolved);
				res.statusCode = 200;
				res.setHeader('content-type', mime);
				if (url.searchParams.get('inline') !== '1') {
					res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
				}
				res.setHeader('cache-control', 'no-store');
				res.end(buffer);
			} catch {
				res.statusCode = 404;
				res.end('not found');
			}
		};
		ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DOWNLOAD, handler: runDownload }), `cts-agent: GET ${DOWNLOAD}`);

		const runFile = async (req, res) => {
			const rejection = ctx.connection?.requestRejection?.(req);
			if (rejection !== undefined) {
				res.statusCode = rejection;
				res.end();
				return;
			}
			const url = new URL(req.url || '/', 'http://127.0.0.1');
			const relative = url.searchParams.get('path') || '';
			if (relative === '' || relative.includes('..')) {
				res.statusCode = 400;
				res.end('bad path');
				return;
			}
			const absolute = path.join(root, 'projects', relative);
			const resolved = path.resolve(absolute);
			if (!resolved.startsWith(path.resolve(path.join(root, 'projects')))) {
				res.statusCode = 403;
				res.end('forbidden');
				return;
			}
			const type = /\.png$/i.test(resolved) ? 'image/png'
				: /\.jpe?g$/i.test(resolved) ? 'image/jpeg'
					: /\.webp$/i.test(resolved) ? 'image/webp'
						: /\.svg$/i.test(resolved) ? 'image/svg+xml'
							: 'application/octet-stream';
			try {
				const buffer = await fs.readFile(resolved);
				res.statusCode = 200;
				res.setHeader('content-type', type);
				res.setHeader('cache-control', 'max-age=300');
				res.end(buffer);
			} catch {
				res.statusCode = 404;
				res.end('not found');
			}
		};

		const runOAuthStart = async (req, res) => {
			const rejection = ctx.connection?.requestRejection?.(req);
			if (rejection !== undefined) {
				res.statusCode = rejection;
				res.end();
				return;
			}
			try {
				const redirectUri = `${originOf(req)}${OAUTH_CALLBACK}`;
				const url = await startPixsoOAuth(root, redirectUri);
				res.statusCode = 302;
				res.setHeader('location', url);
				res.end();
			} catch (error) {
				res.statusCode = 500;
				res.setHeader('content-type', 'text/plain; charset=utf-8');
				res.end(`授权启动失败：${error instanceof Error ? error.message : String(error)}`);
			}
		};

		const runOAuthCallback = async (req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const code = url.searchParams.get('code') || '';
			const state = url.searchParams.get('state') || '';
			const failed = url.searchParams.get('error') || '';
			res.setHeader('content-type', 'text/html; charset=utf-8');
			if (failed !== '' || code === '') {
				res.statusCode = 400;
				res.end(`<h3>授权失败</h3><p>${failed || '缺少 code'}</p>`);
				return;
			}
			try {
				await finishPixsoOAuth(root, { code, state });
				res.statusCode = 200;
				res.end(`<meta charset="utf-8"><h3>Pixso 授权成功</h3><p>可以回到测试 Agent，点「检测连接」。</p><p><a href="/">返回</a></p>`);
			} catch (error) {
				res.statusCode = 400;
				res.end(`<h3>授权失败</h3><p>${error instanceof Error ? error.message : String(error)}</p>`);
			}
		};

		// A fixed local port keeps redirect_uri stable across DSH restarts (the GUI
		// port changes every launch, which would otherwise force a re-registration).
		let oauthServer = null;
		const oauthListening = () => Boolean(oauthServer && oauthServer.listening);
		try {
			oauthServer = http.createServer(async (req, res) => {
				const url = new URL(req.url || '/', `http://127.0.0.1:${OAUTH_PORT}`);
				if (!url.pathname.startsWith('/callback')) {
					res.writeHead(404).end('not found');
					return;
				}
				res.setHeader('content-type', 'text/html; charset=utf-8');
				const code = url.searchParams.get('code') || '';
				const state = url.searchParams.get('state') || '';
				const failed = url.searchParams.get('error') || '';
				if (failed || !code) {
					await recordCallback(root, { ok: false, error: failed || 'missing code', port: OAUTH_PORT }).catch(() => {});
					res.statusCode = 400;
					res.end(`<meta charset="utf-8"><h3>Pixso 授权失败</h3><p>${failed || '缺少 code'}</p>`);
					return;
				}
				try {
					await finishPixsoOAuth(root, { code, state });
					await recordCallback(root, { ok: true, port: OAUTH_PORT }).catch(() => {});
					res.end('<meta charset="utf-8"><h3>Pixso 授权成功</h3><p>可以回到测试 Agent，点「检测连接」。</p>');
				} catch (error) {
					await recordCallback(root, { ok: false, error: error instanceof Error ? error.message : String(error), port: OAUTH_PORT }).catch(() => {});
					res.statusCode = 400;
					res.end(`<meta charset="utf-8"><h3>授权失败</h3><p>${error instanceof Error ? error.message : String(error)}</p>`);
				}
			});
			oauthServer.on('error', () => { oauthServer = null; });
			oauthServer.listen(OAUTH_PORT, '127.0.0.1');
		} catch {
			oauthServer = null;
		}
		ctx.effect(() => () => oauthServer?.close(), 'cts-agent: oauth callback server');

		ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: FILE, handler: runFile }), `cts-agent: GET ${FILE}`);
		ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: OAUTH_START, handler: runOAuthStart }), `cts-agent: GET ${OAUTH_START}`);
		ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: OAUTH_CALLBACK, handler: runOAuthCallback }), `cts-agent: GET ${OAUTH_CALLBACK}`);

	try {
		ctx.tools.register({
			name: 'cts_projects',
			description: 'List cockpit test projects and, for one project, its PRD / signal / design inventory. Read-only.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				required: ['action'],
				properties: {
					action: { type: 'string', enum: ['list', 'summary'] },
					project: { type: 'string', description: 'Project id from action "list".' }
				}
			},
			execute: async (input) => {
				if (input.action === 'list') return JSON.stringify(await listProjects(config));
				if (!input.project) throw new Error('action "summary" 需要 project');
				return JSON.stringify(await summary(config, input.project));
			}
		});
		ctx.tools.register({
			name: 'cts_check',
			description: 'Run the deterministic case linter: missing expected/steps, unresolved references, unbound controls and signals.',
			parameters: { type: 'object', additionalProperties: false, required: ['project'], properties: { project: { type: 'string' } } },
			execute: async (input) => {
				const cases = await loadArtifact(root, input.project, 'cases');
				const points = await loadArtifact(root, input.project, 'points');
				const facts = await loadArtifact(root, input.project, 'facts');
				const issues = lint(cases.items, new Set(points.items.map((point) => point.point_id)), new Set(facts.items.map((fact) => fact.fact_id)));
				return JSON.stringify({ errorCount: issues.filter((issue) => issue.severity !== 'warning').length, issues: issues.slice(0, 30) });
			}
		});
		ctx.tools.register({
			name: 'cts_history',
			description: 'Search the legacy workbench history: how a similar requirement was defined or tested before.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				required: ['query'],
				properties: { query: { type: 'string' }, limit: { type: 'number' } }
			},
			execute: async (input) => JSON.stringify(searchHistory(root, String(input.query || ''), input.limit))
		});
		ctx.tools.register({
			name: 'cts_evidence',
			description: 'Cockpit test evidence: build the evidence index for a project, then search or read citable chunks (E-xxxx).',
			parameters: {
				type: 'object',
				additionalProperties: false,
				required: ['action', 'project'],
				properties: {
					action: { type: 'string', enum: ['build', 'search', 'read'] },
					project: { type: 'string' },
					query: { type: 'string' },
					id: { type: 'string' },
					limit: { type: 'number' }
				}
			},
			execute: async (input) => {
				if (input.action === 'build') {
					const item = await findProject(config, input.project);
					const { document } = await buildEvidence(config, item, root);
					return JSON.stringify(document.stats);
				}
				if (input.action === 'search') return JSON.stringify(await searchEvidence(config, input.project, root, String(input.query || ''), { limit: input.limit }));
				if (input.action === 'read') return JSON.stringify(await readEvidence(config, input.project, root, String(input.id || '')));
				throw new Error(`未知操作：${input.action}`);
			}
		});
	} catch (error) {
		ctx.logger?.warn?.(`cts-agent: 注册工具失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}
