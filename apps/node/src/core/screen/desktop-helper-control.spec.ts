import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopHelperHost, type DesktopStreamHandlers } from './desktop-helper-backend';
import { helperControlPath } from './helper/helper-control';
import { helperPathsFor } from './helper/helper-trust';
import { HELPER_MESSAGES } from './helper/helper-protocol';
import { fakeHelperSpawner, memoryHelperFs, sha256Of } from './helper/helper-test-kit';

/**
 * Desktop view & control (FL-07 P2, T-31, FR-37 … FR-40) — the host's control
 * half: the owner's on-machine permission (bound to the admission) decides
 * whether a controlling stream opens and whether `input` is advertised; input
 * reaches the helper only on a controlling stream; withdrawing the permission
 * releases every key and button and ends control within a second.
 */

const paths = helperPathsFor('/home/me/.config/ever-works-node/node-config.json', 'linux');
const BINARY = 'helper v1';
const ADMITTED_AT = '2026-10-26T01:00:00.000Z';
const RECORD = JSON.stringify({
	schemaVersion: 1,
	path: paths.installPath,
	sha256: sha256Of(BINARY),
	level: 'hash-pinned',
	version: '0.1.0',
	published: true,
	acknowledgedAt: ADMITTED_AT
});
const ALLOWED = JSON.stringify({ schemaVersion: 1, allowed: true, admissionAt: ADMITTED_AT, changedAt: ADMITTED_AT });
const ALLOWED_FOR_ANOTHER = JSON.stringify({
	schemaVersion: 1,
	allowed: true,
	admissionAt: '2026-10-01T00:00:00.000Z',
	changedAt: ADMITTED_AT
});

