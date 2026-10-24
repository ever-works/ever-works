import { describe, expect, it, vi } from 'vitest';
import {
	FLEET_LINK_COMPUTER_LEG_FRAME,
	FLEET_LINK_COMPUTER_LEG_REQUEST,
	FLEET_NO_CONSENTS,
	encodeComputerFrame,
	type FleetLinkExtensionMessage
} from '@ever-works/contracts';
import type { NodeLeg, NodeLegOptions } from '../screen/node-leg';
import { ComputerLegBroker, legacyLegForced, openComputerSessionLeg } from './computer-leg';
import { createDesktopModule } from './modules/desktop';
import type { NodeChannelContext, NodeChannelHandler } from './modules/registry';

/**
 * Fleet node link (FL-02, T-22, spec FR-34) — a live view's inbound leg over
 * the link: asked for on channel 0, matched to the view by session id, fed
 * the same computer frames the legacy leg carries, and the legacy leg as the
 * fallback whenever the link cannot (or can no longer) carry it.
 */

const SESSION = '5b0f2c1e-3a4d-4e5f-8a6b-7c8d9e0f1a2b';

function fakeLink(phase = 'connected') {
	const sent: FleetLinkExtensionMessage[] = [];
	return {
		sent,
		port: {
			getState: () => ({ phase }),
			sendControl: (message: FleetLinkExtensionMessage) => {
				sent.push(message);
				return true;
			}
		}
	};
}

function channelContext(params: Record<string, unknown>) {
	const closes: string[] = [];
	const context = {
		channel: 3,
		family: 'desktop',
		params,
		consents: { ...FLEET_NO_CONSENTS, attend: true },
		control: { paused: false, drain: null, onChange: () => () => undefined },
		nodeVersion: '0.3.0',
		nodeName: 'build-01',
		sendJson: () => true,
		sendBinary: () => true,
		sendControl: () => true,
		close: (reason: string) => closes.push(reason),
		operations: { start: () => 'op-1', progress: () => undefined, done: () => undefined }
	} as unknown as NodeChannelContext;
	return { context, closes };
}

function legacySpy() {
	const opened: NodeLegOptions[] = [];
	const closed: number[] = [];
	const openLegacy = (options: NodeLegOptions): NodeLeg => {
		opened.push(options);
		const index = opened.length;
		return { close: () => closed.push(index) };
	};
	return { opened, closed, openLegacy };
}

const legOptions = (onRequest = vi.fn()) => ({
	apiUrl: 'https://api.ever.works',
	mintToken: async () => ({ token: 't', wsPath: '/ws/computer/x' }),
	factory: () => {
		throw new Error('no socket in tests');
	},
	onRequest
});

describe('ComputerLegBroker', () => {
	it('asks on channel 0 and hands the opened channel to the view, frames and all', async () => {
		const link = fakeLink();
		const broker = new ComputerLegBroker({ waitMs: 1000 });
		broker.bindLink(link.port);
		const onRequest = vi.fn();
		const onMode = vi.fn();
		const pending = broker.request(SESSION, { onRequest, onMode });
		expect(link.sent).toEqual([{ type: FLEET_LINK_COMPUTER_LEG_REQUEST, sessionId: SESSION }]);

		const { context } = channelContext({ source: 'browser', sessionId: SESSION });
		const opened = broker.open(context);
		expect(opened.ok).toBe(true);
		const leg = await pending;
		expect(leg).not.toBeNull();

		const handler = (opened as { ok: true; handler: NodeChannelHandler }).handler;
		handler.onJson?.({ type: FLEET_LINK_COMPUTER_LEG_FRAME, data: encodeComputerFrame({ kind: 'refresh' }) });
		handler.onJson?.({
			type: FLEET_LINK_COMPUTER_LEG_FRAME,
			data: encodeComputerFrame({ kind: 'mode', mode: 'controlling' })
		});
		// Anything else on the channel is ignored.
		handler.onJson?.({ type: 'desktop.other', data: 'x' });
		expect(onRequest).toHaveBeenCalledWith({ kind: 'refresh' });
		expect(onMode).toHaveBeenCalledWith('controlling');
	});

	it('refuses a channel no view asked for', () => {
		const broker = new ComputerLegBroker();
		broker.bindLink(fakeLink().port);
		const { context } = channelContext({ source: 'browser', sessionId: SESSION });
		const opened = broker.open(context);
		expect(opened).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});

	it('answers null when the link is down or nothing arrives in time', async () => {
		const down = new ComputerLegBroker({ waitMs: 10 });
		down.bindLink(fakeLink('reconnecting').port);
		expect(await down.request(SESSION, { onRequest: vi.fn() })).toBeNull();

		const slow = new ComputerLegBroker({ waitMs: 10 });
		const link = fakeLink();
		slow.bindLink(link.port);
		expect(await slow.request(SESSION, { onRequest: vi.fn() })).toBeNull();
		// A channel that arrives after the wait is refused (nobody waits any more).
		const { context } = channelContext({ source: 'browser', sessionId: SESSION });
		expect(slow.open(context).ok).toBe(false);
	});

	it('tells the view when the channel is lost, but not when it closed the leg itself', async () => {
		const broker = new ComputerLegBroker({ waitMs: 1000 });
		broker.bindLink(fakeLink().port);
		const pending = broker.request(SESSION, { onRequest: vi.fn() });
		const { context, closes } = channelContext({ source: 'browser', sessionId: SESSION });
		const opened = broker.open(context) as { ok: true; handler: NodeChannelHandler };
		const leg = (await pending)!;
		const lost = vi.fn();
		leg.onLost(lost);
		opened.handler.onClose?.('resume_failed');
		expect(lost).toHaveBeenCalledTimes(1);

		const second = broker.request(SESSION, { onRequest: vi.fn() });
		const again = channelContext({ source: 'browser', sessionId: SESSION });
		const reopened = broker.open(again.context) as { ok: true; handler: NodeChannelHandler };
		const leg2 = (await second)!;
		const lost2 = vi.fn();
		leg2.onLost(lost2);
		leg2.close();
		expect(again.closes).toEqual(['normal']);
		reopened.handler.onClose?.('normal');
		expect(lost2).not.toHaveBeenCalled();
		expect(closes).toEqual([]);
	});
});

