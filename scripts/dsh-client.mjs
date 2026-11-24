import fs from 'node:fs/promises';
import path from 'node:path';

/** Authenticated client for the local DSH instance running the workspace plugin.
 *  运行地址、日志位置、项目与模块必须由调用方提供，脚本不内置任何项目默认值。 */
const required = (name) => {
	const value = process.env[name];
	if (!value) throw new Error(`缺少环境变量 ${name}`);
	return value;
};
const base = required('CTS_BASE');
const log = required('CTS_SERVER_LOG');
const token = [...(await fs.readFile(log, 'utf8')).matchAll(/\?token=([^\s]+)/g)].at(-1)?.[1];
if (!token) throw new Error('DSH login link unavailable');
const login = await fetch(base + '/?token=' + encodeURIComponent(token), { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
if (!cookie) throw new Error('DSH did not issue cookies: ' + login.status);
const headers = { cookie, origin: base, 'content-type': 'application/json' };

export const project = required('CTS_PROJECT');
export const module = required('CTS_MODULE');
export const post = (route, fields) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ project, module, ...fields }) });
export const api = async (action, fields = {}) => {
	const result = await (await post('/cts/api', { action, ...fields })).json();
	if (!result.ok) throw new Error(action + ': ' + result.error);
	return result.state;
};
export const rawApi = async (action, fields = {}) => (await post('/cts/api', { action, ...fields })).json();
export const generate = async (kind, fields = {}) => {
	const response = await post('/cts/api/generate', { kind, draft: false, ...fields });
	if (!response.ok) throw new Error('generate HTTP ' + response.status);
	const events = [];
	let buffer = '';
	for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
		buffer += chunk;
		let at;
		while ((at = buffer.indexOf('\n\n')) >= 0) {
			const block = buffer.slice(0, at);
			buffer = buffer.slice(at + 2);
			const [event, data] = block.split('\n');
			if (!data?.startsWith('data: ')) continue;
			events.push({ event: event.replace('event: ', ''), ...JSON.parse(data.slice(6)) });
		}
	}
	return events;
};
export const saveJson = (dir, name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 1));
export { base, cookie };