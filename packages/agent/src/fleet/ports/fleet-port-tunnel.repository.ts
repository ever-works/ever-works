import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FleetPortTunnelClosedReason } from '@ever-works/contracts';
import { FleetPortTunnel } from '../../entities/fleet-port-tunnel.entity';

/**
 * Servers and ports, phase 2 (FL-10) — `fleet_port_tunnels` reads and the
 * three writes `FleetPortTunnelService` makes: open (insert), touch (advance
 * the counters and the idle clock of an OPEN row) and close — a
 * compare-and-set on `state = 'open'`, so two closers (the route and the
 * sweeper, two replicas' sweepers) close a tunnel exactly once and only the
 * winner writes the close audit row.
 */
@Injectable()
export class FleetPortTunnelRepository {
    constructor(
        @InjectRepository(FleetPortTunnel)
        private readonly repository: Repository<FleetPortTunnel>,
    ) {}

    async insert(input: {
        /** The tunnel id, chosen before the machine was asked (the channel carries it). */
        id: string;
        ownerUserId: string;
        nodeId: string;
        port: number;
        previewHost: string;
        openedAt: Date;
    }): Promise<FleetPortTunnel> {
        return this.repository.save(
            this.repository.create({
                id: input.id,
                ownerUserId: input.ownerUserId,
                nodeId: input.nodeId,
                port: input.port,
                previewHost: input.previewHost,
                state: 'open',
                openedAt: input.openedAt,
                lastRequestAt: null,
                closedAt: null,
                closedReason: null,
                requestCount: 0,
                bytesIn: 0,
                bytesOut: 0,
                auditOpenId: null,
                auditCloseId: null,
            }),
        );
    }

    findById(id: string): Promise<FleetPortTunnel | null> {
        return this.repository.findOne({ where: { id } });
    }

    countOpenForOwner(ownerUserId: string): Promise<number> {
        return this.repository.count({ where: { ownerUserId, state: 'open' } });
    }

    listOpenForOwner(ownerUserId: string): Promise<FleetPortTunnel[]> {
        return this.repository.find({
            where: { ownerUserId, state: 'open' },
            order: { openedAt: 'ASC' },
        });
    }

    listOpenForNode(nodeId: string): Promise<FleetPortTunnel[]> {
        return this.repository.find({
            where: { nodeId, state: 'open' },
            order: { openedAt: 'ASC' },
        });
    }

    findOpenForPort(
        ownerUserId: string,
        nodeId: string,
        port: number,
    ): Promise<FleetPortTunnel | null> {
        return this.repository.findOne({
            where: { ownerUserId, nodeId, port, state: 'open' },
            order: { openedAt: 'DESC' },
        });
    }

    /** Every open tunnel, oldest first (the sweeper decides in code which must close). */
    listOpen(limit = 500): Promise<FleetPortTunnel[]> {
        return this.repository.find({
            where: { state: 'open' },
            order: { openedAt: 'ASC' },
            take: limit,
        });
    }

    /** Close an OPEN row. False when it was already closed (someone else won the race). */
    async close(id: string, reason: FleetPortTunnelClosedReason, at: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(FleetPortTunnel)
            .set({ state: 'closed', closedReason: reason, closedAt: at })
            .where('id = :id', { id })
            .andWhere('state = :open', { open: 'open' })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Advance an OPEN row's counters and idle clock by what one replica served. */
    async touch(
        id: string,
        delta: { requests: number; bytesIn: number; bytesOut: number; at: Date },
    ): Promise<void> {
        const requests = Math.max(0, Math.floor(delta.requests));
        const bytesIn = Math.max(0, Math.floor(delta.bytesIn));
        const bytesOut = Math.max(0, Math.floor(delta.bytesOut));
        await this.repository
            .createQueryBuilder()
            .update(FleetPortTunnel)
            .set({
                requestCount: () => `"requestCount" + ${requests}`,
                bytesIn: () => `"bytesIn" + ${bytesIn}`,
                bytesOut: () => `"bytesOut" + ${bytesOut}`,
                lastRequestAt: delta.at,
            })
            .where('id = :id', { id })
            .andWhere('state = :open', { open: 'open' })
            .execute();
    }

    async stampAudit(
        id: string,
        stamp: { auditOpenId?: string; auditCloseId?: string },
    ): Promise<void> {
        const patch: Partial<FleetPortTunnel> = {};
        if (stamp.auditOpenId) patch.auditOpenId = stamp.auditOpenId;
        if (stamp.auditCloseId) patch.auditCloseId = stamp.auditCloseId;
        if (Object.keys(patch).length === 0) return;
        await this.repository.update({ id }, patch);
    }
}
