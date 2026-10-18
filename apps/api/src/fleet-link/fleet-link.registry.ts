import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
    asFleetLinkReply,
    decodeFleetLinkControl,
    decodeFleetLinkJson,
    encodeFleetLinkControl,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_CHANNEL_OPEN_TIMEOUT_MS,
    FLEET_LINK_DEFAULT_LIMITS,
    FLEET_LINK_FRAME_HEADER_BYTES,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_MAX_CHANNEL_NUMBER,
    FLEET_LINK_MAX_CHANNELS,
    FLEET_LINK_MAX_PAYLOAD_BYTES,
    FLEET_LINK_REQUEST_TIMEOUT_MS,
    FLEET_LINK_RESUME_WINDOW_MS,
    fleetConsentMissingHint,
    fleetConsentSatisfies,
    fleetConsentsDiffer,
    isFleetLinkControlMessage,
    type FleetConsents,
    type FleetLinkCloseReason,
    type FleetLinkControlMessage,
    type FleetLinkExtensionMessage,
    type FleetLinkFamily,
    type FleetLinkFrame,
    type FleetLinkFrameKind,
    type FleetLinkHello,
    type FleetLinkOperationDone,
    type FleetLinkOperationProgress,
    type FleetLinkReady,
    type FleetLinkReply,
    type FleetNodeLinkView,
} from '@ever-works/contracts';
import { FleetLinkException, fleetLinkError } from './fleet-link.errors';
import type { FleetLinkRequirement } from './fleet-link.types';

/**
 * Fleet node link — the platform's registry of live links and their
 * channels (FL-02, CONTRACTS §3).
 *
 * Transport-free, like the terminal and computer relays: a link is anything
 * with `send(frame)` and `close(code, reason)`, which is what makes the whole
 * accept / open / refuse / resume / drop matrix testable without a socket.
 * The gateway adapts real WebSockets onto it; `FleetLinkService` is the one
 * caller every epic goes through.
 *
 * Rules held here:
 *
 *  - **One link per node.** A newer accepted hello replaces an older link
 *    (closed `4010`), whose resumable channels become that hello's to resume.
 *  - **Generations.** Each accepted link gets `max(last, presented) + 1`, so a
 *    generation never repeats for a node even across an API restart. A link
 *    that dropped before the node sent anything on it may never have reached
 *    the node's `link.ready`: the generation it resumed from still counts as
 *    the node's current one.
 *  - **Wire order on accept.** The registry sends `link.ready` itself, then the
 *    pause in force, and only then tells a resumed channel's listeners and the
 *    link listeners — so nothing they send can reach the node before the
 *    ready it would drop it for.
 *  - **Channels are the platform's.** Numbers are allocated from 1 upward per
 *    link, never reused on a generation; at most {@link FLEET_LINK_MAX_CHANNELS}.
 *  - **Resume.** A dropped link's channels that the node acknowledged with a
 *    `resumeKey` are kept for {@link FLEET_LINK_RESUME_WINDOW_MS}; a reconnect
 *    presenting that generation and those channels resumes them — unless the
 *    node no longer holds the consent they need, which closes them
 *    `consent_missing`. Everything else closes `resume_failed`.
 *  - **Consent withdrawn** (a heartbeat with fewer consents) closes every
 *    channel whose family needs what is gone, telling the node.
 *  - **Kill switch.** While paused, every link has been told `link.pause`
 *    (and a link accepted meanwhile is told right after its ready); clearing
 *    sends `link.resume`. The node lifts a pause on every new ready, so a
 *    link that missed the resume is not left paused. Refusing NEW opens is the
 *    authoriser's job.
 *  - **Channels are opened by the platform.** A node that sends
 *    `channel.open` is answered `channel.refused` (`invalid`); nothing opens.
 *
 * No payload is ever logged — control messages by `type` and ids only.
 */

export interface FleetLinkSocketPort {
    /** Send one binary frame; false when it could not be sent (closed, backed up). */
    send(frame: Uint8Array): boolean;
    close(code: number, reason: string): void;
}

/** What a caller listens to on a channel. */
export interface FleetLinkChannelEvents {
    json?(message: Record<string, unknown>): void;
    binary?(kind: FleetLinkFrameKind, payload: Uint8Array): void;
    close?(reason: FleetLinkCloseReason, hint?: string): void;
    resume?(linkGeneration: number): void;
}

export interface FleetLinkRegistryOptions {
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    requestTimeoutMs?: number;
    openTimeoutMs?: number;
    resumeWindowMs?: number;
}

export const FLEET_LINK_REGISTRY_OPTIONS = 'FLEET_LINK_REGISTRY_OPTIONS' as const;

