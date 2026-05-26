import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';

/**
 * Filter shape for `findByUserIdScoped`. All fields optional — caller
 * combines them. Mirrors the controller list-query DTO from
 * agents/plan.md §4 (scope filter + status filter + per-target filter).
 */
export interface ListAgentsFilter {
    scope?: AgentScope;
    status?: AgentStatus | AgentStatus[];
    missionId?: string;
    ideaId?: string;
    workId?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

/**
 * Repository for the `agents` table (agents/plan.md §3.1).
 *
 * Includes the CAS-claim primitive `tryClaimForRun(agentId)` used by
 * the heartbeat dispatcher (`agent-heartbeat-dispatcher` task, Phase 6)
 * to atomically transition an Agent from `active → running` while
 * carrying `nextHeartbeatAt = null`. Mirrors the
 * `WorkScheduleRepository.tryMarkDispatched` pattern from
 * `packages/agent/src/database/repositories/work-schedule.repository.ts`.
 */
@Injectable()
export class AgentRepository {
    constructor(
        @InjectRepository(Agent)
        private readonly repository: Repository<Agent>,
    ) {}

    async findById(id: string): Promise<Agent | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdAndUser(id: string, userId: string): Promise<Agent | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    /**
     * Uniqueness check used by `AgentService.create`. Honors scope —
     * a tenant-scoped CEO and a Mission-scoped CEO are distinct rows
     * (matches `uq_agents_user_scope_slug`).
     */
    async findByUserIdAndSlug(
        userId: string,
        scope: AgentScope,
        slug: string,
        opts: { missionId?: string | null; ideaId?: string | null; workId?: string | null } = {},
    ): Promise<Agent | null> {
        return this.repository.findOne({
            where: {
                userId,
                scope,
                slug,
                missionId: opts.missionId ?? IsNull(),
                ideaId: opts.ideaId ?? IsNull(),
                workId: opts.workId ?? IsNull(),
            },
        });
    }

