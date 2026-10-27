import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    FLEET_PORT_TUNNELS_PER_OWNER,
    fleetPortTunnelEndsAt,
    fleetPortTunnelExpiry,
    fleetPortTunnelUrl,
    isFleetPortNumber,
    type FleetPortTunnelClosedReason,
    type FleetPortTunnelView,
} from '@ever-works/contracts';
import { config } from '../../config';
import type { FleetNode } from '../../entities/fleet-node.entity';
import type { FleetPortTunnel } from '../../entities/fleet-port-tunnel.entity';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { fleetPortsError } from './fleet-ports.errors';
import type { FleetPortsCaller } from './fleet-ports-node.port';
import type { FleetPortsActor } from './fleet-ports.service';
import { FleetPortTunnelRepository } from './fleet-port-tunnel.repository';

/**
 * Servers and ports, phase 2 (FL-10, CONTRACTS R-17, §4.9, §10) — **Preview
 * in my browser**: the one writer of `fleet_port_tunnels`.
 *
 * Open, in order (spec FR-23 … FR-27): the flag (`FLEET_PORT_TUNNEL_ENABLED`
 * with a preview host — off answers 404, the surface not even confirmed), the
 * `ports` audience (CONTRACTS §2.1), the kind of computer, the kill switch
 * (fail-closed), an already-open tunnel to the same port (answered again,
 * never a second), the per-person limit (4 — `limit_exceeded` listing them),
 * the machine (the node checks something listens; its refusal comes back as
 * is), then the row and ONE `node.port.preview.open` audit row.
 *
 * Close: a compare-and-set on `state = 'open'`, so a tunnel closes exactly
 * once whoever closes it (the person, the sweeper on any replica, the request
 * path that finds it expired), and only the winner writes the ONE
 * `node.port.preview.close` row — with the reason (CONTRACTS §4.9), the
 * precise trigger, the request count and the bytes. Never one row per request.
 *
 * Every request on the preview host is authorised here (`authorizeRequest`):
 * the tunnel is open, unexpired, the fleet is not stopped, and the person is
 * its owner — anyone else is refused before anything is forwarded.
 */

/** How the tunnel transport is reached (bound by the API's bridge, `FleetPortTunnelBridge`). */
export interface FleetPortTunnelLinkPort {
    /** Open the tunnel's channel on the node's link (the node checks the port listens). Throws the §8 refusal. */
    open(input: {
        tunnelId: string;
        nodeId: string;
        port: number;
        caller: FleetPortsCaller;
    }): Promise<void>;
    /** Close this replica's channel of the tunnel; another replica's closes on its next request or when idle. */
    close(tunnelId: string, reason: FleetPortTunnelClosedReason): void;
    /** The platform holds the node's link right now. */
    isConnected(nodeId: string): boolean;
}

export const FLEET_PORT_TUNNEL_LINK_PORT = 'FLEET_PORT_TUNNEL_LINK_PORT' as const;

/** What the preview host learns about one request. */
export type FleetPortTunnelAuthorization =
    | { ok: true; tunnel: FleetPortTunnel }
    | { ok: false; why: 'off' | 'ended' | 'not-yours' };

/** A node that has not beaten for this long, with no link, has its tunnels closed `node-offline`. */
const NODE_SILENT_MS = 2 * 60_000;

