/**
 * Agent computers — a minimal browser debugging-protocol connection.
 *
 * Just enough to drive a Chromium-family browser the node launched (or the
 * Agent's own browser it attached to): numbered request/response over one
 * WebSocket, with per-call timeouts and flattened target sessions. Node 22
 * ships a WHATWG WebSocket client, so this needs no dependency; the socket
 * factory is injected so every path is testable without a browser.
 *
 * It never logs a message body — a screenshot is a picture of someone's
 * screen and a cookie list is a list of their logins.
 */

/** The WHATWG WebSocket surface this uses (Node's global satisfies it). */
export interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Node's built-in WebSocket client, or null on a runtime without one. */
export function defaultWebSocketFactory(): WebSocketFactory | null {
	const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
	return typeof Ctor === 'function' ? (url: string) => new Ctor(url) : null;
}

export const CDP_DEFAULT_CALL_TIMEOUT_MS = 10_000;

export class CdpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CdpError';
	}
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class CdpConnection {
	private nextId = 1;
	private closed = false;
	private readonly pending = new Map<number, Pending>();
	private readonly closeListeners = new Set<() => void>();

	private constructor(
		private readonly socket: WebSocketLike,
		private readonly callTimeoutMs: number
	) {
		socket.onmessage = (event) => this.onMessage(event?.data);
		socket.onclose = () => this.onClosed(new CdpError('Browser debugging connection closed'));
		socket.onerror = () => this.onClosed(new CdpError('Browser debugging connection failed'));
	}

	/** Open a connection and resolve once the socket is open. */
	static open(
		url: string,
		factory: WebSocketFactory,
		options: { timeoutMs?: number; callTimeoutMs?: number } = {}
	): Promise<CdpConnection> {
		return new Promise((resolve, reject) => {
			let socket: WebSocketLike;
			try {
				socket = factory(url);
			} catch (error) {
				reject(new CdpError(`Could not open the browser debugging connection: ${describe(error)}`));
				return;
			}
			const timer = setTimeout(() => {
				try {
					socket.close();
				} catch {
					// already gone
				}
				reject(new CdpError('Timed out opening the browser debugging connection'));
			}, options.timeoutMs ?? CDP_DEFAULT_CALL_TIMEOUT_MS);
			socket.onopen = () => {
				clearTimeout(timer);
				resolve(new CdpConnection(socket, options.callTimeoutMs ?? CDP_DEFAULT_CALL_TIMEOUT_MS));
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new CdpError('Could not open the browser debugging connection'));
			};
			socket.onclose = () => {
				clearTimeout(timer);
				reject(new CdpError('Browser debugging connection closed before it opened'));
			};
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** One protocol call; resolves with its `result`, rejects with its `error` or on timeout. */
	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		if (this.closed) return Promise.reject(new CdpError('Browser debugging connection is closed'));
		const id = this.nextId++;
		const message: Record<string, unknown> = { id, method, params };
		if (sessionId) message.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpError(`Browser did not answer ${method} in time`));
			}, this.callTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.socket.send(JSON.stringify(message));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new CdpError(`Could not send ${method}: ${describe(error)}`));
			}
		});
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		if (this.closed) return;
		try {
			this.socket.close();
		} catch {
			// already gone
		}
		this.onClosed(new CdpError('Browser debugging connection closed'));
	}

	private onMessage(data: unknown): void {
		if (typeof data !== 'string') return;
		let parsed: { id?: unknown; result?: unknown; error?: { message?: unknown } };
		try {
			parsed = JSON.parse(data) as typeof parsed;
		} catch {
			return;
		}
		if (typeof parsed.id !== 'number') return; // an event; this client subscribes to none
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);
		clearTimeout(pending.timer);
		if (parsed.error) {
			const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'protocol error';
			pending.reject(new CdpError(message));
			return;
		}
		pending.resolve(
			parsed.result && typeof parsed.result === 'object' ? (parsed.result as Record<string, unknown>) : {}
		);
	}

	private onClosed(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
		for (const listener of this.closeListeners) {
			try {
				listener();
			} catch {
				// a listener's failure is its own
			}
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
