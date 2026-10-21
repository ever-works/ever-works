import {
	FLEET_LINK_COMPUTER_LEG_FRAME,
	FLEET_LINK_COMPUTER_LEG_REQUEST,
	FLEET_LINK_COMPUTER_LEG_SOURCE,
	FLEET_LINK_COMPUTER_LEG_WAIT_MS,
	decodeComputerFrame,
	isComputerInputFrame,
	makeFleetLinkError,
	type ComputerFrame,
	type FleetLinkExtensionMessage
} from '@ever-works/contracts';
import type { Logger } from '../logger';
import { openNodeLeg, type NodeLeg, type NodeLegOptions } from '../screen/node-leg';
import type { NodeChannelContext, NodeChannelOpenResult } from './modules/registry';

/**
 * Fleet node link (FL-02, T-22, spec FR-34) — a live view's inbound leg over
 * the node link, with today's WebSocket leg kept as the fallback.
 *
 * A `computer-session` view needs the owner's quality and refresh requests,
 * the view's mode and the controlling person's input to reach this machine.
 * Until now that was its own outbound WebSocket (`screen/node-leg.ts`). When
 * the node link is up, the same frames ride a `desktop` channel instead
 * (`params.source: 'browser'`): the node cannot open channels (CONTRACTS
 * §3.2), so the view ASKS on channel 0 (`computer.leg { sessionId }`), the
 * replica holding the link checks the view is pinned here and live and opens
 * the channel, and the platform's relay treats it as the machine's `worker`
 * leg. Each frame is `{ type: 'desktop.frame', data }` with `data` in the
 * computer frame encoding — the very frames, in the very encoding, the legacy
 * leg carries, so both legs share one handler and nothing changes for the
 * viewer.
 *
 * Falls back to the legacy leg when the link is not connected, when no
 * channel arrives within {@link FLEET_LINK_COMPUTER_LEG_WAIT_MS} (an older
 * platform, a kill switch, a refusal), or when the channel closes while the
 * view still runs. `EVER_WORKS_NODE_LINK_LEGACY_LEG=1` forces the legacy leg.
 */

/** Set to `1` (or `true`) to keep every live view on the legacy WebSocket leg. */
export const NODE_LINK_LEGACY_LEG_ENV = 'EVER_WORKS_NODE_LINK_LEGACY_LEG';

/** What the broker needs from the link: its phase and a way to ask on channel 0. */
export interface ComputerLegLinkPort {
	getState(): { phase: string };
	sendControl(message: FleetLinkExtensionMessage): boolean;
}

/** Where a leg's frames go: the same handlers the legacy leg calls. */
export interface ComputerLegHandlers {
	onRequest: NodeLegOptions['onRequest'];
	onMode?: NodeLegOptions['onMode'];
	onInput?: NodeLegOptions['onInput'];
}

interface WaitingLeg {
	handlers: ComputerLegHandlers;
	settle: (leg: LinkLeg | null) => void;
}

/** A leg carried by a link channel. */
export interface LinkLeg extends NodeLeg {
	/** Called once when the channel closes for any reason other than {@link NodeLeg.close}. */
	onLost(listener: () => void): void;
}

/** Dispatch one computer frame to the handlers, exactly as `screen/node-leg.ts` does. */
export function deliverComputerFrame(frame: ComputerFrame, handlers: ComputerLegHandlers): void {
	try {
		if (frame.kind === 'quality' || frame.kind === 'refresh') handlers.onRequest(frame);
		else if (frame.kind === 'mode') handlers.onMode?.(frame.mode);
		else if (isComputerInputFrame(frame)) handlers.onInput?.(frame);
	} catch {
		// the listener's failure is its own
	}
}

/**
 * The process's broker between running views and the link's `desktop`
 * family: a view registers what it is waiting for, the channel the platform
 * opens is matched to it by `sessionId`, and an unasked channel is refused.
 */
export class ComputerLegBroker {
	private link: ComputerLegLinkPort | null = null;
	private readonly waiting = new Map<string, WaitingLeg>();

	constructor(private readonly options: { logger?: Logger; waitMs?: number; now?: () => number } = {}) {}

	/** The runtime binds the link once it exists. */
	bindLink(link: ComputerLegLinkPort | null): void {
		this.link = link;
	}

	/** True when a leg could be asked for right now. */
	get available(): boolean {
		return this.link !== null && this.link.getState().phase === 'connected';
	}

