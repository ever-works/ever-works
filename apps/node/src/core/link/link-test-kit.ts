import {
	decodeFleetLinkControl,
	decodeFleetLinkFrame,
	decodeFleetLinkJson,
	encodeFleetLinkControl,
	encodeFleetLinkFrame,
	encodeFleetLinkJson,
	FLEET_LINK_DEFAULT_LIMITS,
	type FleetLinkControlMessage,
	type FleetLinkExtensionMessage,
	type FleetLinkFrame,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import type { Scheduler } from '../heartbeat';
import type { LinkSocketFactory, LinkSocketLike } from './link-socket';

/**
 * Test support for the node link specs — a manual clock and a scriptable
 * socket. Not imported by any production module (the bundle starts at the
 * CLI entry, so this file never ships).
 */

export interface ManualClock {
	scheduler: Scheduler;
	now: () => number;
	/** Move time forward, running every timer that falls due, in order. */
	advance(ms: number): void;
	/** Delays of the timers currently pending, soonest first. */
	pending(): number[];
}

export function manualClock(start = 1_760_000_000_000): ManualClock {
	let time = start;
	let nextId = 1;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		scheduler: {
			setTimeout: (callback, ms) => {
				const id = nextId++;
				timers.set(id, { at: time + Math.max(0, ms), callback });
				return id;
			},
			clearTimeout: (handle) => {
				timers.delete(handle as number);
			}
		},
		now: () => time,
		advance(ms) {
			const target = time + ms;
			for (;;) {
				let dueId: number | null = null;
				let dueAt = Infinity;
				for (const [id, timer] of timers) {
					if (timer.at <= target && timer.at < dueAt) {
						dueAt = timer.at;
						dueId = id;
					}
				}
				if (dueId === null) break;
				const timer = timers.get(dueId)!;
				timers.delete(dueId);
				time = Math.max(time, timer.at);
				timer.callback();
			}
			time = target;
		},
		pending: () => [...timers.values()].map((timer) => timer.at - time).sort((a, b) => a - b)
	};
}

export class FakeLinkSocket implements LinkSocketLike {
	readyState = 0;
	binaryType = 'blob';
	readonly sent: FleetLinkFrame[] = [];
	closedWith: { code?: number; reason?: string } | null = null;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;

	constructor(readonly url: string) {}

	send(data: Uint8Array | ArrayBuffer | string): void {
		if (typeof data === 'string') throw new Error('the link is binary-only');
		const frame = decodeFleetLinkFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
		if (!frame) throw new Error('the client sent an undecodable frame');
		this.sent.push({ ...frame, payload: frame.payload.slice() });
	}

	close(code?: number, reason?: string): void {
		this.closedWith = { code, reason };
		this.readyState = 3;
	}

	/** The server accepted the TCP/TLS connection. */
	open(): void {
		this.readyState = 1;
		this.onopen?.({});
	}

	/** The server sent a control message. */
	receiveControl(message: FleetLinkControlMessage | FleetLinkExtensionMessage): void {
		this.onmessage?.({ data: encodeFleetLinkControl(message)!.slice().buffer });
	}

	/** The server sent a JSON message on a channel. */
	receiveJson(channel: number, message: Record<string, unknown>): void {
		this.onmessage?.({ data: encodeFleetLinkJson(channel, message)!.slice().buffer });
	}

	receiveBinary(channel: number, kind: FleetLinkFrameKind, payload: Uint8Array): void {
		this.onmessage?.({ data: encodeFleetLinkFrame(channel, kind, payload)!.slice().buffer });
	}

	receiveRaw(bytes: Uint8Array): void {
		this.onmessage?.({ data: bytes });
	}

	/** The server (or the network) closed the socket. */
	drop(code = 1006): void {
		this.readyState = 3;
		this.onclose?.({ code });
	}

	/** Control messages the client sent, decoded. */
	controls(): Array<FleetLinkControlMessage | FleetLinkExtensionMessage> {
		return this.sent
			.filter((frame) => frame.channel === 0)
			.map((frame) => decodeFleetLinkControl(frame.payload))
			.filter((message): message is FleetLinkControlMessage | FleetLinkExtensionMessage => message !== null);
	}

	/** JSON messages the client sent on a channel, decoded. */
	jsonOn(channel: number): Array<Record<string, unknown>> {
		return this.sent
			.filter((frame) => frame.channel === channel && frame.kind === 10)
			.map((frame) => decodeFleetLinkJson(frame.payload, Number.MAX_SAFE_INTEGER))
			.filter((message): message is Record<string, unknown> => message !== null);
	}
}

export function fakeSocketFactory(): { factory: LinkSocketFactory; sockets: FakeLinkSocket[]; last(): FakeLinkSocket } {
	const sockets: FakeLinkSocket[] = [];
	return {
		factory: (url) => {
			const socket = new FakeLinkSocket(url);
			sockets.push(socket);
			return socket;
		},
		sockets,
		last: () => {
			const socket = sockets[sockets.length - 1];
			if (!socket) throw new Error('no socket was opened');
			return socket;
		}
	};
}

/** A `link.ready` with the default limits. */
export function readyMessage(
	linkGeneration: number,
	extra: { resumed?: number[]; closed?: number[] } = {}
): FleetLinkControlMessage {
	return {
		type: 'link.ready',
		linkGeneration,
		limits: FLEET_LINK_DEFAULT_LIMITS,
		serverTime: new Date(0).toISOString(),
		resumed: extra.resumed ?? [],
		closed: extra.closed ?? []
	};
}

/** Let pending promise continuations run. */
export async function flush(times = 5): Promise<void> {
	for (let i = 0; i < times; i += 1) await Promise.resolve();
}
