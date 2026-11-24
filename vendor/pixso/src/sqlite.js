'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('./util');

function json(value) {
  return value === undefined || value === null ? null : stableStringify(value);
}

function number(value) {
  return Number.isFinite(value) ? value : null;
}

function textValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : stableStringify(value);
}

function sqlitePath(filePath) {
  return process.platform === 'win32' ? path.toNamespacedPath(filePath) : filePath;
}

function buildIndex(databasePath, normalized, metadata = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (fs.existsSync(databasePath)) {
    throw new Error(`Refusing to overwrite existing SQLite index: ${databasePath}`);
  }
  const db = new DatabaseSync(sqlitePath(databasePath));
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = OFF;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE pages (
        source_id TEXT NOT NULL, page_id TEXT NOT NULL, entity_id TEXT PRIMARY KEY,
        name TEXT NOT NULL, internal INTEGER NOT NULL, source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE boards (
        source_id TEXT NOT NULL, board_id TEXT NOT NULL, entity_id TEXT PRIMARY KEY,
        page_id TEXT, name TEXT NOT NULL, visible INTEGER NOT NULL,
        width REAL, height REAL, board_kind TEXT, classification_json TEXT,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE nodes (
        node_pk INTEGER PRIMARY KEY, source_id TEXT NOT NULL, node_id TEXT NOT NULL,
        entity_id TEXT NOT NULL UNIQUE, node_type TEXT NOT NULL, name TEXT NOT NULL,
        parent_id TEXT, page_id TEXT, board_id TEXT, semantic_class TEXT,
        visible INTEGER NOT NULL, opacity REAL, x REAL, y REAL, width REAL, height REAL,
        raw_payload_sha256 TEXT, component_key TEXT, image_hash_refs_json TEXT,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE node_bbox USING rtree(node_pk, min_x, max_x, min_y, max_y);
      CREATE TABLE edges (
        edge_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, from_entity TEXT NOT NULL,
        edge_type TEXT NOT NULL, to_entity TEXT NOT NULL, source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE components (
        component_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, node_id TEXT,
        name TEXT NOT NULL, component_key TEXT, publish_file TEXT, publish_id TEXT,
        prop_defs_json TEXT, source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE instances (
        instance_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, node_id TEXT,
        name TEXT NOT NULL, instance_of TEXT, symbol_node_id TEXT,
        override_count INTEGER NOT NULL, derived_node_count INTEGER NOT NULL,
        transform_json TEXT, source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE overrides (
        override_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        guid_path_json TEXT, patch_json TEXT, patch_sha256 TEXT,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE texts (
        text_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, node_id TEXT, entity_id TEXT,
        page_id TEXT, board_id TEXT, text TEXT NOT NULL, origin TEXT NOT NULL,
        font_family TEXT, font_style TEXT, font_size REAL, guid_path_json TEXT,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE assets (
        asset_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, pixso_hash TEXT,
        entry_name TEXT, media_type TEXT, bytes INTEGER, object_sha256 TEXT,
        object_ref TEXT, source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE blobs (
        blob_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, blob_index INTEGER,
        bytes INTEGER, object_sha256 TEXT, object_ref TEXT,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE styles (
        style_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, node_id TEXT,
        name TEXT NOT NULL, style_type TEXT, master_json TEXT, reference_json TEXT,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_nodes_page ON nodes(page_id);
      CREATE INDEX idx_nodes_board ON nodes(board_id);
      CREATE INDEX idx_nodes_type ON nodes(node_type);
      CREATE INDEX idx_edges_from ON edges(from_entity, edge_type);
      CREATE INDEX idx_edges_to ON edges(to_entity, edge_type);
      CREATE INDEX idx_texts_board ON texts(board_id);
      CREATE INDEX idx_instances_symbol ON instances(symbol_node_id);
    `);

    let ftsTokenizer = 'trigram';
    try {
      db.exec("CREATE VIRTUAL TABLE search_fts USING fts5(entity_id UNINDEXED, entity_type UNINDEXED, name, text, tokenize='trigram')");
    } catch (error) {
      ftsTokenizer = 'unicode61';
      db.exec("CREATE VIRTUAL TABLE search_fts USING fts5(entity_id UNINDEXED, entity_type UNINDEXED, name, text, tokenize='unicode61')");
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const putMetadata = db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries({ ...metadata, fts_tokenizer: ftsTokenizer })) {
        putMetadata.run(key, typeof value === 'string' ? value : stableStringify(value));
      }

      const putPage = db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.pages) putPage.run(
        item.source_id, item.page_id, item.entity_id, item.name, item.internal ? 1 : 0, item.source_sha256,
      );

      const putBoard = db.prepare('INSERT INTO boards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.boards) putBoard.run(
        item.source_id, item.board_id, item.entity_id, item.page_id, item.name, item.visible ? 1 : 0,
        number(item.size?.width), number(item.size?.height), item.classification?.board_kind || null,
        json(item.classification), item.source_sha256,
      );

      const putNode = db.prepare(`INSERT INTO nodes(
        source_id,node_id,entity_id,node_type,name,parent_id,page_id,board_id,semantic_class,
        visible,opacity,x,y,width,height,raw_payload_sha256,component_key,image_hash_refs_json,source_sha256
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const putBox = db.prepare('INSERT INTO node_bbox VALUES (?, ?, ?, ?, ?)');
      for (const item of normalized.records.nodes) {
        const box = item.absolute_box;
        const result = putNode.run(
          item.source_id, item.node_id, item.entity_id, item.node_type, item.name, item.parent_id,
          item.page_id, item.board_id, item.semantic_class, item.visible ? 1 : 0, number(item.opacity),
          number(box?.x), number(box?.y), number(box?.width), number(box?.height), item.raw_payload_sha256,
          item.component_key, json(item.image_hash_refs || []), item.source_sha256,
        );
        if (box && [box.x, box.y, box.width, box.height].every(Number.isFinite)) {
          putBox.run(Number(result.lastInsertRowid), box.x, box.x + box.width, box.y, box.y + box.height);
        }
      }

      const putEdge = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.edges) putEdge.run(
        item.edge_id, item.source_id, item.from, item.edge_type, item.to, item.source_sha256,
      );

      const putComponent = db.prepare('INSERT INTO components VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.components) putComponent.run(
        item.component_id, item.source_id, item.node_id, item.name, textValue(item.component_key),
        textValue(item.publish_file), textValue(item.publish_id), json(item.component_prop_defs || []), item.source_sha256,
      );

      const putInstance = db.prepare('INSERT INTO instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.instances) putInstance.run(
        item.instance_id, item.source_id, item.node_id, item.name, item.instance_of,
        item.symbol_node_id, item.override_count, item.derived_node_count, json(item.transform), item.source_sha256,
      );

      const putOverride = db.prepare('INSERT INTO overrides VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.overrides) putOverride.run(
        item.override_id, item.source_id, item.instance_id, json(item.guid_path), json(item.patch),
        item.patch_sha256, item.source_sha256,
      );

      const putText = db.prepare('INSERT INTO texts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.texts) putText.run(
        item.text_id, item.source_id, item.node_id, item.entity_id, item.page_id, item.board_id,
        item.text, item.origin, item.font_family || null, item.font_style || null,
        number(item.font_size), json(item.guid_path), item.source_sha256,
      );

      const putAsset = db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.assets) putAsset.run(
        item.asset_id, item.source_id, item.pixso_hash, item.entry_name, item.media_type,
        item.bytes, item.object_sha256, item.object_ref, item.source_sha256,
      );

      const putBlob = db.prepare('INSERT INTO blobs VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.blobs) putBlob.run(
        item.blob_id, item.source_id, item.blob_index, item.bytes, item.object_sha256,
        item.object_ref, item.source_sha256,
      );

      const putStyle = db.prepare('INSERT INTO styles VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of normalized.records.styles) putStyle.run(
        item.style_id, item.source_id, item.node_id, item.name,
        item.style_type === null || item.style_type === undefined ? null : String(item.style_type),
        json(item.master), json(item.reference), item.source_sha256,
      );

      const putSearch = db.prepare('INSERT INTO search_fts(entity_id, entity_type, name, text) VALUES (?, ?, ?, ?)');
      for (const item of normalized.records.pages) putSearch.run(item.entity_id, 'page', item.name, '');
      for (const item of normalized.records.boards) putSearch.run(item.entity_id, 'board', item.name, '');
      for (const item of normalized.records.nodes) if (item.name) putSearch.run(item.entity_id, 'node', item.name, '');
      for (const item of normalized.records.components) putSearch.run(item.component_id, 'component', item.name, '');
      for (const item of normalized.records.texts) putSearch.run(item.entity_id || item.text_id, 'text', '', item.text);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.exec('PRAGMA optimize');
  } finally {
    db.close();
  }
}

function verifyIndex(databasePath, expectedStats) {
  const db = new DatabaseSync(sqlitePath(databasePath), { readOnly: true });
  try {
    const actual = {};
    for (const table of ['pages', 'boards', 'nodes', 'edges', 'components', 'instances', 'overrides', 'texts', 'assets', 'blobs', 'styles']) {
      actual[`${table}_count`] = Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
    }
    const checks = [
      ['pages_count', expectedStats.page_count + expectedStats.internal_page_count],
      ['boards_count', expectedStats.top_level_board_count],
      ['nodes_count', expectedStats.node_count],
      ['edges_count', expectedStats.edge_count],
      ['components_count', expectedStats.component_count],
      ['instances_count', expectedStats.instance_count],
      ['overrides_count', expectedStats.override_count],
      ['texts_count', expectedStats.text_record_count],
      ['assets_count', expectedStats.asset_count],
      ['blobs_count', expectedStats.blob_count],
      ['styles_count', expectedStats.style_count],
    ];
    const failures = checks.filter(([key, expected]) => actual[key] !== expected)
      .map(([key, expected]) => ({ check: key, expected, actual: actual[key] }));
    return { status: failures.length ? 'failed' : 'passed', actual, failures };
  } finally {
    db.close();
  }
}

module.exports = { buildIndex, verifyIndex };