    async findByUserIdScoped(
        userId: string,
        filter: ListAgentsFilter = {},
    ): Promise<{ rows: Agent[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('agent')
            .where('agent.userId = :userId', { userId })
            .andWhere('agent.status != :archived', { archived: AgentStatus.ARCHIVED });

        if (filter.scope) {
            qb.andWhere('agent.scope = :scope', { scope: filter.scope });
        }
        if (filter.status) {
            if (Array.isArray(filter.status)) {
                qb.andWhere('agent.status IN (:...statuses)', { statuses: filter.status });
            } else {
                qb.andWhere('agent.status = :status', { status: filter.status });
            }
        }
        if (filter.missionId) {
            qb.andWhere('agent.missionId = :missionId', { missionId: filter.missionId });
        }
        if (filter.ideaId) {
            qb.andWhere('agent.ideaId = :ideaId', { ideaId: filter.ideaId });
        }
        if (filter.workId) {
            qb.andWhere('agent.workId = :workId', { workId: filter.workId });
        }
        if (filter.search) {
            qb.andWhere('(agent.name LIKE :q OR agent.slug LIKE :q OR agent.title LIKE :q)', {
                q: `%${filter.search}%`,
            });
        }

        const total = await qb.getCount();
        qb.orderBy('agent.updatedAt', 'DESC')
            .take(filter.limit ?? 50)
            .skip(filter.offset ?? 0);
        const rows = await qb.getMany();
        return { rows, total };
    }

    async save(agent: Agent): Promise<Agent> {
        return this.repository.save(agent);
    }

    async create(data: Partial<Agent>): Promise<Agent> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async updateById(id: string, data: Partial<Agent>): Promise<void> {
        await this.repository.update(id, data);
    }

    async archiveById(id: string): Promise<void> {
        await this.repository.update(id, { status: AgentStatus.ARCHIVED });
    }

    async deleteById(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    /**
     * Find active Agents whose heartbeat is due. Used by the
     * dispatcher (`AgentScheduleDispatcherService.dispatchDue`).
     *
     * Manual-cadence Agents (cadence='manual' or null) skip — they're
     * triggered explicitly via `POST /agents/:id/run-now`.
     */
    async findDueForHeartbeat(limit: number, now: Date = new Date()): Promise<Agent[]> {
        return this.repository
            .createQueryBuilder('agent')
            .where('agent.status = :active', { active: AgentStatus.ACTIVE })
            .andWhere('agent.heartbeatCadence IS NOT NULL')
            .andWhere("agent.heartbeatCadence != 'manual'")
            .andWhere('agent.nextHeartbeatAt IS NOT NULL')
            .andWhere('agent.nextHeartbeatAt <= :now', { now })
            .orderBy('agent.nextHeartbeatAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * CAS-claim the Agent for a dispatcher run. Atomic transition
     * `active → running` AND clears `nextHeartbeatAt` AND sets
     * `lastRunAt` — only succeeds if no other worker grabbed it first.
     *
     * Returns the previous `nextHeartbeatAt` if we won the claim (the
     * caller needs this to compute the next-fire time after the run
     * completes). Returns null if another worker beat us.
     *
     * Mirrors `WorkScheduleRepository.tryMarkDispatched`.
     */
    async tryClaimForRun(agentId: string): Promise<Date | null> {
        const agent = await this.repository.findOne({
            where: { id: agentId },
            select: ['id', 'nextHeartbeatAt', 'status'],
        });
        if (!agent?.nextHeartbeatAt || agent.status !== AgentStatus.ACTIVE) {
            return null;
        }

        const originalNext = agent.nextHeartbeatAt;
        const claimedAt = new Date();

        const result = await this.repository
            .createQueryBuilder()
            .update(Agent)
            .set({
                status: AgentStatus.RUNNING,
                lastRunAt: claimedAt,
                nextHeartbeatAt: null,
                updatedAt: claimedAt,
            })
            .where('id = :id', { id: agentId })
            .andWhere('status = :active', { active: AgentStatus.ACTIVE })
            .andWhere('nextHeartbeatAt = :originalNext', { originalNext })
            .execute();

        return (result.affected ?? 0) > 0 ? originalNext : null;
    }

    /**
     * FU-2 (post-review) — manual run-now variant. Permissive about
     * `nextHeartbeatAt` (manual agents may have no scheduled heartbeat)
     * and accepts ACTIVE *or* ERROR (operator hitting "Run now" on a
     * failed agent is the canonical retry path). Still atomic via CAS
     * on the status column so two concurrent run-now calls cannot
     * double-fire.
     *
     * Returns a marker `{ priorNextHeartbeatAt, priorStatus }` so the
     * release-on-failure path can restore the Agent to its prior shape
     * verbatim. `null` means another worker beat us.
     */
    async tryClaimForManualRun(
        agentId: string,
    ): Promise<{ priorNextHeartbeatAt: Date | null; priorStatus: AgentStatus } | null> {
        const agent = await this.repository.findOne({
            where: { id: agentId },
            select: ['id', 'nextHeartbeatAt', 'status'],
        });
        if (!agent) return null;
        if (agent.status !== AgentStatus.ACTIVE && agent.status !== AgentStatus.ERROR) {
            return null;
        }

        const priorNext = agent.nextHeartbeatAt;
        const priorStatus = agent.status;
        const claimedAt = new Date();

        const result = await this.repository
            .createQueryBuilder()
            .update(Agent)
            .set({
                status: AgentStatus.RUNNING,
                lastRunAt: claimedAt,
                nextHeartbeatAt: null,
                updatedAt: claimedAt,
            })
            .where('id = :id', { id: agentId })
            .andWhere('status = :prior', { prior: priorStatus })
            .execute();

        return (result.affected ?? 0) > 0
            ? { priorNextHeartbeatAt: priorNext, priorStatus }
            : null;
    }

    /**
     * Release the Agent back to `active` after a successful run, with
     * the computed `nextHeartbeatAt`. Resets errorCount + sets
     * lastRunStatus.
     */
    async releaseAfterRun(
        agentId: string,
        nextHeartbeatAt: Date | null,
        lastRunStatus: string,
    ): Promise<void> {
        await this.repository.update(agentId, {
            status: AgentStatus.ACTIVE,
            nextHeartbeatAt,
            lastRunStatus,
            errorCount: 0,
        });
    }

    /**
     * FU-2 (post-review) — release path for manual run-now failures.
     * Restores the Agent to the priorStatus + priorNextHeartbeatAt
     * captured at claim time so an ERROR-status Agent doesn't get
     * silently promoted to ACTIVE just because the user clicked
     * "Run now" and the trigger failed.
     */
    async releaseAfterManualRunFailure(
        agentId: string,
        prior: { priorStatus: AgentStatus; priorNextHeartbeatAt: Date | null },
        lastRunStatus: string,
    ): Promise<void> {
        await this.repository.update(agentId, {
            status: prior.priorStatus,
            nextHeartbeatAt: prior.priorNextHeartbeatAt,
            lastRunStatus,
        });
    }

    /**
     * Increment the errorCount after a failed run. If the new value
     * crosses `pauseAfterFailures`, transition to `error`. Otherwise
     * leave at `active` so the dispatcher will retry.
     */
    async incrementErrorCount(
        agentId: string,
        nextHeartbeatAt: Date | null,
    ): Promise<{ paused: boolean }> {
        await this.repository.increment({ id: agentId }, 'errorCount', 1);
        const agent = await this.repository.findOne({
            where: { id: agentId },
            select: ['id', 'errorCount', 'pauseAfterFailures'],
        });
        if (agent && agent.errorCount >= agent.pauseAfterFailures) {
            await this.repository.update(agentId, {
                status: AgentStatus.ERROR,
                nextHeartbeatAt: null,
                lastRunStatus: 'failed',
            });
            return { paused: true };
        }
        await this.repository.update(agentId, {
            status: AgentStatus.ACTIVE,
            nextHeartbeatAt,
            lastRunStatus: 'failed',
        });
        return { paused: false };
    }

    /**
     * Conservative status transition — returns false if the move is
     * disallowed by the state machine described in agents/spec.md §3.1
     * (FR-5). Service layer wraps this with a proper exception.
     */
    async transitionStatus(
        agentId: string,
        from: AgentStatus | AgentStatus[],
        to: AgentStatus,
    ): Promise<boolean> {
        const fromList = Array.isArray(from) ? from : [from];
        const result = await this.repository
            .createQueryBuilder()
            .update(Agent)
            .set({ status: to, updatedAt: new Date() })
            .where('id = :id', { id: agentId })
            .andWhere('status IN (:...from)', { from: fromList })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Reset stuck runs — used by a clean-up job or test fixtures to
     * unwedge Agents whose `RUNNING` claim never released (e.g. worker
     * crashed mid-run). Only resets when `lastRunAt` is older than
     * `olderThan`.
     */
    async findStuckRunning(olderThan: Date): Promise<Agent[]> {
        return this.repository.find({
            where: {
                status: AgentStatus.RUNNING,
                lastRunAt: LessThanOrEqual(olderThan),
            },
        });
    }

    /**
     * Bulk-find by scope + a set of mission/idea/work ids. Used by the
     * per-target tabs (`/works/:id/agents` etc.).
     */
    async findByScopeTarget(userId: string, scope: AgentScope, ids: string[]): Promise<Agent[]> {
        if (ids.length === 0) {
            return [];
        }
        const column: keyof Agent =
            scope === AgentScope.MISSION
                ? 'missionId'
                : scope === AgentScope.IDEA
                  ? 'ideaId'
                  : 'workId';
        return this.repository.find({
            // Post-rebase fix: `Partial<Agent>` doesn't cover TypeORM
            // FindOperator values; use `FindOptionsWhere<Agent>` which
            // is the proper "criteria" type for `.find({where: ...})`.
            where: {
                userId,
                scope,
                [column]: In(ids),
                status: Not(AgentStatus.ARCHIVED),
            } as FindOptionsWhere<Agent>,
        });
    }
}
