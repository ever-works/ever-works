import {
	decodeFleetLinkAck,
	decodeFleetLinkJson,
	encodeFleetLinkControl,
	encodeFleetLinkFrame,
	encodeFleetLinkJson,
	fleetConsentMissingHint,
	fleetConsentSatisfies,
	FLEET_LINK_CREDIT_FAMILIES,
	FLEET_LINK_CREDIT_WINDOW_BYTES,
	FLEET_LINK_FRAME_KINDS,
	FLEET_LINK_MAX_CHANNELS,
	FLEET_LINK_MAX_PAYLOAD_BYTES,
	makeFleetLinkError,
	type FleetConsents,
	type FleetLinkChannelOpen,
	type FleetLinkCloseReason,
	type FleetLinkConsentRequirement,
	type FleetLinkError,
	type FleetLinkExtensionMessage,
	type FleetLinkFamily,
	type FleetLinkFrame,
	type FleetLinkFrameKind,
	type FleetLinkResumeChannel
} from '@ever-works/contracts';
import type { Logger } from '../logger';
import type {
	ComposedNodeModules,
	NodeChannelContext,
	NodeChannelHandler,
	NodeLinkControlState,
	NodeOperationReporter
} from './modules/registry';

/**
 * Fleet node link — the node's channel table.
 *
 * Owns every open channel of the link: who handles it, whether it may
 * survive a drop, and the per-channel flow-control credit. Transport-free —
 * it is handed a `send(frame)` and fed decoded frames — so the whole open /
 * refuse / close / resume matrix is testable without a socket.
 *
 * Rules (CONTRACTS §3.2, spec FR-12 … FR-15, FR-24):
 *
 *  - channels are opened by the PLATFORM only; this table never opens one;
 *  - at most {@link FLEET_LINK_MAX_CHANNELS} are open at once — the next open
 *    is refused `limit_exceeded`;
 *  - a channel number closed on this link generation is never accepted again
 *    on it;
 *  - the family's consent is checked HERE, on the machine, before the
 *    family's module is asked — whatever the platform already checked;
 *  - a family no module registered is refused `unsupported_on_node`;
 *  - while the kill switch has the link paused, every open is refused
 *    `kill_switch`;
 *  - `DATA` on a credit family is sent only against credit the receiver
 *    returned with `ACK`, so one bulk transfer never fills the link.
 */

interface ChannelEntry {
	channel: number;
	family: FleetLinkFamily;
	handler: NodeChannelHandler;
	/** DATA bytes this side may still send (credit families only). */
	credit: number | null;
	/** Kept across a link drop, waiting for the next generation's verdict. */
	suspended: boolean;
}

export interface ChannelMuxOptions {
	modules: ComposedNodeModules;
	consents: FleetConsents;
	control: NodeLinkControlState;
	operations: NodeOperationReporter;
	nodeVersion: string;
	nodeName: string;
	logger?: Logger;
}

export class ChannelMux {
	private readonly channels = new Map<number, ChannelEntry>();
	/** Numbers closed on the current generation. */
	private retired = new Set<number>();
	private sender: ((frame: Uint8Array) => boolean) | null = null;

	constructor(private readonly options: ChannelMuxOptions) {}

	/** Channels currently open (suspended ones included). */
	get size(): number {
		return this.channels.size;
	}

	/** Point the table at a socket (null while the link is down). */
	bind(sender: ((frame: Uint8Array) => boolean) | null): void {
		this.sender = sender;
	}

	has(channel: number): boolean {
		return this.channels.has(channel);
	}

	/** Send a raw frame through the bound socket. */
	sendFrame(frame: Uint8Array | null): boolean {
		if (!frame || !this.sender) return false;
		try {
			return this.sender(frame);
		} catch {
			return false;
		}
	}

	sendControl(message: Parameters<typeof encodeFleetLinkControl>[0]): boolean {
		return this.sendFrame(encodeFleetLinkControl(message));
	}

