import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getManagedCodexHome } from '../utils/codex-home.js';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args)
}));

vi.mock('../utils/binary-manager.js', () => ({
	ensureBinary: vi.fn().mockResolvedValue('/tmp/codex-generator/bin/codex')
}));

class MockStream extends EventEmitter {
	emitData(value: string): void {
		this.emit('data', Buffer.from(value, 'utf-8'));
	}
}

class MockChildProcess extends EventEmitter {
	readonly stdout = new MockStream();
	readonly stderr = new MockStream();
	killed = false;

	kill = vi.fn(() => {
		this.killed = true;
		this.emit('exit', 0);
		return true;
	});
}

describe('device-auth', () => {
	beforeEach(() => {
		vi.useRealTimers();
		process.env.EVER_WORKS_DATA_DIR = path.join(process.cwd(), '.tmp', 'ever-works-device-auth-test');
		spawnMock.mockReset();
		spawnMock.mockImplementation((command: string, args: string[]) => {
			const child = new MockChildProcess();

			queueMicrotask(() => {
				if (args[0] === '--version') {
					child.emit('exit', 0);
					return;
				}

				if (args[0] === 'login' && args[1] === 'status') {
					child.stderr.emitData('not logged in');
					child.emit('exit', 1);
					return;
				}

				if (args[0] === 'login' && args[1] === '--device-auth') {
					child.stdout.emitData('Open https://auth.openai.com/codex/device\nCode: ABCD-EFGH\n');
				}
			});

			return child;
		});
	});

	afterEach(async () => {
		vi.useRealTimers();
		delete process.env.EVER_WORKS_DATA_DIR;
		await fs
			.rm(path.join(process.cwd(), '.tmp', 'ever-works-device-auth-test'), {
				recursive: true,
				force: true
			})
			.catch(() => undefined);
	});

	it('returns a user-scoped status for managed device auth', async () => {
		const userId = 'user-status';
		const codexHome = getManagedCodexHome(userId);
		await fs.mkdir(codexHome, { recursive: true });
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');

		const { getDeviceAuthStatus } = await import('../device-auth.js');
		const result = await getDeviceAuthStatus(userId);

		expect(result.connected).toBe(true);
		expect(result.scope).toBe('user');
		expect(result.flowType).toBe('device-code');
	});

	it('starts device auth with a managed per-user CODEX_HOME', async () => {
		const userId = 'user-device-auth';
		const codexHome = getManagedCodexHome(userId);

		const { startDeviceAuth } = await import('../device-auth.js');
		const result = await startDeviceAuth(userId);

		expect(result.pending).toBe(true);
		expect(result.scope).toBe('user');
		expect(result.flowType).toBe('device-code');
		expect(result.prompt?.verificationUri).toBe('https://auth.openai.com/codex/device');
		expect(result.prompt?.userCode).toBe('ABCD-EFGH');

		expect(spawnMock).toHaveBeenCalledWith(
			'/tmp/codex-generator/bin/codex',
			['login', '--device-auth'],
			expect.objectContaining({
				env: expect.objectContaining({
					CODEX_HOME: codexHome
				})
			})
		);
	});

	it('expires pending device-auth sessions that are never completed', async () => {
		const userId = 'user-device-auth-expired';
		const { startDeviceAuth, getDeviceAuthStatus } = await import('../device-auth.js');
		const startedAt = Date.now();
		const startResult = await startDeviceAuth(userId);

		expect(startResult.pending).toBe(true);
		expect(startResult.prompt?.userCode).toBe('ABCD-EFGH');

		const loginCallIndex = spawnMock.mock.calls.findIndex(
			(call) => call[1]?.[0] === 'login' && call[1]?.[1] === '--device-auth'
		);
		const loginChild = spawnMock.mock.results[loginCallIndex]?.value as MockChildProcess | undefined;

		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 11 * 60 * 1000);
		const expiredStatus = await getDeviceAuthStatus(userId);
		nowSpy.mockRestore();

		expect(expiredStatus.pending).toBe(false);
		expect(expiredStatus.connected).toBe(false);
		expect(expiredStatus.message).toContain('expired');
		expect(loginChild?.kill).toHaveBeenCalled();
	});
});
