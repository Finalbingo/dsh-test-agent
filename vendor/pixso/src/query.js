'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadRegistry, resolveBundle } = require('./registry');
const { readJson } = require('./util');

function indexPath(bundlePath) {
  const target = path.join(bundlePath, 'index', 'compiled_ui.sqlite');
  if (!fs.existsSync(target)) throw new Error(`Compiled index is missing: ${target}`);
  return target;
}

function openReadOnly(databasePath) {
  return new DatabaseSync(process.platform === 'win32' ? path.toNamespacedPath(databasePath) : databasePath, { readOnly: true });
}

function listStatus(storeRoot) {
  const registry = loadRegistry(storeRoot);
  return {
    schema_id: registry.schema_id,
    updated_at: registry.updated_at || null,
    sources: Object.values(registry.sources).sort((a, b) => a.logical_file_id.localeCompare(b.logical_file_id)).map(source => {
      const bundlePath = path.resolve(storeRoot, ...source.current_bundle_ref.split('/'));
      const ready = fs.existsSync(path.join(bundlePath, 'READY'));
      const manifestPath = path.join(bundlePath, 'bundle_manifest.json');
      return {
        ...source, ready,
        stats: fs.existsSync(manifestPath) ? readJson(manifestPath).stats : null,
      };
    }),
    source_sets: Object.values(registry.source_sets).sort((a, b) => a.source_set_id.localeCompare(b.source_set_id)),
  };
}

function listPages(storeRoot, logicalFileId, databasePath) {
  const db = openReadOnly(databasePath || indexPath(resolveBundle(storeRoot, logicalFileId).bundlePath));
  try {
    const pages = db.prepare(`
      SELECT p.page_id, p.entity_id, p.name, p.internal, count(b.board_id) AS board_count
      FROM pages p LEFT JOIN boards b ON b.page_id = p.page_id
      GROUP BY p.page_id ORDER BY p.internal, p.name, p.page_id
    `).all().map(item => ({ ...item, internal: Boolean(item.internal), board_count: Number(item.board_count) }));
    for (const page of pages) page.boards = db.prepare(`
      SELECT board_id, entity_id, name, width, height, board_kind, visible,
        json_extract(classification_json, '$.node_type') AS node_type
      FROM boards WHERE page_id = ? ORDER BY name, board_id
    `).all(page.page_id).map(item => ({ ...item, visible: Boolean(item.visible) }));
    return { logical_file_id: logicalFileId, pages };
  } finally {
    db.close();
  }
}

function ftsExpression(text) {
  return `"${text.replace(/"/g, '""')}"`;
}

function searchOne(storeRoot, logicalFileId, text, limit, databasePath) {
  const db = openReadOnly(databasePath || indexPath(resolveBundle(storeRoot, logicalFileId).bundlePath));
  try {
    let rows = [];
    if ([...text].length >= 3) {
      try {
        rows = db.prepare(`
          SELECT entity_id, entity_type, name, text, bm25(search_fts) AS rank
          FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?
        `).all(ftsExpression(text), limit);
      } catch (error) {
        rows = [];
      }
    }
    if (rows.length === 0) {
      const pattern = `%${text}%`;
      rows = db.prepare(`
        SELECT entity_id, entity_type, name, text, 0.0 AS rank FROM (
          SELECT entity_id, 'page' AS entity_type, name, '' AS text FROM pages
          UNION ALL SELECT entity_id, 'board', name, '' FROM boards
          UNION ALL SELECT entity_id, 'node', name, '' FROM nodes
          UNION ALL SELECT component_id, 'component', name, '' FROM components
          UNION ALL SELECT coalesce(entity_id,text_id), 'text', '', text FROM texts
        ) WHERE name LIKE ? OR text LIKE ? LIMIT ?
      `).all(pattern, pattern, limit);
    }
    return rows.map(row => ({ logical_file_id: logicalFileId, ...row }));
  } finally {
    db.close();
  }
}

function search(storeRoot, text, options = {}) {
  if (!text) throw new Error('Search text must not be empty');
  const limit = Math.max(1, Math.min(Number(options.limit || 50), 500));
  const registry = loadRegistry(storeRoot);
  const ids = options.logicalFileId ? [options.logicalFileId] : Object.keys(registry.sources).sort();
  const perSource = Math.max(limit, options.logicalFileId ? limit : Math.ceil(limit / Math.max(ids.length, 1)));
  const results = ids.flatMap(id => searchOne(storeRoot, id, text, perSource));
  results.sort((a, b) => Number(a.rank) - Number(b.rank) || a.logical_file_id.localeCompare(b.logical_file_id));
  return { query: text, logical_file_id: options.logicalFileId || null, result_count: Math.min(results.length, limit), results: results.slice(0, limit) };
}

function getNode(storeRoot, logicalFileId, nodeId, databasePath) {
  const db = openReadOnly(databasePath || indexPath(resolveBundle(storeRoot, logicalFileId).bundlePath));
  try {
    const entityId = nodeId.includes('::node::') ? nodeId : `${logicalFileId}::node::${nodeId}`;
    const node = db.prepare('SELECT * FROM nodes WHERE entity_id = ?').get(entityId);
    if (!node) return null;
    const result = {
      ...node,
      visible: Boolean(node.visible),
      image_hash_refs: node.image_hash_refs_json ? JSON.parse(node.image_hash_refs_json) : [],
      children: db.prepare('SELECT node_id, entity_id, node_type, name, visible FROM nodes WHERE parent_id = ? ORDER BY node_pk').all(node.node_id)
        .map(item => ({ ...item, visible: Boolean(item.visible) })),
      texts: db.prepare('SELECT text_id, text, origin, font_family, font_style, font_size FROM texts WHERE entity_id = ? OR node_id = ?').all(entityId, node.node_id),
      outgoing_edges: db.prepare('SELECT edge_type, to_entity FROM edges WHERE from_entity = ?').all(entityId),
      incoming_edges: db.prepare('SELECT edge_type, from_entity FROM edges WHERE to_entity = ?').all(entityId),
    };
    delete result.image_hash_refs_json;
    return result;
  } finally {
    db.close();
  }
}

function spatialQuery(storeRoot, logicalFileId, box, limit = 200) {
  const { bundlePath } = resolveBundle(storeRoot, logicalFileId);
  const db = openReadOnly(indexPath(bundlePath));
  try {
    return db.prepare(`
      SELECT n.entity_id,n.node_id,n.node_type,n.name,n.page_id,n.board_id,n.x,n.y,n.width,n.height
      FROM node_bbox b JOIN nodes n ON n.node_pk=b.node_pk
      WHERE b.max_x >= ? AND b.min_x <= ? AND b.max_y >= ? AND b.min_y <= ?
      ORDER BY n.node_pk LIMIT ?
    `).all(box.x, box.x + box.width, box.y, box.y + box.height, Math.max(1, Math.min(Number(limit), 1000)));
  } finally {
    db.close();
  }
}

module.exports = { getNode, listPages, listStatus, search, searchOne, spatialQuery };
