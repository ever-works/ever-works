import { describe, expect, it } from 'vitest';
import type { ManagedServiceOptions, Scheduler, SpawnFn } from './process-manager';
import {
	DEFAULT_BACKOFF_MAX_MS,
	LogRingBuffer,
	ManagedService,
	ProcessManager,
	computeBackoffMs,
	resolveServiceCommand
} from './process-manager';

class FakeStream {
	private listeners: Array<(chunk: unknown) => void> = [];

	on(_event: 'data', listener: (chunk: unknown) => void): void {
		this.listeners.push(listener);
	}

	emit(chunk: string): void {
		for (const listener of this.listeners) {
			listener(chunk);
		}
	}
}

class FakeChild {
	pid = 4321;
	kills: Array<NodeJS.Signals | number | undefined> = [];
	stdout = new FakeStream();
	stderr = new FakeStream();
	private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];

	kill(signal?: NodeJS.Signals | number): boolean {
		this.kills.push(signal);
		return true;
	}

	on(_event: 'exit', listener: (code: number | null, signal: string | null) => void): void {
		this.exitListeners.push(listener);
	}

	exit(code: number | null): void {
		for (const listener of this.exitListeners) {
			listener(code, null);
		}
	}
}

class FakeScheduler implements Scheduler {
	tasks: Array<{ id: number; callback: () => void; ms: number }> = [];
	private nextId = 1;

	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.tasks.push({ id, callback, ms });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks = this.tasks.filter((task) => task.id !== handle);
	}

	fire(index = 0): void {
		const [task] = this.tasks.splice(index, 1);
		task?.callback();
	}
}

function createHarness(overrides: Partial<ManagedServiceOptions> = {}) {
	const scheduler = new FakeScheduler();
	const spawned: FakeChild[] = [];
	const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
	const spawnFn: SpawnFn = (command, args, options) => {
		const child = new FakeChild();
		spawned.push(child);
		spawnCalls.push({ command, args, cwd: options.cwd });
		return child;
	};
	const service = new ManagedService(
		{ id: 'api', command: 'pnpm', args: ['dev:api'], cwd: '/repo', ...overrides },
		{ spawnFn, scheduler, now: () => 1_000 }
	);
	return { service, scheduler, spawned, spawnCalls };
}

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe('computeBackoffMs', () => {
	it('doubles per attempt and caps at the max', () => {
		expect(computeBackoffMs(0, 1_000)).toBe(1_000);
		expect(computeBackoffMs(1, 1_000)).toBe(2_000);
		expect(computeBackoffMs(3, 1_000)).toBe(8_000);
		expect(computeBackoffMs(20, 1_000)).toBe(DEFAULT_BACKOFF_MAX_MS);
	});
});

describe('LogRingBuffer', () => {
	it('drops the oldest entries once capacity is exceeded', () => {
		const buffer = new LogRingBuffer(3);
		for (let index = 0; index < 5; index++) {
			buffer.push({ serviceId: 'api', stream: 'stdout', line: `line-${index}`, at: index });
		}
		expect(buffer.size).toBe(3);
		expect(buffer.toArray().map((entry) => entry.line)).toEqual(['line-2', 'line-3', 'line-4']);
	});
});

