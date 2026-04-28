import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
	spawn: vi.fn()
}));

import { spawn } from 'child_process';
import { executeHermes } from '../utils/process-runner.js';

function createMockChild(exitCode = 0): EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
	killed: boolean;
	kill: ReturnType<typeof vi.fn>;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		killed: boolean;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.killed = false;
	child.kill = vi.fn((signal?: string) => {
		child.killed = true;
		if (signal === 'SIGTERM' || signal === 'SIGKILL') {
			queueMicrotask(() => child.emit('exit', null));
		}
		return true;
	});

	queueMicrotask(() => {
		child.stdout.end();
		child.stderr.end();
		child.emit('exit', exitCode);
	});

	return child;
}

describe('process-runner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('removes the abort listener when Hermes exits naturally', async () => {
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, 'addEventListener');
		const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
		vi.mocked(spawn).mockReturnValueOnce(createMockChild(0) as never);

		const result = await executeHermes({
			binaryPath: 'hermes',
			prompt: 'Return JSON',
			cwd: '/tmp/workspace',
			profile: 'default',
			toolsets: 'web',
			maxTurns: 10,
			yolo: true,
			signal: controller.signal
		}).promise;

		expect(result.exitCode).toBe(0);
		expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
		expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
	});
});