	/**
	 * Ask for a view's leg over the link. Resolves the leg once the platform
	 * opened its channel, or null when the link is down, the request could not
	 * be sent, or nothing arrived within the wait.
	 */
	request(sessionId: string, handlers: ComputerLegHandlers): Promise<LinkLeg | null> {
		if (!this.available || !this.link) return Promise.resolve(null);
		this.waiting.get(sessionId)?.settle(null);
		return new Promise<LinkLeg | null>((resolve) => {
			let settled = false;
			const timer = setTimeout(() => entry.settle(null), this.options.waitMs ?? FLEET_LINK_COMPUTER_LEG_WAIT_MS);
			timer.unref?.();
			const entry: WaitingLeg = {
				handlers,
				settle: (leg) => {
					if (settled) {
						leg?.close();
						return;
					}
					settled = true;
					clearTimeout(timer);
					if (this.waiting.get(sessionId) === entry) this.waiting.delete(sessionId);
					resolve(leg);
				}
			};
			this.waiting.set(sessionId, entry);
			const sent = this.link!.sendControl({ type: FLEET_LINK_COMPUTER_LEG_REQUEST, sessionId });
			if (!sent) entry.settle(null);
		});
	}

	/** The `desktop` family's open for `source: 'browser'`: hand the channel to the view that asked. */
	open(context: NodeChannelContext): NodeChannelOpenResult {
		const sessionId = typeof context.params.sessionId === 'string' ? context.params.sessionId : '';
		const waiting = sessionId ? this.waiting.get(sessionId) : undefined;
		if (!waiting) {
			return {
				ok: false,
				error: makeFleetLinkError('not_found', 'no live view on this computer is waiting for that leg')
			};
		}
		let closedByUs = false;
		let lost = false;
		const lostListeners: Array<() => void> = [];
		const leg: LinkLeg = {
			close: () => {
				if (closedByUs || lost) return;
				closedByUs = true;
				context.close('normal');
			},
			onLost: (listener) => {
				if (lost) listener();
				else lostListeners.push(listener);
			}
		};
		const handlers = waiting.handlers;
		waiting.settle(leg);
		this.options.logger?.info(`Live view ${sessionId}: its leg rides the node link (channel ${context.channel}).`);
		return {
			ok: true,
			handler: {
				onJson: (message) => {
					if (message.type !== FLEET_LINK_COMPUTER_LEG_FRAME || typeof message.data !== 'string') return;
					const frame = decodeComputerFrame(message.data);
					if (frame) deliverComputerFrame(frame, handlers);
				},
				onClose: () => {
					if (closedByUs || lost) return;
					lost = true;
					for (const listener of lostListeners.splice(0)) {
						try {
							listener();
						} catch {
							// a listener's failure is its own
						}
					}
				}
			}
		};
	}
}

/** True when the environment forces the legacy leg. */
export function legacyLegForced(env: Record<string, string | undefined> = process.env): boolean {
	const value = env[NODE_LINK_LEGACY_LEG_ENV]?.trim().toLowerCase();
	return value === '1' || value === 'true' || value === 'yes';
}

export interface ComputerSessionLegOptions extends NodeLegOptions {
	sessionId: string;
	/** The link's broker, when the node runs the link. Absent → the legacy leg. */
	broker?: ComputerLegBroker | null;
	env?: Record<string, string | undefined>;
	/** Test seam for the legacy leg. */
	openLegacy?: (options: NodeLegOptions) => NodeLeg;
}

/**
 * Open a view's inbound leg: over the link when it can, else (and whenever
 * the link leg is lost while the view runs) the legacy WebSocket leg. The
 * returned leg closes whichever is current.
 */
export function openComputerSessionLeg(options: ComputerSessionLegOptions): NodeLeg {
	const { sessionId, broker, env, openLegacy = openNodeLeg, ...legOptions } = options;
	let closed = false;
	let current: NodeLeg | null = null;
	const legacy = (): void => {
		if (closed) return;
		current = openLegacy(legOptions);
	};
	if (!broker || legacyLegForced(env ?? process.env) || !broker.available) {
		legacy();
	} else {
		void broker
			.request(sessionId, {
				onRequest: legOptions.onRequest,
				...(legOptions.onMode ? { onMode: legOptions.onMode } : {}),
				...(legOptions.onInput ? { onInput: legOptions.onInput } : {})
			})
			.then((leg) => {
				if (closed) {
					leg?.close();
					return;
				}
				if (!leg) {
					legOptions.logger?.info(`Live view ${sessionId}: no leg over the node link; using its own socket.`);
					legacy();
					return;
				}
				current = leg;
				leg.onLost(() => {
					if (closed || current !== leg) return;
					legOptions.logger?.info(`Live view ${sessionId}: the node link leg dropped; using its own socket.`);
					current = null;
					legacy();
				});
			})
			.catch(() => legacy());
	}
	return {
		close: () => {
			closed = true;
			current?.close();
			current = null;
		}
	};
}

export { FLEET_LINK_COMPUTER_LEG_SOURCE };