function toNumber(value: number | string | null | undefined): number {
    const parsed = typeof value === 'string' ? Number(value) : (value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The view of a row. */
export function toFleetPortTunnelView(
    row: FleetPortTunnel,
    requestedBy?: string | null,
): FleetPortTunnelView {
    const view: FleetPortTunnelView = {
        id: row.id,
        nodeId: row.nodeId,
        port: row.port,
        url: fleetPortTunnelUrl(row.previewHost, row.id),
        state: row.state === 'closed' ? 'closed' : 'open',
        openedAt: iso(row.openedAt) ?? new Date(0).toISOString(),
        lastRequestAt: iso(row.lastRequestAt),
        closedAt: iso(row.closedAt),
        closedReason: row.closedReason ?? null,
        requestCount: toNumber(row.requestCount),
        bytesIn: toNumber(row.bytesIn),
        bytesOut: toNumber(row.bytesOut),
        endsAt: fleetPortTunnelEndsAt(row.openedAt).toISOString(),
    };
    if (requestedBy !== undefined) view.requestedBy = requestedBy;
    return view;
}

function ownerOf(actor: FleetPortsActor): string {
    return actor.kind === 'user' ? actor.userId : actor.ownerUserId;
}

function callerOf(actor: FleetPortsActor): FleetPortsCaller {
    return actor.kind === 'user'
        ? { kind: 'user', userId: actor.userId }
        : { kind: 'agent', agentId: actor.agentId, ownerUserId: actor.ownerUserId };
}

function requestedByOf(actor: FleetPortsActor): string {
    return actor.kind === 'user' ? `user:${actor.userId}` : `agent:${actor.agentId}`;
}

@Injectable()
export class FleetPortTunnelService {
    private readonly logger = new Logger(FleetPortTunnelService.name);

    constructor(
        private readonly tunnels: FleetPortTunnelRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        private readonly nodes: FleetNodeRepository,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional()
        @Inject(FLEET_PORT_TUNNEL_LINK_PORT)
        private readonly link?: FleetPortTunnelLinkPort,
    ) {}

    /** `FLEET_PORT_TUNNEL_ENABLED` with a preview host (and the machine-facts flag). */
    isEnabled(): boolean {
        return config.fleet.isPortTunnelEnabled();
    }

    /** Open a tunnel to `port` on the computer for the actor's owner (or answer the one already open). */
    async open(
        nodeId: string,
        port: number,
        actor: FleetPortsActor,
    ): Promise<{ tunnel: FleetPortTunnelView; created: boolean }> {
        const previewHost = config.fleet.getPortPreviewHost();
        if (!this.isEnabled() || !previewHost)
            throw fleetPortsError('not_found', 'Cannot find route');
        if (!isFleetPortNumber(port)) {
            throw fleetPortsError('invalid', 'a port is a number from 1 to 65535', {
                field: 'port',
            });
        }
        const ownerUserId = ownerOf(actor);
        const { node } = await this.access.resolveForFamily(nodeId, ownerUserId, 'ports');
        this.assertKind(node);
        await this.assertNotStopped();
        const link = this.requireLink();

        const existing = await this.tunnels.findOpenForPort(ownerUserId, node.id, port);
        if (existing && !fleetPortTunnelExpiry(existing, new Date())) {
            return { tunnel: toFleetPortTunnelView(existing), created: false };
        }
        if (existing) await this.close(existing.id, 'hard', 'expired-on-open');

        const open = await this.tunnels.listOpenForOwner(ownerUserId);
        if (open.length >= FLEET_PORT_TUNNELS_PER_OWNER) {
            throw fleetPortsError(
                'limit_exceeded',
                `You already have ${FLEET_PORT_TUNNELS_PER_OWNER} previews open — close one`,
                {
                    limit: FLEET_PORT_TUNNELS_PER_OWNER,
                    tunnels: open.map((row) => toFleetPortTunnelView(row)),
                },
            );
        }

        const tunnelId = randomUUID();
        // The machine first: a port nothing listens on is refused before any row exists.
        await link.open({ tunnelId, nodeId: node.id, port, caller: callerOf(actor) });
        let row: FleetPortTunnel;
        try {
            row = await this.tunnels.insert({
                id: tunnelId,
                ownerUserId,
                nodeId: node.id,
                port,
                previewHost,
                openedAt: new Date(),
            });
        } catch (error) {
            link.close(tunnelId, 'link-closed');
            throw error;
        }
        const auditId = await this.recordAudit('node.port.preview.open', node, actor, {
            port,
            tunnelId: row.id,
            previewHost,
            outcome: 'opened',
        });
        if (auditId) await this.tunnels.stampAudit(row.id, { auditOpenId: auditId });
        return { tunnel: toFleetPortTunnelView(row, requestedByOf(actor)), created: true };
    }

    /** The open tunnel to `port` the actor's owner holds on the computer (404 when none). */
    async current(
        nodeId: string,
        port: number,
        actor: FleetPortsActor,
    ): Promise<FleetPortTunnelView> {
        if (!this.isEnabled()) throw fleetPortsError('not_found', 'Cannot find route');
        const ownerUserId = ownerOf(actor);
        const { node } = await this.access.resolveForFamily(nodeId, ownerUserId, 'view');
        const row = isFleetPortNumber(port)
            ? await this.tunnels.findOpenForPort(ownerUserId, node.id, port)
            : null;
        if (!row)
            throw fleetPortsError('not_found', `no preview of :${port} is open on ${node.name}`);
        return toFleetPortTunnelView(row);
    }

    /** The open tunnels the person holds to one computer (the Ports tab's rows). */
    async listOpenForNode(nodeId: string, ownerUserId: string): Promise<FleetPortTunnelView[]> {
        if (!this.isEnabled()) return [];
        const rows = await this.tunnels.listOpenForOwner(ownerUserId);
        return rows.filter((row) => row.nodeId === nodeId).map((row) => toFleetPortTunnelView(row));
    }

    /** "Close preview" — the actor's owner's open tunnel to `port`. */
    async closeForUser(nodeId: string, port: number, actor: FleetPortsActor): Promise<void> {
        if (!this.isEnabled()) throw fleetPortsError('not_found', 'Cannot find route');
        const ownerUserId = ownerOf(actor);
        const { node } = await this.access.resolveForFamily(nodeId, ownerUserId, 'ports');
        const row = isFleetPortNumber(port)
            ? await this.tunnels.findOpenForPort(ownerUserId, node.id, port)
            : null;
        if (!row)
            throw fleetPortsError('not_found', `no preview of :${port} is open on ${node.name}`);
        await this.close(row.id, 'user', actor.kind === 'agent' ? 'agent' : 'user', actor);
    }

    /**
     * Close one tunnel. A compare-and-set: false when it was already closed
     * (someone else won), and then nothing is written. The winner closes this
     * replica's channel and writes the one close audit row.
     */
    async close(
        tunnelId: string,
        reason: FleetPortTunnelClosedReason,
        trigger: string,
        actor: FleetPortsActor | null = null,
    ): Promise<boolean> {
        const row = await this.tunnels.findById(tunnelId);
        if (!row || row.state !== 'open') return false;
        const closedAt = new Date();
        if (!(await this.tunnels.close(row.id, reason, closedAt))) return false;
        try {
            this.link?.close(row.id, reason);
        } catch (error) {
            this.logger.debug(
                `closing the channel of tunnel ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        const node = await this.nodes.findById(row.nodeId).catch(() => null);
        const auditId = await this.recordAudit(
            'node.port.preview.close',
            node,
            actor,
            {
                port: row.port,
                tunnelId: row.id,
                reason,
                trigger,
                requestCount: toNumber(row.requestCount),
                bytesIn: toNumber(row.bytesIn),
                bytesOut: toNumber(row.bytesOut),
                durationSec: Math.max(
                    0,
                    Math.round((closedAt.getTime() - new Date(row.openedAt).getTime()) / 1000),
                ),
                outcome: 'closed',
            },
            row.ownerUserId,
        );
        if (auditId) await this.tunnels.stampAudit(row.id, { auditCloseId: auditId });
        return true;
    }

    /**
     * May `userId` use tunnel `tunnelId` right now? Open, unexpired, the fleet
     * not stopped, and theirs. An expired tunnel found here is closed here
     * (the sweeper is the floor, this is the ceiling); a stopped fleet closes
     * it `kill-switch` (spec U3: within 5 s of the next request).
     */
    async authorizeRequest(
        tunnelId: string,
        userId: string,
    ): Promise<FleetPortTunnelAuthorization> {
        if (!this.isEnabled()) return { ok: false, why: 'off' };
        const row = await this.tunnels.findById(tunnelId);
        if (!row || row.state !== 'open') return { ok: false, why: 'ended' };
        if (row.ownerUserId !== userId) return { ok: false, why: 'not-yours' };
        const expired = fleetPortTunnelExpiry(row, new Date());
        if (expired) {
            await this.close(row.id, expired, `${expired}-on-request`);
            return { ok: false, why: 'ended' };
        }
        let stopped: boolean;
        try {
            stopped = await this.killSwitch.isStopped();
        } catch {
            stopped = true;
        }
        if (stopped) {
            await this.close(row.id, 'kill-switch', 'kill-switch-on-request');
            return { ok: false, why: 'ended' };
        }
        return { ok: true, tunnel: row };
    }

    /** The computer a tunnel reached (open or closed), for the preview host's "ended" page; null when unknown. */
    async nodeIdOf(tunnelId: string): Promise<string | null> {
        const row = await this.tunnels.findById(tunnelId);
        return row?.nodeId ?? null;
    }

    /** Advance an open tunnel's counters and idle clock (the serving replica, after each request). */
    async touch(
        tunnelId: string,
        delta: { requests: number; bytesIn: number; bytesOut: number },
    ): Promise<void> {
        try {
            await this.tunnels.touch(tunnelId, { ...delta, at: new Date() });
        } catch (error) {
            this.logger.debug(
                `tunnel ${tunnelId} counters not advanced: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * The sweeper (every minute, any replica): close every open tunnel that
     * must close — the kill switch (`kill-switch`), an hour old (`hard`), ten
     * idle minutes (`idle`), a node gone, disabled or silent without a link
     * (`node-offline`, the precise trigger in the audit row). Idempotent: two
     * overlapping sweeps close each tunnel once (the CAS).
     */
    async sweep(now: Date = new Date()): Promise<{ closed: number }> {
        if (!this.isEnabled()) return { closed: 0 };
        const open = await this.tunnels.listOpen();
        if (open.length === 0) return { closed: 0 };
        let stopped: boolean;
        try {
            stopped = await this.killSwitch.isStopped();
        } catch {
            stopped = true;
        }
        let closed = 0;
        const nodes = new Map<string, FleetNode | null>();
        for (const row of open) {
            let reason: FleetPortTunnelClosedReason | null = null;
            let trigger = '';
            if (stopped) {
                reason = 'kill-switch';
                trigger = 'kill-switch';
            } else {
                const expired = fleetPortTunnelExpiry(row, now);
                if (expired) {
                    reason = expired;
                    trigger = expired;
                } else {
                    if (!nodes.has(row.nodeId)) {
                        nodes.set(
                            row.nodeId,
                            await this.nodes.findById(row.nodeId).catch(() => null),
                        );
                    }
                    const node = nodes.get(row.nodeId) ?? null;
                    const silentSince = node?.lastHeartbeatAt
                        ? new Date(node.lastHeartbeatAt).getTime()
                        : 0;
                    if (!node) {
                        reason = 'node-offline';
                        trigger = 'node-removed';
                    } else if (node.status === 'disabled') {
                        reason = 'node-offline';
                        trigger = 'node-disabled';
                    } else if (
                        this.link &&
                        !this.link.isConnected(node.id) &&
                        now.getTime() - silentSince > NODE_SILENT_MS
                    ) {
                        reason = 'node-offline';
                        trigger = 'link-lost';
                    }
                }
            }
            if (reason && (await this.close(row.id, reason, trigger))) closed++;
        }
        return { closed };
    }

    private assertKind(node: FleetNode): void {
        if (node.kind !== 'node') {
            throw fleetPortsError('unsupported_on_node', 'Not available on this kind of node yet', {
                kind: node.kind,
            });
        }
    }

    private async assertNotStopped(): Promise<void> {
        let stopped: boolean;
        try {
            stopped = await this.killSwitch.isStopped();
        } catch {
            stopped = true;
        }
        if (stopped) throw fleetPortsError('kill_switch', 'clear it under Settings → Fleet');
    }

    private requireLink(): FleetPortTunnelLinkPort {
        if (!this.link) throw fleetPortsError('unreachable', 'this process cannot reach computers');
        return this.link;
    }

    /** One audit row; its id, or null when it could not be written (logged, never thrown). */
    private async recordAudit(
        action: 'node.port.preview.open' | 'node.port.preview.close',
        node: FleetNode | null,
        actor: FleetPortsActor | null,
        details: Record<string, unknown>,
        ownerUserId?: string,
    ): Promise<string | null> {
        if (!this.audit) return null;
        try {
            const row = await this.audit.record({
                action,
                actorUserId: actor
                    ? actor.kind === 'user'
                        ? actor.userId
                        : actor.ownerUserId
                    : null,
                ownerUserId: node?.userId ?? ownerUserId ?? null,
                nodeId: node?.id ?? null,
                details: {
                    family: 'ports',
                    requestedBy: actor ? requestedByOf(actor) : 'system:fleet-port-tunnel',
                    confirmationClass: 'plain',
                    ...details,
                },
            });
            return row.id;
        } catch (error) {
            this.logger.error(
                `${action} could not be audited: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }
}
