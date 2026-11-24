'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, utcNow, writeJsonAtomic } = require('./util');

const REGISTRY_SCHEMA = 'pixso-compiled-ui-registry/v1';

function registryPath(storeRoot) {
  return path.join(storeRoot, 'compiled_ui_registry.json');
}

function loadRegistry(storeRoot) {
  const target = registryPath(storeRoot);
  if (!fs.existsSync(target)) return { schema_id: REGISTRY_SCHEMA, sources: {}, source_sets: {} };
  const value = readJson(target);
  if (value.schema_id !== REGISTRY_SCHEMA) throw new Error(`Unsupported registry schema: ${value.schema_id}`);
  value.sources ||= {};
  value.source_sets ||= {};
  return value;
}

function toPortableRelative(storeRoot, target) {
  return path.relative(storeRoot, target).split(path.sep).join('/');
}

function updateRegistry(storeRoot, updates) {
  const registry = loadRegistry(storeRoot);
  for (const update of updates.sources || []) {
    registry.sources[update.logical_file_id] = {
      logical_file_id: update.logical_file_id,
      source_sha256: update.source_sha256,
      compile_profile_digest: update.compile_profile_digest,
      current_bundle_ref: toPortableRelative(storeRoot, update.bundle_path),
      status: 'ready',
    };
  }
  if (updates.source_set) {
    registry.source_sets[updates.source_set.source_set_id] = {
      source_set_id: updates.source_set.source_set_id,
      source_set_digest: updates.source_set.source_set_digest,
      current_manifest_ref: toPortableRelative(storeRoot, updates.source_set.manifest_path),
      status: 'ready',
    };
  }
  registry.updated_at = utcNow();
  writeJsonAtomic(registryPath(storeRoot), registry);
  return registry;
}

function resolveBundle(storeRoot, logicalFileId) {
  const registry = loadRegistry(storeRoot);
  const source = registry.sources[logicalFileId];
  if (!source) throw new Error(`No compiled source registered for ${logicalFileId}`);
  const bundlePath = path.resolve(storeRoot, ...source.current_bundle_ref.split('/'));
  if (!fs.existsSync(path.join(bundlePath, 'READY'))) throw new Error(`Registered bundle is not ready: ${bundlePath}`);
  return { registry, source, bundlePath };
}

module.exports = { loadRegistry, registryPath, resolveBundle, updateRegistry };
