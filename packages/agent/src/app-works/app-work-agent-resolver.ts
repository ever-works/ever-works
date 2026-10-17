import { Injectable, Logger, Optional } from '@nestjs/common';
import { ownershipScopeMatches, type OwnershipScope } from '../database/ownership-scope';
import { AgentRepository } from '../database/repositories/agent.repository';
import { TaskRepository } from '../database/repositories/task.repository';
import { AgentScope, AgentStatus, type Agent } from '../entities/agent.entity';
import { TaskStatus } from '../entities/task.entity';

/**
 * APW-08 T25 — the agent-resolution rule (plan §2.8, Resolution R-21).
 *
 * One answer to "which Agent changes this App Work?", shared by every caller that files a
 * Task on an App Work without a person picking the Agent:
 *
 *   - `AppChangeRequestService` — `POST /api/works/:id/evolve` (the chat-to-modify loop);
 *   - `AppProvisioningService` — APW-04's AI provisioning Task;
 *   - APW-02's conflict Task (`AppUpstreamStateService.recordConflict`), which injects the
 *     token `@Optional()` and, before this file, always saw `undefined`.
 *
 * ## The rule — first match wins
 *
 *   1. `recent-task` — the Agent of the most recently updated `in_review` / `done` Task on
 *      the Work, while that Agent still exists and is eligible;
 *   2. `pinned` — the ONLY eligible Agent pinned to the Work (`scope: work`);
 *   3. `assigned` — the ONLY eligible Agent whose targets include the Work;
 *   4. `tenant-default` — the ONLY eligible tenant-scope Agent the owner has (added
 *      2026-10-17, lane aw-ai: the orchestrator's brief is "the Work's configured agent, else
 *      the tenant default", and a person with exactly one committing Agent should not be
 *      asked to pick it). Two or more is ambiguous and answers `null`, so the caller offers
 *      the picker rather than guessing.
 *
 * **Eligible** = not archived and `permissions.canCommitToRepo === true`: an App Work change
 * is a commit, and an Agent that may not commit cannot deliver one.
 *
 * Pure over repository reads; holds no state. A failing read is treated as "no candidate
 * from that step" and logged — the resolver never throws.
 */

/** Where the resolved Agent came from. */
export type AppWorkAgentSource = 'recent-task' | 'pinned' | 'assigned' | 'tenant-default';

/** The resolver's answer. */
export interface AppWorkAgentResolution {
    readonly agentId: string;
    readonly source: AppWorkAgentSource;
}

/** The port every consumer injects (CONTRACTS §2 row, APW-08 T25). */
export interface AppWorkAgentResolver {
    resolve(input: {
        userId: string;
        workId: string;
        /** The Work's ownership scope; when given, a candidate outside it is skipped. */
        scope?: OwnershipScope;
    }): Promise<AppWorkAgentResolution | null>;
}

/**
 * DI token for {@link AppWorkAgentResolver} — owned by APW-08 T25.
 *
 * Declared HERE and re-exported from `app-upstream-state.service.ts` (where the provisional
 * declaration used to live), so there is exactly one Symbol and APW-02's injection receives
 * this module's binding.
 */
export const APP_WORK_AGENT_RESOLVER = Symbol('APP_WORK_AGENT_RESOLVER');

/** How many recent Tasks step 1 looks through before giving up. */
const RECENT_TASK_WINDOW = 20;

/** How many Agents a scoped step reads; more than one eligible is already ambiguous. */
const SCOPED_AGENT_WINDOW = 25;

/** Is this Agent allowed to deliver an App Work change? */
export function isCommittingAgent(agent: Pick<Agent, 'status' | 'permissions'> | null): boolean {
    if (!agent) return false;
    if (agent.status === AgentStatus.ARCHIVED) return false;
    return agent.permissions?.canCommitToRepo === true;
}

@Injectable()
export class AppWorkAgentResolverService implements AppWorkAgentResolver {
    private readonly logger = new Logger(AppWorkAgentResolverService.name);

