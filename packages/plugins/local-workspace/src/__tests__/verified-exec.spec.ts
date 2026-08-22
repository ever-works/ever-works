import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileWithVerifiedCancellation } from '../verified-exec.js';

const roots: string[] = [];
const ownedPids: number[] = [];

afterEach(async () => {
	for (const pid of ownedPids.splice(0)) {
		if (!isAlive(pid)) continue;
		try {
			if (process.platform === 'win32') {
				execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
			} else {
				process.kill(pid, 'SIGKILL');
			}
		} catch {
			// Best effort for a test-owned process after a failed assertion.
		}
	}
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
	}
});

describe('verified Git/helper process cancellation', () => {
	it('kills and verifies a real parent plus descendant before reporting AbortError', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-git-tree-'));
		roots.push(root);
		const ready = join(root, 'pids.json');
		const script = join(root, 'tree.cjs');
		writeFileSync(
			script,
			`const {spawn}=require('node:child_process');const fs=require('node:fs');` +
				`const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
				`fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`
		);
		const controller = new AbortController();
		const pending = execFileWithVerifiedCancellation(process.execPath, [script], {
			signal: controller.signal,
			maxBuffer: 1024 * 1024
		});

		await expect.poll(() => existsSync(ready), { timeout: 2_500 }).toBe(true);
		const pids = JSON.parse(readFileSync(ready, 'utf8')) as number[];
		ownedPids.push(...pids);
		controller.abort(new Error('test cancellation'));
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await expect.poll(() => pids.every((pid) => !isAlive(pid)), { timeout: 2_500 }).toBe(true);
	});
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}