describe('ManagedService', () => {
	it('spawns with the configured command and becomes running without a ready pattern', () => {
		const { service, spawnCalls } = createHarness();
		service.start();
		expect(spawnCalls).toEqual([{ command: 'pnpm', args: ['dev:api'], cwd: '/repo' }]);
		expect(service.status().state).toBe('running');
		expect(service.status().pid).toBe(4321);
	});

	it('waits for the ready pattern before reporting running', () => {
		const { service, spawned } = createHarness({ readyPattern: /successfully started/ });
		service.start();
		expect(service.status().state).toBe('starting');
		spawned[0].stdout.emit('booting...\n');
		expect(service.status().state).toBe('starting');
		spawned[0].stdout.emit('Nest application successfully started\n');
		expect(service.status().state).toBe('running');
	});

	it('captures stdout and stderr lines in the ring buffer with stream tags', () => {
		const { service, spawned } = createHarness();
		service.start();
		spawned[0].stdout.emit('hello\nworld\n');
		spawned[0].stderr.emit('oops\n');
		const lines = service.logs.toArray().map((entry) => `${entry.stream}:${entry.line}`);
		expect(lines).toEqual(['stdout:hello', 'stdout:world', 'stderr:oops']);
	});

	it('stops gracefully: SIGTERM, then stopped once the process exits (no SIGKILL)', async () => {
		const { service, spawned, scheduler } = createHarness();
		service.start();
		const stopPromise = service.stop();
		expect(service.status().state).toBe('stopping');
		expect(spawned[0].kills).toEqual(['SIGTERM']);
		expect(scheduler.tasks).toHaveLength(1); // pending SIGKILL escalation
		spawned[0].exit(0);
		await stopPromise;
		expect(service.status().state).toBe('stopped');
		expect(spawned[0].kills).toEqual(['SIGTERM']);
		expect(scheduler.tasks).toHaveLength(0); // escalation cancelled
	});

	it('escalates to SIGKILL when graceful shutdown times out', async () => {
		const { service, spawned, scheduler } = createHarness({ gracefulTimeoutMs: 5_000 });
		service.start();
		const stopPromise = service.stop();
		expect(scheduler.tasks[0]?.ms).toBe(5_000);
		scheduler.fire();
		expect(spawned[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
		spawned[0].exit(null);
		await stopPromise;
		expect(service.status().state).toBe('stopped');
	});

	it('restarts on crash with exponential backoff', () => {
		const { service, spawned, spawnCalls, scheduler } = createHarness({ backoffBaseMs: 1_000 });
		service.start();
		spawned[0].exit(1);
		expect(service.status().state).toBe('restarting');
		expect(service.status().restarts).toBe(1);
		expect(service.status().lastExitCode).toBe(1);
		expect(scheduler.tasks[0]?.ms).toBe(1_000);

		scheduler.fire();
		expect(spawnCalls).toHaveLength(2);
		expect(service.status().state).toBe('running');

		spawned[1].exit(1);
		expect(scheduler.tasks[0]?.ms).toBe(2_000); // doubled backoff
	});

	it('gives up after maxRestarts and reports failed', () => {
		const { service, spawned, scheduler } = createHarness({ maxRestarts: 1 });
		service.start();
		spawned[0].exit(1);
		scheduler.fire();
		spawned[1].exit(1);
		expect(service.status().state).toBe('failed');
		expect(scheduler.tasks).toHaveLength(0);
	});

	it('does not restart when restartOnCrash is disabled', () => {
		const { service, spawned, scheduler } = createHarness({ restartOnCrash: false });
		service.start();
		spawned[0].exit(1);
		expect(service.status().state).toBe('failed');
		expect(scheduler.tasks).toHaveLength(0);
	});

	it('cancels a pending crash-restart when stopped', async () => {
		const { service, spawned, scheduler } = createHarness();
		service.start();
		spawned[0].exit(1);
		expect(service.status().state).toBe('restarting');
		await service.stop();
		expect(service.status().state).toBe('stopped');
		expect(scheduler.tasks).toHaveLength(0);
	});
});

describe('resolveServiceCommand', () => {
	const join = (...segments: string[]) => segments.join('/');

	it('prefers the built API entrypoint when present, else the dev script', () => {
		expect(resolveServiceCommand('api', '/repo', (path) => path === '/repo/apps/api/dist/main.js', join)).toEqual({
			command: 'node',
			args: ['dist/main.js'],
			cwd: '/repo/apps/api'
		});
		expect(resolveServiceCommand('api', '/repo', () => false, join)).toEqual({
			command: 'pnpm',
			args: ['dev:api'],
			cwd: '/repo'
		});
	});

	it('prefers next start when a web build exists, else the dev script', () => {
		expect(resolveServiceCommand('web', '/repo', (path) => path === '/repo/apps/web/.next/BUILD_ID', join)).toEqual(
			{
				command: 'pnpm',
				args: ['--filter', 'ever-works-web', 'start'],
				cwd: '/repo'
			}
		);
		expect(resolveServiceCommand('web', '/repo', () => false, join)).toEqual({
			command: 'pnpm',
			args: ['dev:web'],
			cwd: '/repo'
		});
	});
});

describe('ProcessManager', () => {
	it('stops services in reverse registration order (web before api)', async () => {
		const scheduler = new FakeScheduler();
		const children = new Map<string, FakeChild>();
		const spawnFn: SpawnFn = (_command, args) => {
			const child = new FakeChild();
			children.set(args.join(' '), child);
			return child;
		};
		const manager = new ProcessManager({ spawnFn, scheduler });
		manager.create({ id: 'api', command: 'pnpm', args: ['dev:api'], cwd: '/repo' });
		manager.create({ id: 'web', command: 'pnpm', args: ['dev:web'], cwd: '/repo' });
		manager.startAll();

		const apiChild = children.get('dev:api');
		const webChild = children.get('dev:web');
		const stopAllPromise = manager.stopAll();

		expect(webChild?.kills).toEqual(['SIGTERM']);
		expect(apiChild?.kills).toEqual([]); // api untouched until web is down

		webChild?.exit(0);
		await flush();
		expect(apiChild?.kills).toEqual(['SIGTERM']);

		apiChild?.exit(0);
		await stopAllPromise;
		expect(manager.statuses().every((status) => status.state === 'stopped')).toBe(true);
	});
});
