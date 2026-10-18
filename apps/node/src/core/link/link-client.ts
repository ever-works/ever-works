import {
	decodeFleetLinkControl,
	decodeFleetLinkFrame,
	encodeFleetLinkControl,
	FLEET_LINK_AUTH_TIMEOUT_MS,
	FLEET_LINK_CLOSE_CODES,
	FLEET_LINK_DEFAULT_LIMITS,
	FLEET_LINK_HELLO_BLOCK_MS,
	FLEET_LINK_MAX_FRAME_BYTES,
	FLEET_LINK_MAX_JSON_BYTES,
	FLEET_LINK_REFUSED_RETRY_MS,
	FLEET_LINK_RESUME_WINDOW_MS,
	FLEET_LINK_VERSION,
	FLEET_LINK_WS_PATH,
	isFleetLinkControlMessage,
	isFleetLinkEligible,
	makeFleetLinkError,
	peekFleetLinkFrameChannel,
	type FleetConsents,
	type FleetLinkControlMessage,
	type FleetLinkError,
	type FleetLinkExtensionMessage,
	type FleetLinkHello,
	type FleetLinkLimits,
	type FleetLinkOperationDone,
	type FleetLinkResumeChannel
} from '@ever-works/contracts';
import { randomUUID } from 'node:crypto';
import { FleetClientError } from '../fleet-client';
import { systemScheduler, type Scheduler } from '../heartbeat';
import type { Logger } from '../logger';
import { ChannelMux } from './channel-mux';
import {
	isSecureLinkOrigin,
	LINK_SOCKET_OPEN,
	LinkBackoff,
	linkCloseCode,
	linkMessageBytes,
	toLinkWsUrl,
	type LinkSocketFactory,
	type LinkSocketLike
} from './link-socket';
import { composeNodeLinkModules } from './modules';
import { createLinkControlState, type LinkControlStateHolder } from './modules/control';
import type { ComposedNodeModules, NodeLinkControlState, NodeOperationReporter } from './modules/registry';

/**
 * Fleet node link — the node's end (FL-02, CONTRACTS §3.1).
 *
 * One outbound WebSocket per node, opened after the first ACCEPTED
 * heartbeat and only when this process was started with at least one of
 * `--work`, `--attend`, `--manage` (README D2). Nothing ever connects into
 * the machine; the platform opens channels on this socket and the node's
 * modules answer them.
 *
 *  1. Mint a link token through the node credential (`POST
 *     /api/fleet/link-token`): five minutes, single use, bound to this node.
 *     A `404` means the platform does not accept links (its flag is off, or
 *     it predates them): say so once and try again in five minutes.
 *  2. Open `wss://<origin>/ws/fleet/link`; the first frame is `link.hello`
 *     with the tags, the consents, the token, and — on a reconnect — the
 *     generation lost and the channels still held.
 *  3. `link.ready` makes the link connected: the backoff resets ONLY here
 *     (an open that is then refused is a failed attempt), resumed channels
 *     carry on, the rest close `resume_failed`.
 *  4. `link.ping` every 15 s; 45 s without any frame closes the link and
 *     reconnects 1 s → 30 s with jitter.
 *
 * Plain `http:` to anything but this machine's loopback never mints a
 * token and never opens a socket (spec FR-6). No payload is ever logged:
 * control messages are logged by `type` and ids only.
 */

export type NodeLinkPhase =
	/** Not started yet (waiting for an accepted heartbeat). */
	| 'idle'
	/** This process has no consent that opens a link. */
	| 'not-open'
	/** The platform origin is plain `http:` to another host. */
	| 'insecure'
	/** This runtime has no WebSocket client. */
	| 'unavailable'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	/** The platform does not accept links; retrying every five minutes. */
	| 'refused'
	| 'closed';

export interface NodeLinkState {
	phase: NodeLinkPhase;
	/** One line a person reads about why the link is in that phase, or null. */
	detail: string | null;
	linkGeneration: number | null;
	/** Epoch ms the current connection became ready, or null. */
	connectedSince: number | null;
	/** Epoch ms the last connection was lost, or null. */
	lastDisconnectAt: number | null;
	/** Bytes over the current connection. */
	bytesIn: number;
	bytesOut: number;
	openChannels: number;
	/** The fleet kill switch has this link paused. */
	paused: boolean;
	/** Delay until the next connection attempt, or null. */
	nextAttemptInMs: number | null;
}