export interface FleetLinkAcceptInput {
    nodeId: string;
    ownerUserId: string;
    nodeName: string;
    nodeKind: string;
    hello: FleetLinkHello;
    socket: FleetLinkSocketPort;
}

/** The gateway's handle on one accepted link. */
export interface FleetLinkSession {
    readonly nodeId: string;
    readonly linkGeneration: number;
    /** The ready the registry sent as this link's first frame. */
    readonly ready: FleetLinkReady;
    /** Epoch ms of the last frame received. */
    lastFrameAt(): number;
    /** A decoded frame from the node. */
    receive(frame: FleetLinkFrame): void;
    /** The node sent a frame over the cap for `channel`; only that channel closes (spec U5). */
    refuseOversized(channel: number | null): void;
    /** The socket is gone. */
    dropped(reason: string): void;
}

/** A long request's id, as a node replied. */
export type FleetLinkRequestReply = FleetLinkReply;

interface PendingRequest {
    resolve(reply: FleetLinkRequestReply): void;
    reject(error: FleetLinkException): void;
    timer: unknown;
}

interface ChannelEntry {
    channel: number;
    family: FleetLinkFamily;
    params: Record<string, unknown>;
    requirement: FleetLinkRequirement;
    requestedBy: string;
    state: 'opening' | 'open' | 'suspended' | 'closed';
    resumeKey?: string;
    link: LinkEntry | null;
    listeners: Set<FleetLinkChannelEvents>;
    pending: Map<string, PendingRequest>;
    opening: {
        requestId: string;
        resolve(): void;
        reject(error: FleetLinkException): void;
        timer: unknown;
    } | null;
    handle: FleetLinkChannelHandle;
}

interface LinkEntry {
    id: number;
    nodeId: string;
    ownerUserId: string;
    nodeName: string;
    nodeKind: string;
    nodeVersion: string | null;
    generation: number;
    consents: FleetConsents;
    capabilities: string[];
    socket: FleetLinkSocketPort;
    channels: Map<number, ChannelEntry>;
    retired: Set<number>;
    nextChannel: number;
    connectedAt: number;
    lastFrameAt: number;
    bytesIn: number;
    bytesOut: number;
    machine: Promise<FleetLinkChannelHandle> | null;
    dropped: boolean;
    /** The generation this link's hello resumed from, or null for a fresh hello. */
    resumedFrom: number | null;
    /** True once any frame arrived on this link — the node had its `link.ready`. */
    heard: boolean;
}

interface Orphan {
    generation: number;
    /**
     * Also accepted as "the same node process": the generation the dropped
     * link resumed from, when the node was never heard on it (its ready may
     * not have arrived). Null otherwise.
     */
    alsoGeneration: number | null;
    channels: ChannelEntry[];
    timer: unknown;
}

/**
 * A caller's face of one channel: survives a resume (the same handle keeps
 * working on the next generation) and refuses everything once closed.
 */
export class FleetLinkChannelHandle {
    constructor(
        private readonly registry: FleetLinkRegistry,
        private readonly entry: () => ChannelEntry,
    ) {}

    get nodeId(): string {
        return this.registry.nodeOf(this.entry());
    }

    get channel(): number {
        return this.entry().channel;
    }

    get family(): FleetLinkFamily {
        return this.entry().family;
    }

    get isOpen(): boolean {
        return this.entry().state === 'open';
    }

    get isClosed(): boolean {
        return this.entry().state === 'closed';
    }

    get linkGeneration(): number | null {
        return this.entry().link?.generation ?? null;
    }

    /** Send a request on this channel; resolves the node's reply (result, error or operation id). */
    request(
        verb: string,
        params: Record<string, unknown> = {},
        options: { timeoutMs?: number } = {},
    ): Promise<FleetLinkRequestReply> {
        return this.registry.requestOn(this.entry(), verb, params, options.timeoutMs);
    }

    sendJson(message: Record<string, unknown>): boolean {
        return this.registry.sendOn(
            this.entry(),
            encodeFleetLinkJson(this.entry().channel, message),
        );
    }

    sendBinary(kind: FleetLinkFrameKind, payload: Uint8Array): boolean {
        return this.registry.sendOn(
            this.entry(),
            encodeFleetLinkFrame(this.entry().channel, kind, payload),
        );
    }

    close(reason: FleetLinkCloseReason = 'normal', hint?: string): void {
        this.registry.finish(this.entry(), reason, hint, true);
    }

    /** Listen; returns the unsubscribe. */
    listen(events: FleetLinkChannelEvents): () => void {
        const entry = this.entry();
        entry.listeners.add(events);
        return () => {
            entry.listeners.delete(events);
        };
    }
}

