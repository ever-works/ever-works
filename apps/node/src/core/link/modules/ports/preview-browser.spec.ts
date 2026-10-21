import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentProfileRoot } from '../../../screen/agent-profile';
import { MachineVerbError } from '../registry';
import {
	defaultPreviewProfileRoot,
	previewBrowserDir,
	PreviewBrowserManager,
	type PreviewBrowserStarter,
	type PreviewSurface
} from './preview-browser';

function fakeScheduler() {
	const timers = new Map<number, { at: number; callback: () => void }>();
	let now = 0;
	let next = 1;
	return {
		now: () => now,
		scheduler: {
			setTimeout: (callback: () => void, ms: number) => {
				const id = next++;
				timers.set(id, { at: now + ms, callback });
				return id;
			},
			clearTimeout: (handle: unknown) => {
				timers.delete(handle as number);
			}
		},
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.callback();
				}
			}
		}
	};
}

function fakeSurface(): PreviewSurface & { urls: string[]; stopped: boolean } {
	const surface = {
		urls: [] as string[],
		stopped: false,
		navigate: async (url: string) => {
			surface.urls.push(url);
		},
		capture: async () => ({ mime: 'image/jpeg' as const, width: 10, height: 10, data: 'AA==' }),
		stop: async () => {
			surface.stopped = true;
		}
	};
	return surface;
}

function manager(starter: PreviewBrowserStarter | null) {
	const clock = fakeScheduler();
	const mkdir = vi.fn(async () => undefined);
	const instance = new PreviewBrowserManager({
		starter,
		root: '/home/ops/.ever-works/preview-profile',
		mkdir,
		nodeName: 'build-01',
		scheduler: clock.scheduler,
		now: clock.now
	});
	return { instance, clock, mkdir };
}

describe('preview profile location (R-3)', () => {
	it('sits beside the Agent profiles, never inside them', () => {
		const env = {};
		const preview = defaultPreviewProfileRoot(env, '/home/ops');
		const agents = defaultAgentProfileRoot(env, '/home/ops');
		expect(preview).toBe(join('/home/ops', '.ever-works', 'preview-profile'));
		expect(preview.startsWith(`${agents}`)).toBe(false);
		expect(previewBrowserDir(preview)).toBe(join(preview, 'browser'));
	});
});

describe('PreviewBrowserManager', () => {
	it('refuses with the U10 sentence when the machine has no browser', async () => {
		const { instance } = manager(null);
		await expect(
			instance.open({ url: 'http://127.0.0.1:3000/', port: 3000, viewId: 'v1', holder: 'Ops' })
		).rejects.toMatchObject({ error: { code: 'unsupported_on_node' } });
	});

	it('never navigates off the loopback', async () => {
		const surface = fakeSurface();
		const { instance } = manager({ start: async () => surface });
		await expect(
			instance.open({ url: 'http://example.com:3000/', port: 3000, viewId: 'v1', holder: 'Ops' })
		).rejects.toBeInstanceOf(MachineVerbError);
		expect(surface.urls).toEqual([]);
	});

	it('answers busy naming the holder for a second view (FR-11)', async () => {
		const surface = fakeSurface();
		const { instance } = manager({ start: async () => surface });
		await instance.open({ url: 'http://127.0.0.1:5173/', port: 5173, viewId: 'v1', holder: 'Ops' });
		await expect(
			instance.open({ url: 'http://127.0.0.1:3000/', port: 3000, viewId: 'v2', holder: 'Nina' })
		).rejects.toMatchObject({ error: { code: 'busy', hint: 'Ops is previewing :5173 on build-01' } });
	});

	it('ends 15 s after the last viewer leaves, and after 60 minutes in all', async () => {
		const surface = fakeSurface();
		const { instance, clock } = manager({ start: async () => surface });
		await instance.open({ url: 'http://127.0.0.1:3000/', port: 3000, viewId: 'v1', holder: 'Ops' });
		const ended: string[] = [];
		const attached = instance.attach('v1', { push: () => undefined, end: (reason) => ended.push(reason) });
		expect(attached).not.toBeNull();
		attached!.detach();
		clock.advance(14_000);
		expect(instance.current()).not.toBeNull();
		clock.advance(1_000);
		expect(instance.current()).toBeNull();

		const second = fakeSurface();
		const again = manager({ start: async () => second });
		await again.instance.open({ url: 'http://127.0.0.1:3000/', port: 3000, viewId: 'v1', holder: 'Ops' });
		again.instance.attach('v1', { push: () => undefined, end: (reason) => ended.push(reason) });
		again.clock.advance(60 * 60_000);
		expect(ended).toContain('hard');
		expect(again.instance.current()).toBeNull();
	});
});