export interface NodeLinkMintedToken {
	token: string;
	wsPath: string;
	expiresInSec?: number;
}

export interface NodeLinkOptions {
	/** The platform origin, as the heartbeat client resolved it. */
	apiUrl: string;
	nodeId: string;
	/** How hints name this machine (`build-01`); defaults to "this computer". */
	nodeName?: string;
	nodeVersion: string;
	consents: FleetConsents;
	/** The tags the hello carries — the same list the heartbeat reports. */
	capabilities: () => Promise<readonly string[]> | readonly string[];
	mintToken: () => Promise<NodeLinkMintedToken>;
	factory: LinkSocketFactory | null;
	modules?: ComposedNodeModules;
	logger?: Logger;
	scheduler?: Scheduler;
	now?: () => number;
	random?: () => number;
}

export interface NodeLink {
	getState(): NodeLinkState;
	onChange(listener: (state: NodeLinkState) => void): () => void;
	/** Begin connecting (idempotent). The runtime calls it on the first accepted heartbeat. */
	start(): void;
	/** Close the link for good: channels end `normal`, nothing reconnects. */
	close(): void;
	/** The kill-switch / drain state every module reads. */
	readonly control: NodeLinkControlState;
	readonly modules: ComposedNodeModules;
}

/** Operation completions kept for the next link when none is up (bounded). */
const MAX_PENDING_OPERATION_RESULTS = 64;
/** How long `link.ready` may take after the socket opened before the attempt counts as failed. */
const READY_TIMEOUT_MS = FLEET_LINK_AUTH_TIMEOUT_MS * 2;
const MAX_HELLO_TAGS = 64;

export function createNodeLink(options: NodeLinkOptions): NodeLink {
	return new NodeLinkClient(options);
}

class NodeLinkClient implements NodeLink {
	readonly control: LinkControlStateHolder = createLinkControlState();
	readonly modules: ComposedNodeModules;
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly backoff: LinkBackoff;
	private readonly mux: ChannelMux;
	private readonly listeners = new Set<(state: NodeLinkState) => void>();
	private readonly operations = new Map<string, { cancel: () => void }>();
	private pendingResults: FleetLinkOperationDone[] = [];
	private limits: FleetLinkLimits = FLEET_LINK_DEFAULT_LIMITS;
	private started = false;
	private closed = false;
	private socket: LinkSocketLike | null = null;
	private reconnectTimer: unknown = null;
	private tickTimer: unknown = null;
	private readyTimer: unknown = null;
	private resumeExpiry: unknown = null;
	private lastFrameAt = 0;
	/** The generation to present on the next hello (the last one this node held). */
	private previousGeneration: number | null = null;
	private resumeChannels: FleetLinkResumeChannel[] = [];
	private refusalLogged = false;
	/** The single-use token of the attempt in flight, protected in the logger until the attempt ends. */
	private attemptToken: string | null = null;
	private dropLogged = false;
	private state: NodeLinkState = {
		phase: 'idle',
		detail: null,
		linkGeneration: null,
		connectedSince: null,
		lastDisconnectAt: null,
		bytesIn: 0,
		bytesOut: 0,
		openChannels: 0,
		paused: false,
		nextAttemptInMs: null
	};

