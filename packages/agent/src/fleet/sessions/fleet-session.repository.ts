import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, LessThan, Not, Repository } from 'typeorm';
import { FLEET_SESSION_RECENT_FOLDERS, type FleetSessionKind } from '@ever-works/contracts';
import { advisoryLockObjectId } from '../../database/repositories/agent-run.repository';
import { AgentRun } from '../../entities/agent-run.entity';
import { FleetSession } from '../../entities/fleet-session.entity';

/**
 * Advisory-lock namespace (`classid`) for session admission on one machine —
 * distinct from the run-admission and live-view namespaces. Arbitrary but
 * STABLE across releases (a rolling restart must lock on the same key).
 */
export const FLEET_SESSION_ADMISSION_LOCK_CLASS_ID = 0x6577_0041 | 0;

/** What the platform's list reads accept. */
export interface FleetSessionListQuery {
    state?: 'live' | 'ended';
    kind?: FleetSessionKind;
    agentId?: string;
    since?: Date;
    limit?: number;
    /** `<lastActivityAt ISO>|<id>` of the last row of the previous page. */
    cursor?: string;
    /**
     * FL-15 P1: only sessions whose Run works on this Task (the Task page's
     * Computer block, `GET /api/fleet/sessions?taskId=&limit=1`).
     */
    taskId?: string;
}

export const FLEET_SESSION_LIST_DEFAULT_LIMIT = 50;
export const FLEET_SESSION_LIST_MAX_LIMIT = 200;

/**
 * Data access for `fleet_sessions`. Every transition into `ended` is a
 * conditional UPDATE that restates "still live", so a user's End racing the
 * node's exit report (or two replicas) can never both win: an ended session
 * stays ended with the first reason written.
 */
@Injectable()
export class FleetSessionRepository {
    private readonly logger = new Logger(FleetSessionRepository.name);

    constructor(
        @InjectRepository(FleetSession)
        private readonly repository: Repository<FleetSession>,
    ) {}

