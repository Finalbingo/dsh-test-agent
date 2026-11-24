import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { apply } from '../index.js';

const source = '/Users/Admin/Documents/CTS-testagent';
const project = 'P-d346f484e6';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cts-24-export-'));
const routes = new Map();
const cleanup = [];
let host;
try {
  for (const part of [`projects/${project}`, `artifacts/${project}`, `evidence/${project}`]) {
    await fs.cp(path.join(source, part), path.join(root, part), { recursive: true });
  }
  apply({
    get: () => undefined,
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); },
    webServer: { register: (route) => routes.set(route.path, route.handler) },
    tools: { register() {} }
  }, { dataDir: root, legacyRoot: false });
  host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://local').pathname);
    Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(error.message));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + host.address().port;
  const api = async (action, fields = {}) => { const result = await (await (await fetch(base + '/cts/api', { method: 'POST', body: JSON.stringify({ action, project, module: 'M-main', ...fields }) })).json()); assert.ok(result.ok, action + ': ' + JSON.stringify(result)); return result.state; };
  const list = await api('package.list');
  const current = list.current || (await api('package.current'));
  assert.equal(current.package_id, 'PKG-001-9b20dd0e');
  const first = await api('package.export', { package_id: current.package_id, bundle: true });
  const second = await api('package.export', { package_id: current.package_id, bundle: true });
  const hash = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const firstHashes = { xlsx: await hash(first.xlsx), html: await hash(first.html), json: await hash(first.json), markdown: await hash(first.md) };
  const secondHashes = { xlsx: await hash(second.xlsx), html: await hash(second.html), json: await hash(second.json), markdown: await hash(second.md) };
  assert.deepEqual(secondHashes, firstHashes, '同快照两次导出内容必须一致');
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'artifacts', project, 'M-main', 'packages', current.package_id, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.cases.items.length, 24);
  console.log('PASS 24场景快照：24 cases，两次导出 xlsx/html/json/markdown SHA 一致');
  console.log('HASH', JSON.stringify(firstHashes));
  console.log('EXPORT_DIR', first.dir);
} finally {
  await new Promise((resolve) => host ? host.close(resolve) : resolve());
  for (const dispose of cleanup.reverse()) await dispose();
  await fs.rm(root, { recursive: true, force: true });
}