	constructor(private readonly options: NodeLinkOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
		this.now = options.now ?? (() => Date.now());
		this.backoff = new LinkBackoff({ random: options.random });
		this.modules =
			options.modules ??
			composeNodeLinkModules({
				inlineReplyMs: () => this.limits.inlineReplyMs,
				setTimer: (callback, ms) => this.scheduler.setTimeout(callback, ms),
				clearTimer: (handle) => this.scheduler.clearTimeout(handle)
			});
		const operations: NodeOperationReporter = {
			start: (cancel) => {
				const id = `op-${randomUUID()}`;
				this.operations.set(id, { cancel });
				return id;
			},
			progress: (operationId, progress) => {
				if (!this.operations.has(operationId)) return;
				if (this.state.phase === 'connected') {
					this.mux.sendControl({ type: 'operation.progress', operationId, progress });
				}
			},
			done: (operationId, outcome) => {
				if (!this.operations.delete(operationId)) return;
				let done: FleetLinkOperationDone = { type: 'operation.done', operationId };
				if (outcome.error) done.error = outcome.error;
				else done.result = outcome.result ?? null;
				if (encodeFleetLinkControl(done) === null) {
					// Over the control-message cap: no link would ever carry it, so
					// keeping it would retry it forever while the platform shows
					// "running". The operation ends, failed, saying why.
					done = {
						type: 'operation.done',
						operationId,
						error: makeFleetLinkError(
							'operation_failed',
							`the result was too large to send back (over ${Math.round(FLEET_LINK_MAX_JSON_BYTES / (1024 * 1024))} MiB)`
						)
					};
				}
				if (this.state.phase !== 'connected' || !this.mux.sendControl(done)) this.keepResult(done);
			}
		};
		this.mux = new ChannelMux({
			modules: this.modules,
			consents: options.consents,
			control: this.control,
			operations,
			nodeVersion: options.nodeVersion,
			nodeName: options.nodeName?.trim() || 'this computer',
			logger: options.logger
		});
		this.control.onChange(({ paused }) => this.patch({ paused }));
	}

	getState(): NodeLinkState {
		return { ...this.state, openChannels: this.mux.size };
	}

