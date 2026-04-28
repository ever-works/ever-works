import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
	spawn: vi.fn()
}));

import { spawn } from 'child_process';
import { ensureBinary, validateProfile } from '../utils/binary-manager.js';

function createMockChild(options?: {
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
}): EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();

	setTimeout(() => {
		if (options?.stdout) {
			child.stdout.write(options.stdout);
		}
		child.stdout.end();

		if (options?.stderr) {
			child.stderr.write(options.stderr);
		}
		child.stderr.end();

		child.emit('exit', options?.exitCode ?? 0);
	}, 0);

	return child;
}

describe('binary-manager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('verifies Hermes binary availability asynchronously', async () => {
		vi.mocked(spawn).mockReturnValueOnce(createMockChild() as never);

		await expect(
			ensureBinary({ profile: 'default', toolsets: 'web,terminal,skills', maxTurns: 90, yolo: true }, console)
		).resolves.toBe('hermes');
		expect(spawn).toHaveBeenCalledWith(
			'hermes',
			['--version'],
			expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
		);
	});

	it('fails validation when the Hermes profile is unavailable', async () => {
		vi.mocked(spawn)
			.mockReturnValueOnce(createMockChild() as never)
			.mockReturnValueOnce(
				createMockChild({
					stderr: 'profile not found',
					exitCode: 1
				}) as never
			);

		await expect(
			validateProfile({ profile: 'missing', toolsets: 'web,terminal,skills', maxTurns: 90, yolo: true }, console)
		).rejects.toThrow('Hermes profile "missing" is not available');
	});
});
