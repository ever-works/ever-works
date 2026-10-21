import { Injectable, Logger } from '@nestjs/common';
import {
    FleetAgentNodeAffinityRepository,
    FleetSessionService,
    readFleetCommandError,
    type FleetScheduleTasksPort,
} from '@ever-works/agent/fleet';
import {
    readFleetSessionScheduleLabels,
    TasksService,
    type TaskSessionScheduleDispatcher,
    type TaskSessionScheduleDispatchResult,
} from '@ever-works/agent/tasks-domain';
import type { Task } from '@ever-works/agent/entities';

/**
 * Schedules on computers (FL-13 P2, spec FR-8) — starts one fire of an
 * Agent-session schedule as an Agent SESSION on the computer the Agent is
 * pinned to (`TASK_SESSION_SCHEDULE_DISPATCHER`, read by
 * `TaskTransitionService.dispatchAgentRun` — the one dispatch choke point,
 * after its ownership check).
 *
 * The computer is the Agent's node affinity NOW (R-29 — the only pin); the
 * session is FL-04's (`FleetSessionService.start`, kind `agent`): its own Run
 * (trigger `session`) linked to this Task instance, the durable
 * `agent-session` job pinned to the node, the first message = the schedule's
 * prompt (the Task's description), the folder = the schedule's checkout or the
 * owner's home. The person who owns the Task is the actor (a schedule fires on
 * its owner's behalf, as a recurring Task always has).
 *
 * A fire that cannot start — the Agent is no longer pinned, the computer is
 * offline or lacks `--work`, the kill switch — answers the dispatch's own
 * failure shape (`error: 'session-<code>'`), so the recurrence dispatcher
 * records it like any failed dispatch (lane-log decision 21; the 60-minute
 * "wait while offline" of spec U10 is question Q4).
 */
@Injectable()
export class FleetSessionScheduleDispatcher implements TaskSessionScheduleDispatcher {
    private readonly logger = new Logger(FleetSessionScheduleDispatcher.name);

    constructor(
        private readonly affinities: FleetAgentNodeAffinityRepository,
        private readonly sessions: FleetSessionService,
    ) {}

    async dispatch(task: Task, agentId: string): Promise<TaskSessionScheduleDispatchResult> {
        const organizationId = task.organizationId ?? null;
        const affinity = organizationId
            ? await this.affinities.findForAgent(task.userId, organizationId, agentId).catch(() => null)
            : null;
        if (!affinity) {
            return { runId: null, dispatched: false, parked: false, error: 'session-not-pinned' };
        }
        const { provider, checkoutId } = readFleetSessionScheduleLabels(task.labels ?? null);
        const firstMessage = (task.description ?? '').trim() || task.title;
        try {
            const view = await this.sessions.start(
                affinity.nodeId,
                { userId: task.userId },
                {
                    kind: 'agent',
                    provider,
                    agentId,
                    firstMessage,
                    cwd: checkoutId ? '' : '~',
                    ...(checkoutId ? { checkoutId } : {}),
                    taskId: task.id,
                    title: task.title,
                },
            );
            return { runId: view.agentRunId ?? null, dispatched: true, parked: false };
        } catch (error) {
            const code = readFleetCommandError(error)?.code ?? 'internal';
            this.logger.warn(`Agent-session schedule fire for task ${task.id} did not start: ${code}`);
            return { runId: null, dispatched: false, parked: false, error: `session-${code}` };
        }
    }
}

/**
 * Schedules on computers (FL-13 P2) — `FLEET_SCHEDULE_TASKS_PORT` over the
 * Tasks domain: an Agent-session schedule IS a recurring Task (R-29), filed
 * exactly as a person files one — `TasksService.create` (its secret scan of
 * the description, its scope checks) then `setRecurring` with the cadence as a
 * cron and the computer's time zone.
 */
@Injectable()
export class FleetScheduleTasksAdapter implements FleetScheduleTasksPort {
    constructor(private readonly tasks: TasksService) {}

    async createRecurring(input: Parameters<FleetScheduleTasksPort['createRecurring']>[0]) {
        const scope = { tenantId: input.tenantId, organizationId: input.organizationId };
        const task = await this.tasks.create(
            input.userId,
            {
                title: input.title,
                description: input.prompt,
                agentId: input.agentId,
                labels: input.labels,
                createdByType: 'user',
                createdById: input.userId,
            },
            scope,
        );
        const recurring = await this.tasks.setRecurring(
            input.userId,
            task.id,
            { recurrenceCron: input.cron, recurrenceTimezone: input.timeZone },
            scope,
        );
        return { taskId: task.id, nextOccurrenceAt: recurring.nextOccurrenceAt ?? null };
    }
}
