import { describe, expect, it, vi } from 'vitest';
import {
	decodeFleetLinkControl,
	decodeFleetLinkFrame,
	encodeFleetLinkAck,
	encodeFleetLinkJson,
	FLEET_LINK_CREDIT_WINDOW_BYTES,
	FLEET_LINK_FRAME_KINDS,
	FLEET_NO_CONSENTS,
	type FleetConsents,
	type FleetLinkFamily
} from '@ever-works/contracts';
import { ChannelMux } from './channel-mux';
import { createLinkControlState } from './modules/control';
import {
	composeNodeModules,
	type NodeChannelContext,
	type NodeChannelHandler,
	type NodeModule
} from './modules/registry';

const MANAGE: FleetConsents = { ...FLEET_NO_CONSENTS, manage: true, work: true };

function harness(options: { consents?: FleetConsents; modules?: NodeModule[] } = {}) {
	const frames: Uint8Array[] = [];
	const control = createLinkControlState();
	const contexts = new Map<number, NodeChannelContext>();
	const handlers = new Map<number, NodeChannelHandler & { closed?: string }>();
	const openFamily = (family: FleetLinkFamily, resumable = false): NodeModule => ({
		id: `m-${family}`,
		families: [
			{
				family,
				open: (context) => {
					contexts.set(context.channel, context);
					const handler: NodeChannelHandler & { closed?: string } = {
						onJson: vi.fn(),
						onBinary: vi.fn(),
						onDrain: vi.fn(),
						onResume: vi.fn(),
						onClose: (reason) => {
							handler.closed = reason;
						}
					};
					if (resumable) handler.resumeKey = `key-${context.channel}`;
					handlers.set(context.channel, handler);
					return { ok: true, handler };
				}
			}
		]
	});
	const modules = composeNodeModules(
		options.modules ?? [openFamily('logs'), openFamily('session', true), openFamily('files'), openFamily('command')]
	);
	const mux = new ChannelMux({
		modules,
		consents: options.consents ?? MANAGE,
		control,
		operations: { start: () => 'op-1', progress: () => undefined, done: () => undefined },
		nodeVersion: '0.3.0',
		nodeName: 'build-01'
	});
	mux.bind((frame) => {
		frames.push(frame);
		return true;
	});
	const controls = () =>
		frames
			.map((frame) => decodeFleetLinkFrame(frame)!)
			.filter((frame) => frame.channel === 0)
			.map((frame) => decodeFleetLinkControl(frame.payload));
	const open = (channel: number, family: FleetLinkFamily, params: Record<string, unknown> = {}) =>
		mux.open({ type: 'channel.open', channel, family, params, requestId: `r${channel}` });
	return { mux, frames, controls, open, control, contexts, handlers };
}

