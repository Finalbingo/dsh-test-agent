/**
 * One writer per project. Two sessions editing the same artefacts would silently
 * overwrite each other; a lock file makes the second caller wait instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const WAIT_MS = 150;
const TIMEOUT_MS = 15000;
const STALE_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockFile(dataRoot, projectId) {
	return path.join(dataRoot, 'locks', `${projectId}.lock`);
}

export async function acquire(dataRoot, projectId) {
	const file = lockFile(dataRoot, projectId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const started = Date.now();
	for (;;) {
		try {
			await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
			return async () => {
				await fs.unlink(file).catch(() => {});
			};
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			const stat = await fs.stat(file).catch(() => null);
			if (stat && Date.now() - stat.mtimeMs > STALE_MS) {
				await fs.unlink(file).catch(() => {});
				continue;
			}
			if (Date.now() - started > TIMEOUT_MS) {
				throw new Error('该项目正在被另一个操作写入，请稍后再试');
			}
			await sleep(WAIT_MS);
		}
	}
}

export async function withLock(dataRoot, projectId, work) {
	const release = await acquire(dataRoot, projectId);
	try {
		return await work();
	} finally {
		await release();
	}
}
