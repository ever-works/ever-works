import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { TasksService } from '../tasks-domain/tasks.service';
import { AgentsService } from '../agents/agents.service';
import {
    AGENT_HEARTBEAT_TRIGGER,
    AgentScheduleDispatcherService,
    type AgentHeartbeatTrigger,
} from '../agents/agent-schedule-dispatcher.service';
import { MissionsService } from '../missions/missions.service';
import { InboundTriggersService } from '../triggers/inbound-triggers.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { SchedulesService } from './schedules.service';
import {
    MISSION_PAUSE_NOT_ACKNOWLEDGED,
    SCHEDULE_ALREADY_RUNNING,
    SCHEDULE_CONTROL_UNAVAILABLE,
    SCHEDULE_NO_AGENT,
    SCHEDULE_OWNER_ARCHIVED,
} from './schedule-control.codes';
import type {
    ScheduleControlName,
    ScheduleControlReasonKey,
    ScheduleSourceType,
    ScheduleView,
} from './schedule-view.types';

/** Who is acting, and in which workspace scope. */
export interface ScheduleControlContext {
    userId: string;
    tenantId: string | null;
    organizationId: string | null;
}

/** A synthetic schedule id split into its two halves. */
export interface ParsedScheduleId {
    sourceType: ScheduleSourceType;
    ownerKey: string;
}

/**
 * What run-now produced. A recurring Task and a heartbeat produce Runs; a
 * Mission tick raises Ideas instead and carries NO run id — the surface links
 * to the Mission rather than to a receipt it cannot make.
 */
export type ScheduleRunNowResult =
    | {
          kind: 'run';
          scheduleId: string;
          runIds: string[];
          /** Parked by the dispatch gate rather than started. */
          parked: boolean;
          queuedReason: string | null;
          /** The spawned Task instance, for a recurring Task fire. */
          taskId: string | null;
          /** The UNCHANGED next scheduled fire. */
          nextRunAt: string | null;
      }
    | {
          kind: 'mission-tick';
          scheduleId: string;
          missionId: string;
          ownerLink: string;
          outcome: string;
          ideasCreated: number | null;
          ideasQueued: number | null;
      };

const SOURCE_TYPES: readonly ScheduleSourceType[] = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
    'inbound_trigger',
];

/** Split `${sourceType}:${ownerKey}`; null when the shape is wrong. */
export function parseScheduleId(id: string): ParsedScheduleId | null {
    if (typeof id !== 'string') return null;
    const parts = id.split(':');
    if (parts.length !== 2 || !parts[1]) return null;
    const sourceType = parts[0] as ScheduleSourceType;
    if (!SOURCE_TYPES.includes(sourceType)) return null;
    return { sourceType, ownerKey: parts[1] };
}

function refusalCode(reason: ScheduleControlReasonKey | undefined): string {
    if (reason === 'noAgent') return SCHEDULE_NO_AGENT;
    if (reason === 'ownerArchived') return SCHEDULE_OWNER_ARCHIVED;
    return SCHEDULE_CONTROL_UNAVAILABLE;
}

/**
 * Schedules — run now, pause and resume, for any row of the workspace list.
 *
 * Owns NO write of its own. It resolves the synthetic id against the
 * caller's own projection (so a foreign or missing id is one and the same
 * 404), refuses exactly what the row's control descriptor already declared,
 * and otherwise delegates to the domain service that owns the row — so every
 * existing ownership check, state machine and activity trail is inherited:
 *
 *  - recurring Task → `TasksService` (pause keeps the cadence; run-now goes
 *    through the gated Task dispatch path and never moves the next fire);
 *  - Agent heartbeat → `AgentsService` for the pause, and the Agent run-now
 *    dispatcher through the configured heartbeat trigger binding;
 *  - Mission tick → `MissionsService` (pausing asks first, because it pauses
 *    the whole Mission; run-now raises Ideas, not a Run);
 *  - inbound Trigger → `InboundTriggersService`.
 *
 * Every dependency is @Optional(): a reduced module graph answers 503 for
 * the control it cannot perform instead of failing to boot.
 */
@Injectable()
export class ScheduleControlService {
    private readonly logger = new Logger(ScheduleControlService.name);

