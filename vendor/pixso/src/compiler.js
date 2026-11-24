'use strict';

const fs = require('fs');
const path = require('path');
const { decodeArchive, inspectArchive } = require('./decoder');
const { normalizePixso } = require('./normalize');
const { updateRegistry } = require('./registry');
const { buildIndex, verifyIndex } = require('./sqlite');
const {
  ensureWithin, fileRecord, findWorkspaceRoot, readJson, safeSegment, sha256Buffer, sha256File,
  stableStringify, utcNow, writeJson, writeJsonl,
} = require('./util');

const ADAPTER_ID = 'pixso-source-adapter';
const ADAPTER_VERSION = '1.0.1';
const IR_SCHEMA_ID = 'pixso-normalized-ir/v1';

function validateSourceSet(value, sourceSetPath) {
  if (value.schema_id !== 'project-source-set/v1') throw new Error(`Unsupported source set schema in ${sourceSetPath}`);
  if (!value.source_set_id || !value.project) throw new Error('source_set_id and project are required');
  if (!Array.isArray(value.pixso_sources) || value.pixso_sources.length === 0) throw new Error('pixso_sources must not be empty');
  const ids = new Set();
  for (const source of value.pixso_sources) {
    if (!source.logical_file_id || !source.path || !source.role) throw new Error('Each Pixso source needs logical_file_id, path, and role');
    if (ids.has(source.logical_file_id)) throw new Error(`Duplicate logical_file_id: ${source.logical_file_id}`);
    ids.add(source.logical_file_id);
    if (source.sha256 && !/^[0-9a-f]{64}$/i.test(source.sha256)) throw new Error(`Invalid SHA-256 for ${source.logical_file_id}`);
  }
}

function compileProfileDigest(kiwiSchemaSha256, filesOnly = false) {
  const schemaPath = path.join(__dirname, '..', 'schemas', 'pixso-normalized-ir-v1.schema.json');
  const profile = {
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    ir_schema_id: IR_SCHEMA_ID,
    ir_schema_sha256: sha256File(schemaPath),
    kiwi_schema_sha256: kiwiSchemaSha256,
    policies: {
      primary_nodes: 'fully_normalized_with_content_addressed_raw_payload',
      instances: 'base_symbol_plus_override_patch_and_effective_text_projection',
      derived_geometry: 'counted_not_permanently_expanded',
      visual_evidence: 'offline_structure_only',
    },
  };
  if (filesOnly) profile.policies.storage = 'jsonl_only_v1';
  return { profile, digest: sha256Buffer(Buffer.from(stableStringify(profile), 'utf8')) };
}

function listFiles(root) {
  const output = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else output.push(target);
    }
  }
  visit(root);
  return output.sort((a, b) => a.localeCompare(b));
}

function writeNormalizedBundle(target, normalized) {
  const irRoot = path.join(target, 'ir');
  const recordFiles = {
    pages: 'pages.jsonl', boards: 'boards.jsonl', nodes: 'nodes.jsonl', edges: 'edges.jsonl',
    components: 'components.jsonl', instances: 'instances.jsonl', overrides: 'overrides.jsonl',
    texts: 'texts.jsonl', assets: 'assets.jsonl', blobs: 'blobs.jsonl', styles: 'styles.jsonl',
    node_payloads: 'node_payloads.jsonl',
  };
  for (const [key, fileName] of Object.entries(recordFiles)) writeJsonl(path.join(irRoot, fileName), normalized.records[key]);
  writeJson(path.join(target, 'atlas', 'product_atlas.json'), normalized.productAtlas);
  writeJsonl(path.join(target, 'findings', 'findings.jsonl'), normalized.findings);
  for (const card of normalized.records.screen_cards) {
    const cardName = `${safeSegment(card.page_id)}__${safeSegment(card.board_id)}.json`;
    writeJson(path.join(target, 'screen_cards', cardName), card);
  }
  return recordFiles;
}

function validateNormalized(normalized, storeRoot) {
  const failures = [];
  const nodeIds = new Set();
  for (const node of normalized.records.nodes) {
    if (nodeIds.has(node.entity_id)) failures.push({ check: 'unique_node_entity_id', entity_id: node.entity_id });
    nodeIds.add(node.entity_id);
  }
  for (const item of [...normalized.records.assets, ...normalized.records.blobs]) {
    const target = path.resolve(storeRoot, ...item.object_ref.split('/'));
    try {
      ensureWithin(storeRoot, target);
      if (!fs.existsSync(target)) failures.push({ check: 'content_object_exists', object_ref: item.object_ref });
      else if (sha256File(target) !== item.object_sha256) failures.push({ check: 'content_object_digest', object_ref: item.object_ref });
    } catch (error) {
      failures.push({ check: 'content_object_path', object_ref: item.object_ref, message: error.message });
    }
  }
  return { status: failures.length ? 'failed' : 'passed', failures };
}

