import { describe, expect, it, vi } from 'vitest';
import type { WebSocketLike } from './cdp-connection';
import {
	isSecureLegOrigin,
	NODE_LEG_ACCEPTED_AFTER_MS,
	NODE_LEG_RECONNECT_BASE_MS,
	NODE_LEG_RECONNECT_MAX_MS,
	openNodeLeg,
	toComputerWsUrl
} from './node-leg';
import { resolveNodeShell } from './terminal-channel';

const SESSION = '33333333-2222-4333-8444-555555555555';

describe('toComputerWsUrl', () => {
	it('turns the platform origin into the live-view gateway URL, never carrying a query string', () => {
		expect(toComputerWsUrl('https://api.ever.works', `/ws/computer/${SESSION}`)).toBe(
			`wss://api.ever.works/ws/computer/${SESSION}`
		);
		expect(toComputerWsUrl('http://localhost:3100/api', `ws/computer/${SESSION}`)).toBe(
			`ws://localhost:3100/ws/computer/${SESSION}`
		);
	});
});

describe('isSecureLegOrigin', () => {
	it('allows https anywhere and plain http only to this machine’s loopback', () => {
		expect(isSecureLegOrigin('https://api.ever.works')).toBe(true);
		expect(isSecureLegOrigin('https://10.0.0.5:3100/api')).toBe(true);
		expect(isSecureLegOrigin('http://localhost:3100/api')).toBe(true);
		expect(isSecureLegOrigin('http://127.0.0.1:3100')).toBe(true);
		expect(isSecureLegOrigin('http://[::1]:3100')).toBe(true);

		expect(isSecureLegOrigin('http://api.ever.works')).toBe(false);
		expect(isSecureLegOrigin('http://10.0.0.5:3100/api')).toBe(false);
		expect(isSecureLegOrigin('http://localhost.example.com')).toBe(false);
		expect(isSecureLegOrigin('ftp://api.ever.works')).toBe(false);
		expect(isSecureLegOrigin('not a url')).toBe(false);
	});
});