const POINTER = { kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left', buttons: 1 } as const;

function handlers(): DesktopStreamHandlers & { ended: string[]; revoked: string[]; results: string[] } {
	const state = { ended: [] as string[], revoked: [] as string[], results: [] as string[] };
	return Object.assign(state, {
		onFrame: () => undefined,
		onTiles: () => undefined,
		onDisplays: () => undefined,
		onError: () => undefined,
		onEnded: (reason: string) => {
			state.ended.push(reason);
		},
		onControlRevoked: (reason: string) => {
			state.revoked.push(reason);
		},
		onInputResult: (result: { code: string }) => {
			state.results.push(result.code);
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
		env: { DISPLAY: ':0' },
		spawner: fake.spawner
	});
	return { desktop, fs, fake };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('control facts', () => {
	it('lives beside the admission record', () => {
		expect(helperControlPath(paths)).toBe('/home/me/.config/ever-works-node/helper-control.json');
	});

	it('is not allowed by default: no `input` tag, and the heartbeat says why', async () => {
		const { desktop } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		await desktop.refresh();
		expect(desktop.tags()).toEqual(['helper:screen', 'screen:desktop']);
		expect(desktop.controlReasons()).toEqual(['control-not-allowed']);
		expect((await desktop.report()).helper).toMatchObject({ control: 'not-allowed', inputReasons: [] });
	});

	it('advertises `input` exactly when the owner allowed control for THIS admission (FR-40)', async () => {
		const allowed = host({
			[paths.installPath]: BINARY,
			[paths.policyPath]: RECORD,
			[helperControlPath(paths)]: ALLOWED
		});
		await allowed.desktop.refresh();
		expect(allowed.desktop.tags()).toEqual(['helper:screen', 'screen:desktop', 'input']);
		expect((await allowed.desktop.report()).helper.control).toBe('allowed');

		const stale = host({
			[paths.installPath]: BINARY,
			[paths.policyPath]: RECORD,
			[helperControlPath(paths)]: ALLOWED_FOR_ANOTHER
		});
		await stale.desktop.refresh();
		expect(stale.desktop.tags()).not.toContain('input');
	});

	it('names what the helper said would stop input (macOS Accessibility)', async () => {
		const { desktop } = host(
			{ [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED },
			{ inputReasons: ['permission-accessibility'] }
		);
		await desktop.refresh();
		expect(desktop.controlReasons()).toEqual(['permission-accessibility']);
		expect(desktop.tags()).not.toContain('input');
	});
});

describe('controlling streams', () => {
	it('refuses a controlling open the owner has not allowed, before any helper starts', async () => {
		const { desktop, fake } = host({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const opened = await desktop.openStream({ display: null, quality: 'smooth', controlling: true }, handlers());
		expect(opened).toMatchObject({ ok: false, refusal: { kind: 'control', reason: 'control-not-allowed' } });
		expect(fake.children).toHaveLength(0);
	});

	it('refuses a controlling open when the helper says input is impossible', async () => {
		const { desktop } = host(
			{ [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED },
			{ inputReasons: ['permission-accessibility'] }
		);
		const opened = await desktop.openStream({ display: null, quality: 'smooth', controlling: true }, handlers());
		expect(opened).toMatchObject({ ok: false, refusal: { kind: 'control', reason: 'permission-accessibility' } });
	});

	it('forwards input with the picture size on a controlling stream only', async () => {
		const files = { [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED };
		const { desktop, fake } = host(files);
		const watching = await desktop.openStream({ display: null, quality: 'smooth' }, handlers());
		const controlling = await desktop.openStream(
			{ display: null, quality: 'smooth', controlling: true },
			handlers()
		);
		if (!watching.ok || !controlling.ok) throw new Error('both open');
		expect(watching.stream.input(POINTER, { width: 1280, height: 720 })).toBe(false);
		expect(controlling.stream.input(POINTER, { width: 1280, height: 720 })).toBe(true);
		await flush();
		expect(fake.children[0].inputs).toEqual([]);
		expect(fake.children[1].inputs).toEqual([{ ...POINTER, pictureWidth: 1280, pictureHeight: 720 }]);
	});

	it('passes the helper’s second refusal of a blocked shortcut on as a code', async () => {
		const files = { [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED };
		const { desktop } = host(files);
		const sink = handlers();
		const opened = await desktop.openStream({ display: null, quality: 'smooth', controlling: true }, sink);
		if (!opened.ok) throw new Error('open');
		opened.stream.input(
			{ kind: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers: 2 },
			{ width: 64, height: 64 }
		);
		await flush();
		expect(sink.results).toEqual(['blocked-shortcut']);
	});

	it('releases every key and button when the stream stops (FR-39)', async () => {
		const files = { [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED };
		const { desktop, fake } = host(files);
		const opened = await desktop.openStream({ display: null, quality: 'smooth', controlling: true }, handlers());
		if (!opened.ok) throw new Error('open');
		opened.stream.stop();
		await flush();
		expect(fake.children[0].received.some((message) => message.kind === HELPER_MESSAGES.releaseAll)).toBe(true);
	});

	it('ends control within a second of `helper control deny`, releasing everything first', async () => {
		vi.useFakeTimers();
		const files = { [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED };
		const { desktop, fs, fake } = host(files);
		const sink = handlers();
		const opening = desktop.openStream({ display: null, quality: 'smooth', controlling: true }, sink);
		await vi.advanceTimersByTimeAsync(0);
		const opened = await opening;
		expect(opened.ok).toBe(true);
		await fs.remove(helperControlPath(paths));
		await vi.advanceTimersByTimeAsync(1_100);
		expect(sink.revoked).toEqual(['control-not-allowed']);
		expect(fake.children[0].releases).toBeGreaterThanOrEqual(1);
		if (opened.ok) expect(opened.stream.input(POINTER, { width: 64, height: 64 })).toBe(false);
	});
});

describe('a helper that dies during control (owner question 14)', () => {
	const FILES = { [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED };

	it('starts a fresh, verified helper whose first and only command is releaseHeld, then stops it', async () => {
		const { desktop, fake } = host(FILES);
		const sink = handlers();
		const opened = await desktop.openStream({ display: null, quality: 'smooth', controlling: true }, sink);
		if (!opened.ok) throw new Error('open');
		const crashed = fake.children.length - 1;
		fake.children[crashed].crash();
		await vi.waitFor(() => expect(fake.children.length).toBe(crashed + 2));
		const fresh = fake.children[crashed + 1];
		await vi.waitFor(() =>
			expect(fresh.received.map((message) => message.kind)).toEqual([HELPER_MESSAGES.releaseHeld])
		);
		expect(fresh.path).toBe(paths.installPath);
		expect(sink.ended).toEqual(['helper-exited']);
		// Stopped once it has released: its stdin was closed, nothing else was asked of it.
		expect(fresh.received.some((message) => message.kind === HELPER_MESSAGES.start)).toBe(false);
	});

	it('does nothing of the kind for a watching stream, nor when the node ended the stream itself', async () => {
		const watching = host(FILES);
		const opened = await watching.desktop.openStream({ display: null, quality: 'smooth' }, handlers());
		if (!opened.ok) throw new Error('open');
		const before = watching.fake.children.length;
		watching.fake.children[before - 1].crash();
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(watching.fake.children.length).toBe(before);

		const stopped = host(FILES);
		const controlled = await stopped.desktop.openStream(
			{ display: null, quality: 'smooth', controlling: true },
			handlers()
		);
		if (!controlled.ok) throw new Error('open');
		const count = stopped.fake.children.length;
		controlled.stream.stop();
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stopped.fake.children.length).toBe(count);
		expect(
			stopped.fake.children.some((child) =>
				child.received.some((message) => message.kind === HELPER_MESSAGES.releaseHeld)
			)
		).toBe(false);
	});

	it('starts nothing when the helper is no longer approved (FR-14 holds for the release too)', async () => {
		const { desktop, fs, fake } = host(FILES);
		const opened = await desktop.openStream({ display: null, quality: 'smooth', controlling: true }, handlers());
		if (!opened.ok) throw new Error('open');
		await fs.remove(paths.policyPath);
		const count = fake.children.length;
		fake.children[count - 1].crash();
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fake.children.length).toBe(count);
	});
});