describe('ChannelMux', () => {
	it('acknowledges an open the family accepts and routes its frames to the handler', async () => {
		const h = harness();
		await h.open(1, 'logs');
		expect(h.controls()).toEqual([{ type: 'channel.ready', channel: 1, requestId: 'r1' }]);
		h.mux.deliver(decodeFleetLinkFrame(encodeFleetLinkJson(1, { type: 'logs.follow' })!)!);
		expect(h.handlers.get(1)!.onJson).toHaveBeenCalledWith({ type: 'logs.follow' });
	});

	it('refuses an open whose module consent check throws, and keeps running (a module bug is not a daemon crash)', async () => {
		const h = harness({
			modules: [
				{
					id: 'fragile',
					families: [
						{
							family: 'logs',
							consent: () => {
								throw new Error('params.path is not a string');
							},
							open: () => ({ ok: true, handler: {} })
						}
					]
				}
			]
		});
		await expect(h.open(1, 'logs', { path: 42 })).resolves.toBeUndefined();
		expect(h.controls()).toEqual([
			{
				type: 'channel.refused',
				channel: 1,
				requestId: 'r1',
				error: { code: 'internal', hint: "build-01 could not check this channel's consent" }
			}
		]);
		expect(h.mux.size).toBe(0);
	});

	it('names a resumable channel’s key in channel.ready', async () => {
		const h = harness();
		await h.open(4, 'session');
		expect(h.controls()).toEqual([{ type: 'channel.ready', channel: 4, requestId: 'r4', resumeKey: 'key-4' }]);
	});

	it('refuses the 65th channel with limit_exceeded and the stated hint (FR-15, U6)', async () => {
		const h = harness();
		for (let channel = 1; channel <= 64; channel += 1) await h.open(channel, 'command');
		await h.open(65, 'command');
		expect(h.controls().at(-1)).toEqual({
			type: 'channel.refused',
			channel: 65,
			requestId: 'r65',
			error: { code: 'limit_exceeded', hint: '64 channels are open on build-01; close one' }
		});
		expect(h.mux.size).toBe(64);
	});

	it('never accepts a closed channel number again on the same generation (FR-14)', async () => {
		const h = harness();
		await h.open(2, 'logs');
		h.mux.closeRemote(2, 'normal');
		expect(h.handlers.get(2)!.closed).toBe('normal');
		await h.open(2, 'logs');
		expect(h.controls().at(-1)).toMatchObject({ type: 'channel.refused', channel: 2, error: { code: 'invalid' } });
		// A new generation starts a fresh table.
		h.mux.resumeGeneration([], []);
		await h.open(2, 'logs');
		expect(h.controls().at(-1)).toMatchObject({ type: 'channel.ready', channel: 2 });
	});

	it('checks the consent on the node before the module is asked (FR-24)', async () => {
		const h = harness({ consents: { ...FLEET_NO_CONSENTS, work: true } });
		await h.open(1, 'logs');
		expect(h.contexts.has(1)).toBe(false);
		expect(h.controls()).toEqual([
			{
				type: 'channel.refused',
				channel: 1,
				requestId: 'r1',
				error: {
					code: 'consent_missing',
					hint: 'start the node with --manage on build-01',
					details: { family: 'logs', consent: 'manage' }
				}
			}
		]);
	});

	it('refuses a family no module registered with unsupported_on_node', async () => {
		const h = harness();
		await h.open(1, 'tunnel');
		expect(h.controls()[0]).toMatchObject({
			type: 'channel.refused',
			error: { code: 'unsupported_on_node', hint: 'build-01 (node 0.3.0) cannot do this yet: tunnel' }
		});
	});

	it('refuses every open while the kill switch has the link paused, and opens again after resume', async () => {
		const h = harness();
		h.control.pause();
		await h.open(1, 'logs');
		expect(h.controls()[0]).toMatchObject({ type: 'channel.refused', error: { code: 'kill_switch' } });
		h.control.resume();
		await h.open(2, 'logs');
		expect(h.controls()[1]).toMatchObject({ type: 'channel.ready', channel: 2 });
	});

	it('sends DATA on a credit family only against ACK credit, and tells the handler when credit returns', async () => {
		const h = harness();
		await h.open(1, 'files');
		const context = h.contexts.get(1)!;
		const chunk = new Uint8Array(64 * 1024);
		let sent = 0;
		while (context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, chunk)) sent += chunk.byteLength;
		expect(sent).toBe(FLEET_LINK_CREDIT_WINDOW_BYTES);
		h.mux.deliver(
			decodeFleetLinkFrame(new Uint8Array([0, 0, 0, 1, 30, 0, 0, 0, 4, ...encodeFleetLinkAck(65_536)!]))!
		);
		expect(h.handlers.get(1)!.onDrain).toHaveBeenCalledTimes(1);
		expect(h.handlers.get(1)!.onBinary).not.toHaveBeenCalled();
		expect(context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, chunk)).toBe(true);
		expect(context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, chunk)).toBe(false);
	});

	it('does not credit-limit a non-credit family', async () => {
		const h = harness();
		await h.open(1, 'command');
		const context = h.contexts.get(1)!;
		const chunk = new Uint8Array(1024 * 1024);
		for (let i = 0; i < 20; i += 1) expect(context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, chunk)).toBe(true);
	});

	it('keeps resumable channels across a drop and closes the rest with resume_failed (FR-9)', async () => {
		const h = harness();
		await h.open(1, 'logs');
		await h.open(2, 'session');
		await h.open(3, 'session');
		const resume = h.mux.suspend();
		expect(h.handlers.get(1)!.closed).toBe('resume_failed');
		expect(resume).toEqual([
			{ channel: 2, family: 'session', resumeKey: 'key-2' },
			{ channel: 3, family: 'session', resumeKey: 'key-3' }
		]);
		// Nothing is delivered to a suspended channel.
		h.mux.deliver(decodeFleetLinkFrame(encodeFleetLinkJson(2, { x: 1 })!)!);
		expect(h.handlers.get(2)!.onJson).not.toHaveBeenCalled();
		h.mux.resumeGeneration([2], [3], 'consent_missing');
		expect(h.handlers.get(2)!.onResume).toHaveBeenCalled();
		expect(h.handlers.get(2)!.closed).toBeUndefined();
		expect(h.handlers.get(3)!.closed).toBe('consent_missing');
		h.mux.deliver(decodeFleetLinkFrame(encodeFleetLinkJson(2, { x: 1 })!)!);
		expect(h.handlers.get(2)!.onJson).toHaveBeenCalledWith({ x: 1 });
	});

	it('tells the platform when the node closes a channel itself', async () => {
		const h = harness();
		await h.open(5, 'command');
		h.contexts.get(5)!.close('operation_failed', 'the shell exited');
		expect(h.controls().at(-1)).toEqual({
			type: 'channel.close',
			channel: 5,
			reason: 'operation_failed',
			hint: 'the shell exited'
		});
		expect(h.handlers.get(5)!.closed).toBe('operation_failed');
		expect(h.contexts.get(5)!.sendJson({ late: true })).toBe(false);
	});

	it('answers a module that throws while opening with operation_failed, not a crash', async () => {
		const h = harness({
			modules: [
				{
					id: 'broken',
					families: [
						{
							family: 'logs',
							open: () => {
								throw new Error('journalctl missing\nmore');
							}
						}
					]
				}
			]
		});
		await h.open(1, 'logs');
		expect(h.controls()[0]).toMatchObject({
			type: 'channel.refused',
			error: { code: 'operation_failed', hint: 'journalctl missing' }
		});
	});
});