	onChange(listener: (state: NodeLinkState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	start(): void {
		if (this.started || this.closed) return;
		this.started = true;
		if (!isFleetLinkEligible(this.options.consents)) {
			this.patch({
				phase: 'not-open',
				detail: 'not open: this computer only reports health (start it with --work, --attend or --manage)'
			});
			this.options.logger?.info(
				'Node link not opened: no --work, --attend or --manage consent — this computer only reports health.'
			);
			return;
		}
		if (!isSecureLinkOrigin(this.options.apiUrl)) {
			this.patch({ phase: 'insecure', detail: 'not open: the platform is reached over plain http' });
			this.options.logger?.warn(
				'Node link not opened: the platform is reached over plain http, and a link token is only sent over https (or to localhost).'
			);
			return;
		}
		if (!this.options.factory) {
			this.patch({ phase: 'unavailable', detail: 'not open: this runtime has no WebSocket client' });
			this.options.logger?.warn('Node link not opened: this runtime has no WebSocket client.');
			return;
		}
		void this.connect();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimer('reconnectTimer');
		this.clearTimer('tickTimer');
		this.clearTimer('readyTimer');
		this.clearTimer('resumeExpiry');
		this.mux.closeAll('normal');
		const socket = this.socket;
		this.socket = null;
		this.mux.bind(null);
		if (socket) {
			this.detach(socket);
			try {
				socket.close(FLEET_LINK_CLOSE_CODES.normal, 'node shutting down');
			} catch {
				// already gone
			}
		}
		this.forgetToken();
		for (const operation of this.operations.values()) operation.cancel();
		this.operations.clear();
		this.patch({ phase: 'closed', detail: null, nextAttemptInMs: null, linkGeneration: null });
	}

	// ─── Connecting ────────────────────────────────────────────────────────

	private async connect(): Promise<void> {
		if (this.closed) return;
		this.patch({
			phase: this.previousGeneration === null ? 'connecting' : 'reconnecting',
			nextAttemptInMs: null
		});
		let minted: NodeLinkMintedToken;
		try {
			minted = await this.options.mintToken();
		} catch (error) {
			if (this.closed) return;
			if (error instanceof FleetClientError && error.status === 404) {
				this.refused();
				return;
			}
			this.options.logger?.warn(`Node link: could not get a link token: ${describe(error)}`);
			this.scheduleReconnect(this.backoff.next());
			return;
		}
		if (this.closed) return;
		this.forgetToken();
		this.attemptToken = minted.token;
		this.options.logger?.protect(minted.token);
		let capabilities: string[];
		try {
			capabilities = [...(await this.options.capabilities())].slice(0, MAX_HELLO_TAGS);
		} catch {
			capabilities = [];
		}
		if (this.closed) return;
		let socket: LinkSocketLike;
		try {
			socket = this.options.factory!(toLinkWsUrl(this.options.apiUrl, minted.wsPath || FLEET_LINK_WS_PATH));
		} catch (error) {
			this.forgetToken();
			this.options.logger?.warn(`Node link: could not open a socket: ${describe(error)}`);
			this.scheduleReconnect(this.backoff.next());
			return;
		}
		this.socket = socket;
		this.patch({ bytesIn: 0, bytesOut: 0 });
		socket.onopen = () => {
			if (this.socket !== socket) return;
			const hello: FleetLinkHello = {
				type: 'link.hello',
				nodeId: this.options.nodeId,
				linkVersion: FLEET_LINK_VERSION,
				capabilities,
				consents: { ...this.options.consents },
				token: minted.token,
				nodeVersion: this.options.nodeVersion
			};
			if (this.previousGeneration !== null) {
				hello.resume = { linkGeneration: this.previousGeneration, channels: this.resumeChannels };
			}
			// Opening is not acceptance: the backoff is NOT reset here.
			this.mux.bind((frame) => this.sendOn(socket, frame));
			this.mux.sendControl(hello);
			this.lastFrameAt = this.now();
			this.clearTimer('readyTimer');
			this.readyTimer = this.scheduler.setTimeout(() => {
				this.readyTimer = null;
				if (this.socket === socket && this.state.phase !== 'connected') {
					this.dropSocket(socket, FLEET_LINK_CLOSE_CODES.protocol, 'no link.ready');
				}
			}, READY_TIMEOUT_MS);
		};
		socket.onmessage = (event) => {
			if (this.socket === socket) this.onBytes(event.data);
		};
		socket.onerror = () => undefined;
		socket.onclose = (event) => {
			if (this.socket === socket) this.dropSocket(socket, linkCloseCode(event), null);
		};
	}

	private refused(): void {
		this.patch({
			phase: 'refused',
			detail: 'refused by the platform: this deployment does not accept node links yet'
		});
		if (!this.refusalLogged) {
			this.refusalLogged = true;
			this.options.logger?.info('The platform does not accept node links yet — trying again in 5 minutes.');
		}
		this.scheduleReconnect(FLEET_LINK_REFUSED_RETRY_MS);
	}

	private scheduleReconnect(delayMs: number): void {
		if (this.closed) return;
		this.clearTimer('reconnectTimer');
		this.patch({ nextAttemptInMs: delayMs });
		this.reconnectTimer = this.scheduler.setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect();
		}, delayMs);
	}

	// ─── Receiving ─────────────────────────────────────────────────────────

	private onBytes(data: unknown): void {
		const bytes = linkMessageBytes(data);
		if (!bytes) return; // the link is binary-only
		this.lastFrameAt = this.now();
		this.state.bytesIn += bytes.byteLength;
		if (bytes.byteLength > FLEET_LINK_MAX_FRAME_BYTES) {
			// Refused before parse; only the channel it was aimed at closes (spec U5).
			const channel = peekFleetLinkFrameChannel(bytes);
			if (channel !== null && channel > 0) this.mux.closeLocal(channel, 'invalid', 'frame over 16 MiB');
			return;
		}
		const frame = decodeFleetLinkFrame(bytes);
		if (!frame) return;
		if (frame.channel !== 0) {
			if (this.state.phase === 'connected') this.mux.deliver(frame);
			return;
		}
		const message = decodeFleetLinkControl(frame.payload);
		if (!message) return;
		if (isFleetLinkControlMessage(message)) this.onControl(message);
		else if (this.state.phase === 'connected') this.onExtension(message);
	}

