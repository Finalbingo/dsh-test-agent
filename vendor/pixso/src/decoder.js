'use strict';

const path = require('path');
const AdmZip = require('adm-zip');
const kiwi = require('kiwi-schema');
const { decompress } = require('fzstd');
const { sha256Buffer } = require('./util');

const ZSTD_MARKER = Buffer.from('compress:zstd', 'ascii');

function findDocumentEntry(archive, filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const exact = archive.getEntry(`${baseName}.pix`);
  if (exact) return exact;
  const candidates = archive.getEntries().filter(entry => /(^|\/)\w.*\.pix$/i.test(entry.entryName));
  if (candidates.length !== 1) throw new Error(`Expected one Pixso document entry in ${filePath}, found ${candidates.length}`);
  return candidates[0];
}

function inspectArchive(filePath) {
  const archive = new AdmZip(filePath);
  const documentEntry = findDocumentEntry(archive, filePath);
  const schemaEntry = archive.getEntry('pixso.binary');
  const versionEntry = archive.getEntry('VERSION');
  if (!schemaEntry || !versionEntry) throw new Error(`Missing pixso.binary or VERSION in ${filePath}`);
  const schemaBytes = schemaEntry.getData();
  return {
    archive,
    documentEntry,
    schemaBytes,
    kiwiSchemaSha256: sha256Buffer(schemaBytes),
    version: JSON.parse(versionEntry.getData().toString('utf8')),
  };
}

function decodeArchive(inspected, filePath) {
  const raw = inspected.documentEntry.getData();
  const markerIndex = raw.indexOf(ZSTD_MARKER);
  if (markerIndex < 0) throw new Error(`Zstandard marker not found in ${filePath}`);
  const compressedOffset = markerIndex + ZSTD_MARKER.length;
  const decompressed = decompress(raw.subarray(compressedOffset));
  const schemaAst = kiwi.decodeBinarySchema(new Uint8Array(inspected.schemaBytes));
  const compiled = kiwi.compileSchema(schemaAst);
  const message = compiled.decodePixsoMsg(decompressed);
  return {
    ...inspected,
    message,
    compressedBytes: raw.length - compressedOffset,
    decompressedBytes: decompressed.length,
    schemaDefinitionCount: schemaAst.definitions.length,
  };
}

function decodePixso(filePath) {
  return decodeArchive(inspectArchive(filePath), filePath);
}

module.exports = { decodeArchive, decodePixso, inspectArchive };