    constructor(
        private readonly schedules: SchedulesService,
        @Optional() private readonly tasks?: TasksService,
        @Optional() private readonly agents?: AgentsService,
        @Optional() private readonly heartbeatDispatcher?: AgentScheduleDispatcherService,
        @Optional()
        @Inject(AGENT_HEARTBEAT_TRIGGER)
        private readonly heartbeatTrigger?: AgentHeartbeatTrigger,
        @Optional() private readonly missions?: MissionsService,
        @Optional() private readonly inboundTriggers?: InboundTriggersService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    async runNow(ctx: ScheduleControlContext, id: string): Promise<ScheduleRunNowResult> {
        const { parsed, row } = await this.resolve(ctx, id);
        this.assertAllowed(row, 'runNow');
        const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId };

        switch (parsed.sourceType) {
            case 'recurring_task': {
                const tasks = this.require(this.tasks, 'recurring tasks');
                const result = await tasks.runRecurringNow(ctx.userId, parsed.ownerKey, scope);
                if (
                    result.runs.length > 0 &&
                    result.runs.every((run) => run.error === 'no-dispatcher')
                ) {
                    throw new ServiceUnavailableException(
                        'No job runtime is configured, so this schedule cannot run now.',
                    );
                }
                const parkedRun = result.runs.find((run) => run.parked);
                return {
                    kind: 'run',
                    scheduleId: row.id,
                    runIds: result.runs
                        .map((run) => run.runId)
                        .filter((runId): runId is string => Boolean(runId)),
                    parked: result.runs.length > 0 && result.runs.every((run) => run.parked),
                    queuedReason: parkedRun?.queuedReason ?? null,
                    taskId: result.instanceId,
                    nextRunAt: result.nextOccurrenceAt
                        ? result.nextOccurrenceAt.toISOString()
                        : null,
                };
            }
            case 'agent_heartbeat': {
                const agents = this.require(this.agents, 'agents');
                const dispatcher = this.require(this.heartbeatDispatcher, 'heartbeat runs');
                const trigger = this.require(this.heartbeatTrigger, 'heartbeat runs');
                await agents.getOne(ctx.userId, parsed.ownerKey, scope);
                const outcome = await dispatcher.dispatchOne(trigger, parsed.ownerKey);
                if (outcome.outcome === 'failed') {
                    throw new ServiceUnavailableException(outcome.message);
                }
                if (outcome.outcome === 'skipped') {
                    if (outcome.reason === 'agent-missing') {
                        throw new NotFoundException('Schedule not found.');
                    }
                    if (outcome.reason === 'already-claimed') {
                        throw new ConflictException({
                            code: SCHEDULE_ALREADY_RUNNING,
                            message: 'This schedule is already running.',
                        });
                    }
                    if (outcome.reason === 'inactive') {
                        throw new ConflictException({
                            code: SCHEDULE_CONTROL_UNAVAILABLE,
                            reasonKey: 'ownerInactive',
                            message: 'The agent is not active.',
                        });
                    }
                    return {
                        kind: 'run',
                        scheduleId: row.id,
                        runIds: [],
                        parked: true,
                        queuedReason: outcome.reason,
                        taskId: null,
                        nextRunAt: row.nextRunAt,
                    };
                }
                await this.logActivity(ctx, row, ActivityActionType.SCHEDULE_EXECUTED, {
                    control: 'runNow',
                    runId: outcome.runId,
                });
                return {
                    kind: 'run',
                    scheduleId: row.id,
                    runIds: [outcome.runId],
                    parked: false,
                    queuedReason: null,
                    taskId: null,
                    nextRunAt: row.nextRunAt,
                };
            }
            case 'mission_tick': {
                const missions = this.require(this.missions, 'missions');
                const tick = await missions.runNow(ctx.userId, parsed.ownerKey, scope);
                await this.logActivity(ctx, row, ActivityActionType.SCHEDULE_EXECUTED, {
                    control: 'runNow',
                    outcome: tick.status,
                });
                return {
                    kind: 'mission-tick',
                    scheduleId: row.id,
                    missionId: parsed.ownerKey,
                    ownerLink: row.ownerLink,
                    outcome: tick.status,
                    ideasCreated: tick.ideasCreated ?? null,
                    ideasQueued: tick.ideasQueued ?? null,
                };
            }
            default:
                // The descriptor already refused every other source.
                throw this.unavailable(row, 'runNow');
        }
    }

    async pause(
        ctx: ScheduleControlContext,
        id: string,
        opts: { acknowledgeMissionPause?: boolean } = {},
    ): Promise<ScheduleView> {
        const { parsed, row } = await this.resolve(ctx, id);
        if (row.controls?.disabledReasons.pause === 'alreadyPaused') return row;
        this.assertAllowed(row, 'pause');
        if (parsed.sourceType === 'mission_tick' && opts.acknowledgeMissionPause !== true) {
            throw new ConflictException({
                code: MISSION_PAUSE_NOT_ACKNOWLEDGED,
                message:
                    'Pausing this cadence pauses the whole mission. Acknowledge that before pausing.',
            });
        }
        const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId };

