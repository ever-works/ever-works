import { describe, expect, it } from 'vitest';
import {
	encodeComputerFrame,
	FLEET_LINK_FRAME_KINDS,
	type ComputerInputFrame,
	type FleetConsents,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import { DesktopHelperHost } from '../../../screen/desktop-helper-backend';
import { helperControlPath } from '../../../screen/helper/helper-control';
import { HELPER_MESSAGES } from '../../../screen/helper/helper-protocol';
import { helperPathsFor } from '../../../screen/helper/helper-trust';
import { fakeHelperSpawner, memoryHelperFs, sha256Of } from '../../../screen/helper/helper-test-kit';
import type { NodeChannelContext, NodeChannelHandler, NodeLinkControlState } from '../registry';
import { createDesktopSourceOpener } from './desktop-source';

/**
 * Desktop view & control (FL-07 P2, T-31, FR-37 … FR-39) — the Desktop source's
 * controlling channel: input only on a channel opened `controlling`, the
 * blocked shortcuts refused here before the helper sees them, every key and
 * button released when control ends for any reason, and the machine's console
 * told who is controlling it.
 */

const VIEW_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ATTEND: FleetConsents = { work: false, attend: true, manage: false, usageScan: false };
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
const FILES = { [paths.installPath]: BINARY, [paths.policyPath]: RECORD, [helperControlPath(paths)]: ALLOWED };
const CONTROLLING = { source: 'desktop', viewId: VIEW_ID, mode: 'controlling', controlledBy: 'Ada Lovelace' };

function harness(params: Record<string, unknown>) {
	const json: Array<Record<string, unknown>> = [];
	const closes: Array<{ reason: string; hint?: string }> = [];
	const listeners: Array<(state: { paused: boolean; drain: null }) => void> = [];
	const ctl: NodeLinkControlState & { set(paused: boolean): void } = {
		paused: false,
		drain: null,
		onChange: (listener) => {
			listeners.push(listener);
			return () => undefined;
		},
		set(next) {
			(ctl as { paused: boolean }).paused = next;
			for (const listener of listeners) listener({ paused: next, drain: null });
		}
	};
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
		sendBinary: (_kind: FleetLinkFrameKind, _payload: Uint8Array) => true,
		sendControl: () => true,
		close: (reason, hint) => {
			closes.push({ reason, ...(hint ? { hint } : {}) });
		},
		operations: { start: () => 'op', progress: () => undefined, done: () => undefined }
	};
	return { context, json, closes, ctl };
}