	/** `channel.open` from the platform: answer `channel.ready` or `channel.refused`. */
	async open(message: FleetLinkChannelOpen): Promise<void> {
		const { channel, family, params, requestId } = message;
		const refuse = (error: FleetLinkError): void => {
			this.sendControl({ type: 'channel.refused', channel, requestId, error });
		};
		if (this.channels.has(channel) || this.retired.has(channel)) {
			refuse(makeFleetLinkError('invalid', `channel ${channel} is already in use on this link`));
			return;
		}
		if (this.channels.size >= FLEET_LINK_MAX_CHANNELS) {
			refuse(
				makeFleetLinkError(
					'limit_exceeded',
					`${FLEET_LINK_MAX_CHANNELS} channels are open on ${this.options.nodeName}; close one`
				)
			);
			return;
		}
		if (this.options.control.paused) {
			refuse(makeFleetLinkError('kill_switch', 'clear it under Settings → Fleet'));
			return;
		}
		const provider = this.options.modules.family(family);
		if (!provider) {
			refuse(
				makeFleetLinkError(
					'unsupported_on_node',
					`${this.options.nodeName} (node ${this.options.nodeVersion}) cannot do this yet: ${family}`,
					{ family, nodeVersion: this.options.nodeVersion }
				)
			);
			return;
		}
		// A module-supplied function over platform-controlled params: whatever
		// it throws is a refusal of this open, never a daemon crash.
		let requirement: FleetLinkConsentRequirement;
		try {
			requirement = this.options.modules.familyConsent(family, params);
		} catch (thrown) {
			this.options.logger?.warn(
				`Link channel ${channel} (${family}) consent check failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`
			);
			refuse(makeFleetLinkError('internal', `${this.options.nodeName} could not check this channel's consent`));
			return;
		}
		if (!fleetConsentSatisfies(this.options.consents, requirement)) {
			refuse(
				makeFleetLinkError('consent_missing', fleetConsentMissingHint(requirement, this.options.nodeName), {
					family,
					consent: requirement
				})
			);
			return;
		}
		// Reserved before the module runs, so a second open of the same
		// number while `open` is pending is refused, not raced.
		const placeholder: ChannelEntry = { channel, family, handler: {}, credit: null, suspended: false };
		this.channels.set(channel, placeholder);
		let result;
		try {
			result = await provider.open(this.contextFor(channel, family, params));
		} catch (thrown) {
			result = {
				ok: false as const,
				error: makeFleetLinkError(
					'operation_failed',
					(thrown instanceof Error ? thrown.message : String(thrown)).split(/\r?\n/, 1)[0].slice(0, 300)
				)
			};
		}
		if (this.channels.get(channel) !== placeholder) {
			// Closed (or the link reset) while the module was opening it.
			if (result.ok) result.handler.onClose?.('normal');
			return;
		}
		if (!result.ok) {
			this.channels.delete(channel);
			this.retired.add(channel);
			refuse(result.error);
			return;
		}
		placeholder.handler = result.handler;
		placeholder.credit = (FLEET_LINK_CREDIT_FAMILIES as readonly string[]).includes(family)
			? FLEET_LINK_CREDIT_WINDOW_BYTES
			: null;
		const ready: { type: 'channel.ready'; channel: number; requestId: string; resumeKey?: string } = {
			type: 'channel.ready',
			channel,
			requestId
		};
		if (result.handler.resumeKey) ready.resumeKey = result.handler.resumeKey;
		this.sendControl(ready);
	}

	/** A frame for a channel above 0. Frames for an unknown channel are dropped. */
	deliver(frame: FleetLinkFrame): void {
		const entry = this.channels.get(frame.channel);
		if (!entry || entry.suspended) return;
		if (frame.kind === FLEET_LINK_FRAME_KINDS.ACK && entry.credit !== null) {
			const granted = decodeFleetLinkAck(frame.payload);
			if (granted !== null && granted > 0) {
				entry.credit = Math.min(entry.credit + granted, FLEET_LINK_CREDIT_WINDOW_BYTES);
				try {
					entry.handler.onDrain?.();
				} catch {
					// the handler's failure is its own
				}
			}
			return;
		}
		try {
			if (frame.kind === FLEET_LINK_FRAME_KINDS.JSON) {
				const message = decodeFleetLinkJson(frame.payload, FLEET_LINK_MAX_PAYLOAD_BYTES);
				if (message) entry.handler.onJson?.(message);
				return;
			}
			entry.handler.onBinary?.(frame.kind, frame.payload);
		} catch (thrown) {
			this.options.logger?.warn(
				`Link channel ${frame.channel} (${entry.family}) handler failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`
			);
		}
	}

