import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not, In, MoreThan, type FindOptionsWhere } from 'typeorm';
import { Task } from '../entities/task.entity';
import { Agent, AgentStatus } from '../entities/agent.entity';
import { Mission, MissionType, MissionStatus } from '../entities/mission.entity';
import { WorkSchedule } from '../entities/work-schedule.entity';
import { Work } from '../entities/work.entity';
import { WorkScheduleStatus } from '../entities/types';
import {
    describeCron,
    describeIntervalMinutes,
    describeRrule,
    describeWorkCadence,
    computeNextCronFire,
} from './cadence';
import type {
    ScheduleQueryFilters,
    ScheduleScope,
    ScheduleStatus,
    ScheduleView,
} from './schedule-view.types';

/**
 * Defence-in-depth cap on rows read per source. Per-user schedule counts
 * are small; this only bounds memory if a user has pathologically many
 * Works (data-sync matches nearly every Work). P1 is un-paginated
 * (spec §4.1) — cursor pagination is a documented follow-up (spec §11.4).
 */
const MAX_PER_SOURCE = 500;

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    const time = value instanceof Date ? value : new Date(value);
    return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/**
 * Schedules ("Cadence") aggregation service (spec §4.3).
 *
 * Read-only. Projects the six scheduled sources — recurring Tasks, Agent
 * heartbeats, Work schedules, Mission ticks, item source-validation, and
 * data-sync polling — into one unified `ScheduleView[]`, scoped to the
 * caller exactly like every other Tier A read (userId + active
 * Organization; personal scope filters `organizationId IS NULL`).
 *
 * Each source is queried independently and wrapped in its own try/catch
 * so a single failing source (e.g. an unparseable cron) degrades to an
 * empty slice instead of 500-ing the whole page.
 */
@Injectable()
export class SchedulesService {
    private readonly logger = new Logger(SchedulesService.name);

    constructor(
        @InjectRepository(Task) private readonly taskRepo: Repository<Task>,
        @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
        @InjectRepository(WorkSchedule)
        private readonly workScheduleRepo: Repository<WorkSchedule>,
        @InjectRepository(Mission) private readonly missionRepo: Repository<Mission>,
        @InjectRepository(Work) private readonly workRepo: Repository<Work>,
    ) {}

    async getSchedules(
        scope: ScheduleScope,
        filters: ScheduleQueryFilters = {},
    ): Promise<ScheduleView[]> {
        const now = new Date();

        const [tasks, agents, workSchedules, missions, sourceValidation, dataSync] =
            await Promise.all([
                this.recurringTasks(scope, now),
                this.agentHeartbeats(scope),
                this.workSchedules(scope),
                this.missionTicks(scope, now),
                this.sourceValidation(scope),
                this.dataSync(scope, now),
            ]);

        let views: ScheduleView[] = [
            ...tasks,
            ...agents,
            ...workSchedules,
            ...missions,
            ...sourceValidation,
            ...dataSync,
        ];

        if (filters.sourceType) {
            views = views.filter((view) => view.sourceType === filters.sourceType);
        }
        if (filters.ownerType) {
            views = views.filter((view) => view.ownerType === filters.ownerType);
        }
        if (filters.enabledOnly) {
            views = views.filter((view) => view.enabled);
        }

        return this.sortByNextRun(views);
    }

    /** Ascending by `nextRunAt`, nulls last; stable tiebreak on ownerName. */
    private sortByNextRun(views: ScheduleView[]): ScheduleView[] {
        return views.sort((a, b) => {
            if (a.nextRunAt && b.nextRunAt) {
                const delta = a.nextRunAt.localeCompare(b.nextRunAt);
                if (delta !== 0) return delta;
            } else if (a.nextRunAt && !b.nextRunAt) {
                return -1;
            } else if (!a.nextRunAt && b.nextRunAt) {
                return 1;
            }
            return a.ownerName.localeCompare(b.ownerName);
        });
    }

    /**
     * Scope predicate shared by every source: always filter by userId,
     * and additionally by the active Organization (or `organizationId IS
     * NULL` for the bare-Tenant/personal scope) — spec §2.2.
     */
    private scopeWhere<T extends { userId?: string; organizationId?: string | null }>(
        scope: ScheduleScope,
    ): FindOptionsWhere<T> {
        const where: Record<string, unknown> = { userId: scope.userId };
        where.organizationId = scope.organizationId ? scope.organizationId : IsNull();
        return where as FindOptionsWhere<T>;
    }

