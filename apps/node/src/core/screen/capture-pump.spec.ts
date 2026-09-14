import { describe, expect, it, vi } from 'vitest';
import {
	COMPUTER_DEGRADE_WINDOW_MS,
	COMPUTER_QUALITY_PRESETS,
	COMPUTER_RECOVER_WINDOW_MS,
	type ComputerNodeToServerFrame
} from '@ever-works/contracts';
import type { Scheduler } from '../heartbeat';
import type { CaptureBackend, CaptureRequest, CaptureSource, CapturedPicture } from './capture-backend';
import { CapturePump, formatNodeLocalTime } from './capture-pump';

/** Timers that fire only when the test says so. */
function manualScheduler(): Scheduler & { pending: () => number } {
	const timers = new Map<number, () => void>();
	let next = 1;
	return {
		setTimeout: (callback) => {
			const id = next++;
			timers.set(id, callback);
			return id;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		pending: () => timers.size
	};
}

function fakeOutbox() {
	const frames: ComputerNodeToServerFrame[] = [];
	const link = { backlog: 0, ackMs: 0 };
	return {
		frames,
		link,
		push: vi.fn((frame: ComputerNodeToServerFrame) => {
			frames.push(frame);
			return true;
		}),
		backlog: () => link.backlog,
		lastAckMs: () => link.ackMs,
		bytesOut: () => 4096
	};
}

function backendWith(capture: (request: CaptureRequest) => Promise<CapturedPicture>) {
	const requests: CaptureRequest[] = [];
	const sources: Array<CaptureSource & { stopped: boolean }> = [];
	const backend: CaptureBackend = {
		id: 'fake',
		isAvailable: () => true,
		start: vi.fn(async () => {
			const source = {
				stopped: false,
				capture: async (request: CaptureRequest) => {
					requests.push(request);
					return capture(request);
				},
				stop: async () => {
					source.stopped = true;
				}
			};
			sources.push(source);
			return source;
		})
	};
	return { backend, requests, sources };
}

const shot = (data = 'AAAA'): CapturedPicture => ({ mime: 'image/jpeg', width: 800, height: 600, data });

describe('formatNodeLocalTime', () => {
	it('writes the machine’s wall clock with its own offset', () => {
		const value = formatNodeLocalTime(new Date('2026-09-13T09:41:07Z'));
		expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
	});
});

describe('CapturePump', () => {
	it('captures at the chosen preset’s width and encoder quality', async () => {
		const { backend, requests } = backendWith(async () => shot());
		const outbox = fakeOutbox();
		const pump = new CapturePump({
			backend,
			profileDir: '/p',
			quality: 'smooth',
			outbox,
			scheduler: manualScheduler()
		});
		await pump.start();
		await pump.tick();
		expect(requests[0]).toEqual({
			width: COMPUTER_QUALITY_PRESETS.smooth.width,
			quality: COMPUTER_QUALITY_PRESETS.smooth.q
		});
		expect(outbox.frames[0]).toMatchObject({ kind: 'frame', seq: 1, keyframe: true, mime: 'image/jpeg' });
		await pump.stop();
	});

	it('does not re-send an unchanged picture until the keyframe interval, but a refresh always sends one', async () => {
		let now = 0;
		const { backend } = backendWith(async () => shot('SAME'));
		const outbox = fakeOutbox();
		const pump = new CapturePump({
			backend,
			profileDir: '/p',
			quality: 'sharp',
			outbox,
			scheduler: manualScheduler(),
			now: () => now
		});
		await pump.start();
		await pump.tick();
		now += 100;
		await pump.tick();
		expect(outbox.frames.filter((f) => f.kind === 'frame')).toHaveLength(1);

		pump.refresh();
		await pump.tick();
		expect(outbox.frames.filter((f) => f.kind === 'frame')).toHaveLength(2);

		now += COMPUTER_QUALITY_PRESETS.sharp.keyframeMs;
		await pump.tick();
		expect(outbox.frames.filter((f) => f.kind === 'frame')).toHaveLength(3);
		await pump.stop();
	});

	it('restarts the capture after three failed pictures in a row, says so, and keeps the view open', async () => {
		let fail = true;
		const { backend, sources } = backendWith(async () => {
			if (fail) throw new Error('page crashed');
			return shot('NEW');
		});
		const outbox = fakeOutbox();
		const pump = new CapturePump({
			backend,
			profileDir: '/p',
			quality: 'sharp',
			outbox,
			scheduler: manualScheduler()
		});
		await pump.start();
		await pump.tick();
		await pump.tick();
		expect(backend.start).toHaveBeenCalledTimes(1);
		await pump.tick();
		expect(backend.start).toHaveBeenCalledTimes(2);
		expect(sources[0].stopped).toBe(true);
		expect(pump.restartCount).toBe(1);
		expect(outbox.frames.some((f) => f.kind === 'error')).toBe(true);
		expect(outbox.frames.some((f) => f.kind === 'end')).toBe(false);

		fail = false;
		await pump.tick();
		expect(outbox.frames.at(-1)).toMatchObject({ kind: 'frame' });
		await pump.stop();
	});

	it('drops one tier after the link is over its limits for the degrade window, then recovers to the chosen tier', async () => {
		let now = 0;
		let data = 0;
		const { backend, requests } = backendWith(async () => shot(`P${data++}`));
		const outbox = fakeOutbox();
		const pump = new CapturePump({
			backend,
			profileDir: '/p',
			quality: 'sharp',
			outbox,
			scheduler: manualScheduler(),
			now: () => now
		});
		await pump.start();

		outbox.link.backlog = 4;
		await pump.tick();
		now += COMPUTER_DEGRADE_WINDOW_MS - 1;
		await pump.tick();
		expect(pump.effectiveQuality).toBe('sharp');
		now += 1;
		await pump.tick();
		expect(pump.effectiveQuality).toBe('smooth');
		expect(pump.stats()).toMatchObject({ quality: 'sharp', effectiveQuality: 'smooth' });

		outbox.link.backlog = 0;
		await pump.tick();
		now += COMPUTER_RECOVER_WINDOW_MS;
		await pump.tick();
		expect(pump.effectiveQuality).toBe('sharp');
		expect(requests.at(-1)?.width).toBeLessThanOrEqual(COMPUTER_QUALITY_PRESETS.sharp.width);
		await pump.stop();
	});

	it('an owner’s quality choice takes effect at once as both chosen and effective tier', async () => {
		const { backend, requests } = backendWith(async () => shot());
		const outbox = fakeOutbox();
		const pump = new CapturePump({
			backend,
			profileDir: '/p',
			quality: 'sharp',
			outbox,
			scheduler: manualScheduler()
		});
		await pump.start();
		pump.setQuality('steady');
		await pump.tick();
		expect(requests.at(-1)).toEqual({
			width: COMPUTER_QUALITY_PRESETS.steady.width,
			quality: COMPUTER_QUALITY_PRESETS.steady.q
		});
		expect(pump.stats()).toMatchObject({ quality: 'steady', effectiveQuality: 'steady', bytesOut: 4096 });
		await pump.stop();
	});

	it('does not start capturing when stopped while its source is still starting, and releases that source', async () => {
		const scheduler = manualScheduler();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { backend, sources } = backendWith(async () => shot());
		const startSource = backend.start;
		backend.start = vi.fn(async (input) => {
			await gate;
			return startSource(input);
		});
		const pump = new CapturePump({ backend, profileDir: '/p', quality: 'sharp', outbox: fakeOutbox(), scheduler });

		const starting = pump.start();
		await vi.waitFor(() => expect(backend.start).toHaveBeenCalledTimes(1));
		let stopResolved = false;
		const stopping = pump.stop().then(() => {
			stopResolved = true;
		});
		await Promise.resolve();
		expect(stopResolved).toBe(false);

		release();
		await starting;
		await stopping;
		expect(sources).toHaveLength(1);
		expect(sources[0].stopped).toBe(true);
		expect(pump.captureSource).toBeNull();
		expect(scheduler.pending()).toBe(0);
	});

	it('waits for a restart that is still starting when stopped, and stops the source it produces', async () => {
		const scheduler = manualScheduler();
		const { backend, sources } = backendWith(async () => {
			throw new Error('page crashed');
		});
		const startSource = backend.start;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let starts = 0;
		backend.start = vi.fn(async (input) => {
			starts += 1;
			// The first source opens at once; the restart waits for the test.
			if (starts > 1) await gate;
			return startSource(input);
		});
		const outbox = fakeOutbox();
		const pump = new CapturePump({ backend, profileDir: '/p', quality: 'sharp', outbox, scheduler });
		await pump.start();
		await pump.tick();
		await pump.tick();

		// The third failure restarts the capture; its new source is still starting.
		const restarting = pump.tick();
		await vi.waitFor(() => expect(backend.start).toHaveBeenCalledTimes(2));
		expect(sources[0].stopped).toBe(true);

		let stopResolved = false;
		const stopping = pump.stop().then(() => {
			stopResolved = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(stopResolved).toBe(false);

		release();
		await stopping;
		// stop() resolved only after the late source was released.
		expect(sources).toHaveLength(2);
		expect(sources[1].stopped).toBe(true);
		await restarting;
		expect(pump.captureSource).toBeNull();
		expect(scheduler.pending()).toBe(0);
		expect(backend.start).toHaveBeenCalledTimes(2);
	});

	it('opens nothing once stopped', async () => {
		const { backend } = backendWith(async () => shot());
		const pump = new CapturePump({
			backend,
			profileDir: '/p',
			quality: 'sharp',
			outbox: fakeOutbox(),
			scheduler: manualScheduler()
		});
		await pump.stop();
		await pump.start();
		await pump.tick();
		expect(backend.start).not.toHaveBeenCalled();
	});

	it('stops its source and its timers', async () => {
		const scheduler = manualScheduler();
		const { backend, sources } = backendWith(async () => shot());
		const pump = new CapturePump({ backend, profileDir: '/p', quality: 'sharp', outbox: fakeOutbox(), scheduler });
		await pump.start();
		expect(scheduler.pending()).toBeGreaterThan(0);
		await pump.stop();
		expect(sources[0].stopped).toBe(true);
		expect(scheduler.pending()).toBe(0);
	});
});
