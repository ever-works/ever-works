import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
	decodeFleetPortTunnelChunk,
	encodeFleetPortTunnelChunk,
	FLEET_LINK_FRAME_KINDS,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import { createLinkControlState } from '../control';
import type { NodeChannelContext, NodeChannelHandler } from '../registry';
import { openTunnelChannel } from './tunnel';

/**
 * Servers and ports, phase 2 (FL-10, T-17) — the node's tunnel channel against
 * a REAL loopback server: one request round trip with a streamed body, the
 * `Host` rewritten to the loopback, credentials stripped, and a port nothing
 * listens on refused before the channel opens.
 */

let server: http.Server | null = null;
afterEach(() => {
	server?.close();
	server = null;
});

function listen(handler: http.RequestListener): Promise<number> {
	return new Promise((resolve) => {
		server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
	});
}

function fakeContext(port: number) {
	const json: Array<Record<string, unknown>> = [];
	const binary: Array<{ kind: FleetLinkFrameKind; payload: Uint8Array }> = [];
	const context = {
		channel: 7,
		family: 'tunnel',
		params: { tunnelId: 'abcdef12-0000-4000-8000-000000000000', port },
		consents: { work: false, attend: false, manage: true, usageScan: false },
		control: createLinkControlState(),
		nodeVersion: 'test',
		nodeName: 'build-01',
		sendJson: (message: Record<string, unknown>) => {
			json.push(message);
			return true;
		},
		sendBinary: (kind: FleetLinkFrameKind, payload: Uint8Array) => {
			binary.push({ kind, payload });
			return true;
		},
		sendControl: () => true,
		close: () => undefined,
		operations: { start: () => 'op', progress: () => undefined, done: () => undefined }
	} as unknown as NodeChannelContext;
	return { context, json, binary };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('tunnel channel', () => {
	it('refuses a port nothing listens on', async () => {
		const { context } = fakeContext(1);
		const result = await openTunnelChannel(context, { isListening: async () => false });
		expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});

	it('round-trips a request with a body to the loopback only', async () => {
		let seen: { host?: string; authorization?: string; body: string } = { body: '' };
		const port = await listen((req, res) => {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				seen = { host: req.headers.host, authorization: req.headers.authorization, body };
				res.writeHead(201, { 'content-type': 'text/plain', 'set-cookie': 'app=1' });
				res.end('hello from :' + port);
			});
		});
		const { context, json, binary } = fakeContext(port);
		const opened = await openTunnelChannel(context);
		expect(opened.ok).toBe(true);
		const handler = (opened as { ok: true; handler: NodeChannelHandler }).handler;
		handler.onJson!({
			type: 'tunnel.request',
			requestId: '1',
			method: 'POST',
			path: '/x',
			query: 'a=1',
			headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' }
		});
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.DATA, encodeFleetPortTunnelChunk(1, new TextEncoder().encode('ping')));
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.END, encodeFleetPortTunnelChunk(1));
		await until(() => binary.some((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.END));

		expect(seen).toEqual({ host: `127.0.0.1:${port}`, authorization: undefined, body: 'ping' });
		expect(json[0]).toMatchObject({ type: 'tunnel.response', requestId: '1', status: 201 });
		expect((json[0].headers as Record<string, unknown>)['set-cookie']).toEqual(['app=1']);
		const body = binary
			.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.DATA)
			.map((frame) => new TextDecoder().decode(decodeFleetPortTunnelChunk(frame.payload)!.bytes))
			.join('');
		expect(body).toBe('hello from :' + port);
		handler.onClose!('normal');
	});

	it('refuses a path that is not on this port', async () => {
		const port = await listen((_req, res) => res.end('x'));
		const { context, json } = fakeContext(port);
		const opened = (await openTunnelChannel(context)) as { ok: true; handler: NodeChannelHandler };
		opened.handler.onJson!({
			type: 'tunnel.request',
			requestId: '2',
			method: 'GET',
			path: '//evil.test/',
			query: '',
			headers: {}
		});
		expect(json[0]).toMatchObject({ type: 'tunnel.error', requestId: '2', code: 'invalid' });
		opened.handler.onClose!('normal');
	});
});