	private onControl(message: FleetLinkControlMessage): void {
		if (this.state.phase !== 'connected') {
			if (message.type === 'link.ready') this.onReady(message);
			return;
		}
		switch (message.type) {
			case 'link.ping':
				this.mux.sendControl({ type: 'link.pong', t: message.t });
				return;
			case 'link.pause':
				if (!this.control.paused) {
					this.options.logger?.warn('The fleet kill switch is on: live actions on this computer are paused.');
				}
				this.control.pause();
				return;
			case 'link.resume':
				if (this.control.paused)
					this.options.logger?.info('The fleet kill switch was cleared: live actions resume.');
				this.control.resume();
				return;
			case 'link.drain':
				this.options.logger?.warn(`Drain all: owner sessions on this computer end in ${message.graceSec} s.`);
				this.control.startDrain(message, this.now());
				return;
			case 'channel.open':
				this.mux.open(message).catch((error: unknown) => {
					this.options.logger?.warn(
						`Node link: opening channel ${message.channel} failed: ${describe(error)}`
					);
				});
				return;
			case 'channel.close':
				this.mux.closeRemote(message.channel, message.reason);
				return;
			case 'operation.cancel':
				this.operations.get(message.operationId)?.cancel();
				return;
			default:
				// hello / ready / node-side messages echoed back: nothing to do.
				return;
		}
	}

	private onReady(message: Extract<FleetLinkControlMessage, { type: 'link.ready' }>): void {
		const socket = this.socket;
		if (!socket) return;
		this.clearTimer('readyTimer');
		this.clearTimer('resumeExpiry');
		this.forgetToken();
		this.limits = message.limits;
		this.previousGeneration = message.linkGeneration;
		// A pause belongs to the link that carried it. The platform sends
		// `link.pause` right after `link.ready` while its kill switch is on,
		// so a pause from an earlier link — whose `link.resume` this computer
		// was not connected to hear — must not outlive it.
		if (this.control.paused) {
			this.control.resume();
			this.options.logger?.info(
				'Node link reconnected: the earlier pause is lifted unless the platform repeats it.'
			);
		}
		this.resumeChannels = [];
		this.backoff.reset();
		this.refusalLogged = false;
		this.dropLogged = false;
		this.patch({
			phase: 'connected',
			detail: null,
			linkGeneration: message.linkGeneration,
			connectedSince: this.now(),
			nextAttemptInMs: null
		});
		this.mux.resumeGeneration(message.resumed, message.closed);
		this.options.logger?.info(
			`Node link connected (generation ${message.linkGeneration}${
				message.resumed.length > 0 ? `, ${message.resumed.length} channel(s) resumed` : ''
			}).`
		);
		this.flushResults();
		this.scheduleTick();
	}

	private onExtension(message: FleetLinkExtensionMessage): void {
		const handler = this.modules.controlHandler(message.type);
		if (!handler) return;
		try {
			handler(message, { consents: this.options.consents, control: this.control, logger: this.options.logger });
		} catch (error) {
			this.options.logger?.warn(`Node link: ${message.type} handler failed: ${describe(error)}`);
		}
	}

	// ─── Keeping it alive ──────────────────────────────────────────────────

	private scheduleTick(): void {
		this.clearTimer('tickTimer');
		this.tickTimer = this.scheduler.setTimeout(() => {
			this.tickTimer = null;
			this.tick();
		}, this.limits.pingIntervalMs);
	}

	private tick(): void {
		const socket = this.socket;
		if (!socket || this.state.phase !== 'connected') return;
		if (this.now() - this.lastFrameAt >= this.limits.silenceMs) {
			this.options.logger?.warn(
				`Node link: nothing heard for ${Math.round(this.limits.silenceMs / 1000)} s — reconnecting.`
			);
			this.dropSocket(socket, FLEET_LINK_CLOSE_CODES.silence, 'silence');
			return;
		}
		this.mux.sendControl({ type: 'link.ping', t: this.now() });
		this.scheduleTick();
	}