function setup(files: Record<string, string>) {
	const fake = fakeHelperSpawner();
	const fs = memoryHelperFs(files);
	const host = new DesktopHelperHost({ paths, fs, platform: 'linux', env: { DISPLAY: ':0' }, spawner: fake.spawner });
	const timers: Array<() => void> = [];
	const said: string[] = [];
	let clock = 0;
	const opener = createDesktopSourceOpener({
		host,
		logger: {
			info: (line: string) => void said.push(line),
			warn: (line: string) => void said.push(line),
			error: (line: string) => void said.push(line)
		} as never,
		now: () => clock,
		setTimer: (callback) => {
			timers.push(callback);
			return timers.length;
		},
		setRepeat: () => 0,
		clearRepeat: () => undefined
	});
	return {
		host,
		fs,
		fake,
		opener,
		said,
		tick: (ms: number) => {
			clock += ms;
		},
		runTimers: () => timers.splice(0).forEach((callback) => callback())
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const inputBytes = (frame: ComputerInputFrame) => new TextEncoder().encode(encodeComputerFrame(frame) ?? '');

async function open(files: Record<string, string>, params: Record<string, unknown> = CONTROLLING) {
	const env = setup(files);
	const view = harness(params);
	const result = await env.opener(view.context);
	env.runTimers();
	await flush();
	return { ...env, ...view, result };
}

describe('a controlling desktop channel', () => {
	it('refuses to open when the owner has not allowed control, with the command that fixes it', async () => {
		const { result, fake } = await open({ [paths.installPath]: BINARY, [paths.policyPath]: RECORD });
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'unsupported_on_node', details: { reason: 'control-not-allowed' } }
		});
		expect((result as { error: { hint: string } }).error.hint).toContain('ever-works-node helper control allow');
		expect(fake.children).toHaveLength(0);
	});

	it('says on the machine who is controlling it, and how to stop it', async () => {
		const { result, said, json } = await open(FILES);
		expect(result.ok).toBe(true);
		expect(
			said.some(
				(line) => line.includes('Ada Lovelace is now controlling') && line.includes('helper control deny')
			)
		).toBe(true);
		expect(json[0]).toMatchObject({ type: 'desktop.started', mode: 'controlling' });
	});

	it('forwards pointer, wheel, key and text with the picture size', async () => {
		const { result, fake } = await open(FILES);
		const handler = (result as { ok: true; handler: NodeChannelHandler }).handler;
		handler.onBinary!(
			FLEET_LINK_FRAME_KINDS.INPUT,
			inputBytes({ kind: 'pointer', action: 'move', x: 1, y: 2, button: null, buttons: 0 })
		);
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, inputBytes({ kind: 'scroll', x: 1, y: 2, dx: 0, dy: 120 }));
		handler.onBinary!(
			FLEET_LINK_FRAME_KINDS.INPUT,
			inputBytes({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 })
		);
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, inputBytes({ kind: 'text', text: 'hello' }));
		await flush();
		expect(fake.children[0].inputs.map((input) => input.kind)).toEqual(['pointer', 'scroll', 'key', 'text']);
		expect(fake.children[0].inputs[0]).toMatchObject({ pictureWidth: 64, pictureHeight: 64 });
	});

	it('refuses a blocked shortcut itself, telling the controller by code at most once a second', async () => {
		const { result, fake, json, tick } = await open(FILES);
		const handler = (result as { ok: true; handler: NodeChannelHandler }).handler;
		const copy = inputBytes({ kind: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers: 2 });
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, copy);
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, copy);
		tick(1_000);
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, copy);
		await flush();
		expect(fake.children[0].inputs).toEqual([]);
		expect(json.filter((message) => message.type === 'desktop.inputRefused')).toEqual([
			{ type: 'desktop.inputRefused', code: 'blocked-shortcut' },
			{ type: 'desktop.inputRefused', code: 'blocked-shortcut' }
		]);
	});

	it('refuses a shortcut split across presses, and text typed while Alt is held (FR-37)', async () => {
		const { result, fake } = await open(FILES);
		const handler = (result as { ok: true; handler: NodeChannelHandler }).handler;
		const send = (frame: ComputerInputFrame) => handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, inputBytes(frame));
		send({ kind: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: 0 });
		send({ kind: 'key', action: 'down', key: 'v', code: 'KeyV', modifiers: 0 });
		send({ kind: 'key', action: 'up', key: 'Control', code: 'ControlLeft', modifiers: 0 });
		send({ kind: 'key', action: 'down', key: 'Alt', code: 'AltLeft', modifiers: 0 });
		send({ kind: 'text', text: '\t' });
		await flush();
		expect(fake.children[0].inputs.map((input) => input.code ?? input.kind)).toEqual([
			'ControlLeft',
			'ControlLeft',
			'AltLeft'
		]);
	});

	it('drops input while the kill switch pauses the link, then ends the view and releases everything', async () => {
		const { result, fake, ctl, closes, said } = await open(FILES);
		const handler = (result as { ok: true; handler: NodeChannelHandler }).handler;
		(ctl as { paused: boolean }).paused = true;
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, inputBytes({ kind: 'text', text: 'x' }));
		await flush();
		expect(fake.children[0].inputs).toEqual([]);
		ctl.set(true);
		await flush();
		expect(closes[0]).toMatchObject({ reason: 'kill_switch' });
		expect(fake.children[0].received.some((message) => message.kind === HELPER_MESSAGES.releaseAll)).toBe(true);
		expect(said.some((line) => line.startsWith('Desktop control of this computer ended'))).toBe(true);
	});

	it('releases every key and button when the channel closes (FR-39)', async () => {
		const { result, fake } = await open(FILES);
		(result as { ok: true; handler: NodeChannelHandler }).handler.onClose!('normal');
		await flush();
		expect(fake.children[0].received.some((message) => message.kind === HELPER_MESSAGES.releaseAll)).toBe(true);
	});
});

describe('a watching desktop channel', () => {
	it('never forwards input, even when control is allowed on the machine', async () => {
		const { result, fake } = await open(FILES, { source: 'desktop', viewId: VIEW_ID });
		const handler = (result as { ok: true; handler: NodeChannelHandler }).handler;
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.INPUT, inputBytes({ kind: 'text', text: 'x' }));
		await flush();
		expect(fake.children[0].inputs).toEqual([]);
		expect(fake.children[0].received.some((message) => message.kind === HELPER_MESSAGES.input)).toBe(false);
	});
});
