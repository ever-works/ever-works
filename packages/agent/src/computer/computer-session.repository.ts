import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { COMPUTER_SESSION_OPEN_STATUSES } from '@ever-works/contracts';
import { advisoryLockObjectId } from '../database/repositories/agent-run.repository';
import { ComputerSession } from '../entities/computer-session.entity';

/**
 * Advisory-lock namespaces (`classid`) for live-view admission — one per
 * kind of key, so a machine's key and an Organization's key can never
 * collide with each other, and neither can collide with the run-admission
 * namespace (`0x6577_0001`). Arbitrary but STABLE: changing one would make
 * an old and a new replica lock on different keys during a rolling restart.
 */
export const COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID = 0x6577_000b | 0;
export const COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID = 0x6577_000c | 0;

/** What one live-view admission serializes on. */
export interface ComputerAdmissionLockKeys {
    /** The machine whose per-node cap (and whose Agent profiles) the critical section reads. */
    nodeId: string;
    /** The Organization (or personal workspace) whose cap it reads; omitted when none is read. */
    scopeKey?: string | null;
}

/** The admission scope key of a session: its Organization, else its owner's personal workspace. */
export function computerSessionScopeKey(scope: {
    userId: string;
    organizationId: string | null;
}): string {
    return scope.organizationId ? `org:${scope.organizationId}` : `user:${scope.userId}`;
}

/**
 * Data access for `computer_sessions`. Every transition is a conditional
 * UPDATE that restates its precondition, so two API replicas (or a node
 * report racing an owner's close) can never both win: an ended session
 * stays ended, and a session is bound to a Run at most once.
 */
@Injectable()
export class ComputerSessionRepository {
    private readonly logger = new Logger(ComputerSessionRepository.name);

    constructor(
        @InjectRepository(ComputerSession)
        private readonly repository: Repository<ComputerSession>,
    ) {}

    /**
     * Serialize a live-view admission's count-then-insert (and a profile
     * reset's check-then-rotate) against every other one on the same
     * machine and in the same Organization — the run-admission lock's
     * pattern (`AgentRunRepository.withAdmissionLock`), in its own namespace.
     *
     * POSTGRES: takes `pg_advisory_xact_lock` on the machine key, then on the
     * scope key, inside one throwaway transaction held for the whole of `fn`.
     * The order is fixed (machine first, always), so two admissions can
     * never hold one key each while waiting for the other's. `fn` runs on the
     * pool's normal connection, so the row it inserts is committed — and
     * visible to the next admission's count — before the lock is released.
     *
     * EVERY OTHER DRIVER (better-sqlite3 — the e2e/CI stack): advisory locks
     * do not exist, so this is a documented no-op that calls `fn` directly.
     *
     * A failure to TAKE the lock degrades to running `fn` unlocked (logged),
     * like the run-admission lock: a broken safety valve must never stop a
     * legitimate view. A failure INSIDE `fn` is re-raised and `fn` is never
     * re-run, since it may already have inserted its row.
     */
    async withAdmissionLock<T>(keys: ComputerAdmissionLockKeys, fn: () => Promise<T>): Promise<T> {
        const driver = this.repository.manager.connection.options.type;
        if (driver !== 'postgres') {
            return fn();
        }
        const locks: Array<[number, number]> = [
            [COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID, advisoryLockObjectId(`node:${keys.nodeId}`)],
        ];
        if (keys.scopeKey) {
            locks.push([
                COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID,
                advisoryLockObjectId(`scope:${keys.scopeKey}`),
            ]);
        }
        let entered = false;
        try {
            return await this.repository.manager.connection.transaction(async (manager) => {
                for (const [classId, objectId] of locks) {
                    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
                        classId,
                        objectId,
                    ]);
                }
                entered = true;
                return fn();
            });
        } catch (error) {
            if (entered) throw error;
            this.logger.warn(
                `Live-view admission lock unavailable for node ${keys.nodeId} — admitting unlocked: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return fn();
        }
    }

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

    /** A controller's input arrived — the idle clock the receipt and the control arbiter read. */
    async recordInput(id: string, at: Date): Promise<void> {
        await this.repository.update({ id, status: Not('ended') }, { lastInputAt: at });
    }

    /** Replace the control spans. Written only by the control arbiter, after the lock itself moved. */
    async setControlSpans(id: string, spans: ComputerSession['controlSpans']): Promise<void> {
        await this.repository.update({ id }, { controlSpans: spans });
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
