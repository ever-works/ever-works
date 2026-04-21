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

describe('local-auth', () => {
	beforeEach(() => {
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
		await fs.rm(path.join('/tmp/codex-generator', 'auth'), { recursive: true, force: true }).catch(() => undefined);
	});

	it('returns a managed per-user auth path for local auth status', async () => {
		const userId = 'user-status';
		const codexHome = getManagedCodexHome(userId);
		await fs.mkdir(codexHome, { recursive: true });
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');

		const { getLocalAuthStatus } = await import('../local-auth.js');
		const result = await getLocalAuthStatus(userId);

		expect(result.connected).toBe(true);
		expect(result.authPath).toBe(path.join(codexHome, 'auth.json'));
	});

	it('starts device auth with a managed per-user CODEX_HOME', async () => {
		const userId = 'user-device-auth';
		const codexHome = getManagedCodexHome(userId);

		const { startLocalAuth } = await import('../local-auth.js');
		const result = await startLocalAuth(userId);

		expect(result.pending).toBe(true);
		expect(result.authPath).toBe(path.join(codexHome, 'auth.json'));
		expect(result.verificationUri).toBe('https://auth.openai.com/codex/device');
		expect(result.userCode).toBe('ABCD-EFGH');

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
});