    private async recurringTasks(scope: ScheduleScope, now: Date): Promise<ScheduleView[]> {
        try {
            const rows = await this.taskRepo.find({
                where: {
                    ...this.scopeWhere<Task>(scope),
                    isRecurring: true,
                    parentRecurringTaskId: IsNull(),
                },
                take: MAX_PER_SOURCE,
            });
            const nowMs = now.getTime();
            return rows.map((task) => {
                const exhausted =
                    task.recurrenceMaxOccurrences != null &&
                    task.recurrenceOccurredCount >= task.recurrenceMaxOccurrences;
                const past =
                    task.recurrenceEndsAt != null && task.recurrenceEndsAt.getTime() <= nowMs;
                const ended = exhausted || past;
                const status: ScheduleStatus = ended ? 'ended' : 'active';
                return {
                    id: `recurring_task:${task.id}`,
                    sourceType: 'recurring_task',
                    ownerType: 'task',
                    ownerId: task.id,
                    ownerName: task.title,
                    ownerLink: `/tasks/${task.id}`,
                    cadenceRaw: task.recurrenceRule ?? null,
                    cadenceHuman: describeRrule(task.recurrenceRule),
                    nextRunAt: ended ? null : toIso(task.nextOccurrenceAt),
                    lastRunAt: null,
                    lastRunStatus: null,
                    status,
                    enabled: !ended,
                };
            });
        } catch (error) {
            this.warn('recurring_task', error);
            return [];
        }
    }

    private async agentHeartbeats(scope: ScheduleScope): Promise<ScheduleView[]> {
        try {
            const rows = await this.agentRepo.find({
                where: {
                    ...this.scopeWhere<Agent>(scope),
                    heartbeatCadence: Not(IsNull()),
                },
                take: MAX_PER_SOURCE,
            });
            return (
                rows
                    // 'manual' is stored in the cadence column but means "no cron".
                    .filter((agent) => (agent.heartbeatCadence ?? '').toLowerCase() !== 'manual')
                    .map((agent) => {
                        const status = this.mapAgentStatus(agent.status);
                        return {
                            id: `agent_heartbeat:${agent.id}`,
                            sourceType: 'agent_heartbeat',
                            ownerType: 'agent',
                            ownerId: agent.id,
                            ownerName: agent.name,
                            ownerLink: `/agents/${agent.id}`,
                            cadenceRaw: agent.heartbeatCadence ?? null,
                            cadenceHuman: describeCron(agent.heartbeatCadence),
                            nextRunAt: toIso(agent.nextHeartbeatAt),
                            lastRunAt: toIso(agent.lastRunAt),
                            lastRunStatus: agent.lastRunStatus ?? null,
                            status,
                            enabled: agent.status === AgentStatus.ACTIVE,
                        };
                    })
            );
        } catch (error) {
            this.warn('agent_heartbeat', error);
            return [];
        }
    }

    private async workSchedules(scope: ScheduleScope): Promise<ScheduleView[]> {
        try {
            const qb = this.workScheduleRepo
                .createQueryBuilder('ws')
                .leftJoinAndSelect('ws.work', 'work')
                .where('ws.userId = :userId', { userId: scope.userId })
                .andWhere('ws.status IN (:...statuses)', {
                    statuses: [WorkScheduleStatus.ACTIVE, WorkScheduleStatus.PAUSED],
                })
                .take(MAX_PER_SOURCE);
            if (scope.organizationId) {
                qb.andWhere('ws.organizationId = :orgId', { orgId: scope.organizationId });
            } else {
                qb.andWhere('ws.organizationId IS NULL');
            }
            const rows = await qb.getMany();
            return rows.map((ws) => {
                const work = ws.work as { id?: string; name?: string } | undefined;
                return {
                    id: `work_schedule:${ws.workId}`,
                    sourceType: 'work_schedule',
                    ownerType: 'work',
                    ownerId: ws.workId,
                    ownerName: work?.name ?? 'Work',
                    ownerLink: `/works/${ws.workId}/generator/schedule`,
                    cadenceRaw: ws.cadence ?? null,
                    cadenceHuman: describeWorkCadence(ws.cadence),
                    nextRunAt: toIso(ws.nextRunAt),
                    lastRunAt: toIso(ws.lastRunAt),
                    lastRunStatus: ws.lastRunStatus ?? null,
                    status: this.mapWorkScheduleStatus(ws.status),
                    enabled: ws.status === WorkScheduleStatus.ACTIVE,
                };
            });
        } catch (error) {
            this.warn('work_schedule', error);
            return [];
        }
    }

