import { describe, expect, it, vi } from 'vitest';
import type { HeartbeatState } from 'ever-works-node';
import { startRuntimeInOrder } from './start-order';

/**
 * #2598 a — a desktop node must not lease before a heartbeat has been
 * ACCEPTED: that answer brings the owner's saved limit ceiling (and the
 * version verdict).
 */

type BeatOutcome = 'connected' | 'retrying';

/**
 * A heartbeat loop shaped like `HeartbeatLoop` where it matters here:
 * `start()` resolves after the FIRST attempt whatever its outcome; an
 * accepted beat patches `connected` and THEN runs `onAccepted` (which is
 * where the runtime applies the ceiling), synchronously; `stop()` patches
 * `stopped`.
 */
class FakeLoop {
	private state: HeartbeatState = {
		state: 'idle',
		lastHeartbeatAt: null,
		consecutiveFailures: 0,
		nextAttemptInMs: null,
		lastError: null,
		lastErrorKind: null,
		node: null
	};
	private readonly listeners = new Set<(state: HeartbeatState) => void>();
	ceilingApplied = false;

	constructor(private readonly firstBeat: Promise<BeatOutcome>) {}

	getState(): HeartbeatState {
		return { ...this.state };
	}

	onChange(listener: (state: HeartbeatState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<void> {
		this.beat(await this.firstBeat);
	}

	/** One beat: the state change first, then (when accepted) `onAccepted`. */
	beat(outcome: BeatOutcome): void {
		this.patch(outcome);
		if (outcome === 'connected') this.ceilingApplied = true;
	}

	stop(): void {
		this.patch('stopped');
	}

	private patch(state: HeartbeatState['state']): void {
		this.state = { ...this.state, state };
		for (const listener of [...this.listeners]) listener(this.getState());
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function runtimeWith(loop: FakeLoop) {
	const ceilingSeenByWorker: boolean[] = [];
	const worker = {
		start: vi.fn(async () => {
			ceilingSeenByWorker.push(loop.ceilingApplied);
		})
	};
	return { worker, ceilingSeenByWorker, runtime: { loop, worker } as never };
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('startRuntimeInOrder', () => {
	it('starts the worker only after the first beat is ACCEPTED, with the ceiling already applied', async () => {
		const first = deferred<BeatOutcome>();
		const loop = new FakeLoop(first.promise);
		const { worker, ceilingSeenByWorker, runtime } = runtimeWith(loop);

		const started = startRuntimeInOrder(runtime, () => true);
		await flush();
		expect(worker.start).not.toHaveBeenCalled();

		first.resolve('connected');
		await started;
		expect(worker.start).toHaveBeenCalledTimes(1);
		expect(ceilingSeenByWorker).toEqual([true]);
	});

	it('a FAILED first beat does not start the worker; the first later accepted beat does, exactly once (review)', async () => {
		const loop = new FakeLoop(Promise.resolve('retrying'));
		const { worker, ceilingSeenByWorker, runtime } = runtimeWith(loop);

		const started = startRuntimeInOrder(runtime, () => true);
		await flush();
		expect(worker.start).not.toHaveBeenCalled();

		loop.beat('retrying');
		await flush();
		expect(worker.start).not.toHaveBeenCalled();

		loop.beat('connected');
		await started;
		loop.beat('connected');
		await flush();
		expect(worker.start).toHaveBeenCalledTimes(1);
		expect(ceilingSeenByWorker).toEqual([true]);
	});

	it('never starts the worker of a runtime disconnected during the first beat', async () => {
		const first = deferred<BeatOutcome>();
		const loop = new FakeLoop(first.promise);
		const { worker, runtime } = runtimeWith(loop);
		let current = true;

		const started = startRuntimeInOrder(runtime, () => current);
		current = false; // the operator disconnected while the beat was in flight
		first.resolve('connected');
		await started;

		expect(worker.start).not.toHaveBeenCalled();
	});

	it('a disconnect while waiting out failed beats ends the wait without starting the worker', async () => {
		const loop = new FakeLoop(Promise.resolve('retrying'));
		const { worker, runtime } = runtimeWith(loop);
		let current = true;

		const started = startRuntimeInOrder(runtime, () => current);
		await flush();
		current = false;
		loop.stop(); // what disconnect() does
		await expect(started).resolves.toBeUndefined();
		expect(worker.start).not.toHaveBeenCalled();
	});

	it('a visibility-only runtime (no worker) just starts the heartbeat', async () => {
		const loop = new FakeLoop(Promise.resolve('connected'));
		await expect(startRuntimeInOrder({ loop } as never, () => true)).resolves.toBeUndefined();
		expect(loop.getState().state).toBe('connected');
	});
});
