import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopHelperHost, helperSettingsFor, type DesktopStreamHandlers } from './desktop-helper-backend';
import { helperPathsFor, readHelperEvents } from './helper/helper-trust';
import { fakeHelperSpawner, memoryHelperFs, sha256Of } from './helper/helper-test-kit';

/**
 * Desktop view & control (FL-07, T-14, FR-3, FR-14, FR-19) — the host: tags and
 * reasons from facts, verification before every start, revocation ends every
 * stream, a fake helper that speaks the protocol.
 */

const paths = helperPathsFor('/home/me/.config/ever-works-node/node-config.json', 'linux');
const BINARY = 'helper v1';
const RECORD = JSON.stringify({
	schemaVersion: 1,
	path: paths.installPath,
	sha256: sha256Of(BINARY),
	level: 'hash-pinned',
	version: '0.1.0',
	published: true,
	acknowledgedAt: '2026-10-26T01:00:00.000Z'
});

function handlers(): DesktopStreamHandlers & { frames: number; tiles: number; ended: string[] } {
	const state = { frames: 0, tiles: 0, ended: [] as string[] };
	return Object.assign(state, {
		onFrame: () => {
			state.frames += 1;
		},
		onTiles: () => {
			state.tiles += 1;
		},
		onDisplays: () => undefined,
		onError: () => undefined,
		onEnded: (reason: string) => {
			state.ended.push(reason);
		}
	});
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function host(files: Record<string, string>, options: Parameters<typeof fakeHelperSpawner>[0] = {}) {
	const fs = memoryHelperFs(files);
	const fake = fakeHelperSpawner(options);
	const desktop = new DesktopHelperHost({
		paths,
		fs,
		platform: 'linux',
		env: { DISPLAY: ':0', HOME: '/home/me', EVER_WORKS_NODE_SECRET: 'never' },
		spawner: fake.spawner
	});
	return { desktop, fs, fake };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('DesktopHelperHost facts', () => {
	it('advertises nothing and reports helper-missing before anything is known (fail-closed)', async () => {
		const { desktop } = host({});
		expect(desktop.tags()).toEqual([]);
		expect(desktop.reasons()).toEqual(['helper-missing']);
		await desktop.refresh();
		expect(desktop.tags()).toEqual([]);
		expect((await desktop.report()).helperTrust).toBe('none');
	});

	it('advertises both tags for an admitted helper whose hello names no reason', async () => {
		const { desktop } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		await desktop.refresh();
		expect(desktop.tags()).toEqual(['helper:screen', 'screen:desktop']);
		const report = await desktop.report();
		expect(report).toMatchObject({ helperTrust: 'hash-pinned', desktopReasons: [] });
		expect(report.helper).toMatchObject({
			admitted: true,
			present: true,
			fingerprintPrefix: sha256Of(BINARY).slice(0, 8)
		});
		expect(report.displays.map((display) => display.id)).toEqual(['DP-1']);
	});

	it('keeps helper:screen but not screen:desktop on a Wayland session', async () => {
		const { desktop } = host(
			{ [paths.installPath]: BINARY, [paths.policyPath]: RECORD },
			{ reasons: ['wayland-unsupported'] }
		);
		await desktop.refresh();
		expect(desktop.tags()).toEqual(['helper:screen']);
		expect(desktop.reasons()).toEqual(['wayland-unsupported']);
	});

	it('never starts a changed helper, and records verify-failed once', async () => {
		const { desktop, fake, fs } = host({ [paths.installPath]: 'tampered', [paths.policyPath]: RECORD });
		await desktop.refresh();
		await desktop.refresh();
		expect(fake.children).toHaveLength(0);
		expect(desktop.reasons()).toEqual(['helper-untrusted']);
		const opened = await desktop.openStream({ display: null, quality: 'smooth' }, handlers());
		expect(opened).toMatchObject({ ok: false, refusal: { kind: 'reason', reason: 'helper-untrusted' } });
		expect(fake.children).toHaveLength(0);
		const events = await readHelperEvents(fs, paths.eventsPath);
		expect(events.map((event) => event.kind)).toEqual(['verify-failed']);
	});
});

describe('DesktopHelperHost streams', () => {
	it('hands the helper only the capture environment', async () => {
		const { desktop, fake } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const opened = await desktop.openStream({ display: null, quality: 'sharp' }, handlers());
		expect(opened.ok).toBe(true);
		expect(fake.children[0].env).toEqual({ DISPLAY: ':0' });
		expect(fake.children[0].path).toBe(paths.installPath);
	});

	it('starts at the preset and forwards frames and tiles in order', async () => {
		const { desktop, fake } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const sink = handlers();
		const opened = await desktop.openStream({ display: 'DP-1', quality: 'steady' }, sink);
		expect(opened.ok).toBe(true);
		const start = fake.children[0].received.find((message) => message.kind === 0x01)!;
		expect(JSON.parse(new TextDecoder().decode(start.payload))).toEqual({
			...helperSettingsFor('steady'),
			display: 'DP-1'
		});
		await flush();
		fake.children[0].sendTiles();
		fake.children[0].sendFrame();
		expect(sink.frames).toBeGreaterThanOrEqual(2);
		expect(sink.tiles).toBe(1);
	});

	it('refuses a third stream on one computer', async () => {
		const { desktop } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		expect((await desktop.openStream({ display: null, quality: 'smooth' }, handlers())).ok).toBe(true);
		expect((await desktop.openStream({ display: null, quality: 'smooth' }, handlers())).ok).toBe(true);
		expect(await desktop.openStream({ display: null, quality: 'smooth' }, handlers())).toMatchObject({
			ok: false,
			refusal: { kind: 'limit' }
		});
	});

	it('answers a start the helper refused as failed', async () => {
		const { desktop } = host(
			{ [paths.installPath]: BINARY, [paths.policyPath]: RECORD },
			{ startError: 'capture-failed' }
		);
		expect(await desktop.openStream({ display: null, quality: 'smooth' }, handlers())).toMatchObject({
			ok: false,
			refusal: { kind: 'failed' }
		});
	});

	it('ends every stream within a second of a revoke (FR-19)', async () => {
		vi.useFakeTimers();
		const { desktop, fs } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const sink = handlers();
		const opening = desktop.openStream({ display: null, quality: 'smooth' }, sink);
		await vi.advanceTimersByTimeAsync(0);
		const opened = await opening;
		expect(opened.ok).toBe(true);
		await fs.remove(paths.policyPath);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(sink.ended).toEqual(['revoked']);
		expect(desktop.liveStreams).toBe(0);
	});

	it('reports a helper that exits mid-stream, and refuses opens after three crashes in a minute', async () => {
		const { desktop, fake } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		for (let index = 0; index < 3; index += 1) {
			const sink = handlers();
			const opened = await desktop.openStream({ display: null, quality: 'smooth' }, sink);
			expect(opened.ok).toBe(true);
			fake.children[fake.children.length - 1].crash();
			await flush();
			expect(sink.ended).toEqual(['helper-exited']);
		}
		expect(await desktop.openStream({ display: null, quality: 'smooth' }, handlers())).toMatchObject({
			ok: false,
			refusal: { kind: 'crashing' }
		});
	});
});
