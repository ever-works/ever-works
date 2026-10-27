import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { FleetSessionService } from '@ever-works/agent/fleet';
import {
    FLEET_LINK_FRAME_HEADER_BYTES,
    FLEET_SESSION_MAX_VIEWERS,
    type FleetSessionAttachRole,
    type FleetSessionPresence,
} from '@ever-works/contracts';
import { fleetLinkError } from '../../fleet-link/fleet-link.errors';
import {
    FleetLinkViewerGatewayService,
    type FleetLinkViewerHandle,
    type FleetLinkViewerObserver,
} from '../../fleet-link/fleet-link-viewer-gateway.service';

/** One attached browser, as this replica counts it. */
interface PresenceEntry {
    userId: string;
    role: FleetSessionAttachRole;
    /** Reserved at admit; true once its channel opened. */
    opened: boolean;
    since: number;
    /** A driver's span: the payload bytes it sent, and when it last sent any. */
    inputBytes: number;
    firstInputAt: number | null;
    lastInputAt: number | null;
}

/**
 * Sessions on computers (FL-04 P1b, spec FR-21 … FR-26, FR-35) — who is
 * attached to each session through the browser, on THIS API replica, and the
 * rules that hang off it. It observes FL-02's viewer gateway for the
 * `session` family (`registerObserver`):
 *
 *  - **admit** — a sixth attached browser is refused `limit_exceeded` naming
 *    the five (a slot is reserved here before the channel opens, so five
 *    simultaneous opens cannot all squeeze past the count);
 *  - **opened** — one `node.session.attach` audit row with the role;
 *  - **inbound** — a driver's frames are counted (bytes only, never content);
 *  - **closed** — a driver that typed anything leaves ONE `node.session.input`
 *    row for its whole span (start, end, bytes), never one per keystroke;
 *  - **stillAllowed** — every 30 s the person must still be in the session's
 *    `sessions` audience, else the socket is closed (a revoked member stops
 *    watching within a ping).
 *
 * The count is per replica: behind several API replicas a session's browsers
 * may be split between them. The node's daemon fans the stream out to every
 * channel either way; the cap is a courtesy limit, not a security boundary
 * (lane log, owner question).
 */
@Injectable()
export class FleetSessionPresenceService
    implements OnApplicationBootstrap, FleetLinkViewerObserver
{
    private readonly logger = new Logger(FleetSessionPresenceService.name);
    /** Session row id → viewer handle id → entry. */
    private readonly bySession = new Map<string, Map<string, PresenceEntry>>();

    constructor(
        private readonly sessions: FleetSessionService,
        @Optional() private readonly gateway?: FleetLinkViewerGatewayService,
    ) {}

    onApplicationBootstrap(): void {
        this.gateway?.registerObserver('session', this);
    }

    // ─── Reads ─────────────────────────────────────────────────────────────

    /** Who is attached to a session right now (the detail page's footer). */
    presence(sessionId: string): FleetSessionPresence {
        const entries = [...(this.bySession.get(sessionId)?.values() ?? [])].filter(
            (entry) => entry.opened,
        );
        const drivers = entries.filter((entry) => entry.role === 'driver').length;
        return {
            attached: entries.map((entry) => ({
                userId: entry.userId,
                role: entry.role,
                since: new Date(entry.since).toISOString(),
            })),
            drivers,
            watchers: entries.length - drivers,
        };
    }

    /** The people attached or about to be (ids), for the cap and the refusal that names them. */
    attachedIds(sessionId: string): string[] {
        return [...(this.bySession.get(sessionId)?.values() ?? [])].map((entry) => entry.userId);
    }

    // ─── The gateway's hooks ───────────────────────────────────────────────

    admit(viewer: FleetLinkViewerHandle): void {
        const sessionId = viewer.claims.target;
        const entries = this.bySession.get(sessionId) ?? new Map<string, PresenceEntry>();
        if (entries.size >= FLEET_SESSION_MAX_VIEWERS) {
            throw fleetLinkError(
                'limit_exceeded',
                `This session already has ${entries.size} watchers.`,
                {
                    limit: FLEET_SESSION_MAX_VIEWERS,
                    watchers: [...entries.values()].map((entry) => entry.userId),
                },
            );
        }
        entries.set(viewer.id, {
            userId: viewer.claims.userId,
            role: viewer.claims.role,
            opened: false,
            since: Date.now(),
            inputBytes: 0,
            firstInputAt: null,
            lastInputAt: null,
        });
        this.bySession.set(sessionId, entries);
    }

    opened(viewer: FleetLinkViewerHandle): void {
        const entry = this.entry(viewer);
        if (!entry) return;
        entry.opened = true;
        entry.since = Date.now();
        void this.sessions.recordViewer(
            'node.session.attach',
            viewer.claims.userId,
            viewer.claims.target,
            {
                role: viewer.claims.role,
                outcome: 'attached',
            },
        );
    }

    inbound(viewer: FleetLinkViewerHandle, bytes: number): void {
        if (viewer.claims.role !== 'driver') return;
        const entry = this.entry(viewer);
        if (!entry || !entry.opened) return;
        const payload = Math.max(0, bytes - FLEET_LINK_FRAME_HEADER_BYTES);
        if (payload === 0) return;
        const now = Date.now();
        entry.inputBytes += payload;
        entry.firstInputAt ??= now;
        entry.lastInputAt = now;
    }

    async stillAllowed(viewer: FleetLinkViewerHandle): Promise<boolean> {
        return this.sessions.canStillSee(viewer.claims.target, { userId: viewer.claims.userId });
    }

    closed(viewer: FleetLinkViewerHandle): void {
        const sessionId = viewer.claims.target;
        const entries = this.bySession.get(sessionId);
        const entry = entries?.get(viewer.id);
        if (!entries || !entry) return;
        entries.delete(viewer.id);
        if (entries.size === 0) this.bySession.delete(sessionId);
        if (!entry.opened || entry.role !== 'driver' || entry.inputBytes === 0) return;
        void this.sessions
            .recordViewer('node.session.input', entry.userId, sessionId, {
                role: 'driver',
                outcome: 'span',
                from: new Date(entry.firstInputAt ?? entry.since).toISOString(),
                to: new Date(entry.lastInputAt ?? Date.now()).toISOString(),
                bytes: entry.inputBytes,
            })
            .catch((error: unknown) =>
                this.logger.debug(
                    `driver span audit for ${sessionId} failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                ),
            );
    }

    private entry(viewer: FleetLinkViewerHandle): PresenceEntry | undefined {
        return this.bySession.get(viewer.claims.target)?.get(viewer.id);
    }
}
