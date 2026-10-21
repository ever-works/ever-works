import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { judgeFleetHandoffComputer, type FleetSessionTaskRef } from '@ever-works/contracts';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import type { Agent } from '../../entities/agent.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { Task } from '../../entities/task.entity';
import { taskBranchName } from '../../tasks-domain/task-isolation';
import { FleetAgentNodeAffinityRepository } from '../fleet-agent-node-affinity.repository';
import { FleetNodeRepository } from '../fleet-node.repository';
import { fleetSessionError } from './fleet-session.errors';
import { FleetSessionRepository } from './fleet-session.repository';

const UUID = /^[0-9a-f-]{36}$/i;

/** What a Task hand-off start carries onto the session and its Run (FL-15 spec FR-6). */
export interface FleetSessionTaskAdmission {
    taskId: string;
    workId: string | null;
    slug: string;
    title: string;
    /** The Task's branch (FL-06 FR-4): the stored `branchRef`, else the branch rule's first cut; null without a Work. */
    branch: string | null;
}

/** The Agent a hand-off is judged for. */
export type FleetSessionTaskAgent = Pick<Agent, 'id' | 'name' | 'organizationId'> & { userId?: string };

/**
 * Tasks on computers (FL-15 P1) — the start-time rules of a Task hand-off and
 * the Task a session's Run carries, agent-side so every caller of FL-04's one
 * start path (REST, the Agent tools, the CLI) gets them:
 *
 *  - the Task exists and the person may see it (their own, or their Agent's
 *    Organization's) — else the 404 of an unknown id;
 *  - `busy` while the same Agent already works the Task (a queued or running
 *    Run for (Task, Agent) — the dedup assign-task uses, spec U13), naming
 *    the session when the Run is one;
 *  - the Agent's pinned computer is respected and NEVER written (FR-3): a
 *    start on another computer is refused `invalid` naming the pin;
 *  - a free Agent-session slot on the computer (spec U5, `limit_exceeded`).
 *
 * The order is `judgeFleetHandoffComputer`'s, the one the dialog lists
 * computers by, so the dialog and the server agree.
 */
@Injectable()
export class FleetSessionTaskService {
    private readonly logger = new Logger(FleetSessionTaskService.name);

    constructor(
        @InjectRepository(Task) private readonly tasks: Repository<Task>,
        private readonly sessions: FleetSessionRepository,
        private readonly nodes: FleetNodeRepository,
        @Optional() private readonly runs?: AgentRunRepository,
        @Optional() private readonly affinities?: FleetAgentNodeAffinityRepository,
    ) {}

    /**
     * May this Agent start a session for this Task on this computer? Answers
     * what the session and its Run carry; throws the CONTRACTS §8 refusal
     * otherwise. Never writes anything.
     */
    async admit(input: {
        userId: string;
        agent: FleetSessionTaskAgent;
        node: Pick<FleetNode, 'id' | 'name' | 'effectiveMaxConcurrentJobs'>;
        taskId: string;
    }): Promise<FleetSessionTaskAdmission> {
        const task = await this.findTask(input.userId, input.taskId, input.agent.organizationId ?? null);
        if (!task) throw fleetSessionError('not_found', 'no such Task', { field: 'taskId' });

        if (this.runs) {
            const inflight = await this.runs.findInFlightForTaskAgent(task.id, input.agent.id);
            if (inflight) {
                const sessionId = (inflight as { fleetSessionId?: string | null }).fleetSessionId ?? null;
                throw fleetSessionError(
                    'busy',
                    `${input.agent.name} is already working on ${task.slug}`,
                    { runId: inflight.id, ...(sessionId ? { sessionId } : {}) },
                );
            }
        }

        const pinnedNodeId = await this.pinnedNodeId(input.userId, input.agent);
        const pinnedNode =
            pinnedNodeId && pinnedNodeId !== input.node.id
                ? await this.nodes.findById(pinnedNodeId).catch(() => null)
                : null;
        const verdict = judgeFleetHandoffComputer({
            nodeId: input.node.id,
            nodeName: input.node.name,
            // FL-04's own start rules run in the session service, before this.
            refusal: null,
            pinnedNodeId,
            pinnedNodeName: pinnedNode?.name ?? null,
            agentName: input.agent.name,
            liveAgentSessions: await this.sessions.countLiveAgentForNode(input.node.id),
            slots:
                typeof input.node.effectiveMaxConcurrentJobs === 'number'
                    ? input.node.effectiveMaxConcurrentJobs
                    : null,
        });
        if (!verdict.selectable) {
            if (verdict.reason === 'not-pinned') {
                throw fleetSessionError('invalid', verdict.hint ?? 'the Agent is pinned to another computer', {
                    field: 'nodeId',
                    reason: 'not-pinned',
                    pinnedNodeId,
                });
            }
            throw fleetSessionError('limit_exceeded', verdict.hint ?? 'no free agent slot on this computer', {
                reason: verdict.reason,
                slots: input.node.effectiveMaxConcurrentJobs ?? null,
            });
        }

        const branch =
            typeof task.branchRef === 'string' && task.branchRef.trim()
                ? task.branchRef.trim()
                : task.workId
                  ? taskBranchName(task)
                  : null;
        return {
            taskId: task.id,
            workId: task.workId ?? null,
            slug: task.slug,
            title: task.title,
            branch,
        };
    }

    /** The computer an Agent is pinned to, or null (read only — FR-3). Never throws. */
    async pinnedNodeId(userId: string, agent: FleetSessionTaskAgent): Promise<string | null> {
        if (!this.affinities || !agent.organizationId) return null;
        try {
            const row = await this.affinities.findForAgent(userId, agent.organizationId, agent.id);
            return row?.nodeId ?? null;
        } catch (error) {
            this.logger.debug(
                `Affinity read for Agent ${agent.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }

    /**
     * The Task each Run works on, by Run id (the session card's chip, FR-10).
     * Runs without a Task are absent. Never throws: a failed read answers an
     * empty map and the cards simply carry no chip.
     */
    async refsForRuns(runIds: readonly string[]): Promise<Map<string, FleetSessionTaskRef>> {
        const out = new Map<string, FleetSessionTaskRef>();
        const ids = [...new Set(runIds.filter((id) => typeof id === 'string' && UUID.test(id)))];
        if (ids.length === 0 || !this.runs) return out;
        try {
            const runs = await this.runs.findByIds(ids);
            const taskIds = [...new Set(runs.map((run) => run.taskId).filter((id): id is string => !!id))];
            if (taskIds.length === 0) return out;
            const tasks = await this.tasks.find({
                select: { id: true, slug: true, title: true },
                where: { id: In(taskIds) },
            });
            const byId = new Map(tasks.map((task) => [task.id, task]));
            for (const run of runs) {
                const task = run.taskId ? byId.get(run.taskId) : undefined;
                if (task) out.set(run.id, { id: task.id, slug: task.slug, title: task.title });
            }
        } catch (error) {
            this.logger.debug(
                `Task refs for ${ids.length} runs failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return out;
    }

    /** The person's own Task, or one of their Agent's Organization. */
    private async findTask(userId: string, taskId: string, organizationId: string | null): Promise<Task | null> {
        if (typeof taskId !== 'string' || !UUID.test(taskId)) {
            throw fleetSessionError('invalid', 'taskId', { field: 'taskId' });
        }
        const own = await this.tasks.findOne({ where: { id: taskId, userId } });
        if (own) return own;
        if (!organizationId) return null;
        return this.tasks.findOne({ where: { id: taskId, organizationId } });
    }
}
