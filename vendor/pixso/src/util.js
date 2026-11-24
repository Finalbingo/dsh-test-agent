'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes) hash.update(buffer.subarray(0, bytes));
    } while (bytes);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function jsonSafe(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes_hex: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const child = jsonSafe(value[key]);
      if (child !== undefined) result[key] = child;
    }
    return result;
  }
  return String(value);
}

function stableStringify(value) {
  return JSON.stringify(jsonSafe(value));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(jsonSafe(value), null, 2)}\n`, 'utf8');
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(jsonSafe(value), null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  try {
    for (const record of records) fs.writeSync(fd, `${stableStringify(record)}\n`, null, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeSegment(value) {
  const result = String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!result || result === '.' || result === '..') throw new Error(`Unsafe path segment: ${value}`);
  return result;
}

function ensureWithin(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes store root: ${resolvedTarget}`);
  return resolvedTarget;
}

function findWorkspaceRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function fileRecord(filePath, root) {
  const stat = fs.statSync(filePath);
  return {
    path: path.relative(root, filePath).split(path.sep).join('/'),
    bytes: stat.size,
    sha256: sha256File(filePath),
  };
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = {
  ensureWithin,
  fileRecord,
  findWorkspaceRoot,
  jsonSafe,
  readJson,
  safeSegment,
  sha256Buffer,
  sha256File,
  stableStringify,
  utcNow,
  writeJson,
  writeJsonAtomic,
  writeJsonl,
};