    private async missionTicks(scope: ScheduleScope, now: Date): Promise<ScheduleView[]> {
        try {
            const rows = await this.missionRepo.find({
                where: {
                    ...this.scopeWhere<Mission>(scope),
                    type: MissionType.SCHEDULED,
                },
                take: MAX_PER_SOURCE,
            });
            return rows.map((mission) => {
                const status = this.mapMissionStatus(mission.status);
                const enabled = mission.status === MissionStatus.ACTIVE;
                return {
                    id: `mission_tick:${mission.id}`,
                    sourceType: 'mission_tick',
                    ownerType: 'mission',
                    ownerId: mission.id,
                    ownerName: mission.title,
                    ownerLink: `/missions/${mission.id}`,
                    cadenceRaw: mission.schedule ?? null,
                    cadenceHuman: describeCron(mission.schedule),
                    // Missions persist no next-fire timestamp — compute it
                    // from the cron string at query time (spec §2.1 note).
                    nextRunAt: enabled ? computeNextCronFire(mission.schedule, now) : null,
                    lastRunAt: null,
                    lastRunStatus: null,
                    status,
                    enabled,
                };
            });
        } catch (error) {
            this.warn('mission_tick', error);
            return [];
        }
    }

    private async sourceValidation(scope: ScheduleScope): Promise<ScheduleView[]> {
        try {
            const rows = await this.workRepo.find({
                where: {
                    ...this.scopeWhere<Work>(scope),
                    sourceValidationEnabled: true,
                },
                take: MAX_PER_SOURCE,
            });
            return rows.map((work) => ({
                id: `source_validation:${work.id}`,
                sourceType: 'source_validation',
                ownerType: 'work',
                ownerId: work.id,
                ownerName: work.name,
                ownerLink: `/works/${work.id}`,
                cadenceRaw: work.sourceValidationCadence ?? null,
                cadenceHuman: describeWorkCadence(work.sourceValidationCadence),
                nextRunAt: toIso(work.sourceValidationNextRunAt),
                lastRunAt: toIso(work.sourceValidationLastRunAt),
                lastRunStatus: null,
                status: 'active' as ScheduleStatus,
                enabled: true,
            }));
        } catch (error) {
            this.warn('source_validation', error);
            return [];
        }
    }

    private async dataSync(scope: ScheduleScope, now: Date): Promise<ScheduleView[]> {
        try {
            const rows = await this.workRepo.find({
                where: {
                    ...this.scopeWhere<Work>(scope),
                    syncIntervalMinutes: MoreThan(0),
                },
                take: MAX_PER_SOURCE,
            });
            const nowMs = now.getTime();
            return rows.map((work) => {
                const lastPolled = work.lastPolledAt ?? null;
                const nextRunAt = lastPolled
                    ? new Date(lastPolled.getTime() + work.syncIntervalMinutes * 60_000)
                    : now;
                return {
                    id: `data_sync:${work.id}`,
                    sourceType: 'data_sync',
                    ownerType: 'work',
                    ownerId: work.id,
                    ownerName: work.name,
                    ownerLink: `/works/${work.id}`,
                    cadenceRaw: `${work.syncIntervalMinutes}m`,
                    cadenceHuman: describeIntervalMinutes(work.syncIntervalMinutes),
                    // Never-polled Works are due "now"; clamp a stale
                    // computed next-run up to now so the UI reads sensibly.
                    nextRunAt: toIso(nextRunAt.getTime() < nowMs && !lastPolled ? now : nextRunAt),
                    lastRunAt: toIso(lastPolled),
                    lastRunStatus: null,
                    status: 'active' as ScheduleStatus,
                    enabled: true,
                };
            });
        } catch (error) {
            this.warn('data_sync', error);
            return [];
        }
    }

    private mapAgentStatus(status: AgentStatus): ScheduleStatus {
        switch (status) {
            case AgentStatus.ACTIVE:
            case AgentStatus.RUNNING:
                return 'active';
            case AgentStatus.PAUSED:
                return 'paused';
            case AgentStatus.ERROR:
                return 'error';
            case AgentStatus.ARCHIVED:
                return 'ended';
            case AgentStatus.DRAFT:
            default:
                return 'disabled';
        }
    }

    private mapWorkScheduleStatus(status: WorkScheduleStatus): ScheduleStatus {
        switch (status) {
            case WorkScheduleStatus.ACTIVE:
                return 'active';
            case WorkScheduleStatus.PAUSED:
                return 'paused';
            case WorkScheduleStatus.CANCELED:
                return 'ended';
            case WorkScheduleStatus.DISABLED:
            default:
                return 'disabled';
        }
    }

    private mapMissionStatus(status: MissionStatus): ScheduleStatus {
        switch (status) {
            case MissionStatus.ACTIVE:
                return 'active';
            case MissionStatus.PAUSED:
                return 'paused';
            case MissionStatus.FAILED:
                return 'error';
            case MissionStatus.COMPLETED:
                return 'ended';
            default:
                return 'disabled';
        }
    }

    private warn(source: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Schedules aggregation failed for source "${source}": ${message}`);
    }
}