function existingReadyBundle(target, expected) {
  const ready = path.join(target, 'READY');
  const manifestPath = path.join(target, 'bundle_manifest.json');
  if (!fs.existsSync(ready) || !fs.existsSync(manifestPath)) return null;
  const manifest = readJson(manifestPath);
  if (manifest.source_sha256 !== expected.sourceSha256 || manifest.compile_profile_digest !== expected.compileProfileDigest) return null;
  return manifest;
}

function compileOneSource(source, context) {
  const sourcePath = ensureWithin(context.workspaceRoot, path.resolve(context.workspaceRoot, ...source.path.split('/')));
  if (!fs.existsSync(sourcePath)) {
    if (source.required === false) return { logical_file_id: source.logical_file_id, cache_status: 'optional_missing' };
    throw new Error(`Required source is missing: ${sourcePath}`);
  }
  const sourceSha256 = sha256File(sourcePath);
  if (source.sha256 && source.sha256.toLowerCase() !== sourceSha256) {
    throw new Error(`Source digest mismatch for ${source.logical_file_id}: expected ${source.sha256.toLowerCase()}, got ${sourceSha256}`);
  }
  const inspected = inspectArchive(sourcePath);
  const { profile, digest: compileDigest } = compileProfileDigest(inspected.kiwiSchemaSha256, context.filesOnly);
  const target = ensureWithin(context.storeRoot, path.join(
    context.storeRoot, 'source_bundles', 'pixso', safeSegment(source.logical_file_id), sourceSha256, compileDigest,
  ));
  const cached = existingReadyBundle(target, { sourceSha256, compileProfileDigest: compileDigest });
  if (cached) return {
    logical_file_id: source.logical_file_id, source_sha256: sourceSha256,
    compile_profile_digest: compileDigest, bundle_path: target, cache_status: 'hit', manifest: cached,
  };
  if (fs.existsSync(target)) throw new Error(`Incomplete or incompatible immutable bundle already exists: ${target}`);

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const building = `${target}.building-${process.pid}-${Date.now()}`;
  ensureWithin(context.storeRoot, building);
  fs.mkdirSync(building, { recursive: false });

  try {
    const decoded = decodeArchive(inspected, sourcePath);
    const normalized = normalizePixso(decoded, { ...source, actual_sha256: sourceSha256 }, {
      project: context.sourceSet.project,
      storeRoot: context.storeRoot,
      objectRoot: path.join(context.storeRoot, 'objects', 'sha256'),
    });
    const recordFiles = writeNormalizedBundle(building, normalized);
    const indexPath = path.join(building, 'index', 'compiled_ui.sqlite');
    if (!context.filesOnly) buildIndex(indexPath, normalized, {
      adapter_id: ADAPTER_ID, adapter_version: ADAPTER_VERSION, ir_schema_id: IR_SCHEMA_ID,
      source_id: source.logical_file_id, source_sha256: sourceSha256, compile_profile_digest: compileDigest,
    });

    const structuralValidation = validateNormalized(normalized, context.storeRoot);
    const indexValidation = context.filesOnly ? { status: 'passed', storage: 'jsonl_only', record_counts: normalized.stats } : verifyIndex(indexPath, normalized.stats);
    const validation = {
      schema_id: 'pixso-bundle-validation/v1',
      status: structuralValidation.status === 'passed' && indexValidation.status === 'passed' ? 'passed' : 'failed',
      structural: structuralValidation,
      index: indexValidation,
      non_blocking_findings_count: normalized.findings.length,
    };
    writeJson(path.join(building, 'validation.json'), validation);
    if (validation.status !== 'passed') throw new Error(`Bundle validation failed for ${source.logical_file_id}`);

    const inventory = listFiles(building).map(file => fileRecord(file, building));
    const irInventory = inventory.filter(item => item.path.startsWith('ir/') || item.path.startsWith('atlas/') || item.path.startsWith('screen_cards/') || item.path.startsWith('findings/'));
    const manifest = {
      schema_id: 'pixso-compiled-ui-bundle/v1',
      adapter: { id: ADAPTER_ID, version: ADAPTER_VERSION },
      source_set_id: context.sourceSet.source_set_id,
      project: context.sourceSet.project,
      logical_file_id: source.logical_file_id,
      source_role: source.role,
      source_path: source.path,
      source_sha256: sourceSha256,
      source_bytes: fs.statSync(sourcePath).size,
      pixso_version: inspected.version,
      kiwi_schema_sha256: inspected.kiwiSchemaSha256,
      compile_profile: profile,
      compile_profile_digest: compileDigest,
      ir_schema_id: IR_SCHEMA_ID,
      ir_digest: sha256Buffer(Buffer.from(stableStringify(irInventory), 'utf8')),
      index_sha256: context.filesOnly ? null : sha256File(indexPath),
      validation_sha256: sha256File(path.join(building, 'validation.json')),
      record_files: recordFiles,
      stats: normalized.stats,
      files: inventory,
    };
    writeJson(path.join(building, 'bundle_manifest.json'), manifest);
    const manifestDigest = sha256File(path.join(building, 'bundle_manifest.json'));
    fs.writeFileSync(path.join(building, 'READY'), `${manifestDigest}\n`, 'utf8');
    fs.renameSync(building, target);
    return {
      logical_file_id: source.logical_file_id, source_sha256: sourceSha256,
      compile_profile_digest: compileDigest, bundle_path: target, cache_status: 'miss_compiled', manifest,
    };
  } catch (error) {
    error.message = `${error.message} (in build directory ${building})`;
    throw error;
  }
}

