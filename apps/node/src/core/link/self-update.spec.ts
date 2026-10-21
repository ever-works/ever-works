import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../capabilities';
import { createLogger, type LogEntry } from '../logger';
import {
	SELF_UPDATE_RETRY_LADDER_MS,
	SelfUpdateController,
	classifyNodeInstall,
	detectNodeInstall,
	readSelfUpdateRecord,
	selfUpdateRecordPath,
	selfUpdateTarget,
	writeSelfUpdateRecord,
	type NodeInstall,
	type SelfUpdateRecord
} from './self-update';

/**
 * Fleet node link (FL-02, T-25, spec S12, FR-37, FR-38, U16) — the opt-in
 * self-update: what it targets, which installs it will touch, the retry
 * ladder, and that a failure keeps the old version running and is reported.
 */

const NPM_ROOT = '/usr/lib/node_modules';
const ENTRY = '/usr/lib/node_modules/ever-works-node/dist/cli.js';

function logs() {
	const entries: LogEntry[] = [];
	return { entries, logger: createLogger({ sink: (entry) => entries.push(entry) }) };
}

function runnerWith(answers: Record<string, { code: number | null; stdout?: string; timedOut?: boolean }>) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner: CommandRunner = {
		run: async (command, args) => {
			calls.push({ command, args });
			const answer = answers[`${command} ${args.join(' ')}`] ?? { code: 127 };
			return {
				code: answer.code,
				stdout: answer.stdout ?? '',
				stderr: 'secret local path /home/alice',
				...(answer.timedOut ? { timedOut: true } : {})
			};
		}
	};
	return { calls, runner };
}

function controller(
	over: Partial<ConstructorParameters<typeof SelfUpdateController>[0]> & { install?: NodeInstall } = {}
) {
	const { entries, logger } = logs();
	const { calls, runner } = runnerWith({
		'npm install -g ever-works-node@0.3.0': { code: 0 },
		'npm install -g ever-works-node@latest': { code: 0 }
	});
	const restart = vi.fn();
	const persisted: SelfUpdateRecord[] = [];
	let now = Date.parse('2026-10-21T09:00:00.000Z');
	const instance = new SelfUpdateController({
		enabled: true,
		currentVersion: '0.2.1',
		runner,
		logger,
		platform: 'linux',
		entryPath: ENTRY,
		isIdle: () => true,
		requestRestart: restart,
		persist: (record) => {
			persisted.push(record);
		},
		now: () => now,
		detectInstall: async () => over.install ?? { kind: 'npm-global', root: NPM_ROOT },
		...over
	});
	return {
		instance,
		entries,
		calls,
		restart,
		persisted,
		advance: (ms: number) => {
			now += ms;
		}
	};
}

describe('selfUpdateTarget', () => {
	it('installs the recommended version when it is above this daemon', () => {
		expect(selfUpdateTarget('0.2.1', { recommendedNodeVersion: '0.3.0' })).toBe('0.3.0');
		expect(selfUpdateTarget('0.3.0', { recommendedNodeVersion: '0.3.0' })).toBeNull();
	});

	it('installs latest when below the floor with no usable recommended version', () => {
		expect(selfUpdateTarget('0.2.1', { minNodeVersion: '0.3.0', upgradeRequired: true })).toBe('latest');
		// A recommended version below the floor is not usable.
		expect(
			selfUpdateTarget('0.2.1', {
				minNodeVersion: '0.3.0',
				upgradeRequired: true,
				recommendedNodeVersion: '0.2.5'
			})
		).toBe('latest');
	});

	it('does nothing for a current daemon or one whose version cannot be compared (fails open)', () => {
		expect(selfUpdateTarget('0.3.0', { minNodeVersion: '0.3.0', upgradeRequired: false })).toBeNull();
		expect(selfUpdateTarget('dev', { minNodeVersion: '0.3.0', upgradeRequired: true })).toBeNull();
	});
});

describe('classifyNodeInstall', () => {
	it('recognises an npm global install', () => {
		expect(classifyNodeInstall(ENTRY, NPM_ROOT, 'linux')).toEqual({ kind: 'npm-global', root: NPM_ROOT });
		expect(
			classifyNodeInstall(
				'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\ever-works-node\\dist\\cli.js',
				'C:\\Users\\A\\AppData\\Roaming\\npm\\node_modules',
				'win32'
			).kind
		).toBe('npm-global');
	});

	it('refuses a checkout and anything it cannot identify', () => {
		expect(classifyNodeInstall('/src/ever-works/apps/node/dist/cli.js', NPM_ROOT, 'linux')).toEqual({
			kind: 'checkout'
		});
		expect(classifyNodeInstall('/opt/custom/ever-works-node/cli.js', NPM_ROOT, 'linux').kind).toBe('unknown');
		expect(classifyNodeInstall(null, NPM_ROOT, 'linux').kind).toBe('unknown');
	});

	it('asks npm for its global root', async () => {
		const { runner } = runnerWith({ 'npm root -g': { code: 0, stdout: `${NPM_ROOT}\n` } });
		expect(await detectNodeInstall({ entryPath: ENTRY, runner, platform: 'linux' })).toEqual({
			kind: 'npm-global',
			root: NPM_ROOT
		});
		const missing = runnerWith({});
		expect((await detectNodeInstall({ entryPath: ENTRY, runner: missing.runner, platform: 'linux' })).kind).toBe(
			'unknown'
		);
	});
});