	/** `channel.close` from the platform. */
	closeRemote(channel: number, reason: FleetLinkCloseReason): void {
		this.finish(channel, reason, false);
	}

	/** Close one channel from the node's side, telling the platform. */
	closeLocal(channel: number, reason: FleetLinkCloseReason, hint?: string): void {
		if (!this.channels.has(channel)) return;
		this.finish(channel, reason, true, hint);
	}

	/**
	 * The link dropped. Channels that cannot resume are closed now with
	 * `resume_failed`; the rest are suspended and listed for the reconnect.
	 */
	suspend(): FleetLinkResumeChannel[] {
		this.sender = null;
		const resume: FleetLinkResumeChannel[] = [];
		for (const entry of [...this.channels.values()]) {
			if (entry.handler.resumeKey) {
				entry.suspended = true;
				resume.push({ channel: entry.channel, family: entry.family, resumeKey: entry.handler.resumeKey });
			} else {
				this.finish(entry.channel, 'resume_failed', false);
			}
		}
		return resume;
	}

	/**
	 * A new generation is ready. Channels it `resumed` carry on; every other
	 * suspended channel closes with the reason the platform gave, or
	 * `resume_failed`. Numbers retired on the previous generation are free
	 * again — retirement is per generation.
	 */
	resumeGeneration(
		resumed: readonly number[],
		closed: readonly number[],
		closedReason: FleetLinkCloseReason = 'resume_failed'
	): void {
		this.retired = new Set();
		const keep = new Set(resumed);
		for (const entry of [...this.channels.values()]) {
			if (!entry.suspended) continue;
			if (keep.has(entry.channel)) {
				entry.suspended = false;
				try {
					entry.handler.onResume?.();
				} catch {
					// the handler's failure is its own
				}
			} else {
				this.finish(entry.channel, closed.includes(entry.channel) ? closedReason : 'resume_failed', false);
			}
		}
	}

	/** Close every channel (shutdown, or a link that will not come back). */
	closeAll(reason: FleetLinkCloseReason): void {
		for (const channel of [...this.channels.keys()]) this.finish(channel, reason, false);
	}

	private finish(channel: number, reason: FleetLinkCloseReason, tellPlatform: boolean, hint?: string): void {
		const entry = this.channels.get(channel);
		if (!entry) return;
		this.channels.delete(channel);
		this.retired.add(channel);
		if (tellPlatform) {
			const close: { type: 'channel.close'; channel: number; reason: FleetLinkCloseReason; hint?: string } = {
				type: 'channel.close',
				channel,
				reason
			};
			if (hint) close.hint = hint;
			this.sendControl(close);
		}
		try {
			entry.handler.onClose?.(reason);
		} catch {
			// the handler's failure is its own
		}
	}

	private contextFor(
		channel: number,
		family: FleetLinkFamily,
		params: Readonly<Record<string, unknown>>
	): NodeChannelContext {
		const live = (): ChannelEntry | null => {
			const entry = this.channels.get(channel);
			return entry && !entry.suspended ? entry : null;
		};
		return {
			channel,
			family,
			params,
			consents: this.options.consents,
			control: this.options.control,
			nodeVersion: this.options.nodeVersion,
			nodeName: this.options.nodeName,
			logger: this.options.logger,
			operations: this.options.operations,
			sendJson: (message) => (live() ? this.sendFrame(encodeFleetLinkJson(channel, message)) : false),
			sendBinary: (kind: FleetLinkFrameKind, payload: Uint8Array) => {
				const entry = live();
				if (!entry) return false;
				if (kind === FLEET_LINK_FRAME_KINDS.DATA && entry.credit !== null) {
					if (payload.byteLength > entry.credit) return false;
					const sent = this.sendFrame(encodeFleetLinkFrame(channel, kind, payload));
					if (sent) entry.credit -= payload.byteLength;
					return sent;
				}
				return this.sendFrame(encodeFleetLinkFrame(channel, kind, payload));
			},
			sendControl: (message: FleetLinkExtensionMessage) => this.sendControl(message),
			close: (reason, hint) => this.closeLocal(channel, reason, hint)
		};
	}
}
