import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { currentModule, currentConfig } from './scope.js';
import { skillDigests } from './skills.js';

/**
 * A generation run is a list of batches, not one all-or-nothing transaction.
 * Completed batches are persisted as they finish so a later model error or a
 * baseline change cannot discard work that already succeeded, and the points
 * that never produced a case stay visible as pending instead of being filled
 * with a copy of the test point.
 */
export function runsDir(dataRoot, projectId) {
	return path.join(dataRoot, 'artifacts', projectId, currentModule(), 'case-runs');
}

export function startRun(dataRoot, projectId, baseline) {
	const dir = runsDir(dataRoot, projectId);
	fs.mkdirSync(dir, { recursive: true });
	const run = {
		run_id: 'R-' + crypto.randomUUID().slice(0, 8),
		kind: 'cases',
		project: projectId,
		module: currentModule(),
		started_at: new Date().toISOString(),
		baseline_digest: baseline.points_digest,
		baseline,
		skills: skillDigests(),
		config_digest: crypto.createHash('sha256').update(JSON.stringify(currentConfig())).digest('hex').slice(0, 16),
		capabilities: currentConfig().capabilities || [],
		batches: [],
		completed_ids: [],
		failed_ids: [],
		pending_ids: [],
		dropped_details: [],
		stopped: null,
		finished_at: null
	};
	fs.writeFileSync(path.join(dir, run.run_id + '.json'), JSON.stringify(run, null, 1));
	return run;
}

export function recordBatch(dataRoot, projectId, run, batch) {
	const entry = { ...batch, at: new Date().toISOString() };
	run.batches.push(entry);
	if (entry.status === 'ok') run.completed_ids.push(...(entry.point_ids || []));
	run.failed_ids.push(...(entry.failed_points || []).map((failure) => failure.point_id));
	if (entry.status !== 'ok') run.failed_ids.push(...(entry.point_ids || []));
	fs.appendFileSync(path.join(runsDir(dataRoot, projectId), 'batches.jsonl'), JSON.stringify({ run_id: run.run_id, ...entry }) + '\n');
	persist(dataRoot, projectId, run);
	return entry;
}

export function finishRun(dataRoot, projectId, run, { pendingIds, stopped, droppedDetails }) {
	run.pending_ids = pendingIds;
	run.stopped = stopped || null;
	if (Array.isArray(droppedDetails)) run.dropped_details = droppedDetails;
	run.finished_at = new Date().toISOString();
	persist(dataRoot, projectId, run);
	return run;
}

function persist(dataRoot, projectId, run) {
	const file = path.join(runsDir(dataRoot, projectId), run.run_id + '.json');
	fs.writeFileSync(file + '.tmp', JSON.stringify(run, null, 1));
	fs.renameSync(file + '.tmp', file);
}

export function loadRun(dataRoot, projectId, runId) {
	try {
		return JSON.parse(fs.readFileSync(path.join(runsDir(dataRoot, projectId), runId + '.json'), 'utf8'));
	} catch {
		return null;
	}
}

export function listRuns(dataRoot, projectId) {
	const dir = runsDir(dataRoot, projectId);
	try {
		return fs.readdirSync(dir).filter((name) => /^R-.*\.json$/.test(name))
			.map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
			.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
	} catch {
		return [];
	}
}

/** Points still without a case on this baseline: the honest gap list. */
export function pendingPoints(points, cases, pointsDigest, delayed = new Set()) {
	const done = new Set((cases.source_points_digest === pointsDigest ? cases.items : []).map((item) => item.point_id));
	return points.items.filter((point) => !done.has(point.point_id) && !delayed.has(point.point_id)).map((point) => point.point_id);
}