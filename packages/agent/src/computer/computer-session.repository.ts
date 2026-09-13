import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { COMPUTER_SESSION_OPEN_STATUSES } from '@ever-works/contracts';
import { ComputerSession } from '../entities/computer-session.entity';

/**
 * Data access for `computer_sessions`. Every transition is a conditional
 * UPDATE that restates its precondition, so two API replicas (or a node
 * report racing an owner's close) can never both win: an ended session
 * stays ended, and a session is bound to a Run at most once.
 */
@Injectable()
export class ComputerSessionRepository {
    constructor(
        @InjectRepository(ComputerSession)
        private readonly repository: Repository<ComputerSession>,
    ) {}

    async create(data: Partial<ComputerSession>): Promise<ComputerSession> {
        return this.repository.save(this.repository.create(data));
    }

    async findById(id: string): Promise<ComputerSession | null> {
        return this.repository.findOne({ where: { id } });
    }

    /** Owner-scoped: a foreign id resolves to null, exactly like an unknown one. */
    async findForOwner(
        id: string,
        userId: string,
        agentId: string,
    ): Promise<ComputerSession | null> {
        return this.repository.findOne({ where: { id, userId, agentId } });
    }

    /** Node-scoped: the only read a node credential buys. */
    async findForNode(id: string, nodeId: string): Promise<ComputerSession | null> {
        return this.repository.findOne({ where: { id, nodeId } });
    }

    async findOpenForNode(nodeId: string): Promise<ComputerSession[]> {
        return this.repository.find({
            where: { nodeId, status: In([...COMPUTER_SESSION_OPEN_STATUSES]) },
            order: { createdAt: 'ASC' },
        });
    }

    /** Unfinished sessions of one Organization, or of one owner's personal workspace. */
    async findOpenForScope(scope: {
        userId: string;
        organizationId: string | null;
    }): Promise<ComputerSession[]> {
        const status = In([...COMPUTER_SESSION_OPEN_STATUSES]);
        return this.repository.find({
            where: scope.organizationId
                ? { organizationId: scope.organizationId, status }
                : { userId: scope.userId, organizationId: IsNull(), status },
            order: { createdAt: 'ASC' },
        });
    }

    async findOpenForOwner(userId: string): Promise<ComputerSession[]> {
        return this.repository.find({
            where: { userId, status: In([...COMPUTER_SESSION_OPEN_STATUSES]) },
        });
    }

    /** Ids of the views waiting for this node to claim them. */
    async findPendingIdsForNode(nodeId: string): Promise<string[]> {
        const rows = await this.repository.find({
            where: { nodeId, status: 'requested' },
            select: { id: true },
            take: 16,
        });
        return rows.map((row) => row.id);
    }

    async setFleetJob(id: string, fleetJobId: string): Promise<void> {
        await this.repository.update({ id }, { fleetJobId });
    }

    /** Owner edits (quality / channel) — only while the session is unfinished. */
    async updateOpen(id: string, patch: Partial<ComputerSession>): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: In([...COMPUTER_SESSION_OPEN_STATUSES]) },
            patch,
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Pictures arrived. Counters are incremented in the database (not read,
     * added and written back) so two concurrent publishes cannot lose one.
     * A `requested` or `stalled` session becomes `live`; `startedAt` is
     * stamped only the first time.
     */
    async recordFrames(
        id: string,
        frames: number,
        bytes: number,
        at: Date,
    ): Promise<{ becameLive: boolean }> {
        await this.repository
            .createQueryBuilder()
            .update(ComputerSession)
            .set({
                frameCount: () => `"frameCount" + ${Math.max(0, Math.trunc(frames))}`,
                bytesOut: () => `"bytesOut" + ${Math.max(0, Math.trunc(bytes))}`,
                lastFrameAt: at,
            })
            .where('id = :id', { id })
            .andWhere('status != :ended', { ended: 'ended' })
            .execute();
        const live = await this.repository.update(
            { id, status: In(['requested', 'stalled']) },
            { status: 'live' },
        );
        if ((live.affected ?? 0) === 1) {
            await this.repository.update({ id, startedAt: IsNull() }, { startedAt: at });
            return { becameLive: true };
        }
        return { becameLive: false };
    }

    async markStalled(id: string): Promise<boolean> {
        const result = await this.repository.update({ id, status: 'live' }, { status: 'stalled' });
        return (result.affected ?? 0) === 1;
    }

    /** Set once, never re-bound. */
    async bindRun(id: string, runId: string): Promise<boolean> {
        const result = await this.repository.update({ id, runId: IsNull() }, { runId });
        return (result.affected ?? 0) === 1;
    }

    /** End an unfinished session. False when it had already ended. */
    async close(
        id: string,
        patch: Pick<ComputerSession, 'closeReason' | 'endedAt'>,
    ): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: Not('ended') },
            { ...patch, status: 'ended' },
        );
        return (result.affected ?? 0) === 1;
    }
}
