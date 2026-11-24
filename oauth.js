/**
 * Pixso OAuth 2.1 (authorization code + PKCE) for the cloud MCP.
 *
 * The profile can hold a personal access token, but OAuth is the documented
 * recommended path and avoids the "invalid_token" dead end when a PAT is stale.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import path from 'node:path';

// This network resolves pixso.cn to a bogus IPv6 first and Node's fetch then
// times out; prefer IPv4 for the OAuth round trips.
dns.setDefaultResultOrder('ipv4first');

const AUTHORIZE = 'https://pixso.cn/api/user/pixso/oauth2/authorize';
const TOKEN = 'https://pixso.cn/api/user/pixso/oauth2/token';
const REGISTER = 'https://pixso.cn/api/user/pixso/oauth2/register';
const SCOPE = 'mcp:connect';

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function storePath(dataRoot) {
	return path.join(dataRoot, 'pixso-oauth.json');
}

export async function loadToken(dataRoot) {
	try {
		const value = JSON.parse(await fs.readFile(storePath(dataRoot), 'utf8'));
		return value;
	} catch {
		return null;
	}
}

async function saveToken(dataRoot, value) {
	await fs.mkdir(path.dirname(storePath(dataRoot)), { recursive: true });
	await fs.writeFile(storePath(dataRoot), JSON.stringify(value, null, 1), 'utf8');
}

export async function startFlow(dataRoot, redirectUri, options = {}) {
	const verifier = base64url(crypto.randomBytes(32));
	const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
	const state = base64url(crypto.randomBytes(12));

	const existing = await loadToken(dataRoot);
	let clientId = existing?.client_id && existing?.redirect_uri === redirectUri ? existing.client_id : '';
	if (!clientId && options.allowStaleClient && existing?.client_id) clientId = existing.client_id;
	if (!clientId) {
		let response;
		try {
			response = await fetch(REGISTER, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					client_name: 'dsh-cts-agent',
					redirect_uris: [redirectUri],
					grant_types: ['authorization_code'],
					response_types: ['code'],
					token_endpoint_auth_method: 'none',
					scope: SCOPE
				}),
				signal: AbortSignal.timeout(15000)
			});
		} catch (error) {
			throw new Error(`连不上 pixso.cn（${error instanceof Error ? error.message : String(error)}）——检查网络或代理后重试`);
		}
		if (!response.ok) throw new Error(`动态注册失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
		const body = await response.json();
		clientId = body.client_id;
		if (!clientId) throw new Error('注册响应里没有 client_id');
		await saveToken(dataRoot, { client_id: clientId, redirect_uri: redirectUri });
	} else if (!existing?.redirect_uri || existing.redirect_uri !== redirectUri) {
		await saveToken(dataRoot, { ...existing, client_id: clientId, redirect_uri: existing.redirect_uri });
	}

	const url = new URL(AUTHORIZE);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('scope', SCOPE);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');

	await saveToken(dataRoot, {
		client_id: clientId,
		redirect_uri: redirectUri,
		pending: { state, verifier, created_at: Date.now() }
	});
	return url.toString();
}

export async function recordCallback(dataRoot, info) {
	const saved = (await loadToken(dataRoot)) || {};
	const record = { at: new Date().toISOString(), ...info };
	await saveToken(dataRoot, { ...saved, last_callback: record });
	try {
		await fs.appendFile(path.join(dataRoot, 'pixso-oauth.log'), `${JSON.stringify(record)}\n`, 'utf8');
	} catch {
		// logging is best-effort
	}
}

export async function finishFlow(dataRoot, { code, state }) {
	const saved = await loadToken(dataRoot);
	if (!saved?.pending || saved.pending.state !== state) throw new Error('OAuth state 不匹配，请重新授权');
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: saved.redirect_uri,
		client_id: saved.client_id,
		code_verifier: saved.pending.verifier
	});
	const response = await fetch(TOKEN, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`换取令牌失败：HTTP ${response.status} ${text.slice(0, 200)}`);
	const token = JSON.parse(text);
	if (!token.access_token) throw new Error('令牌响应里没有 access_token');
	const record = {
		client_id: saved.client_id,
		redirect_uri: saved.redirect_uri,
		access_token: token.access_token,
		refresh_token: token.refresh_token || '',
		expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
		scope: token.scope || SCOPE,
		obtained_at: new Date().toISOString()
	};
	await saveToken(dataRoot, record);
	return record;
}