        switch (parsed.sourceType) {
            case 'recurring_task':
                await this.require(this.tasks, 'recurring tasks').pauseRecurrence(
                    ctx.userId,
                    parsed.ownerKey,
                    scope,
                );
                break;
            case 'agent_heartbeat':
                await this.require(this.agents, 'agents').pauseHeartbeat(
                    ctx.userId,
                    parsed.ownerKey,
                    scope,
                );
                break;
            case 'mission_tick':
                await this.require(this.missions, 'missions').pause(
                    ctx.userId,
                    parsed.ownerKey,
                    scope,
                );
                break;
            case 'inbound_trigger':
                await this.require(this.inboundTriggers, 'inbound triggers').pause(
                    { userId: ctx.userId, organizationId: ctx.organizationId },
                    parsed.ownerKey,
                );
                break;
            default:
                throw this.unavailable(row, 'pause');
        }

        const after = await this.reload(ctx, row);
        await this.logActivity(ctx, row, ActivityActionType.SCHEDULE_PAUSED, {
            control: 'pause',
            before: { status: row.status },
            after: { status: after.status },
        });
        return after;
    }

    async resume(ctx: ScheduleControlContext, id: string): Promise<ScheduleView> {
        const { parsed, row } = await this.resolve(ctx, id);
        if (row.controls?.disabledReasons.resume === 'notPaused') return row;
        this.assertAllowed(row, 'resume');
        const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId };

        switch (parsed.sourceType) {
            case 'recurring_task':
                await this.require(this.tasks, 'recurring tasks').resumeRecurrence(
                    ctx.userId,
                    parsed.ownerKey,
                    scope,
                );
                break;
            case 'agent_heartbeat':
                await this.require(this.agents, 'agents').resumeHeartbeat(
                    ctx.userId,
                    parsed.ownerKey,
                    scope,
                );
                break;
            case 'mission_tick':
                await this.require(this.missions, 'missions').resume(
                    ctx.userId,
                    parsed.ownerKey,
                    scope,
                );
                break;
            case 'inbound_trigger':
                await this.require(this.inboundTriggers, 'inbound triggers').resume(
                    { userId: ctx.userId, organizationId: ctx.organizationId },
                    parsed.ownerKey,
                );
                break;
            default:
                throw this.unavailable(row, 'resume');
        }

        const after = await this.reload(ctx, row);
        await this.logActivity(ctx, row, ActivityActionType.SCHEDULE_RESUMED, {
            control: 'resume',
            before: { status: row.status },
            after: { status: after.status },
        });
        return after;
    }

    // ── internals ─────────────────────────────────────────────────

    private async resolve(
        ctx: ScheduleControlContext,
        id: string,
    ): Promise<{ parsed: ParsedScheduleId; row: ScheduleView }> {
        const parsed = parseScheduleId(id);
        if (!parsed) {
            throw new BadRequestException('Malformed schedule id.');
        }
        const row = await this.schedules.findOne(
            { userId: ctx.userId, organizationId: ctx.organizationId },
            id,
        );
        // 404 — never 403: a Schedule that is not the caller's is
        // indistinguishable from one that does not exist.
        if (!row) {
            throw new NotFoundException('Schedule not found.');
        }
        return { parsed, row };
    }

    private async reload(ctx: ScheduleControlContext, row: ScheduleView): Promise<ScheduleView> {
        const fresh = await this.schedules
            .findOne({ userId: ctx.userId, organizationId: ctx.organizationId }, row.id)
            .catch(() => null);
        return fresh ?? row;
    }

    private assertAllowed(row: ScheduleView, control: ScheduleControlName): void {
        if (row.controls && row.controls[control] === false) {
            throw this.unavailable(row, control);
        }
    }

    private unavailable(row: ScheduleView, control: ScheduleControlName): ConflictException {
        const reasonKey = row.controls?.disabledReasons[control];
        return new ConflictException({
            code: refusalCode(reasonKey),
            reasonKey: reasonKey ?? null,
            message: `This control is not available for this schedule.`,
        });
    }

    private require<T>(dependency: T | undefined, what: string): T {
        if (!dependency) {
            throw new ServiceUnavailableException(
                `Schedules cannot control ${what} in this deployment.`,
            );
        }
        return dependency;
    }

    private async logActivity(
        ctx: ScheduleControlContext,
        row: ScheduleView,
        actionType: ActivityActionType,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: ctx.userId,
                action: actionType,
                actionType,
                status: ActivityStatus.COMPLETED,
                summary: `Schedule ${row.id} — ${actionType}`,
                details: {
                    ...details,
                    scheduleId: row.id,
                    sourceType: row.sourceType,
                    ownerId: row.ownerId,
                    ownerName: row.ownerName,
                },
            });
        } catch (err) {
            this.logger.warn(`Failed to log schedule activity ${actionType}: ${err}`);
        }
    }
}
