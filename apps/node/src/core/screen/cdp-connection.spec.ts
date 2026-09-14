import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpConnection, CdpError, defaultWebSocketFactory, type WebSocketLike } from './cdp-connection';

class FakeSocket implements WebSocketLike {
	readyState = 0;
	sent: Array<Record<string, unknown>> = [];
	closed = false;
	failSend = false;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;

	send(data: string): void {
		if (this.failSend) throw new Error('socket is gone');
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close(): void {
		this.closed = true;
	}

	answer(message: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
}

async function openConnection(
	options: { callTimeoutMs?: number } = {}
): Promise<{ cdp: CdpConnection; socket: FakeSocket }> {
	const socket = new FakeSocket();
	const opening = CdpConnection.open('ws://127.0.0.1:9222/devtools/browser/abc', () => socket, options);
	socket.readyState = 1;
	socket.onopen?.({});
	return { cdp: await opening, socket };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('CdpConnection.open', () => {
	it('resolves once the socket opens', async () => {
		const { cdp } = await openConnection();
		expect(cdp.isClosed).toBe(false);
	});

	it('rejects when the socket errors or closes before it opens, or the factory throws', async () => {
		const erroring = new FakeSocket();
		const failed = CdpConnection.open('ws://x', () => erroring);
		erroring.onerror?.({});
		await expect(failed).rejects.toBeInstanceOf(CdpError);

		const closing = new FakeSocket();
		const closedEarly = CdpConnection.open('ws://x', () => closing);
		closing.onclose?.({});
		await expect(closedEarly).rejects.toThrow('closed before it opened');

		await expect(
			CdpConnection.open('ws://x', () => {
				throw new Error('bad url');
			})
		).rejects.toThrow('bad url');
	});

	it('gives up and closes the socket when it never opens in time', async () => {
		vi.useFakeTimers();
		const socket = new FakeSocket();
		const opening = CdpConnection.open('ws://x', () => socket, { timeoutMs: 50 });
		const outcome = expect(opening).rejects.toThrow('Timed out');
		await vi.advanceTimersByTimeAsync(50);
		await outcome;
		expect(socket.closed).toBe(true);
	});
});

describe('CdpConnection.send', () => {
	it('numbers each call, carries a flattened target session, and resolves with its result', async () => {
		const { cdp, socket } = await openConnection();
		const first = cdp.send('Target.getTargets');
		const second = cdp.send('Page.captureScreenshot', { format: 'jpeg' }, 'session-1');

		expect(socket.sent[0]).toEqual({ id: 1, method: 'Target.getTargets', params: {} });
		expect(socket.sent[1]).toEqual({
			id: 2,
			method: 'Page.captureScreenshot',
			params: { format: 'jpeg' },
			sessionId: 'session-1'
		});

		socket.answer({ id: 2, result: { data: 'abc' } });
		socket.answer({ id: 1, result: { targetInfos: [] } });
		await expect(second).resolves.toEqual({ data: 'abc' });
		await expect(first).resolves.toEqual({ targetInfos: [] });
	});

	it('rejects with the browser’s own error message', async () => {
		const { cdp, socket } = await openConnection();
		const call = cdp.send('Page.navigate');
		socket.answer({ id: 1, error: { message: 'Not allowed' } });
		await expect(call).rejects.toThrow('Not allowed');
	});

	it('ignores events, unknown ids and unparseable messages', async () => {
		const { cdp, socket } = await openConnection();
		const call = cdp.send('Browser.getVersion');
		socket.answer({ method: 'Target.targetCreated', params: {} });
		socket.answer({ id: 99, result: {} });
		socket.onmessage?.({ data: 'not json' });
		socket.onmessage?.({ data: new Uint8Array([1, 2]) });
		socket.answer({ id: 1, result: { product: 'Chrome' } });
		await expect(call).resolves.toEqual({ product: 'Chrome' });
	});

	it('answers a result-less reply with an empty object', async () => {
		const { cdp, socket } = await openConnection();
		const call = cdp.send('Browser.close');
		socket.answer({ id: 1 });
		await expect(call).resolves.toEqual({});
	});

	it('times out a call the browser never answers', async () => {
		vi.useFakeTimers();
		const { cdp } = await openConnection({ callTimeoutMs: 100 });
		const call = cdp.send('Page.captureScreenshot');
		const outcome = expect(call).rejects.toThrow('did not answer Page.captureScreenshot in time');
		await vi.advanceTimersByTimeAsync(100);
		await outcome;
	});

	it('rejects when the message cannot be sent', async () => {
		const { cdp, socket } = await openConnection();
		socket.failSend = true;
		await expect(cdp.send('Page.enable')).rejects.toThrow('Could not send Page.enable');
	});
});

describe('CdpConnection closing', () => {
	it('rejects every pending call and tells close listeners once when the browser goes away', async () => {
		const { cdp, socket } = await openConnection();
		const listener = vi.fn();
		cdp.onClose(listener);
		const pending = cdp.send('Page.captureScreenshot');

		socket.onclose?.({});
		socket.onerror?.({});

		await expect(pending).rejects.toBeInstanceOf(CdpError);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(cdp.isClosed).toBe(true);
		await expect(cdp.send('Page.enable')).rejects.toThrow('is closed');
	});

	it('closes the socket on request and survives a listener that throws or was removed', async () => {
		const { cdp, socket } = await openConnection();
		const removed = vi.fn();
		const unsubscribe = cdp.onClose(removed);
		unsubscribe();
		cdp.onClose(() => {
			throw new Error('listener failure');
		});

		cdp.close();
		cdp.close();

		expect(socket.closed).toBe(true);
		expect(removed).not.toHaveBeenCalled();
	});
});

describe('defaultWebSocketFactory', () => {
	it('uses the runtime’s WebSocket client when there is one, and answers null when there is none', () => {
		const original = (globalThis as { WebSocket?: unknown }).WebSocket;
		try {
			const constructed: string[] = [];
			(globalThis as { WebSocket?: unknown }).WebSocket = class {
				constructor(url: string) {
					constructed.push(url);
				}
			};
			const factory = defaultWebSocketFactory();
			expect(factory).not.toBeNull();
			factory?.('ws://127.0.0.1:1/devtools/browser/x');
			expect(constructed).toEqual(['ws://127.0.0.1:1/devtools/browser/x']);

			delete (globalThis as { WebSocket?: unknown }).WebSocket;
			expect(defaultWebSocketFactory()).toBeNull();
		} finally {
			(globalThis as { WebSocket?: unknown }).WebSocket = original;
		}
	});
});