describe('openNodeLeg', () => {
	it('authenticates in the first frame and hands only quality and refresh requests to the capture', async () => {
		const sent: string[] = [];
		let socket: WebSocketLike | null = null;
		const factory = vi.fn((url: string) => {
			expect(url).not.toContain('?');
			socket = {
				readyState: 1,
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send: (data: string) => sent.push(data),
				close: vi.fn()
			};
			return socket;
		});
		const requests: string[] = [];
		const leg = openNodeLeg({
			apiUrl: 'https://api.ever.works',
			mintToken: async () => ({ token: 'worker-token', wsPath: `/ws/computer/${SESSION}` }),
			factory,
			onRequest: (frame) => requests.push(frame.kind === 'quality' ? `quality:${frame.quality}` : 'refresh')
		});
		await vi.waitFor(() => expect(socket).not.toBeNull());
		const open = socket as unknown as WebSocketLike;
		open.onopen?.({});
		expect(JSON.parse(sent[0])).toEqual({ kind: 'auth', token: 'worker-token' });

		open.onmessage?.({ data: JSON.stringify({ kind: 'refresh' }) });
		open.onmessage?.({ data: JSON.stringify({ kind: 'quality', quality: 'steady' }) });
		open.onmessage?.({ data: JSON.stringify({ kind: 'pointer', action: 'down', x: 1, y: 1, button: 'left' }) });
		open.onmessage?.({ data: 'garbage' });
		expect(requests).toEqual(['refresh', 'quality:steady']);

		leg.close();
		expect(open.close).toHaveBeenCalled();
	});

	it('reconnects a dropped leg with a FRESH token after a backoff, and stops reconnecting once closed', async () => {
		vi.useFakeTimers();
		try {
			const sockets: WebSocketLike[] = [];
			const sent: string[] = [];
			let minted = 0;
			const leg = openNodeLeg({
				apiUrl: 'https://api.ever.works',
				mintToken: async () => ({ token: `token-${++minted}`, wsPath: `/ws/computer/${SESSION}` }),
				factory: () => {
					const socket: WebSocketLike = {
						readyState: 1,
						onopen: null,
						onmessage: null,
						onerror: null,
						onclose: null,
						send: (data: string) => sent.push(data),
						close: vi.fn()
					};
					sockets.push(socket);
					return socket;
				},
				onRequest: () => undefined
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(sockets).toHaveLength(1);
			sockets[0].onopen?.({});
			sockets[0].onclose?.({});

			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS);
			expect(sockets).toHaveLength(2);
			sockets[1].onopen?.({});
			expect(sent.map((frame) => JSON.parse(frame).token)).toEqual(['token-1', 'token-2']);

			leg.close();
			sockets[1].onclose?.({});
			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_MAX_MS);
			expect(sockets).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps backing off while the relay refuses the leg, and resets only once the leg is accepted', async () => {
		vi.useFakeTimers();
		try {
			const sockets: WebSocketLike[] = [];
			const leg = openNodeLeg({
				apiUrl: 'https://api.ever.works',
				mintToken: async () => ({ token: 'worker-token', wsPath: `/ws/computer/${SESSION}` }),
				factory: () => {
					const socket: WebSocketLike = {
						readyState: 1,
						onopen: null,
						onmessage: null,
						onerror: null,
						onclose: null,
						send: () => undefined,
						close: vi.fn()
					};
					sockets.push(socket);
					return socket;
				},
				onRequest: () => undefined
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(sockets).toHaveLength(1);

			// Opened, then refused by the relay: the wait must grow each time.
			sockets[0].onopen?.({});
			sockets[0].onclose?.({ code: 4001 });
			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS);
			expect(sockets).toHaveLength(2);

			sockets[1].onopen?.({});
			sockets[1].onclose?.({ code: 4001 });
			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS);
			expect(sockets).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS);
			expect(sockets).toHaveLength(3);

			// Accepted: a request arrives on it, so the next drop starts over.
			sockets[2].onopen?.({});
			sockets[2].onmessage?.({ data: JSON.stringify({ kind: 'refresh' }) });
			sockets[2].onclose?.({ code: 1006 });
			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS);
			expect(sockets).toHaveLength(4);

			// Accepted silently: open past the relay's auth window, then dropped.
			sockets[3].onopen?.({});
			sockets[3].onclose?.({ code: 4001 });
			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS * 2);
			expect(sockets).toHaveLength(5);
			sockets[4].onopen?.({});
			await vi.advanceTimersByTimeAsync(NODE_LEG_ACCEPTED_AFTER_MS);
			sockets[4].onclose?.({ code: 1006 });
			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS);
			expect(sockets).toHaveLength(6);

			leg.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it('never mints or sends a token for a plain-http platform that is not this machine', async () => {
		const factory = vi.fn();
		const mintToken = vi.fn(async () => ({ token: 'worker-token', wsPath: `/ws/computer/${SESSION}` }));
		const warn = vi.fn();
		const leg = openNodeLeg({
			apiUrl: 'http://api.example.com',
			mintToken,
			factory,
			onRequest: () => undefined,
			logger: { warn } as never
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mintToken).not.toHaveBeenCalled();
		expect(factory).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(() => leg.close()).not.toThrow();
	});

	it('keeps trying when a token cannot be minted, never opening a socket without one', async () => {
		vi.useFakeTimers();
		try {
			const factory = vi.fn();
			const mintToken = vi
				.fn<() => Promise<{ token: string; wsPath: string }>>()
				.mockRejectedValueOnce(new Error('platform unreachable'))
				.mockResolvedValue({ token: 'worker-token', wsPath: `/ws/computer/${SESSION}` });
			factory.mockImplementation(() => ({
				readyState: 1,
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send: () => undefined,
				close: () => undefined
			}));
			const leg = openNodeLeg({
				apiUrl: 'https://api.ever.works',
				mintToken,
				factory,
				onRequest: () => undefined
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(factory).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(NODE_LEG_RECONNECT_BASE_MS);
			expect(mintToken).toHaveBeenCalledTimes(2);
			expect(factory).toHaveBeenCalledTimes(1);
			leg.close();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('resolveNodeShell', () => {
	it('uses PowerShell on Windows and the login shell (or sh) elsewhere', () => {
		expect(resolveNodeShell('win32', {}).command[0]).toBe('powershell.exe');
		expect(resolveNodeShell('linux', { SHELL: '/bin/zsh' }).command).toEqual(['/bin/zsh']);
		expect(resolveNodeShell('darwin', { SHELL: 'relative-shell' }).command).toEqual(['/bin/sh']);
		expect(resolveNodeShell('linux', {}).command).toEqual(['/bin/sh']);
	});
});

describe('openNodeLeg — a view someone can take control of', () => {
	it('hands the view’s mode and the controller’s input to their own listeners, and nothing else', async () => {
		let socket: WebSocketLike | null = null;
		const factory = vi.fn(() => {
			socket = {
				readyState: 1,
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send: () => undefined,
				close: vi.fn()
			};
			return socket;
		});
		const modes: string[] = [];
		const inputs: string[] = [];
		const requests: string[] = [];
		const leg = openNodeLeg({
			apiUrl: 'https://api.ever.works',
			mintToken: async () => ({ token: 'worker-token', wsPath: `/ws/computer/${SESSION}` }),
			factory,
			onRequest: (frame) => requests.push(frame.kind),
			onMode: (mode) => modes.push(mode),
			onInput: (frame) => inputs.push(frame.kind)
		});
		await vi.waitFor(() => expect(socket).not.toBeNull());
		const open = socket as unknown as WebSocketLike;
		open.onopen?.({});

		open.onmessage?.({ data: JSON.stringify({ kind: 'mode', mode: 'controlling' }) });
		open.onmessage?.({ data: JSON.stringify({ kind: 'pointer', action: 'down', x: 1, y: 1, button: 'left' }) });
		open.onmessage?.({
			data: JSON.stringify({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 })
		});
		open.onmessage?.({ data: JSON.stringify({ kind: 'text', text: 'hi' }) });
		open.onmessage?.({ data: JSON.stringify({ kind: 'scroll', x: 1, y: 1, dx: 0, dy: 3 }) });
		open.onmessage?.({ data: JSON.stringify({ kind: 'control', action: 'release' }) });
		open.onmessage?.({
			data: JSON.stringify({
				kind: 'frame',
				seq: 1,
				keyframe: true,
				width: 1,
				height: 1,
				mime: 'image/png',
				data: 'QUJD'
			})
		});
		open.onmessage?.({ data: JSON.stringify({ kind: 'mode', mode: 'watching' }) });
		open.onmessage?.({ data: JSON.stringify({ kind: 'pointer', action: 'wiggle', x: 1, y: 1, button: 'left' }) });

		expect(modes).toEqual(['controlling', 'watching']);
		expect(inputs).toEqual(['pointer', 'key', 'text', 'scroll']);
		expect(requests).toEqual([]);
		leg.close();
	});
});
