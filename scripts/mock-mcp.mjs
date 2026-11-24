#!/usr/bin/env node
/**
 * Protocol-compatible stand-in for Pixso Desktop's local MCP, used to verify the
 * plugin's client without the desktop app. Serves one PNG for any guid.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_MCP_PORT || 3667);
const sessions = new Set();
let id = 0;

// 4x4 red PNG
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4GBgYERBgAAtQ0DFf0m8wAAAABJRU5ErkJggg==',
	'base64'
);

const server = http.createServer((req, res) => {
	if (req.method !== 'POST') {
		res.writeHead(405).end();
		return;
	}
	let raw = '';
	req.on('data', (chunk) => { raw += chunk; });
	req.on('end', () => {
		let body = {};
		try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
		const send = (payload, headers = {}) => {
			res.writeHead(200, { 'content-type': 'application/json', ...headers });
			res.end(JSON.stringify(payload));
		};
		if (body.method === 'initialize') {
			const session = `mock-${++id}`;
			sessions.add(session);
			send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'mock-pixso', version: '0.0.1' }, capabilities: { tools: {} } } }, { 'mcp-session-id': session });
			return;
		}
		if (body.method === 'notifications/initialized') {
			res.writeHead(202).end();
			return;
		}
		if (!sessions.has(req.headers['mcp-session-id'])) {
			send({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'no session' } }, { 'mcp-session-id': 'none' });
			return;
		}
		if (body.method === 'tools/list') {
			send({ jsonrpc: '2.0', id: body.id, result: { tools: [
				{ name: 'get_screenshot', description: 'render a node' },
				{ name: 'get_node_dsl', description: 'node tree' },
				{ name: 'get_top_level_frames', description: 'pages/frames' }
			] } });
			return;
		}
		if (body.method === 'tools/call') {
			const name = body.params?.name;
			if (name === 'get_screenshot') {
				send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }] } });
				return;
			}
			if (name === 'get_node_dsl') {
				send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ name: 'mock-node', type: 'FRAME', children: [] }) }] } });
				return;
			}
			if (name === 'get_top_level_frames') {
				send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify([{ pageId: '1:1', pageName: '页面 1', frames: [{ frameId: '2:2', frameName: '画板 A' }] }]) }] } });
				return;
			}
			send({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] } });
			return;
		}
		send({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown method' } });
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`mock pixso mcp on http://127.0.0.1:${PORT}/mcp`);
});
