#!/usr/bin/env node
'use strict';

const path = require('path');
const { compileSourceSet } = require('./compiler');
const { getNode, listPages, listStatus, search, spatialQuery } = require('./query');

function parseArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) result._.push(value);
    else {
      const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const next = values[index + 1];
      if (next === undefined || next.startsWith('--')) result[key] = true;
      else { result[key] = next; index += 1; }
    }
  }
  return result;
}

function required(args, name) {
  if (!args[name]) throw new Error(`Missing required option --${name.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`);
  return args[name];
}

function help() {
  return `Pixso Offline Source Adapter

Commands:
  compile --source-set <json> --store <dir> [--files-only]
  status  --store <dir>
  pages   --store <dir> --source <logical_file_id>
  search  --store <dir> --text <query> [--source <logical_file_id>] [--limit 50]
  node    --store <dir> --source <logical_file_id> --id <session:local|entity_id>
  spatial --store <dir> --source <logical_file_id> --x N --y N --width N --height N [--limit 200]

All command output is JSON, so AI callers can consume it without reopening the .pix archive.`;
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const storeRoot = path.resolve(required(args, 'store'));
  let output;
  if (command === 'compile') output = compileSourceSet({ sourceSetPath: required(args, 'sourceSet'), storeRoot, filesOnly: args.filesOnly });
  else if (command === 'status') output = listStatus(storeRoot);
  else if (command === 'pages') output = listPages(storeRoot, required(args, 'source'));
  else if (command === 'search') output = search(storeRoot, required(args, 'text'), { logicalFileId: args.source, limit: args.limit });
  else if (command === 'node') output = getNode(storeRoot, required(args, 'source'), required(args, 'id'));
  else if (command === 'spatial') output = spatialQuery(storeRoot, required(args, 'source'), {
    x: Number(required(args, 'x')), y: Number(required(args, 'y')),
    width: Number(required(args, 'width')), height: Number(required(args, 'height')),
  }, args.limit || 200);
  else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'error', message: error.message, stack: process.env.DEBUG ? error.stack : undefined }, null, 2)}\n`);
  process.exitCode = 1;
}
