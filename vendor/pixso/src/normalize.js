'use strict';

const fs = require('fs');
const path = require('path');
const { jsonSafe, sha256Buffer, stableStringify } = require('./util');

const STATE_PATTERN = /(?:开启|关闭|开|关|激活|选中|未选|默认|按下|禁用|置灰|故障|异常|警告|成功|失败|加载|空状态|深色|浅色|运动|经济|标准|on|off|active|selected|disabled|error|warning|success|loading|default|pressed)/i;

function guid(value) {
  return value && Number.isFinite(value.sessionID) && Number.isFinite(value.localID)
    ? `${value.sessionID}:${value.localID}`
    : null;
}

function entityId(sourceId, kind, physicalId) {
  return `${sourceId}::${kind}::${physicalId}`;
}

function classifyBoard(name, pageName, sourceRole) {
  const value = `${pageName || ''} ${name || ''}`;
  let boardKind = 'unknown';
  let confidence = 0.45;
  let rule = 'fallback_unknown';
  if (/更新记录|变更记录|修改日志|change\s*log/i.test(value)) {
    [boardKind, confidence, rule] = ['change_log', 0.99, 'name_change_log'];
  } else if (/toast|轻提示|吐司/i.test(value)) {
    [boardKind, confidence, rule] = ['toast', 0.9, 'name_toast'];
  } else if (/弹窗|对话框|dialog|popup|overlay|浮层/i.test(value)) {
    [boardKind, confidence, rule] = ['overlay', 0.88, 'name_overlay'];
  } else if (/标注|说明|annotation|设计注释/i.test(value)) {
    [boardKind, confidence, rule] = ['design_annotation', 0.82, 'name_annotation'];
  } else if (/图标|素材|asset|icon/i.test(value)) {
    [boardKind, confidence, rule] = ['asset_sheet', 0.78, 'name_asset_sheet'];
  } else if (/组件|控件|规范|component|spec/i.test(value)) {
    [boardKind, confidence, rule] = ['component_spec', 0.76, 'name_component_spec'];
  } else if (sourceRole === 'component_library') {
    [boardKind, confidence, rule] = ['component_library', 0.68, 'source_role_component_library'];
  } else if (STATE_PATTERN.test(name || '')) {
    [boardKind, confidence, rule] = ['state_variant', 0.62, 'state_token_in_name'];
  } else if (sourceRole === 'product_design') {
    [boardKind, confidence, rule] = ['runtime_screen', 0.55, 'product_design_top_level_frame'];
  }
  return {
    board_kind: boardKind,
    method: `deterministic_rule:${rule}`,
    confidence_for_queue_only: confidence,
    review_status: 'candidate',
  };
}

function affine(node) {
  const value = node?.transform || {};
  return [
    Number.isFinite(value.m00) ? value.m00 : 1,
    Number.isFinite(value.m01) ? value.m01 : 0,
    Number.isFinite(value.m02) ? value.m02 : 0,
    Number.isFinite(value.m10) ? value.m10 : 0,
    Number.isFinite(value.m11) ? value.m11 : 1,
    Number.isFinite(value.m12) ? value.m12 : 0,
  ];
}