describe('openComputerSessionLeg', () => {
	it('uses the legacy leg without a broker, with the link down, or when forced', () => {
		const spy = legacySpy();
		openComputerSessionLeg({ ...legOptions(), sessionId: SESSION, openLegacy: spy.openLegacy });
		const down = new ComputerLegBroker();
		down.bindLink(fakeLink('reconnecting').port);
		openComputerSessionLeg({ ...legOptions(), sessionId: SESSION, broker: down, openLegacy: spy.openLegacy });
		const up = new ComputerLegBroker();
		up.bindLink(fakeLink().port);
		openComputerSessionLeg({
			...legOptions(),
			sessionId: SESSION,
			broker: up,
			env: { EVER_WORKS_NODE_LINK_LEGACY_LEG: '1' },
			openLegacy: spy.openLegacy
		});
		expect(spy.opened).toHaveLength(3);
		expect(legacyLegForced({ EVER_WORKS_NODE_LINK_LEGACY_LEG: 'true' })).toBe(true);
		expect(legacyLegForced({})).toBe(false);
	});

	it('falls back to the legacy leg when no channel arrives in time', async () => {
		const spy = legacySpy();
		const broker = new ComputerLegBroker({ waitMs: 10 });
		broker.bindLink(fakeLink().port);
		openComputerSessionLeg({ ...legOptions(), sessionId: SESSION, broker, openLegacy: spy.openLegacy });
		expect(spy.opened).toHaveLength(0);
		await vi.waitFor(() => expect(spy.opened).toHaveLength(1));
	});

	it('rides the link, and falls back when the link leg is lost while the view runs', async () => {
		const spy = legacySpy();
		const broker = new ComputerLegBroker({ waitMs: 1000 });
		const link = fakeLink();
		broker.bindLink(link.port);
		const leg = openComputerSessionLeg({ ...legOptions(), sessionId: SESSION, broker, openLegacy: spy.openLegacy });
		await vi.waitFor(() => expect(link.sent).toHaveLength(1));
		const { context } = channelContext({ source: 'browser', sessionId: SESSION });
		const opened = broker.open(context) as { ok: true; handler: NodeChannelHandler };
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(spy.opened).toHaveLength(0);
		opened.handler.onClose?.('resume_failed');
		expect(spy.opened).toHaveLength(1);
		leg.close();
		expect(spy.closed).toEqual([1]);
	});
});

describe('the desktop family module', () => {
	it('routes the browser source to the broker and refuses any other source', () => {
		const broker = new ComputerLegBroker();
		broker.bindLink(fakeLink().port);
		const module = createDesktopModule(broker);
		const provider = module.families![0];
		expect(provider.family).toBe('desktop');
		const other = provider.open(channelContext({ source: 'desktop' }).context);
		expect(other).toMatchObject({ ok: false, error: { code: 'unsupported_on_node' } });
		const unasked = provider.open(channelContext({ source: 'browser', sessionId: SESSION }).context);
		expect(unasked).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});
});