/**
 * A link came or went. `continued` is true when the hello presented the
 * generation this platform last issued the node (the same node process,
 * reconnecting) — or when this platform has no record to compare (it
 * restarted); false for a fresh node process.
 */
export type FleetLinkEvent =
    | { type: 'connected'; nodeId: string; linkGeneration: number; continued: boolean }
    | { type: 'dropped'; nodeId: string; reason: string };

/** What the operations service is handed from channel 0. */
export type FleetLinkOperationMessage = FleetLinkOperationProgress | FleetLinkOperationDone;

@Injectable()
export class FleetLinkRegistry {
    private readonly logger = new Logger(FleetLinkRegistry.name);
    private readonly links = new Map<string, LinkEntry>();
    private readonly orphans = new Map<string, Orphan>();
    private readonly generations = new Map<string, number>();
    /** Epoch ms each node's last link dropped, for the "reconnecting" state. */
    private readonly lastDrop = new Map<string, number>();
    /**
     * Per node: the generation its last link resumed from, when that link
     * dropped before the node was heard on it (see the class doc).
     */
    private readonly unconfirmedFrom = new Map<string, number>();
    private readonly controlListeners = new Map<
        string,
        Set<(nodeId: string, message: FleetLinkExtensionMessage) => void>
    >();
    private operationSink: ((nodeId: string, message: FleetLinkOperationMessage) => void) | null =
        null;
    private readonly linkListeners = new Set<(event: FleetLinkEvent) => void>();
    private paused = false;
    private nextLinkId = 1;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly requestTimeoutMs: number;
    private readonly openTimeoutMs: number;
    private readonly resumeWindowMs: number;