function multiply(a, b) {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

function boxFrom(node, matrix) {
  const width = Number.isFinite(node?.size?.x) ? node.size.x : null;
  const height = Number.isFinite(node?.size?.y) ? node.size.y : null;
  if (width === null || height === null) return null;
  const points = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => ({
    x: matrix[0] * x + matrix[1] * y + matrix[2],
    y: matrix[3] * x + matrix[4] * y + matrix[5],
  }));
  const xs = points.map(item => item.x);
  const ys = points.map(item => item.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function guidPath(value) {
  return (value?.guidPath?.guids || []).map(guid).filter(Boolean);
}

function semanticClass(node) {
  if (['CANVAS', 'FRAME', 'TEXT', 'SYMBOL', 'INSTANCE'].includes(node.type)) return 'semantic';
  if (node.name && STATE_PATTERN.test(node.name)) return 'semantic_candidate';
  return 'decorative_or_low_frequency';
}

function stripHeavyInstanceData(node) {
  const copy = { ...node };
  delete copy.derivedSymbolData;
  if (copy.symbolData) {
    copy.symbolData = { ...copy.symbolData };
    delete copy.symbolData.symbolOverrides;
  }
  return jsonSafe(copy);
}

function imageHash(value) {
  if (!value?.hash) return null;
  return Buffer.from(value.hash).toString('hex').toLowerCase();
}

function collectImageHashes(node) {
  const output = new Set();
  for (const field of ['fillPaints', 'strokePaints', 'backgroundPaints']) {
    for (const paint of node?.[field] || []) {
      for (const key of ['image', 'imageThumbnail', 'animatedImage', 'video']) {
        const hash = imageHash(paint?.[key]);
        if (hash) output.add(hash);
      }
    }
  }
  return [...output].sort();
}

function mediaType(entryName) {
  const ext = path.extname(entryName).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'application/octet-stream';
}

function storeObject(buffer, objectRoot) {
  const digest = sha256Buffer(buffer);
  const target = path.join(objectRoot, digest.slice(0, 2), digest);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, buffer, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return { digest, target };
}

function normalizePixso(decoded, source, options) {
  const sourceId = source.logical_file_id;
  const sourceSha256 = source.actual_sha256.toLowerCase();
  const nodes = decoded.message.pixsoNodes || [];
  const nodeMap = new Map(nodes.map(node => [guid(node.guid), node]));
  const parentMap = new Map(nodes.map(node => [guid(node.guid), guid(node.parentIndex?.guid)]));
  const children = new Map();
  for (const node of nodes) {
    const parentId = guid(node.parentIndex?.guid);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(node);
  }

  const pages = nodes.filter(node => node.type === 'CANVAS').map(node => ({
    record_type: 'page', source_id: sourceId, source_sha256: sourceSha256,
    entity_id: entityId(sourceId, 'page', guid(node.guid)), page_id: guid(node.guid),
    name: node.name || '', internal: /internal only/i.test(node.name || ''),
  }));
  const pageById = new Map(pages.map(item => [item.page_id, item]));
  const boardNodes = [];
  for (const page of pages) {
    for (const child of children.get(page.page_id) || []) if (child.type === 'FRAME') boardNodes.push({ node: child, page });
  }
  const boards = boardNodes.map(({ node, page }) => ({
    record_type: 'board', source_id: sourceId, source_sha256: sourceSha256,
    entity_id: entityId(sourceId, 'board', guid(node.guid)), board_id: guid(node.guid),
    page_id: page.page_id, name: node.name || '', visible: node.visible !== false,
    size: { width: node.size?.x ?? null, height: node.size?.y ?? null },
    classification: classifyBoard(node.name || '', page.name, source.role),
    visual_evidence: { render_type: 'unavailable', source: 'offline_structure_only' },
  }));
  const boardById = new Map(boards.map(item => [item.board_id, item]));

  const locationMemo = new Map();
  function location(nodeId) {
    if (locationMemo.has(nodeId)) return locationMemo.get(nodeId);
    const seen = new Set();
    let current = nodeId;
    let pageId = null;
    let boardId = null;
    while (current && current !== '0:0' && !seen.has(current)) {
      seen.add(current);
      if (!boardId && boardById.has(current)) boardId = current;
      if (pageById.has(current)) { pageId = current; break; }
      current = parentMap.get(current);
    }
    const result = { pageId, boardId };
    locationMemo.set(nodeId, result);
    return result;
  }

  const matrixMemo = new Map();
  function absoluteMatrix(nodeId, active = new Set()) {
    if (matrixMemo.has(nodeId)) return matrixMemo.get(nodeId);
    if (active.has(nodeId)) return [1, 0, 0, 0, 1, 0];
    active.add(nodeId);
    const node = nodeMap.get(nodeId);
    const parentId = parentMap.get(nodeId);
    const local = affine(node);
    const result = parentId && parentId !== '0:0' && nodeMap.has(parentId)
      ? multiply(absoluteMatrix(parentId, active), local)
      : local;
    active.delete(nodeId);
    matrixMemo.set(nodeId, result);
    return result;
  }

  const payloadMap = new Map();
  const nodeRecords = [];
  const edgeRecords = [];
  const componentRecords = [];
  const instanceRecords = [];
  const overrideRecords = [];
  const textRecords = [];
  const styleRecords = [];
  const findings = [];
  let derivedNodeCount = 0;

  for (const page of pages) edgeRecords.push({
    record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
    edge_id: `${sourceId}::edge::page_representation::${page.page_id}`,
    from: page.entity_id, edge_type: 'represented_by', to: entityId(sourceId, 'node', page.page_id),
  });
  for (const board of boards) edgeRecords.push(
    {
      record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
      edge_id: `${sourceId}::edge::page_board::${board.page_id}::${board.board_id}`,
      from: entityId(sourceId, 'page', board.page_id), edge_type: 'contains_board', to: board.entity_id,
    },
    {
      record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
      edge_id: `${sourceId}::edge::board_representation::${board.board_id}`,
      from: board.entity_id, edge_type: 'represented_by', to: entityId(sourceId, 'node', board.board_id),
    },
  );

  for (const node of nodes) {
    const nodeId = guid(node.guid);
    if (!nodeId) continue;
    const parentId = guid(node.parentIndex?.guid);
    const loc = location(nodeId);
    const matrix = absoluteMatrix(nodeId);
    const payload = stripHeavyInstanceData(node);
    const payloadJson = stableStringify(payload);
    const payloadSha256 = sha256Buffer(Buffer.from(payloadJson, 'utf8'));
    if (!payloadMap.has(payloadSha256)) payloadMap.set(payloadSha256, { payload_sha256: payloadSha256, payload });
    const localBox = node.size ? { x: node.transform?.m02 ?? 0, y: node.transform?.m12 ?? 0, width: node.size.x, height: node.size.y } : null;
    const record = {
      record_type: 'node', source_id: sourceId, source_sha256: sourceSha256,
      entity_id: entityId(sourceId, 'node', nodeId), node_id: nodeId,
      node_type: node.type || 'UNKNOWN', name: node.name || '', parent_id: parentId,
      page_id: loc.pageId, board_id: loc.boardId, visible: node.visible !== false,
      opacity: node.opacity ?? 1, semantic_class: semanticClass(node),
      local_box: localBox, absolute_box: boxFrom(node, matrix), component_key: node.componentKey || null,
      raw_payload_sha256: payloadSha256, image_hash_refs: collectImageHashes(node),
    };
    nodeRecords.push(record);
    if (parentId && parentId !== '0:0') edgeRecords.push({
      record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
      edge_id: `${sourceId}::edge::parent::${parentId}::${nodeId}`,
      from: entityId(sourceId, 'node', parentId), edge_type: 'parent_of', to: record.entity_id,
    });

    if (node.type === 'TEXT' && node.textData?.characters?.trim()) textRecords.push({
      record_type: 'text', source_id: sourceId, source_sha256: sourceSha256,
      text_id: `${sourceId}::text::${nodeId}`, node_id: nodeId, entity_id: record.entity_id,
      page_id: loc.pageId, board_id: loc.boardId, text: node.textData.characters.trim(),
      origin: 'primary_node', font_family: node.fontName?.family || null,
      font_style: node.fontName?.style || null, font_size: node.fontSize ?? null,
    });

    if (node.type === 'SYMBOL' || node.componentKey || (node.componentPropDef || []).length) {
      const componentId = entityId(sourceId, 'component', nodeId);
      componentRecords.push({
        record_type: 'component', source_id: sourceId, source_sha256: sourceSha256,
        component_id: componentId, node_id: nodeId,
        name: node.name || '', component_key: node.componentKey || null,
        publish_file: node.publishFile || null, publish_id: node.publishID || null,
        component_prop_defs: jsonSafe(node.componentPropDef || []),
      });
      edgeRecords.push({
        record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
        edge_id: `${sourceId}::edge::component_representation::${nodeId}`,
        from: componentId, edge_type: 'represented_by', to: record.entity_id,
      });
    }

    if (node.type === 'INSTANCE') {
      const symbolId = guid(node.symbolData?.symbolID);
      const instanceId = entityId(sourceId, 'instance', nodeId);
      const instanceOf = symbolId ? entityId(sourceId, 'component', symbolId) : null;
      instanceRecords.push({
        record_type: 'instance', source_id: sourceId, source_sha256: sourceSha256,
        instance_id: instanceId, node_id: nodeId, name: node.name || '',
        instance_of: instanceOf, symbol_node_id: symbolId,
        transform: jsonSafe(node.transform || null), override_count: (node.symbolData?.symbolOverrides || []).length,
        derived_node_count: (node.derivedSymbolData || []).length,
      });
      edgeRecords.push({
        record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
        edge_id: `${sourceId}::edge::instance_representation::${nodeId}`,
        from: instanceId, edge_type: 'represented_by', to: record.entity_id,
      });
      if (instanceOf) edgeRecords.push({
        record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
        edge_id: `${sourceId}::edge::instance::${nodeId}::${symbolId}`,
        from: instanceId, edge_type: 'instance_of', to: instanceOf,
      });
      if (symbolId && !nodeMap.has(symbolId)) findings.push({
        finding_type: 'external_or_unresolved_component', instance_id: instanceId,
        symbol_node_id: symbolId, affected_node_id: nodeId, status: 'open',
      });
      for (const [index, override] of (node.symbolData?.symbolOverrides || []).entries()) {
        const pathIds = guidPath(override);
        const patch = { ...override };
        delete patch.guidPath;
        const safePatch = jsonSafe(patch);
        const patchDigest = sha256Buffer(Buffer.from(stableStringify(safePatch), 'utf8'));
        overrideRecords.push({
          record_type: 'override', source_id: sourceId, source_sha256: sourceSha256,
          override_id: `${instanceId}::override::${index}::${patchDigest.slice(0, 16)}`,
          instance_id: instanceId, guid_path: pathIds, patch: safePatch, patch_sha256: patchDigest,
        });
      }
      const effectiveSeen = new Set();
      function collectEffective(items) {
        for (const item of items || []) {
          derivedNodeCount += 1;
          const text = item?.textData?.characters?.trim();
          const ids = guidPath(item);
          if (text) {
            const key = `${ids.join('/')}:${text}`;
            if (!effectiveSeen.has(key)) {
              effectiveSeen.add(key);
              textRecords.push({
                record_type: 'text', source_id: sourceId, source_sha256: sourceSha256,
                text_id: `${instanceId}::effective_text::${sha256Buffer(Buffer.from(key, 'utf8')).slice(0, 20)}`,
                node_id: ids.at(-1) || null, entity_id: instanceId, page_id: loc.pageId, board_id: loc.boardId,
                text, origin: 'instance_effective', guid_path: ids,
              });
            }
          }
          collectEffective(item?.derivedSymbolData);
        }
      }
      collectEffective(node.derivedSymbolData);
    }

    if (node.styleType !== undefined || node.sharedStyleMasterData !== undefined || node.sharedStyleReference !== undefined) styleRecords.push({
      record_type: 'style', source_id: sourceId, source_sha256: sourceSha256,
      style_id: `${sourceId}::style::${nodeId}`, node_id: nodeId, name: node.name || '',
      style_type: node.styleType ?? null, master: jsonSafe(node.sharedStyleMasterData ?? null),
      reference: jsonSafe(node.sharedStyleReference ?? null),
    });
  }

  const assetRecords = [];
  const assetByPixsoHash = new Map();
  for (const entry of decoded.archive.getEntries()) {
    if (entry.isDirectory || !/\.(png|jpe?g|webp|gif)$/i.test(entry.entryName) || /\.thumb\.png$/i.test(entry.entryName)) continue;
    const buffer = entry.getData();
    const stored = storeObject(buffer, options.objectRoot);
    const pixsoHash = path.basename(entry.entryName, path.extname(entry.entryName)).toLowerCase();
    const record = {
      record_type: 'asset', source_id: sourceId, source_sha256: sourceSha256,
      asset_id: `${sourceId}::asset::${pixsoHash}`, pixso_hash: pixsoHash,
      entry_name: entry.entryName, media_type: mediaType(entry.entryName), bytes: buffer.length,
      object_sha256: stored.digest, object_ref: path.relative(options.storeRoot, stored.target).split(path.sep).join('/'),
    };
    assetRecords.push(record);
    assetByPixsoHash.set(pixsoHash, record);
  }

  for (const node of nodeRecords) for (const hash of node.image_hash_refs) {
    const asset = assetByPixsoHash.get(hash);
    if (!asset) continue;
    edgeRecords.push({
      record_type: 'edge', source_id: sourceId, source_sha256: sourceSha256,
      edge_id: `${sourceId}::edge::asset::${node.node_id}::${hash}`,
      from: node.entity_id, edge_type: 'uses_asset', to: asset.asset_id,
    });
  }

  const blobRecords = [];
  for (const [index, blob] of (decoded.message.blobs || []).entries()) {
    const buffer = Buffer.from(blob?.bytes || []);
    const stored = storeObject(buffer, options.objectRoot);
    blobRecords.push({
      record_type: 'blob', source_id: sourceId, source_sha256: sourceSha256,
      blob_id: `${sourceId}::blob::${index}`, blob_index: index, bytes: buffer.length,
      object_sha256: stored.digest, object_ref: path.relative(options.storeRoot, stored.target).split(path.sep).join('/'),
    });
  }

  const screenCards = boards.map(board => ({
    schema_id: 'screen-card/v1', screen_id: board.entity_id, source_id: sourceId,
    source_sha256: sourceSha256, page_id: board.page_id, board_id: board.board_id,
    name: board.name, classification: board.classification, observed: { size: board.size, visible: board.visible },
    state_projection: { constraints: [], unspecified: [] },
    visual_evidence: board.visual_evidence,
    evidence_anchor: { locator_type: 'pixso_node', locator: board.board_id, snapshot_digest: sourceSha256 },
    review_status: 'candidate',
  }));

  const productAtlas = {
    schema_id: 'pixso-product-atlas/v1', source_id: sourceId, source_sha256: sourceSha256,
    project: options.project, role: source.role,
    pages: pages.map(page => ({ page_id: page.page_id, name: page.name, internal: page.internal,
      board_count: boards.filter(board => board.page_id === page.page_id).length })),
    board_kind_counts: Object.fromEntries([...new Set(boards.map(board => board.classification.board_kind))].sort().map(kind => [kind, boards.filter(board => board.classification.board_kind === kind).length])),
  };

  return {
    records: {
      pages, boards, nodes: nodeRecords, edges: edgeRecords, components: componentRecords,
      instances: instanceRecords, overrides: overrideRecords, texts: textRecords,
      assets: assetRecords, styles: styleRecords, blobs: blobRecords,
      node_payloads: [...payloadMap.values()].sort((a, b) => a.payload_sha256.localeCompare(b.payload_sha256)),
      screen_cards: screenCards,
    },
    productAtlas,
    findings,
    stats: {
      page_count: pages.filter(page => !page.internal).length,
      internal_page_count: pages.filter(page => page.internal).length,
      top_level_board_count: boards.length,
      node_count: nodeRecords.length,
      edge_count: edgeRecords.length,
      component_count: componentRecords.length,
      instance_count: instanceRecords.length,
      override_count: overrideRecords.length,
      derived_node_observed_count: derivedNodeCount,
      text_record_count: textRecords.length,
      unique_text_count: new Set(textRecords.map(item => item.text)).size,
      asset_count: assetRecords.length,
      blob_count: blobRecords.length,
      style_count: styleRecords.length,
      unresolved_component_count: findings.filter(item => item.finding_type === 'external_or_unresolved_component').length,
      prototype_interaction_count: nodes.reduce((sum, node) => sum + (node.prototypeInteractions || []).length, 0),
    },
  };
}

module.exports = { classifyBoard, entityId, guid, normalizePixso };