	/**
	 * The socket is gone (closed by the platform, by silence, or by us). Run
	 * the drop once: suspend resumable channels, then decide whether and when
	 * to come back.
	 */
	private dropSocket(socket: LinkSocketLike, code: number | null, reason: string | null): void {
		if (this.socket !== socket) return;
		this.socket = null;
		this.detach(socket);
		this.forgetToken();
		if (reason !== null) {
			try {
				socket.close(code ?? FLEET_LINK_CLOSE_CODES.normal, reason);
			} catch {
				// already gone
			}
		}
		this.clearTimer('tickTimer');
		this.clearTimer('readyTimer');
		const wasConnected = this.state.phase === 'connected';
		this.resumeChannels = this.mux.suspend();
		this.patch({ linkGeneration: null, connectedSince: null, lastDisconnectAt: this.now() });
		if (this.closed) return;
		if (this.resumeChannels.length > 0) this.armResumeExpiry();
		if (code === FLEET_LINK_CLOSE_CODES.disabled) {
			this.refused();
			return;
		}
		if (code === FLEET_LINK_CLOSE_CODES.noConsent) {
			this.mux.closeAll('consent_missing');
			this.patch({ phase: 'not-open', detail: 'refused by the platform: no consent that opens a link' });
			this.options.logger?.warn('The platform refused the node link: no --work, --attend or --manage consent.');
			return;
		}
		if (code === FLEET_LINK_CLOSE_CODES.replaced) {
			this.options.logger?.warn('Node link replaced by a newer link for this node — is it running twice?');
		}
		const wait =
			code === FLEET_LINK_CLOSE_CODES.rateLimited
				? Math.max(this.backoff.next(), FLEET_LINK_HELLO_BLOCK_MS)
				: this.backoff.next();
		if (wasConnected && !this.dropLogged) {
			this.dropLogged = true;
			this.options.logger?.warn(
				`Node link lost${code !== null ? ` (code ${code})` : ''} — reconnecting in ${Math.round(wait / 1000)} s.`
			);
		}
		this.patch({ phase: 'reconnecting', detail: 'reconnecting' });
		this.scheduleReconnect(wait);
	}

	/** Channels held for a reconnect close `resume_failed` if none comes within the window. */
	private armResumeExpiry(): void {
		this.clearTimer('resumeExpiry');
		this.resumeExpiry = this.scheduler.setTimeout(() => {
			this.resumeExpiry = null;
			if (this.state.phase === 'connected') return;
			this.mux.closeAll('resume_failed');
			this.resumeChannels = [];
		}, FLEET_LINK_RESUME_WINDOW_MS);
	}

	// ─── Sending ───────────────────────────────────────────────────────────

	private sendOn(socket: LinkSocketLike, frame: Uint8Array): boolean {
		if (this.socket !== socket || socket.readyState !== LINK_SOCKET_OPEN) return false;
		try {
			socket.send(frame);
		} catch {
			return false;
		}
		this.state.bytesOut += frame.byteLength;
		return true;
	}

	private keepResult(done: FleetLinkOperationDone): void {
		this.pendingResults.push(done);
		if (this.pendingResults.length > MAX_PENDING_OPERATION_RESULTS) this.pendingResults.shift();
	}

	private flushResults(): void {
		const pending = this.pendingResults;
		this.pendingResults = [];
		for (const done of pending) {
			if (!this.mux.sendControl(done)) this.keepResult(done);
		}
	}

	// ─── Plumbing ──────────────────────────────────────────────────────────

	/** A link token is single-use: once its attempt ended it is dead, and need not stay in the redactor. */
	private forgetToken(): void {
		if (this.attemptToken === null) return;
		this.options.logger?.unprotect(this.attemptToken);
		this.attemptToken = null;
	}

	private detach(socket: LinkSocketLike): void {
		socket.onopen = null;
		socket.onmessage = null;
		socket.onclose = null;
		socket.onerror = null;
		this.mux.bind(null);
	}

	private clearTimer(name: 'reconnectTimer' | 'tickTimer' | 'readyTimer' | 'resumeExpiry'): void {
		const handle = this[name];
		if (handle !== null) {
			this.scheduler.clearTimeout(handle);
			this[name] = null;
		}
	}

	private patch(next: Partial<NodeLinkState>): void {
		this.state = { ...this.state, ...next };
		const snapshot = this.getState();
		for (const listener of [...this.listeners]) {
			try {
				listener(snapshot);
			} catch {
				// a listener's failure is its own
			}
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A link error for a channel refusal, as the hub shows it. Exported for the shells' status lines. */
export function describeLinkError(error: FleetLinkError): string {
	return `${error.code}: ${error.hint}`;
}
