/**
 * A worker is a bounded agent loop: its own system prompt, its own tool subset,
 * its own round budget. It exists so a stage can pull extra context instead of
 * being handed one fixed batch and hoping it was enough.
 *
 * This is deliberately not a DSH session agent: a session has a lifecycle and a
 * log of its own, and generation workers are short-lived, throwaway contexts.
 */
const message = (role, text) => ({ role, content: [{ type: 'text', text }] });

function parseToolCall(text) {
	const trimmed = String(text || '').trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
	const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	if (!unfenced.startsWith('{')) return null;
	try {
		const value = JSON.parse(unfenced);
		// A final answer that happens to be an object is not a tool call.
		if (value && typeof value.tool === 'string' && value.tool !== '' && value.args !== undefined) {
			return { tool: value.tool, args: value.args };
		}
	} catch {
		return null;
	}
	return null;
}

/** Models sometimes pass a bare string; map it to the field the tool expects. */
function normalizeArgs(tool, args) {
	if (args && typeof args === 'object' && !Array.isArray(args)) return args;
	const raw = typeof args === 'string' ? args : String(args ?? '');
	if (raw === '') return {};
	if (/(search|lookup|history)/.test(tool)) return { query: raw };
	return { id: raw };
}

function compact(value, limit = 6000) {
	const text = JSON.stringify(value, null, 1);
	return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

/**
 * @param {object} options
 * @param {{llm:object, provider:string, model:string}} options.model
 * @param {string} options.system   skill text (rules)
 * @param {string} options.task     payload + output schema
 * @param {string[]} options.tools  tool names the worker may call
 * @param {(name:string, args:object)=>Promise<any>} options.runTool
 * @param {number} [options.maxRounds]
 * @param {number} [options.maxTokens]
 * @param {(event:object)=>void} [options.onEvent]
 */
export async function runWorker({ model, system, task, tools = [], runTool, maxRounds = 2, maxTokens = 4000, onEvent, requireTool = false }) {
	const allowed = new Set(tools);
	const protocol = allowed.size === 0 ? '' : [
		'',
		'可用工具（需要更多资料时，只输出一行 JSON，不要解释）：',
		...[...allowed].map((name) => `{"tool":"${name}","args":{…}}`),
		'拿到"工具结果"后继续；信息够了就直接输出最终 JSON。'
	].join('\n');
	const messages = [message('system', `${system}${protocol}`), message('user', task)];
	let last = '';
	let usedTool = false;

	for (let round = 0; round <= maxRounds; round += 1) {
		let text = '';
		for await (const part of model.llm.stream({
			provider: model.provider,
			model: model.model,
			maxTokens,
			reasoningEffort: 'off',
			messages
		})) {
			if (part?.type === 'text-delta' && typeof part.text === 'string') text += part.text;
			else if (part?.type === 'finish' && (part.reason?.kind === 'error' || part.reason?.kind === 'aborted')) {
				throw Object.assign(new Error(part.reason?.failure?.message || '模型调用未完成'), { code: part.reason?.failure?.code || 'LLM_FAILED' });
			}
		}
		last = text;

		const call = parseToolCall(text);
		if ((!call || call.gate) && requireTool && !usedTool && round < maxRounds) {
			messages.push(message('user', `你还没有调用任何工具。${allowed.size > 0 ? `必须先调用 ${[...allowed].join(' 或 ')} 取得依据，再给结论。` : ''}`));
			continue;
		}
		if (!call || round === maxRounds) return last;
		if (!allowed.has(call.tool)) {
			messages.push(message('user', `工具 ${call.tool} 不可用。可用：${[...allowed].join('、') || '无'}。请直接输出最终 JSON。`));
			continue;
		}
		usedTool = true;
		const toolArgs = normalizeArgs(call.tool, call.args);
		onEvent?.({ type: 'tool', tool: call.tool, args: toolArgs });
		let result;
		try {
			result = await runTool(call.tool, toolArgs);
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		messages.push(message('user', [
			`你刚才请求了 ${call.tool}（${JSON.stringify(toolArgs)}），结果如下：`,
			compact(result),
			'',
			'继续核对；信息够了就直接输出最终 JSON（不要再用 tool 字段）。'
		].join('\n')));
	}
	return last;
}
