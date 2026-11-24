/**
 * Minimal MCP client for Pixso Desktop's local server.
 *
 * The desktop app exposes one JSON-RPC endpoint; tools we rely on:
 *   get_screenshot { guid, clientFrameworks }  → PNG in content[].data
 *   get_node_dsl   { guid, simplify }          → node tree text
 *   get_top_level_frames { type: 'page' }      → pages/frames for switching
 *   eval_script    { script }                  → used to switch the open file
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:3667/mcp';
const REMOTE_URL = 'https://pixso.cn/mcp';

export const isRemote = (url) => /^https:\/\//.test(String(url || ''));

export class PixsoMcp {
	constructor(url = DEFAULT_URL, timeout = 120000, token = '') {
		this.url = url;
		this.timeout = timeout;
		this.sessionId = null;
		this.nextId = 1;
		this.token = token;
		this.lastStatus = 0;
		this.wwwAuthenticate = '';
	}

	async post(body) {
		const headers = {
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json'
		};
		if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
		if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeout);
		let response;
		let text;
		try {
			response = await fetch(this.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal
			});
			text = await response.text();
		} finally {
			clearTimeout(timer);
		}
		this.lastStatus = response.status;
		this.wwwAuthenticate = response.headers.get('www-authenticate') || '';
		if (response.status === 401) {
			const error = new Error(this.token
				? 'Pixso 令牌无效或已过期（401）'
				: 'Pixso 云端 MCP 需要授权：配置 pixsoToken，或走 OAuth 获取访问令牌');
			error.code = 'PIXSO_UNAUTHORIZED';
			error.wwwAuthenticate = this.wwwAuthenticate;
			throw error;
		}
		const parsed = parsePayload(text);
		return { parsed, headers: response.headers };
	}

	async connect() {
		const { parsed, headers } = await this.post({
			jsonrpc: '2.0',
			id: this.nextId++,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'cts-agent', version: '1.0.0' }
			}
		});
		if (parsed?.error) throw new Error(`MCP 初始化失败：${JSON.stringify(parsed.error)}`);
		// Stateless remote servers omit the session header; only local Pixso sends it.
		this.sessionId = headers.get('mcp-session-id') || null;
		this.protocolVersion = parsed?.result?.protocolVersion || '2025-06-18';
		await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {});
		this.serverInfo = parsed?.result?.serverInfo || null;
		return this;
	}

	async listTools() {
		const { parsed } = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} });
		if (parsed?.error) throw new Error(`tools/list 失败：${JSON.stringify(parsed.error)}`);
		const tools = parsed?.result?.tools || [];
		this.toolNames = tools.map((tool) => tool.name);
		return tools;
	}

	async callTool(name, args) {
		const { parsed } = await this.post({
			jsonrpc: '2.0',
			id: this.nextId++,
			method: 'tools/call',
			params: { name, arguments: args || {} }
		});
		if (parsed?.error) throw new Error(`工具 ${name} 失败：${JSON.stringify(parsed.error)}`);
		const result = parsed?.result || {};
		if (result.isError) throw new Error(`工具 ${name} 返回错误：${JSON.stringify(result).slice(0, 300)}`);
		return result;
	}

	async exportLocalPng(guid, constraint) {
		const result = await this.callTool('get_export_image', {
			guid, exportSettings: { constraint, imageType: 1 }
		});
		const image = result.content?.find((block) => block.type === 'image' && block.data);
		if (image) return { buffer: Buffer.from(image.data, 'base64'), mimeType: 'image/png' };
		const address = result.content?.find((block) => block.type === 'text')?.text.match(/^https?:\/\/\S+/m)?.[0];
		if (!address) throw new Error('Pixso 未返回 PNG 下载地址');
		const url = new URL(address);
		const endpoint = new URL(this.url);
		const localHosts = ['localhost', '127.0.0.1', '[::1]'];
		const sameHost = url.hostname === endpoint.hostname ||
			(localHosts.includes(url.hostname) && localHosts.includes(endpoint.hostname));
		if (!sameHost || url.protocol !== endpoint.protocol || url.port !== endpoint.port ||
			!/^\/export\/[^/]+\.png$/i.test(url.pathname)) throw new Error('PNG 下载地址与本地 Pixso MCP 不匹配');
		const response = await fetch(new URL(url.pathname + url.search, endpoint), {
			signal: AbortSignal.timeout(this.timeout), redirect: 'error'
		});
		if (!response.ok) throw new Error(`PNG 下载失败（HTTP ${response.status}）`);
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
			throw new Error('Pixso 导出内容不是有效的 PNG');
		}
		return { buffer, mimeType: 'image/png' };
	}

	async screenshot(guid, options = {}) {
		// The Advanced bridge takes { nodeId } and returns the image inline.
		if (this.toolNames?.includes('get_screenshot') && !this.toolNames.includes('get_export_image')) {
			const shot = await this.callTool('get_screenshot', { nodeId: guid, scale: options.scale || 2 });
			const block = (shot.content || []).find((item) => item.type === 'image' && item.data);
			if (block) return { buffer: Buffer.from(block.data, 'base64'), mimeType: block.mimeType || 'image/png' };
			const asset = await this.callTool('export_asset', { nodeId: guid, format: 'PNG', scale: options.scale || 2 });
			const assetBlock = (asset.content || []).find((item) => item.type === 'image' && item.data);
			if (assetBlock) return { buffer: Buffer.from(assetBlock.data, 'base64'), mimeType: assetBlock.mimeType || 'image/png' };
			throw new Error('截图工具没有返回图片数据');
		}
		// Cloud MCP exposes get_export_image; local desktop exposes get_screenshot.
		if (options.remote || isRemote(this.url)) {
			const fileKey = options.fileKey || '';
			if (!fileKey) throw new Error('云端 MCP 需要 file_key：请粘贴带 fileKey 的 Pixso 图层链接');
			const target = { file_key: fileKey, ...(guid ? { guid } : {}) };
			try {
				const exported = await this.callTool('get_export_image', {
					...target,
					exportSettings: [{ format: options.imageType || 'PNG', scale: options.scale || 2 }]
				});
				const block = (exported.content || []).find((item) => item.type === 'image' && item.data)
					|| (exported.content || []).find((item) => item.type === 'text' && /^[A-Za-z0-9+/=]+$/.test(String(item.text || '').trim()));
				if (block?.data) return { buffer: Buffer.from(block.data, 'base64'), mimeType: block.mimeType || 'image/png' };
				if (block?.text) return { buffer: Buffer.from(block.text, 'base64'), mimeType: 'image/png' };
				throw new Error('get_export_image 没有返回图片数据');
			} catch (error) {
				const shot = await this.callTool('take_screenshot', { file_key: fileKey, ...(guid ? { nodeId: guid } : {}) });
				const block = (shot.content || []).find((item) => item.type === 'image' && item.data);
				if (!block) throw error;
				return { buffer: Buffer.from(block.data, 'base64'), mimeType: block.mimeType || 'image/png' };
			}
		}
		const { width = 0, height = 0 } = options;
		const edge = Math.max(width, height);
		const failures = [];
		if (edge <= 8192) {
			try {
				const result = await this.callTool('get_screenshot', { guid, clientFrameworks: 'html' });
				const image = result.content?.find((block) => block.type === 'image' && block.data);
				if (!image) throw new Error('没有返回图片数据');
				return { buffer: Buffer.from(image.data, 'base64'), mimeType: image.mimeType || 'image/png' };
			} catch (error) {
				failures.push(error);
			}
		}
		for (const pixels of [4096, 2048]) {
			try {
				const constraint = edge > pixels
					? { type: width >= height ? 2 : 3, value: pixels }
					: { type: 1, value: failures.length > 1 ? 0.5 : options.scale || 1 };
				return await this.exportLocalPng(guid, constraint);
			} catch (error) {
				failures.push(error);
			}
		}
		throw new Error(`Pixso 无法生成图层 ${guid} 的 PNG。请确认图层仍在当前设计稿中，必要时缩小或拆分画板后补图。`, {
			cause: new AggregateError(failures)
		});
	}

	async dsl(guid, options = {}) {
		const args = isRemote(this.url)
			? { file_key: options.fileKey || '', ...(guid ? { guid } : {}), simplify: true }
			: { guid, clientFrameworks: 'html', simplify: true };
		const result = await this.callTool('get_node_dsl', args);
		const text = (result.content || []).find((block) => block.type === 'text')?.text || '';
		return text;
	}
}

function parsePayload(text) {
	const trimmed = String(text || '').trim();
	if (trimmed === '') return {};
	try {
		return JSON.parse(trimmed);
	} catch {
		// Streamable HTTP servers answer over SSE: take the last data frame.
		const frames = trimmed.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim())
			.filter((data) => data && data !== '[DONE]');
		for (let index = frames.length - 1; index >= 0; index -= 1) {
			try {
				return JSON.parse(frames[index]);
			} catch {
				continue;
			}
		}
		throw new Error(`MCP 返回无法解析：${trimmed.slice(0, 200)}`);
	}
}

export async function savePng(dir, name, buffer) {
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.png`);
	await fs.writeFile(file, buffer);
	return file;
}

export { DEFAULT_URL, REMOTE_URL };