    /**
     * Serialize an owner-session admission's count-then-insert against every
     * other one on the same machine (the eight-session limit, spec FR-16).
     * Postgres: `pg_advisory_xact_lock` held for `fn`; every other driver (the
     * SQLite e2e/CI stack): a documented no-op. A failure to TAKE the lock
     * admits unlocked (logged) — a broken safety valve never refuses a person;
     * a failure inside `fn` is re-raised and never re-run.
     */
    async withAdmissionLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
        if (this.repository.manager.connection.options.type !== 'postgres') return fn();
        let entered = false;
        try {
            return await this.repository.manager.connection.transaction(async (manager) => {
                await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
                    FLEET_SESSION_ADMISSION_LOCK_CLASS_ID,
                    advisoryLockObjectId(`fleet-session-node:${nodeId}`),
                ]);
                entered = true;
                return fn();
            });
        } catch (error) {
            if (entered) throw error;
            this.logger.warn(
                `Session admission lock unavailable for node ${nodeId} — admitting unlocked: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return fn();
        }
    }

    async create(data: Partial<FleetSession>): Promise<FleetSession> {
        return this.repository.save(this.repository.create(data));
    }

    async findById(id: string): Promise<FleetSession | null> {
        return this.repository.findOne({ where: { id } });
    }

    /** How a node's report finds its row: `(nodeId, daemonSessionId)` is unique. */
    async findByDaemonId(nodeId: string, daemonSessionId: string): Promise<FleetSession | null> {
        return this.repository.findOne({ where: { nodeId, daemonSessionId } });
    }

    /** Every session on a node the platform still believes alive. */
    async findLiveForNode(nodeId: string): Promise<FleetSession[]> {
        return this.repository.find({
            where: { nodeId, state: Not('ended') },
            order: { createdAt: 'ASC' },
        });
    }

    /** Live OWNER sessions on a node, oldest first (the limit and its refusal's list). */
    async findLiveOwnerForNode(nodeId: string): Promise<FleetSession[]> {
        return this.repository.find({
            where: { nodeId, kind: 'owner', state: Not('ended') },
            order: { createdAt: 'ASC' },
        });
    }

    /** Live AGENT sessions on a node (FL-15: a Task hand-off needs a free slot, spec U5). */
    async countLiveAgentForNode(nodeId: string): Promise<number> {
        return this.repository.count({ where: { nodeId, kind: 'agent', state: Not('ended') } });
    }

    /** The folders of the node's most recent sessions, newest first, distinct (spec FR-15). */
    async recentFolders(
        nodeId: string,
        limit: number = FLEET_SESSION_RECENT_FOLDERS,
    ): Promise<string[]> {
        const rows = await this.repository.find({
            select: { cwd: true, createdAt: true },
            where: { nodeId },
            order: { createdAt: 'DESC' },
            take: limit * 5,
        });
        const out: string[] = [];
        for (const row of rows) {
            if (!out.includes(row.cwd)) out.push(row.cwd);
            if (out.length >= limit) break;
        }
        return out;
    }

    /**
     * Sessions on these nodes, most recently active first, keyset-paged.
     * The caller decided which nodes the person may see; this only narrows.
     */
    async listForNodes(
        nodeIds: readonly string[],
        query: FleetSessionListQuery = {},
    ): Promise<FleetSession[]> {
        if (nodeIds.length === 0) return [];
        const limit = Math.min(
            FLEET_SESSION_LIST_MAX_LIMIT,
            Math.max(1, Math.floor(query.limit ?? FLEET_SESSION_LIST_DEFAULT_LIMIT)),
        );
        const builder = this.repository
            .createQueryBuilder('session')
            .where({ nodeId: In([...nodeIds]) });
        if (query.state === 'live') builder.andWhere('session.state <> :ended', { ended: 'ended' });
        if (query.state === 'ended') builder.andWhere('session.state = :ended', { ended: 'ended' });
        if (query.kind) builder.andWhere('session.kind = :kind', { kind: query.kind });
        if (query.agentId)
            builder.andWhere('session.agentId = :agentId', { agentId: query.agentId });
        if (query.since) builder.andWhere('session.createdAt >= :since', { since: query.since });
        if (query.taskId) {
            // A session knows its Run, a Run knows its Task (spec §7): no column of its own.
            builder.innerJoin(AgentRun, 'run', 'run.id = session.agentRunId').andWhere(
                'run.taskId = :taskId',
                { taskId: query.taskId },
            );
        }
        const cursor = parseCursor(query.cursor);
        if (cursor) {
            builder.andWhere(
                new Brackets((where) => {
                    where
                        .where('session.lastActivityAt < :cursorAt', { cursorAt: cursor.at })
                        .orWhere(
                            new Brackets((tie) => {
                                tie.where('session.lastActivityAt = :cursorAt', {
                                    cursorAt: cursor.at,
                                }).andWhere('session.id < :cursorId', { cursorId: cursor.id });
                            }),
                        );
                }),
            );
        }
        return builder
            .orderBy('session.lastActivityAt', 'DESC')
            .addOrderBy('session.id', 'DESC')
            .take(limit)
            .getMany();
    }

    /** Write a patch unconditionally (title, activity, late facts). */
    async update(id: string, patch: Partial<FleetSession>): Promise<void> {
        await this.repository.update({ id }, patch);
    }

    /**
     * Write a patch only while the session is still live. False when it had
     * already ended (somebody else's end won) — the caller then re-reads.
     */
    async updateIfLive(id: string, patch: Partial<FleetSession>): Promise<boolean> {
        const result = await this.repository.update({ id, state: Not('ended') }, patch);
        return (result.affected ?? 0) > 0;
    }

    /**
     * Write a patch only while the session is in one of `states` (FL-05: the
     * idle floor never moves a session that changed meanwhile). False when it
     * was not.
     */
    async updateIfState(
        id: string,
        states: readonly FleetSession['state'][],
        patch: Partial<FleetSession>,
    ): Promise<boolean> {
        const result = await this.repository.update({ id, state: In([...states]) }, patch);
        return (result.affected ?? 0) > 0;
    }

    /**
     * FL-05's idle floor: `working` / `done` sessions with no activity since
     * before `cutoff`, oldest first (the node's own 30-minute clock is primary).
     */
    async findIdleCandidates(cutoff: Date, limit = 200): Promise<FleetSession[]> {
        return this.repository.find({
            where: { state: In(['working', 'done']), lastActivityAt: LessThan(cutoff) },
            order: { lastActivityAt: 'ASC' },
            take: limit,
        });
    }

    /** Owner sessions still `starting` since before `cutoff` (the sweeper). */
    async findStartingBefore(cutoff: Date, limit = 200): Promise<FleetSession[]> {
        return this.repository.find({
            where: { state: 'starting', kind: 'owner', createdAt: LessThan(cutoff) },
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    /** Agent sessions still waiting for a slot (their job queued) since before `cutoff` (FL-04 P2 sweeper). */
    async findAgentStartingBefore(cutoff: Date, limit = 200): Promise<FleetSession[]> {
        return this.repository.find({
            where: { state: 'starting', kind: 'agent', createdAt: LessThan(cutoff) },
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }
}

/** The cursor of the row after which the next page starts. */
export function fleetSessionCursor(row: Pick<FleetSession, 'id' | 'lastActivityAt'>): string {
    const at =
        row.lastActivityAt instanceof Date ? row.lastActivityAt : new Date(row.lastActivityAt ?? 0);
    return `${at.toISOString()}|${row.id}`;
}

function parseCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw || raw.length > 120) return null;
    const bar = raw.indexOf('|');
    if (bar <= 0) return null;
    const at = new Date(raw.slice(0, bar));
    const id = raw.slice(bar + 1);
    if (Number.isNaN(at.getTime()) || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
    return { at, id };
}