describe('SelfUpdateController', () => {
	it('installs the target, records it and asks for a restart (S12)', async () => {
		const c = controller();
		expect(await c.instance.attempt('0.3.0')).toBe('updated');
		expect(c.calls).toContainEqual({ command: 'npm', args: ['install', '-g', 'ever-works-node@0.3.0'] });
		expect(c.persisted).toEqual([
			expect.objectContaining({ outcome: 'updated', fromVersion: '0.2.1', targetVersion: '0.3.0' })
		]);
		expect(c.restart).toHaveBeenCalledWith('0.3.0');
		expect(c.instance.busy).toBe(true);
	});

	it('only reports when --auto-update is off (FR-38)', () => {
		const c = controller({ enabled: false });
		c.instance.onHeartbeat({ recommendedNodeVersion: '0.3.0' });
		expect(c.calls).toEqual([]);
		expect(c.instance.report()).toMatchObject({ enabled: false, failedAt: null });
	});

	it('waits while a job runs — it never kills work', () => {
		let idle = false;
		const c = controller({ isIdle: () => idle });
		c.instance.onHeartbeat({ recommendedNodeVersion: '0.3.0' });
		expect(c.calls).toEqual([]);
		idle = true;
		c.instance.onHeartbeat({ recommendedNodeVersion: '0.3.0' });
		expect(c.instance.busy).toBe(true);
	});

	it('refuses an unknown installer and a checkout, keeping the old version (U16)', async () => {
		const unknown = controller({ install: { kind: 'unknown', detail: 'not an `npm install -g` install' } });
		expect(await unknown.instance.attempt('0.3.0')).toBe('failed');
		expect(unknown.calls).toEqual([]);
		expect(unknown.restart).not.toHaveBeenCalled();
		expect(unknown.instance.report()).toMatchObject({
			enabled: true,
			targetVersion: '0.3.0',
			error: 'installer unknown: not an `npm install -g` install'
		});

		const checkout = controller({ install: { kind: 'checkout' } });
		expect(await checkout.instance.attempt('0.3.0')).toBe('failed');
		expect(checkout.instance.report().error).toContain('monorepo checkout');
	});

	it('keeps the old version on a failed install, reports a short class of failure and logs once', async () => {
		const { runner } = runnerWith({ 'npm install -g ever-works-node@0.3.0': { code: 1 } });
		const c = controller({ runner });
		expect(await c.instance.attempt('0.3.0')).toBe('failed');
		expect(c.restart).not.toHaveBeenCalled();
		const report = c.instance.report();
		expect(report.error).toBe('npm install exited 1');
		// Never the installer's own output.
		expect(JSON.stringify(report)).not.toContain('/home/alice');
		expect(report.failedAt).toBe('2026-10-21T09:00:00.000Z');
		expect(c.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
		expect(c.persisted.at(-1)).toMatchObject({ outcome: 'failed', error: 'npm install exited 1' });
	});

	it('retries the same target on the ladder, and a new target at once', async () => {
		const { runner, calls } = runnerWith({ 'npm install -g ever-works-node@0.3.0': { code: 1 } });
		const c = controller({ runner });
		await c.instance.attempt('0.3.0');
		const installs = () => calls.filter((call) => call.args[0] === 'install').length;
		expect(installs()).toBe(1);

		c.instance.onHeartbeat({ recommendedNodeVersion: '0.3.0' });
		expect(installs()).toBe(1);
		c.advance(SELF_UPDATE_RETRY_LADDER_MS[0]);
		c.instance.onHeartbeat({ recommendedNodeVersion: '0.3.0' });
		await vi.waitFor(() => expect(installs()).toBe(2));
		await vi.waitFor(() => expect(c.instance.busy).toBe(false));

		// The second failure waits the second rung.
		c.advance(SELF_UPDATE_RETRY_LADDER_MS[0]);
		c.instance.onHeartbeat({ recommendedNodeVersion: '0.3.0' });
		expect(installs()).toBe(2);

		// A different target is tried at once.
		c.instance.onHeartbeat({ recommendedNodeVersion: '0.3.1' });
		await vi.waitFor(() => expect(installs()).toBe(3));
	});

	it('reads the previous process’s record: a completed update is logged and reported', () => {
		const c = controller({
			currentVersion: '0.3.0',
			previous: {
				version: 1,
				outcome: 'updated',
				at: '2026-10-21T08:59:00.000Z',
				fromVersion: '0.2.1',
				targetVersion: '0.3.0'
			}
		});
		expect(c.instance.report()).toMatchObject({ updatedAt: '2026-10-21T08:59:00.000Z', fromVersion: '0.2.1' });
		expect(c.entries.some((entry) => entry.message.includes('0.2.1 → 0.3.0'))).toBe(true);
	});

	it('reports an update that did not take (still the old version after the restart)', () => {
		const c = controller({
			previous: {
				version: 1,
				outcome: 'updated',
				at: '2026-10-21T08:59:00.000Z',
				fromVersion: '0.2.1',
				targetVersion: '0.3.0'
			}
		});
		expect(c.instance.report().error).toContain('still runs 0.2.1');
	});
});

describe('the self-update record', () => {
	it('round-trips beside the config and reads junk as nothing', async () => {
		const files = new Map<string, string>();
		const fs = {
			readFile: async (path: string) => files.get(path) ?? null,
			writeFile: async (path: string, content: string) => {
				files.set(path, content);
			}
		};
		const record: SelfUpdateRecord = {
			version: 1,
			outcome: 'failed',
			at: '2026-10-21T09:00:00.000Z',
			fromVersion: '0.2.1',
			targetVersion: '0.3.0',
			error: 'npm install exited 1'
		};
		await writeSelfUpdateRecord(fs, '/etc/node.json', record);
		expect(files.has(selfUpdateRecordPath('/etc/node.json'))).toBe(true);
		expect(await readSelfUpdateRecord(fs, '/etc/node.json')).toEqual(record);
		files.set(selfUpdateRecordPath('/etc/node.json'), '{ not json');
		expect(await readSelfUpdateRecord(fs, '/etc/node.json')).toBeNull();
	});
});