function writeSourceSetSnapshot(context, results) {
  const members = results.filter(item => item.bundle_path).map(item => ({
    logical_file_id: item.logical_file_id,
    source_sha256: item.source_sha256,
    compile_profile_digest: item.compile_profile_digest,
    bundle_ref: path.relative(context.storeRoot, item.bundle_path).split(path.sep).join('/'),
  })).sort((a, b) => a.logical_file_id.localeCompare(b.logical_file_id));
  const canonical = {
    schema_id: 'compiled-ui-source-set/v1', source_set_id: context.sourceSet.source_set_id,
    project: context.sourceSet.project, scope: context.sourceSet.scope, members,
  };
  const digest = sha256Buffer(Buffer.from(stableStringify(canonical), 'utf8'));
  const target = ensureWithin(context.storeRoot, path.join(
    context.storeRoot, 'source_sets', safeSegment(context.sourceSet.source_set_id), digest,
  ));
  const manifestPath = path.join(target, 'manifest.json');
  if (!fs.existsSync(path.join(target, 'READY'))) {
    if (fs.existsSync(target)) throw new Error(`Incomplete immutable source set snapshot exists: ${target}`);
    fs.mkdirSync(target, { recursive: true });
    writeJson(manifestPath, { ...canonical, source_set_digest: digest });
    fs.writeFileSync(path.join(target, 'READY'), `${sha256File(manifestPath)}\n`, 'utf8');
  }
  return { source_set_id: context.sourceSet.source_set_id, source_set_digest: digest, manifest_path: manifestPath };
}

function compileSourceSet(options) {
  const sourceSetPath = path.resolve(options.sourceSetPath);
  const sourceSet = readJson(sourceSetPath);
  validateSourceSet(sourceSet, sourceSetPath);
  const workspaceRoot = path.resolve(
    path.dirname(sourceSetPath),
    sourceSet.workspace_root_relative_to_manifest || findWorkspaceRoot(path.dirname(sourceSetPath)),
  );
  const storeRoot = path.resolve(options.storeRoot);
  fs.mkdirSync(storeRoot, { recursive: true });
  const context = { sourceSet, sourceSetPath, workspaceRoot, storeRoot, filesOnly: Boolean(options.filesOnly) };
  const startedAt = utcNow();
  const results = [];
  for (const source of sourceSet.pixso_sources) results.push(compileOneSource(source, context));
  const sourceSetSnapshot = writeSourceSetSnapshot(context, results);
  updateRegistry(storeRoot, { sources: results.filter(item => item.bundle_path), source_set: sourceSetSnapshot });

  const runId = `pixso-source-${startedAt.replace(/[-:TZ]/g, '')}-${process.pid}`;
  const runManifest = {
    schema_id: 'pixso-source-compile-run/v1', run_id: runId, started_at: startedAt, completed_at: utcNow(),
    source_set_id: sourceSet.source_set_id, source_set_digest: sourceSetSnapshot.source_set_digest,
    source_set_path: path.relative(workspaceRoot, sourceSetPath).split(path.sep).join('/'),
    store_root: storeRoot,
    summary: {
      sources: results.length,
      cache_hits: results.filter(item => item.cache_status === 'hit').length,
      compiled: results.filter(item => item.cache_status === 'miss_compiled').length,
      optional_missing: results.filter(item => item.cache_status === 'optional_missing').length,
    },
    results: results.map(item => ({
      logical_file_id: item.logical_file_id, source_sha256: item.source_sha256,
      compile_profile_digest: item.compile_profile_digest, cache_status: item.cache_status,
      bundle_ref: item.bundle_path ? path.relative(storeRoot, item.bundle_path).split(path.sep).join('/') : null,
      stats: item.manifest?.stats || null,
    })),
  };
  const runPath = path.join(storeRoot, 'runs', runId, 'run_manifest.json');
  writeJson(runPath, runManifest);
  return { ...runManifest, run_path: runPath, registry_path: path.join(storeRoot, 'compiled_ui_registry.json') };
}

module.exports = { ADAPTER_VERSION, compileOneSource, compileProfileDigest, compileSourceSet, validateSourceSet };
