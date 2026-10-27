import { describe, expect, it } from 'vitest';
import {
	decodeComputerFrame,
	FLEET_LINK_FRAME_KINDS,
	type FleetConsents,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import { DesktopHelperHost } from '../../../screen/desktop-helper-backend';
import { helperPathsFor } from '../../../screen/helper/helper-trust';
import { fakeHelperSpawner, memoryHelperFs, sha256Of } from '../../../screen/helper/helper-test-kit';
import { createDesktopModule } from '../desktop';
import type { NodeChannelContext, NodeChannelHandler, NodeLinkControlState } from '../registry';
import { createDesktopHelperTagsModule, createDesktopSourceOpener, desktopRefusalError } from './desktop-source';

/**
 * Desktop view & control (FL-07, T-16, plan §6.4) — the Desktop source on the
 * `desktop` family: refusals per reason, `desktop.started` after ready, pictures
 * as FRAME / TILES, every INPUT dropped, the kill switch ends the view.
 */

const VIEW_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ATTEND: FleetConsents = { work: false, attend: true, manage: false, usageScan: false };
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

function control(paused = false) {
	const listeners: Array<(state: { paused: boolean; drain: null }) => void> = [];
	const state: NodeLinkControlState & { set(paused: boolean): void } = {
		paused,
		drain: null,
		onChange: (listener) => {
			listeners.push(listener);
			return () => undefined;
		},
		set(next) {
			(state as { paused: boolean }).paused = next;
			for (const listener of listeners) listener({ paused: next, drain: null });
		}
	};
	return state;
}

function harness(params: Record<string, unknown>, paused = false) {
	const json: Array<Record<string, unknown>> = [];
	const binary: Array<{ kind: FleetLinkFrameKind; payload: Uint8Array }> = [];
	const closes: Array<{ reason: string; hint?: string }> = [];
	const ctl = control(paused);
	const context: NodeChannelContext = {
		channel: 7,
		family: 'desktop',
		params,
		consents: ATTEND,
		control: ctl,
		nodeVersion: '1.0.0',
		nodeName: 'build-01',
		sendJson: (message) => {
			json.push(message);
			return true;
		},
		sendBinary: (kind, payload) => {
			binary.push({ kind, payload });
			return true;
		},
		sendControl: () => true,
		close: (reason, hint) => {
			closes.push({ reason, ...(hint ? { hint } : {}) });
		},
		operations: { start: () => 'op', progress: () => undefined, done: () => undefined }
	};
	return { context, json, binary, closes, ctl };
}

function setup(files: Record<string, string>, helperOptions: Parameters<typeof fakeHelperSpawner>[0] = {}) {
	const fake = fakeHelperSpawner(helperOptions);
	const host = new DesktopHelperHost({
		paths,
		fs: memoryHelperFs(files),
		platform: 'linux',
		env: { DISPLAY: ':0' },
		spawner: fake.spawner
	});
	const timers: Array<() => void> = [];
	const opener = createDesktopSourceOpener({
		host,
		setTimer: (callback) => {
			timers.push(callback);
			return timers.length;
		},
		setRepeat: () => 0,
		clearRepeat: () => undefined
	});
	return { host, fake, opener, runTimers: () => timers.splice(0).forEach((callback) => callback()) };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('desktop source refusals', () => {
	it('refuses bad params and the kill switch before touching the helper', async () => {
		const { opener, fake } = setup({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		expect(await opener(harness({ source: 'desktop' }).context)).toMatchObject({
			ok: false,
			error: { code: 'invalid' }
		});
		expect(await opener(harness({ source: 'desktop', viewId: VIEW_ID }, true).context)).toMatchObject({
			ok: false,
			error: { code: 'kill_switch' }
		});
		expect(fake.children).toHaveLength(0);
	});

	it('refuses unsupported_on_node with the reason and the one-line hint', async () => {
		const { opener } = setup({ [paths.installPath]: BINARY });
		const result = await opener(harness({ source: 'desktop', viewId: VIEW_ID }).context);
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'unsupported_on_node', details: { reason: 'helper-unadmitted' } }
		});
		expect((result as { error: { hint: string } }).error.hint).toContain('ever-works-node helper admit');
	});

	it('maps every refusal to a CONTRACTS code', () => {
		expect(desktopRefusalError({ kind: 'limit' }, 'build-01').code).toBe('limit_exceeded');
		expect(desktopRefusalError({ kind: 'crashing' }, 'build-01').code).toBe('operation_failed');
		expect(desktopRefusalError({ kind: 'reason', reason: 'wayland-unsupported' }, 'build-01')).toMatchObject({
			code: 'unsupported_on_node',
			details: { reason: 'wayland-unsupported' }
		});
	});

	it('is the desktop family’s `desktop` source', async () => {
		const { opener } = setup({});
		const module = createDesktopModule(null, { desktop: opener });
		const result = await module.families![0].open(harness({ source: 'desktop', viewId: VIEW_ID }).context);
		expect(result).toMatchObject({ ok: false, error: { details: { reason: 'helper-missing' } } });
	});
});

describe('a live desktop view', () => {
	it('says what it shows after ready, then sends keyframes as FRAME and changes as TILES', async () => {
		const { opener, fake, runTimers } = setup({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const { context, json, binary } = harness({ source: 'desktop', viewId: VIEW_ID, quality: 'steady' });
		const result = await opener(context);
		expect(result.ok).toBe(true);
		// Nothing before `channel.ready` (the first timer).
		expect(json).toEqual([]);
		expect(binary).toEqual([]);
		runTimers();
		expect(json[0]).toMatchObject({
			type: 'desktop.started',
			quality: 'steady',
			fellBack: false,
			display: { id: 'DP-1' }
		});
		await flush();
		fake.children[0].sendTiles();
		const frames = binary.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.FRAME);
		const tiles = binary.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.TILES);
		expect(frames.length).toBeGreaterThanOrEqual(1);
		expect(tiles).toHaveLength(1);
		const picture = decodeComputerFrame(frames[0].payload);
		expect(picture).toMatchObject({ kind: 'frame', keyframe: true, mime: 'image/jpeg', width: 64, height: 64 });
	});

	it('drops every INPUT frame (watching is read-only)', async () => {
		const { opener, fake, runTimers } = setup({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const { context } = harness({ source: 'desktop', viewId: VIEW_ID });
		const result = (await opener(context)) as { ok: true; handler: NodeChannelHandler };
		runTimers();
		const before = fake.children[0].received.length;
		result.handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, new TextEncoder().encode('{"kind":"key"}'));
		expect(fake.children[0].received.length).toBe(before);
	});

	it('answers quality and display requests with their request id', async () => {
		const { opener, runTimers } = setup({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const { context, json } = harness({ source: 'desktop', viewId: VIEW_ID });
		const result = (await opener(context)) as { ok: true; handler: NodeChannelHandler };
		runTimers();
		result.handler.onJson!({ type: 'desktop.quality', requestId: 'r1', quality: 'sharp' });
		result.handler.onJson!({ type: 'desktop.quality', requestId: 'r2', quality: 'ultra' });
		result.handler.onJson!({ type: 'desktop.displays', requestId: 'r3' });
		result.handler.onJson!({ type: 'desktop.setDisplay', requestId: 'r4', display: 'HDMI-9' });
		await flush();
		expect(json).toContainEqual({ requestId: 'r1', ok: true });
		expect(json.find((message) => message.requestId === 'r2')).toMatchObject({ error: { code: 'invalid' } });
		expect(json.find((message) => message.requestId === 'r3')).toMatchObject({ type: 'desktop.displays' });
		expect(json.find((message) => message.requestId === 'r4')).toMatchObject({
			error: { code: 'unsupported_on_node' }
		});
	});

	it('ends at once when the kill switch is thrown', async () => {
		const { opener, host, runTimers } = setup({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		const { context, closes, ctl } = harness({ source: 'desktop', viewId: VIEW_ID });
		await opener(context);
		runTimers();
		ctl.set(true);
		expect(closes).toEqual([{ reason: 'kill_switch', hint: 'clear it under Settings → Fleet' }]);
		expect(host.liveStreams).toBe(0);
	});
});

describe('the helper tags module', () => {
	it('re-reads the host on every call', () => {
		let tags = ['helper:screen'];
		const module = createDesktopHelperTagsModule({ tags: () => tags });
		expect(module.tags!({ consents: ATTEND, platform: 'linux', nodeVersion: '1.0.0' })).toEqual(['helper:screen']);
		tags = [];
		expect(module.tags!({ consents: ATTEND, platform: 'linux', nodeVersion: '1.0.0' })).toEqual([]);
	});
});