    constructor(
        @Optional() private readonly tasks?: TaskRepository,
        @Optional() private readonly agents?: AgentRepository,
    ) {}

    async resolve(input: {
        userId: string;
        workId: string;
        scope?: OwnershipScope;
    }): Promise<AppWorkAgentResolution | null> {
        const { userId, workId, scope } = input;
        if (!userId || !workId || !this.agents) {
            return null;
        }

        const recent = await this.fromRecentTask(userId, workId, scope);
        if (recent) return { agentId: recent, source: 'recent-task' };

        const pinned = await this.onlyEligible(userId, { scope: AgentScope.WORK, workId }, scope);
        if (pinned) return { agentId: pinned, source: 'pinned' };

        const assigned = await this.onlyEligible(userId, { assignedWorkId: workId }, scope);
        if (assigned) return { agentId: assigned, source: 'assigned' };

        const tenant = await this.onlyEligible(userId, { scope: AgentScope.TENANT }, scope);
        if (tenant) return { agentId: tenant, source: 'tenant-default' };

        return null;
    }

    /**
     * Every eligible Agent the owner has, newest first, capped — the `409 agentRequired`
     * picker's candidate list (≤ 20, plan §4).
     */
    async listCandidates(
        userId: string,
        scope?: OwnershipScope,
        limit = 20,
    ): Promise<Array<{ id: string; name: string }>> {
        if (!this.agents) return [];
        try {
            const { rows } = await this.agents.findByUserIdScoped(
                userId,
                { limit: Math.max(limit * 3, limit) },
                scope,
            );
            return rows
                .filter((agent) => isCommittingAgent(agent) && ownershipScopeMatches(agent, scope))
                .slice(0, limit)
                .map((agent) => ({ id: agent.id, name: agent.name ?? agent.slug ?? agent.id }));
        } catch (error) {
            this.logger.warn(`Agent candidates for user ${userId} failed: ${errorText(error)}`);
            return [];
        }
    }

    private async fromRecentTask(
        userId: string,
        workId: string,
        scope?: OwnershipScope,
    ): Promise<string | null> {
        if (!this.tasks || !this.agents) return null;
        let rows: Array<{ agentId?: string | null; updatedAt?: Date | null }>;
        try {
            const page = await this.tasks.findByUserIdFiltered(
                userId,
                {
                    workId,
                    status: [TaskStatus.IN_REVIEW, TaskStatus.DONE],
                    limit: RECENT_TASK_WINDOW,
                },
                scope,
            );
            rows = page.rows;
        } catch (error) {
            this.logger.warn(`Recent-Task lookup for work ${workId} failed: ${errorText(error)}`);
            return null;
        }

        const ordered = [...rows].sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
        const seen = new Set<string>();
        for (const row of ordered) {
            const agentId = row.agentId;
            if (!agentId || seen.has(agentId)) continue;
            seen.add(agentId);
            const agent = await this.agents
                .findByIdAndUser(agentId, userId, scope)
                .catch(() => null);
            if (isCommittingAgent(agent) && ownershipScopeMatches(agent as Agent, scope)) {
                return agentId;
            }
        }
        return null;
    }

    private async onlyEligible(
        userId: string,
        filter: { scope?: AgentScope; workId?: string; assignedWorkId?: string },
        scope?: OwnershipScope,
    ): Promise<string | null> {
        if (!this.agents) return null;
        try {
            const { rows } = await this.agents.findByUserIdScoped(
                userId,
                { ...filter, limit: SCOPED_AGENT_WINDOW },
                scope,
            );
            const eligible = rows.filter(
                (agent) => isCommittingAgent(agent) && ownershipScopeMatches(agent, scope),
            );
            return eligible.length === 1 ? eligible[0].id : null;
        } catch (error) {
            this.logger.warn(
                `Agent lookup ${JSON.stringify(filter)} for user ${userId} failed: ${errorText(error)}`,
            );
            return null;
        }
    }
}

function timeOf(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