    constructor(
        @Optional() @Inject(FLEET_LINK_REGISTRY_OPTIONS) options?: FleetLinkRegistryOptions,
    ) {
        this.now = options?.now ?? (() => Date.now());
        this.setTimer =
            options?.setTimer ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms);
                timer.unref?.();
                return timer;
            });
        this.clearTimer =
            options?.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
        this.requestTimeoutMs = options?.requestTimeoutMs ?? FLEET_LINK_REQUEST_TIMEOUT_MS;
        this.openTimeoutMs = options?.openTimeoutMs ?? FLEET_LINK_CHANNEL_OPEN_TIMEOUT_MS;
        this.resumeWindowMs = options?.resumeWindowMs ?? FLEET_LINK_RESUME_WINDOW_MS;
    }

    // ─── Links ─────────────────────────────────────────────────────────────

    /** Accept a verified hello: replace any older link, resume what can be resumed, answer ready. */
    accept(input: FleetLinkAcceptInput): FleetLinkSession {
        const { nodeId, hello } = input;
        const existing = this.links.get(nodeId);
        if (existing) {
            try {
                existing.socket.close(4010, 'replaced');
            } catch {
                // already gone
            }
            this.drop(existing, 'replaced');
        }
        const now = this.now();
        const previous = this.generations.get(nodeId) ?? 0;
        const presented = hello.resume?.linkGeneration;
        const unconfirmed = this.unconfirmedFrom.get(nodeId);
        this.unconfirmedFrom.delete(nodeId);
        const continued =
            presented !== undefined &&
            (previous === 0 || presented === previous || presented === unconfirmed);
        const generation = Math.max(previous, presented ?? 0) + 1;
        this.generations.set(nodeId, generation);
        const link: LinkEntry = {
            id: this.nextLinkId++,
            nodeId,
            ownerUserId: input.ownerUserId,
            nodeName: input.nodeName,
            nodeKind: input.nodeKind,
            nodeVersion: hello.nodeVersion ?? null,
            generation,
            consents: { ...hello.consents },
            capabilities: [...hello.capabilities],
            socket: input.socket,
            channels: new Map(),
            retired: new Set(),
            nextChannel: 1,
            connectedAt: now,
            lastFrameAt: now,
            bytesIn: 0,
            bytesOut: 0,
            machine: null,
            dropped: false,
            resumedFrom: presented ?? null,
            heard: false,
        };
        const resumed: number[] = [];
        const closed: number[] = [];
        // Told only after `link.ready` (and a pause in force) is on the wire.
        const resumedEntries: ChannelEntry[] = [];
        const offered = new Map(
            (hello.resume?.channels ?? []).map((offer) => [offer.channel, offer]),
        );
        const orphan = this.orphans.get(nodeId);
        if (orphan) {
            this.orphans.delete(nodeId);
            this.clearTimer(orphan.timer);
            for (const entry of orphan.channels) {
                const offer = offered.get(entry.channel);
                offered.delete(entry.channel);
                const sameChannel =
                    presented !== undefined &&
                    (presented === orphan.generation || presented === orphan.alsoGeneration) &&
                    offer !== undefined &&
                    offer.family === entry.family &&
                    offer.resumeKey === entry.resumeKey;
                if (
                    sameChannel &&
                    fleetConsentSatisfies(link.consents, entry.requirement.consent)
                ) {
                    entry.state = 'open';
                    entry.link = link;
                    link.channels.set(entry.channel, entry);
                    resumed.push(entry.channel);
                    // The shared machine channel carries on as the new link's.
                    if (entry.family === 'machine' && !link.machine)
                        link.machine = Promise.resolve(entry.handle);
                    resumedEntries.push(entry);
                    continue;
                }
                if (offer) closed.push(entry.channel);
                this.finish(
                    entry,
                    sameChannel ? 'consent_missing' : 'resume_failed',
                    sameChannel
                        ? fleetConsentMissingHint(entry.requirement.consent, link.nodeName)
                        : undefined,
                    false,
                );
            }
        }
        // Channels the node still holds that the platform does not.
        for (const channel of offered.keys()) closed.push(channel);
        link.nextChannel = resumed.length > 0 ? Math.max(...resumed) + 1 : 1;
        this.links.set(nodeId, link);
        this.lastDrop.delete(nodeId);
        const ready: FleetLinkReady = {
            type: 'link.ready',
            linkGeneration: generation,
            limits: { ...FLEET_LINK_DEFAULT_LIMITS },
            serverTime: new Date(now).toISOString(),
            resumed,
            closed,
        };
        // Wire order: the ready, the pause in force, then whatever a resumed
        // channel's listeners or the link listeners send. The node drops
        // channel frames until it has its ready.
        this.sendControl(link, ready);
        if (this.paused) this.sendControl(link, { type: 'link.pause', reason: 'kill_switch' });
        for (const entry of resumedEntries) {
            if (entry.state !== 'open' || entry.link !== link) continue;
            for (const listener of [...entry.listeners]) {
                try {
                    listener.resume?.(generation);
                } catch (error) {
                    this.logger.warn(`link channel resume listener failed: ${describe(error)}`);
                }
            }
        }
        if (!link.dropped) {
            this.emitLink({ type: 'connected', nodeId, linkGeneration: generation, continued });
        }
        const registry = this;
        return {
            nodeId,
            linkGeneration: generation,
            ready,
            lastFrameAt: () => link.lastFrameAt,
            receive: (frame) => registry.receive(link, frame),
            refuseOversized: (channel) => registry.refuseOversized(link, channel),
            dropped: (reason) => registry.drop(link, reason),
        };
    }

    isConnected(nodeId: string): boolean {
        return this.links.has(nodeId);
    }

    /** Ids of every connected node. */
    connectedNodeIds(): string[] {
        return [...this.links.keys()];
    }

    /** The consents the live link presented, or null when there is no link. */
    liveConsents(nodeId: string): FleetConsents | null {
        const link = this.links.get(nodeId);
        return link ? { ...link.consents } : null;
    }

    /** The node's daemon version as its hello said, or null. */
    nodeVersion(nodeId: string): string | null {
        return this.links.get(nodeId)?.nodeVersion ?? null;
    }

    /** The link as the platform's own socket sees it (spec FR-42). */
    linkView(node: { id: string; kind: string }, linkAccepted: boolean): FleetNodeLinkView {
        const link = this.links.get(node.id);
        if (link) {
            return {
                state: 'connected',
                since: new Date(link.connectedAt).toISOString(),
                linkGeneration: link.generation,
                bytesIn: link.bytesIn,
                bytesOut: link.bytesOut,
                openChannels: [...link.channels.values()].filter((entry) => entry.state === 'open')
                    .length,
            };
        }
        const base = {
            since: null,
            linkGeneration: null,
            bytesIn: 0,
            bytesOut: 0,
            openChannels: 0,
        };
        if (!linkAccepted) return { ...base, state: 'refused' };
        const droppedAt = this.lastDrop.get(node.id);
        if (droppedAt !== undefined && this.now() - droppedAt < this.resumeWindowMs) {
            return { ...base, state: 'reconnecting', since: new Date(droppedAt).toISOString() };
        }
        // The desktop shell cannot report consents (and so open a link) yet (CONTRACTS R-10).
        if (node.kind === 'desktop-node') return { ...base, state: 'unsupported-kind' };
        return { ...base, state: 'not-open' };
    }

    // ─── Kill switch, drain, consents ──────────────────────────────────────

    get isPaused(): boolean {
        return this.paused;
    }

    /** Pause or resume every link (the kill switch). Idempotent. */
    setPaused(paused: boolean): void {
        if (this.paused === paused) return;
        this.paused = paused;
        for (const link of this.links.values()) {
            this.sendControl(
                link,
                paused ? { type: 'link.pause', reason: 'kill_switch' } : { type: 'link.resume' },
            );
        }
    }

    /** Drain-all: tell each connected node to warn and end its owner sessions after `graceSec`. */
    drainNodes(nodeIds: readonly string[], graceSec: number): number {
        let told = 0;
        for (const nodeId of nodeIds) {
            const link = this.links.get(nodeId);
            if (link && this.sendControl(link, { type: 'link.drain', graceSec })) told += 1;
        }
        return told;
    }

    /**
     * A heartbeat reported `consents`. When they differ from the link's, the
     * link takes them and every channel whose family needs a consent no longer
     * held closes `consent_missing`, the node told (spec FR-22).
     */
    applyConsents(nodeId: string, consents: FleetConsents): number {
        const link = this.links.get(nodeId);
        if (!link || !fleetConsentsDiffer(link.consents, consents)) return 0;
        link.consents = { ...consents };
        let closedCount = 0;
        for (const entry of [...link.channels.values()]) {
            if (!fleetConsentSatisfies(consents, entry.requirement.consent)) {
                this.finish(
                    entry,
                    'consent_missing',
                    fleetConsentMissingHint(entry.requirement.consent, link.nodeName),
                    true,
                );
                closedCount += 1;
            }
        }
        return closedCount;
    }

    /** Close every link (shutdown, or the feature switched off). */
    closeAll(code: number, reason: string): void {
        for (const link of [...this.links.values()]) {
            try {
                link.socket.close(code, reason);
            } catch {
                // already gone
            }
            this.drop(link, reason, false);
        }
        for (const [nodeId, orphan] of [...this.orphans]) {
            this.orphans.delete(nodeId);
            this.clearTimer(orphan.timer);
            for (const entry of orphan.channels)
                this.finish(entry, 'unreachable', undefined, false);
        }
    }

    /** Close one node's link (its node was disabled or deleted). */
    closeNode(nodeId: string, code: number, reason: string): void {
        const link = this.links.get(nodeId);
        if (!link) return;
        try {
            link.socket.close(code, reason);
        } catch {
            // already gone
        }
        this.drop(link, reason, false);
    }

    // ─── Channels ──────────────────────────────────────────────────────────

    /**
     * Open a channel on `nodeId`'s link and resolve once the node accepted
     * it. Throws `unreachable` (no link, or no answer in time),
     * `limit_exceeded` (64 open), or the node's own refusal. The caller has
     * already been authorised.
     */
    async openChannel(input: {
        nodeId: string;
        family: FleetLinkFamily;
        params?: Record<string, unknown>;
        requirement: FleetLinkRequirement;
        requestedBy: string;
        events?: FleetLinkChannelEvents;
    }): Promise<FleetLinkChannelHandle> {
        const link = this.links.get(input.nodeId);
        if (!link) throw fleetLinkError('unreachable', 'the computer is not connected');
        const open = [...link.channels.values()].filter((entry) => entry.state !== 'closed').length;
        if (open >= FLEET_LINK_MAX_CHANNELS) {
            throw fleetLinkError(
                'limit_exceeded',
                `${FLEET_LINK_MAX_CHANNELS} channels are open on ${link.nodeName}; close one`,
                { limit: FLEET_LINK_MAX_CHANNELS },
            );
        }
        const channel = this.allocate(link);
        const requestId = `open-${randomUUID()}`;
        let entry!: ChannelEntry;
        entry = {
            channel,
            family: input.family,
            params: input.params ?? {},
            requirement: input.requirement,
            requestedBy: input.requestedBy,
            state: 'opening',
            link,
            listeners: new Set(input.events ? [input.events] : []),
            pending: new Map(),
            opening: null,
            handle: new FleetLinkChannelHandle(this, () => entry),
        };
        link.channels.set(channel, entry);
        const opened = new Promise<void>((resolve, reject) => {
            entry.opening = {
                requestId,
                resolve,
                reject,
                timer: this.setTimer(() => {
                    this.finish(
                        entry,
                        'unreachable',
                        `${link.nodeName} did not answer within ${Math.round(this.openTimeoutMs / 1000)} s`,
                        true,
                    );
                }, this.openTimeoutMs),
            };
        });
        const sent = this.sendControl(link, {
            type: 'channel.open',
            channel,
            family: input.family,
            params: entry.params,
            requestId,
        });
        if (!sent) this.finish(entry, 'unreachable', 'the link could not carry the request', false);
        await opened;
        return entry.handle;
    }

    /**
     * The `machine` channel of a node's link: opened lazily on first use and
     * shared by every request on that link (CONTRACTS §3.3 "one per link").
     */
    machineChannel(nodeId: string, requestedBy: string): Promise<FleetLinkChannelHandle> {
        const link = this.links.get(nodeId);
        if (!link)
            return Promise.reject(fleetLinkError('unreachable', 'the computer is not connected'));
        if (link.machine) {
            const current = link.machine;
            return current.then((handle) => {
                if (handle.isOpen) return handle;
                if (link.machine === current) link.machine = null;
                return this.machineChannel(nodeId, requestedBy);
            });
        }
        const opening = this.openChannel({
            nodeId,
            family: 'machine',
            requirement: { consent: 'link', actionFamily: 'view', stateChanging: false },
            requestedBy,
        });
        link.machine = opening;
        opening.then(
            (handle) =>
                handle.listen({
                    close: () => {
                        if (link.machine === opening) link.machine = null;
                    },
                }),
            () => {
                if (link.machine === opening) link.machine = null;
            },
        );
        return opening;
    }

    /** Listen to a family's own channel-0 `type` from every node (`session.event`, …). */
    onNodeControl(
        type: string,
        listener: (nodeId: string, message: FleetLinkExtensionMessage) => void,
    ): () => void {
        let set = this.controlListeners.get(type);
        if (!set) {
            set = new Set();
            this.controlListeners.set(type, set);
        }
        set.add(listener);
        return () => {
            set?.delete(listener);
        };
    }

    /** Listen to links coming and going (the operations service marks `interrupted`). */
    onLinkEvent(listener: (event: FleetLinkEvent) => void): () => void {
        this.linkListeners.add(listener);
        return () => {
            this.linkListeners.delete(listener);
        };
    }

    /** Where `operation.progress` / `operation.done` go (the operations service). */
    setOperationSink(
        sink: ((nodeId: string, message: FleetLinkOperationMessage) => void) | null,
    ): void {
        this.operationSink = sink;
    }

    /** Ask a node to cancel an operation. False when it has no link. */
    cancelOperation(nodeId: string, operationId: string): boolean {
        const link = this.links.get(nodeId);
        return link ? this.sendControl(link, { type: 'operation.cancel', operationId }) : false;
    }

    /** Send a family's own channel-0 message to a node (`schedule.sync`, …). */
    sendNodeControl(nodeId: string, message: FleetLinkExtensionMessage): boolean {
        const link = this.links.get(nodeId);
        return link ? this.sendControl(link, message) : false;
    }

    // ─── Internals the handle calls ────────────────────────────────────────

    nodeOf(entry: ChannelEntry): string {
        return entry.link?.nodeId ?? '';
    }

    requestOn(
        entry: ChannelEntry,
        verb: string,
        params: Record<string, unknown>,
        timeoutMs?: number,
    ): Promise<FleetLinkRequestReply> {
        if (entry.state !== 'open' || !entry.link) {
            return Promise.reject(fleetLinkError('unreachable', 'the channel is not open'));
        }
        const requestId = `r-${randomUUID()}`;
        const link = entry.link;
        return new Promise<FleetLinkRequestReply>((resolve, reject) => {
            const wait = timeoutMs ?? this.requestTimeoutMs;
            const pending: PendingRequest = {
                resolve,
                reject,
                timer: this.setTimer(() => {
                    entry.pending.delete(requestId);
                    reject(
                        fleetLinkError(
                            'unreachable',
                            `${link.nodeName} did not answer within ${Math.round(wait / 1000)} s`,
                        ),
                    );
                }, wait),
            };
            entry.pending.set(requestId, pending);
            const sent = this.sendOn(
                entry,
                encodeFleetLinkJson(entry.channel, { requestId, type: verb, params }),
            );
            if (!sent) {
                this.clearTimer(pending.timer);
                entry.pending.delete(requestId);
                reject(fleetLinkError('unreachable', 'the link could not carry the request'));
            }
        });
    }

    sendOn(entry: ChannelEntry, frame: Uint8Array | null): boolean {
        if (!frame || entry.state !== 'open' || !entry.link) return false;
        return this.sendFrame(entry.link, frame);
    }

    /** Close a channel once, every way it can close. */
    finish(
        entry: ChannelEntry,
        reason: FleetLinkCloseReason,
        hint: string | undefined,
        tellNode: boolean,
    ): void {
        if (entry.state === 'closed') return;
        const wasOpen = entry.state === 'open';
        entry.state = 'closed';
        const link = entry.link;
        if (link) {
            link.channels.delete(entry.channel);
            link.retired.add(entry.channel);
            if (tellNode && (wasOpen || entry.opening)) {
                const close: {
                    type: 'channel.close';
                    channel: number;
                    reason: FleetLinkCloseReason;
                    hint?: string;
                } = {
                    type: 'channel.close',
                    channel: entry.channel,
                    reason,
                };
                if (hint) close.hint = hint;
                this.sendControl(link, close);
            }
        }
        // A caller waiting on this channel reads a CONTRACTS §8 code: a link
        // that went away (`resume_failed` is a listener's reason, not an API
        // answer) or a channel closed normally are both `unreachable`.
        const callerCode =
            reason === 'normal' || reason === 'resume_failed' ? 'unreachable' : reason;
        const callerHint =
            reason === 'resume_failed' ? 'the link to the computer dropped' : undefined;
        if (entry.opening) {
            this.clearTimer(entry.opening.timer);
            entry.opening.reject(
                fleetLinkError(
                    callerCode,
                    hint ?? callerHint ?? 'the channel closed before it opened',
                ),
            );
            entry.opening = null;
        }
        for (const [requestId, pending] of entry.pending) {
            this.clearTimer(pending.timer);
            pending.reject(fleetLinkError(callerCode, hint ?? callerHint ?? 'the channel closed'));
            entry.pending.delete(requestId);
        }
        for (const listener of [...entry.listeners]) {
            try {
                listener.close?.(reason, hint);
            } catch (error) {
                this.logger.warn(`link channel close listener failed: ${describe(error)}`);
            }
        }
        entry.listeners.clear();
    }

    // ─── Receiving ─────────────────────────────────────────────────────────

    private receive(link: LinkEntry, frame: FleetLinkFrame): void {
        if (link.dropped) return;
        link.heard = true;
        link.lastFrameAt = this.now();
        link.bytesIn += FLEET_LINK_FRAME_HEADER_BYTES + frame.payload.byteLength;
        if (frame.channel === 0) {
            if (frame.kind !== FLEET_LINK_FRAME_KINDS.JSON) return;
            const message = decodeFleetLinkControl(frame.payload);
            if (!message) return;
            if (isFleetLinkControlMessage(message)) this.onControl(link, message);
            else this.onExtension(link, message);
            return;
        }
        const entry = link.channels.get(frame.channel);
        if (!entry || entry.state !== 'open') return;
        if (frame.kind === FLEET_LINK_FRAME_KINDS.JSON) {
            const message = decodeFleetLinkJson(frame.payload, FLEET_LINK_MAX_PAYLOAD_BYTES);
            if (!message) return;
            const requestId = typeof message.requestId === 'string' ? message.requestId : null;
            const pending = requestId ? entry.pending.get(requestId) : undefined;
            if (requestId && pending) {
                const reply = asFleetLinkReply(message);
                if (!reply) return;
                entry.pending.delete(requestId);
                this.clearTimer(pending.timer);
                pending.resolve(reply);
                return;
            }
            this.emit(entry, (listener) => listener.json?.(message));
            return;
        }
        this.emit(entry, (listener) => listener.binary?.(frame.kind, frame.payload));
    }

    private onControl(link: LinkEntry, message: FleetLinkControlMessage): void {
        switch (message.type) {
            case 'link.ping':
                this.sendControl(link, { type: 'link.pong', t: message.t });
                return;
            case 'channel.ready': {
                const entry = link.channels.get(message.channel);
                if (
                    !entry ||
                    entry.state !== 'opening' ||
                    entry.opening?.requestId !== message.requestId
                ) {
                    // An answer to an open that already timed out: the node holds a
                    // channel the platform does not — tell it to drop it.
                    if (!entry)
                        this.sendControl(link, {
                            type: 'channel.close',
                            channel: message.channel,
                            reason: 'normal',
                        });
                    return;
                }
                entry.state = 'open';
                if (message.resumeKey) entry.resumeKey = message.resumeKey;
                const opening = entry.opening;
                entry.opening = null;
                this.clearTimer(opening.timer);
                opening.resolve();
                return;
            }
            case 'channel.refused': {
                const entry = link.channels.get(message.channel);
                if (
                    !entry ||
                    entry.state !== 'opening' ||
                    entry.opening?.requestId !== message.requestId
                )
                    return;
                const opening = entry.opening;
                entry.opening = null;
                this.clearTimer(opening.timer);
                entry.state = 'closed';
                link.channels.delete(entry.channel);
                link.retired.add(entry.channel);
                opening.reject(new FleetLinkException(message.error));
                entry.listeners.clear();
                return;
            }
            case 'channel.close': {
                const entry = link.channels.get(message.channel);
                if (entry) this.finish(entry, message.reason, message.hint, false);
                return;
            }
            case 'operation.progress':
            case 'operation.done':
                try {
                    this.operationSink?.(link.nodeId, message);
                } catch (error) {
                    this.logger.warn(
                        `operation update from node ${link.nodeId} failed: ${describe(error)}`,
                    );
                }
                return;
            case 'channel.open':
                // Channels are the platform's to open (CONTRACTS §3.2,
                // ACC-FL02-07): refused, never created.
                this.logger.debug(
                    `node ${link.nodeId} tried to open channel ${message.channel}; refused`,
                );
                this.sendControl(link, {
                    type: 'channel.refused',
                    channel: message.channel,
                    requestId: message.requestId,
                    error: { code: 'invalid', hint: 'channels are opened by the platform' },
                });
                return;
            default:
                // pong, and anything only the platform sends: nothing to do.
                return;
        }
    }

    private onExtension(link: LinkEntry, message: FleetLinkExtensionMessage): void {
        const listeners = this.controlListeners.get(message.type);
        if (!listeners) return;
        for (const listener of [...listeners]) {
            try {
                listener(link.nodeId, message);
            } catch (error) {
                this.logger.warn(
                    `${message.type} listener failed for node ${link.nodeId}: ${describe(error)}`,
                );
            }
        }
    }

    private refuseOversized(link: LinkEntry, channel: number | null): void {
        if (channel === null || channel === 0) return;
        const entry = link.channels.get(channel);
        if (entry) this.finish(entry, 'invalid', 'frame over 16 MiB', true);
    }

    // ─── Dropping ──────────────────────────────────────────────────────────

    private drop(link: LinkEntry, reason: string, keepForResume = true): void {
        if (link.dropped) return;
        link.dropped = true;
        if (this.links.get(link.nodeId) === link) this.links.delete(link.nodeId);
        this.lastDrop.set(link.nodeId, this.now());
        const alsoGeneration = !link.heard && link.resumedFrom !== null ? link.resumedFrom : null;
        if (alsoGeneration !== null) this.unconfirmedFrom.set(link.nodeId, alsoGeneration);
        else this.unconfirmedFrom.delete(link.nodeId);
        const keep: ChannelEntry[] = [];
        for (const entry of [...link.channels.values()]) {
            if (keepForResume && entry.state === 'open' && entry.resumeKey) {
                entry.state = 'suspended';
                entry.link = null;
                keep.push(entry);
                continue;
            }
            this.finish(entry, 'resume_failed', undefined, false);
        }
        link.channels.clear();
        link.machine = null;
        this.emitLink({ type: 'dropped', nodeId: link.nodeId, reason });
        if (keep.length === 0) return;
        const previous = this.orphans.get(link.nodeId);
        if (previous) {
            this.clearTimer(previous.timer);
            for (const entry of previous.channels)
                this.finish(entry, 'resume_failed', undefined, false);
        }
        const orphan: Orphan = {
            generation: link.generation,
            alsoGeneration,
            channels: keep,
            timer: this.setTimer(() => {
                if (this.orphans.get(link.nodeId) !== orphan) return;
                this.orphans.delete(link.nodeId);
                for (const entry of orphan.channels)
                    this.finish(entry, 'resume_failed', undefined, false);
            }, this.resumeWindowMs),
        };
        this.orphans.set(link.nodeId, orphan);
        this.logger.debug(
            `node ${link.nodeId} link ${link.generation} dropped (${reason}); ${keep.length} channel(s) held`,
        );
    }

    // ─── Sending ───────────────────────────────────────────────────────────

    private allocate(link: LinkEntry): number {
        let channel = link.nextChannel;
        while (link.channels.has(channel) || link.retired.has(channel)) channel += 1;
        if (channel > FLEET_LINK_MAX_CHANNEL_NUMBER) {
            throw fleetLinkError(
                'limit_exceeded',
                'this link ran out of channel numbers; it reconnects on its own',
            );
        }
        link.nextChannel = channel + 1;
        return channel;
    }

    private sendControl(
        link: LinkEntry,
        message: FleetLinkControlMessage | FleetLinkExtensionMessage,
    ): boolean {
        return this.sendFrame(link, encodeFleetLinkControl(message));
    }

    private sendFrame(link: LinkEntry, frame: Uint8Array | null): boolean {
        if (!frame || link.dropped) return false;
        let sent = false;
        try {
            sent = link.socket.send(frame);
        } catch {
            sent = false;
        }
        if (sent) link.bytesOut += frame.byteLength;
        return sent;
    }

    private emitLink(event: FleetLinkEvent): void {
        for (const listener of [...this.linkListeners]) {
            try {
                listener(event);
            } catch (error) {
                this.logger.warn(`link event listener failed: ${describe(error)}`);
            }
        }
    }

    private emit(entry: ChannelEntry, deliver: (listener: FleetLinkChannelEvents) => void): void {
        for (const listener of [...entry.listeners]) {
            try {
                deliver(listener);
            } catch (error) {
                this.logger.warn(
                    `link channel ${entry.channel} (${entry.family}) listener failed: ${describe(error)}`,
                );
            }
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
