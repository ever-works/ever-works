import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { fleetScheduleCadenceRaw } from '@ever-works/contracts';
import { InjectRepository } from '@nestjs/typeorm';
import {
    Repository,
    And,
    IsNull,
    Not,
    In,
    MoreThan,
    type FindOptionsOrder,
    type FindOptionsWhere,
} from 'typeorm';
import { config } from '../config';
import { Task } from '../entities/task.entity';
import { Agent, AgentStatus } from '../entities/agent.entity';
import { Mission, MissionType, MissionStatus } from '../entities/mission.entity';
import { WorkSchedule } from '../entities/work-schedule.entity';
import { Work } from '../entities/work.entity';
import { WorkUpstreamState } from '../entities/work-upstream-state.entity';
import { InboundTrigger } from '../entities/inbound-trigger.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { FleetAgentNodeAffinity } from '../entities/fleet-agent-node-affinity.entity';
import { FleetNode } from '../entities/fleet-node.entity';
import { isFleetSessionScheduleTask } from '../tasks-domain/task-session-schedule.port';
import { WorkScheduleStatus } from '../entities/types';
import {
    describeCron,
    describeEventDriven,
    describeIntervalMinutes,
    describeRrule,
    describeWorkCadence,
    computeNextCronFire,
} from './cadence';
import {
    evaluateScheduleHealth,
    proposeScheduleRepair,
    SCHEDULE_HEALTH_FLAG_CAP,
    type ScheduleHealthInput,
} from './schedule-health.service';
import { buildScheduleControls } from './schedule-controls';
import { NODE_SCHEDULE_PORT, type NodeScheduleSource } from './node-schedule.port';
import type {
    ScheduleHealthReason,
    ScheduleHealthSummary,
    SchedulePage,
    SchedulePageFilters,
    ScheduleQueryFilters,
    ScheduleScope,
    ScheduleSourceType,
    ScheduleStatus,
    ScheduleView,
} from './schedule-view.types';

/**
 * Rows read per source query. The flat `getSchedules` read is one query per
 * source capped at this many rows — a defence-in-depth memory bound for a
 * user with pathologically many Works (data-sync matches nearly every Work),
 * unchanged (spec §4.1).
 *
 * The workspace reads (`getPage`, `getHealthSummary`, `findOne`) are NOT
 * capped: their totals, counts and cursors describe every row, and a row a
 * capped read never returned could not be paged to, counted or controlled.
 * They walk each source in id order, this many rows per batch.
 */
const MAX_PER_SOURCE = 500;

/**
 * How `collect` reads each source: `capped` is the flat read's single
 * bounded query; `all` reads every row, one keyset batch at a time.
 */
type SourceReadMode = 'capped' | 'all';

/** A keyset batch: the rows after `afterId` in id order, at most `take`. */
interface SourceBatch {
    afterId: string | null;
    take: number;
}

/** Split `values` into arrays of at most `size` — keeps `IN (...)` lists bounded. */
function chunked<T>(values: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        out.push(values.slice(index, index + size));
    }
    return out;
}

/** Rows per page of the workspace list, and the most one request may ask for. */
export const SCHEDULE_PAGE_SIZE = 50;

const SOURCE_TYPES: ScheduleSourceType[] = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
    'inbound_trigger',
    // Schedules on computers (FL-13): Command schedules, read through `NODE_SCHEDULE_PORT`.
    'node_schedule',
    // APW-02 T53: the App Works' upstream sync (read only).
    'app_upstream_sync',
];

const STATUSES: ScheduleStatus[] = ['active', 'paused', 'disabled', 'error', 'ended'];

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    const time = value instanceof Date ? value : new Date(value);
    return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

type AgentSummary = Pick<Agent, 'id' | 'name' | 'status'>;

/** One projected row plus the facts its health verdict is computed from. */
interface ProjectedRow {
    view: ScheduleView;
    facts: Omit<ScheduleHealthInput, 'now'>;
    /** The owner's own status when the row's status is not it (a paused heartbeat). */
    ownerStatus?: ScheduleStatus;
}

interface Collected {
    rows: ProjectedRow[];
    degraded: ScheduleSourceType[];
}

/** Opaque page cursor: the sort key of the last row on the previous page. */
interface PageCursor {
    n: string | null;
    o: string;
    i: string;
}

/** Ascending by `nextRunAt`, nulls last; then owner name; then id (stable). */
function compareRows(
    a: Pick<ScheduleView, 'nextRunAt' | 'ownerName' | 'id'>,
    b: Pick<ScheduleView, 'nextRunAt' | 'ownerName' | 'id'>,
): number {
    if (a.nextRunAt && b.nextRunAt) {
        const delta = a.nextRunAt.localeCompare(b.nextRunAt);
        if (delta !== 0) return delta;
    } else if (a.nextRunAt && !b.nextRunAt) {
        return -1;
    } else if (!a.nextRunAt && b.nextRunAt) {
        return 1;
    }
    const byName = a.ownerName.localeCompare(b.ownerName);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
}

function encodeCursor(view: ScheduleView): string {
    const cursor: PageCursor = { n: view.nextRunAt, o: view.ownerName, i: view.id };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null | undefined): PageCursor | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PageCursor;
        if (typeof parsed?.o !== 'string' || typeof parsed?.i !== 'string') return null;
        if (parsed.n !== null && typeof parsed.n !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Schedules ("Cadence") aggregation service (spec §4.3).
 *
 * Read-only. Projects the eight scheduled sources — recurring Tasks, Agent
 * heartbeats, Work schedules, Mission ticks, item source-validation,
 * data-sync polling, inbound triggers and (FL-13) Command schedules on the
 * person's computers — into one unified
 * `ScheduleView[]`, scoped to the
 * caller exactly like every other Tier A read (userId + active
 * Organization; personal scope filters `organizationId IS NULL`).
 *
 * Each source is queried independently and wrapped in its own try/catch
 * so a single failing source (e.g. an unparseable cron) degrades to an
 * empty slice instead of 500-ing the whole page.
 *
 * Schedules workspace: every row also carries the Agent that would run
 * it, a NEVER RUNS health verdict and the row-control descriptor. Those are
 * ADDED fields — `getSchedules` keeps its bare-array shape — and `getPage` /
 * `getHealthSummary` read the very same projection rather than a second
 * list.
 */
/**
 * APW-02 T53 — the upstream sync's documented default (Mondays 06:00 UTC, FR-32), the cron a
 * row shows when the sync run has not recorded the effective one yet. The same literal as
 * `APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE` in `@ever-works/contracts`.
 */
const APP_UPSTREAM_SYNC_DEFAULT_CRON = '0 6 * * 1';

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
        @InjectRepository(InboundTrigger)
        private readonly inboundTriggerRepo: Repository<InboundTrigger>,
        // Schedules workspace — Agent attribution for recurring Tasks.
        // Appended LAST + @Optional() so every positional construction keeps
        // compiling; unbound, a recurring Task resolves its Agent from its
        // own `agentId` only.
        @Optional()
        @InjectRepository(TaskAssignee)
        private readonly taskAssigneeRepo?: Repository<TaskAssignee>,
        // Schedules on computers (FL-13) — the `node_schedule` source. Appended
        // LAST + @Optional(): unbound (no Fleet in this process) the source
        // contributes no rows, and every positional construction compiles.
        @Optional()
        @Inject(NODE_SCHEDULE_PORT)
        private readonly nodeScheduleSource?: NodeScheduleSource,
        // Schedules on computers (FL-13 P2, FR-2) — the computer chip of a
        // recurring Task whose Agent is pinned (R-29: affinity is the pin).
        // Appended LAST + @Optional(): unbound, no chip.
        @Optional()
        @InjectRepository(FleetAgentNodeAffinity)
        private readonly affinityRepo?: Repository<FleetAgentNodeAffinity>,
        @Optional()
        @InjectRepository(FleetNode)
        private readonly fleetNodeRepo?: Repository<FleetNode>,
        // APW-02 T53 — the App Works' upstream sync rows. Appended LAST + @Optional():
        // unbound, the source is empty and the other eight are untouched.
        @Optional()
        @InjectRepository(WorkUpstreamState)
        private readonly upstreamStateRepo?: Repository<WorkUpstreamState>,
    ) {}

    async getSchedules(
        scope: ScheduleScope,
        filters: ScheduleQueryFilters = {},
    ): Promise<ScheduleView[]> {
        const now = new Date();
        const { rows } = await this.collect(scope, now, 'capped');
        let views = rows.map((row) => narrowScheduleView(row.view));
        if (filters.nodeId) {
            // FL-13 `?node=`: the flat row has no node field, so match on the full rows.
            const wanted = filters.nodeId.toLowerCase();
            const onNode = new Set(
                rows
                    .filter((row) => (row.view.nodeId ?? '').toLowerCase() === wanted)
                    .map((row) => row.view.id),
            );
            views = views.filter((view) => onNode.has(view.id));
        }

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

    /**
     * Schedules workspace — one page of the same projection, sorted next
     * fire ascending (nulls last), then name, then id. The cursor is the sort
     * key of the previous page's last row, so a row that was added or removed
     * between two requests never makes the next page skip or repeat a row
     * that is still there.
     */
    async getPage(
        scope: ScheduleScope,
        filters: SchedulePageFilters = {},
        cursor?: string | null,
        limit: number = SCHEDULE_PAGE_SIZE,
    ): Promise<SchedulePage> {
        const now = new Date();
        const { rows, degraded } = await this.collect(scope, now, 'all');
        const unfilteredTotal = rows.length;
        const matching = this.applyPageFilters(
            rows.map((row) => row.view),
            filters,
        ).sort(compareRows);

        const countsBySourceType = Object.fromEntries(
            SOURCE_TYPES.map((type) => [type, 0]),
        ) as Record<ScheduleSourceType, number>;
        const countsByStatus = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
            ScheduleStatus,
            number
        >;
        // The same breakdown taken BEFORE the filters, for the source picker:
        // `countsBySourceType` above is computed after `sourceType` has been
        // applied, so selecting a source zeroes every other entry and the
        // picker can no longer offer a way back or sideways.
        const unfilteredCountsBySourceType = Object.fromEntries(
            SOURCE_TYPES.map((type) => [type, 0]),
        ) as Record<ScheduleSourceType, number>;
        for (const row of rows) unfilteredCountsBySourceType[row.view.sourceType] += 1;
        let neverRuns = 0;
        for (const view of matching) {
            countsBySourceType[view.sourceType] += 1;
            countsByStatus[view.status] += 1;
            if (view.health && !view.health.ok) neverRuns += 1;
        }

        const pageSize = Math.max(1, Math.min(SCHEDULE_PAGE_SIZE, Math.floor(limit) || 1));
        const after = decodeCursor(cursor);
        const start = after
            ? matching.findIndex(
                  (view) =>
                      compareRows(view, { nextRunAt: after.n, ownerName: after.o, id: after.i }) >
                      0,
              )
            : 0;
        const from = start < 0 ? matching.length : start;
        const items = matching.slice(from, from + pageSize);
        const hasMore = from + pageSize < matching.length;

        return {
            items,
            nextCursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
            total: matching.length,
            unfilteredTotal,
            countsBySourceType,
            unfilteredCountsBySourceType,
            countsByStatus,
            healthCounts: { ok: matching.length - neverRuns, neverRuns },
            degradedSources: degraded,
            healthCheckedAt: now.toISOString(),
            generatedAt: now.toISOString(),
        };
    }

    /**
     * Schedules workspace — the NEVER RUNS summary, as a DRY RUN. Nothing is
     * written: every flagged row carries the exact before / after a repair
     * would use and a fingerprint of the before-state, so the surface can
     * preview a fix without a second round trip.
     */
    async getHealthSummary(scope: ScheduleScope): Promise<ScheduleHealthSummary> {
        const now = new Date();
        const { rows, degraded } = await this.collect(scope, now, 'all');
        const byReason: Partial<Record<ScheduleHealthReason, number>> = {};
        const flagged: ScheduleHealthSummary['flagged'] = [];
        let neverRuns = 0;

        const ordered = [...rows].sort((a, b) => compareRows(a.view, b.view));
        for (const row of ordered) {
            const health = row.view.health;
            if (!health || health.ok || !health.reason) continue;
            neverRuns += 1;
            byReason[health.reason] = (byReason[health.reason] ?? 0) + 1;
            if (flagged.length >= SCHEDULE_HEALTH_FLAG_CAP) continue;
            const proposal = proposeScheduleRepair({
                health,
                cadenceKind: row.facts.cadenceKind,
                cadence: row.facts.cadence,
                endsAt: row.facts.endsAt ?? null,
                maxOccurrences: row.facts.maxOccurrences ?? null,
                oneShotAt: row.facts.oneShotAt ?? null,
                now,
            });
            flagged.push({
                id: row.view.id,
                sourceType: row.view.sourceType,
                ownerName: row.view.ownerName,
                ownerLink: row.view.ownerLink,
                reason: health.reason,
                reasonKey: health.reasonKey ?? health.reason,
                ...proposal,
            });
        }

        return {
            checkedAt: now.toISOString(),
            counts: { ok: rows.length - neverRuns, neverRuns, byReason },
            flagged,
            degradedSources: degraded,
        };
    }

    /**
     * Resolve ONE row of the caller's projection by its synthetic id, or null
     * when it is not theirs or does not exist (the two are indistinguishable
     * by design).
     */
    async findOne(scope: ScheduleScope, id: string): Promise<ScheduleView | null> {
        const { rows } = await this.collect(scope, new Date(), 'all');
        return rows.find((row) => row.view.id === id)?.view ?? null;
    }

    private applyPageFilters(views: ScheduleView[], filters: SchedulePageFilters): ScheduleView[] {
        const q = filters.q?.trim().toLowerCase() ?? '';
        return views.filter((view) => {
            if (filters.sourceType && view.sourceType !== filters.sourceType) return false;
            if (filters.ownerType && view.ownerType !== filters.ownerType) return false;
            if (filters.enabledOnly && !view.enabled) return false;
            if (filters.agentId && view.agentId !== filters.agentId) return false;
            if (
                filters.nodeId &&
                (view.nodeId ?? '').toLowerCase() !== filters.nodeId.toLowerCase()
            ) {
                return false;
            }
            if (filters.status && view.status !== filters.status) return false;
            if (filters.health === 'ok' && view.health?.ok === false) return false;
            if (filters.health === 'never-runs' && view.health?.ok !== false) return false;
            if (q) {
                const haystack = [
                    view.ownerName,
                    view.cadenceHuman,
                    view.cadenceRaw,
                    view.agentName,
                ]
                    .filter((part): part is string => typeof part === 'string')
                    .join('\n')
                    .toLowerCase();
                if (!haystack.includes(q)) return false;
            }
            return true;
        });
    }

    /**
     * Query every source, then attach health + controls. A source whose
     * query throws contributes no rows and is named in `degraded`.
     */
    private async collect(
        scope: ScheduleScope,
        now: Date,
        mode: SourceReadMode,
    ): Promise<Collected> {
        const degraded: ScheduleSourceType[] = [];
        const [
            tasks,
            agents,
            workSchedules,
            missions,
            sourceValidation,
            dataSync,
            triggers,
            nodeSchedules,
            upstreamSyncs,
        ] = await Promise.all([
            this.recurringTasks(scope, now, degraded, mode),
            this.agentHeartbeats(scope, degraded, mode),
            this.workSchedules(scope, degraded, mode),
            this.missionTicks(scope, now, degraded, mode),
            this.sourceValidation(scope, degraded, mode),
            this.dataSync(scope, now, degraded, mode),
            this.inboundTriggers(scope, degraded, mode),
            this.nodeSchedules(scope, degraded),
            this.appUpstreamSyncs(scope, degraded, mode),
        ]);

        const rows = [
            ...tasks,
            ...agents,
            ...workSchedules,
            ...missions,
            ...sourceValidation,
            ...dataSync,
            ...triggers,
            ...nodeSchedules,
            ...upstreamSyncs,
        ];
        for (const row of rows) {
            const health = evaluateScheduleHealth({ ...row.facts, now });
            row.view.health = health;
            row.view.controls = buildScheduleControls({
                sourceType: row.view.sourceType,
                status: row.view.status,
                pausedAt: row.view.pausedAt ?? null,
                health,
                ownerStatus: row.ownerStatus,
                nodeLinkUp: row.view.nodeSchedule?.linkUp,
            });
        }
        return { rows, degraded };
    }

    /**
     * Read one source. `capped` makes the single bounded query the flat read
     * has always made (`read(null)`). `all` walks the source by primary key,
     * `MAX_PER_SOURCE` rows per batch, until a short batch — keyset rather
     * than offset, so a row inserted or deleted mid-walk can never shift a
     * later batch into skipping or repeating a row. A batch that brings no
     * row not already seen ends the walk, so a repository that ignores the
     * keyset can never loop forever.
     */
    private async readSource<T extends { id: string }>(
        mode: SourceReadMode,
        read: (batch: SourceBatch | null) => Promise<T[]>,
    ): Promise<T[]> {
        if (mode === 'capped') return (await read(null)) ?? [];
        const out: T[] = [];
        const seen = new Set<string>();
        let afterId: string | null = null;
        for (;;) {
            const batch: T[] = (await read({ afterId, take: MAX_PER_SOURCE })) ?? [];
            let added = 0;
            for (const row of batch) {
                if (seen.has(row.id)) continue;
                seen.add(row.id);
                out.push(row);
                added += 1;
            }
            if (batch.length < MAX_PER_SOURCE || added === 0) return out;
            afterId = batch[batch.length - 1].id;
        }
    }

    /**
     * `find` options for one source read: the flat read's exact options, or
     * one keyset batch ordered by id.
     */
    private findOptions<T extends { id: string }>(
        where: FindOptionsWhere<T>,
        batch: SourceBatch | null,
    ): { where: FindOptionsWhere<T>; take: number; order?: FindOptionsOrder<T> } {
        if (!batch) return { where, take: MAX_PER_SOURCE };
        return {
            where: batch.afterId
                ? ({ ...where, id: MoreThan(batch.afterId) } as FindOptionsWhere<T>)
                : where,
            order: { id: 'ASC' } as FindOptionsOrder<T>,
            take: batch.take,
        };
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

    /**
     * Names + statuses of the caller's own Agents among `ids`. Scoped by
     * userId so a stray assignee row can never surface another user's Agent.
     * Best-effort: a failed lookup attributes nothing rather than failing the
     * source.
     */
    private async lookupAgents(
        scope: ScheduleScope,
        ids: Iterable<string>,
    ): Promise<Map<string, AgentSummary> | null> {
        const unique = [...new Set(ids)].filter(Boolean);
        const out = new Map<string, AgentSummary>();
        if (unique.length === 0) return out;
        try {
            for (const ids of chunked(unique, MAX_PER_SOURCE)) {
                const rows = await this.agentRepo.find({
                    where: { id: In(ids), userId: scope.userId },
                    select: ['id', 'name', 'status'],
                });
                for (const agent of rows ?? []) {
                    if (agent?.id) out.set(agent.id, agent);
                }
            }
            return out;
        } catch (error) {
            // Unknown is not "missing": the caller must not flag an owner
            // as gone because the lookup itself failed.
            this.logger.warn(`Schedules agent attribution failed: ${String(error)}`);
            return null;
        }
    }

    private async recurringTasks(
        scope: ScheduleScope,
        now: Date,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        try {
            const where: FindOptionsWhere<Task> = {
                ...this.scopeWhere<Task>(scope),
                isRecurring: true,
                parentRecurringTaskId: IsNull(),
            };
            const rows = await this.readSource(mode, (batch) =>
                this.taskRepo.find(this.findOptions(where, batch)),
            );

            const assigneesByTask = new Map<string, string[]>();
            if (this.taskAssigneeRepo && rows.length > 0) {
                try {
                    const taskIds = rows.map((task) => task.id);
                    for (const ids of chunked(taskIds, MAX_PER_SOURCE)) {
                        const assignees = await this.taskAssigneeRepo.find({
                            where: { taskId: In(ids), assigneeType: 'agent' },
                        });
                        for (const row of assignees ?? []) {
                            const list = assigneesByTask.get(row.taskId) ?? [];
                            list.push(row.assigneeId);
                            assigneesByTask.set(row.taskId, list);
                        }
                    }
                } catch (error) {
                    this.logger.warn(`Schedules assignee attribution failed: ${String(error)}`);
                }
            }
            const agents = await this.lookupAgents(scope, [
                ...[...assigneesByTask.values()].flat(),
                ...rows.map((task) => task.agentId ?? ''),
            ]);

            const nowMs = now.getTime();
            const projected = rows.map((task): ProjectedRow => {
                const exhausted =
                    task.recurrenceMaxOccurrences != null &&
                    task.recurrenceOccurredCount >= task.recurrenceMaxOccurrences;
                const past =
                    task.recurrenceEndsAt != null && task.recurrenceEndsAt.getTime() <= nowMs;
                const ended = exhausted || past;
                const paused = !ended && Boolean(task.recurrencePausedAt);
                const status: ScheduleStatus = ended ? 'ended' : paused ? 'paused' : 'active';

                // Agent resolution mirrors the dispatcher: agent assignees,
                // then the Task's own `agentId`.
                const assigned = assigneesByTask.get(task.id) ?? [];
                const candidateIds =
                    assigned.length > 0 ? assigned : task.agentId ? [task.agentId] : [];
                const resolved = agents
                    ? candidateIds
                          .map((id) => agents.get(id))
                          .filter((agent): agent is AgentSummary => Boolean(agent))
                    : [];
                const usable = resolved.filter((agent) => agent.status !== AgentStatus.ARCHIVED);
                const attributed = usable[0] ?? resolved[0] ?? null;
                // Every named Agent is archived or no longer exists: the
                // Schedule has an owner, but not one that can run it. When the
                // lookup itself failed nothing is known, so nothing is flagged.
                const ownerArchived =
                    agents !== null && candidateIds.length > 0 && usable.length === 0;
                const agentResolved =
                    candidateIds.length > 0 && (agents === null || usable.length > 0);

                const view: ScheduleView = {
                    id: `recurring_task:${task.id}`,
                    sourceType: 'recurring_task',
                    ownerType: 'task',
                    ownerId: task.id,
                    ownerName: task.title,
                    ownerLink: `/tasks/${task.id}`,
                    // Schedule-modes upgrade: a recurring Task carries
                    // EITHER an RRULE or a 5-field cron (XOR, enforced by
                    // `TasksService.setRecurring`). Reading only
                    // `recurrenceRule` rendered a cron-cadence Task with a
                    // blank cadence on this page.
                    cadenceRaw: task.recurrenceCron ?? task.recurrenceRule ?? null,
                    cadenceHuman: task.recurrenceCron
                        ? describeCron(task.recurrenceCron)
                        : describeRrule(task.recurrenceRule),
                    nextRunAt: ended || paused ? null : toIso(task.nextOccurrenceAt),
                    lastRunAt: null,
                    lastRunStatus: null,
                    status,
                    enabled: !ended && !paused,
                    agentId: attributed?.id ?? null,
                    agentName: attributed?.name ?? null,
                    pausedAt: toIso(task.recurrencePausedAt),
                    nextRunReasonKey: ended ? 'ended' : paused ? 'paused' : null,
                };
                return {
                    view,
                    facts: {
                        sourceType: 'recurring_task',
                        cadenceKind: task.recurrenceCron ? 'cron' : 'rrule',
                        cadence: task.recurrenceCron ?? task.recurrenceRule ?? null,
                        paused,
                        ownerArchived,
                        endsAt: task.recurrenceEndsAt ?? null,
                        maxOccurrences: task.recurrenceMaxOccurrences ?? null,
                        occurredCount: task.recurrenceOccurredCount ?? 0,
                        requiresAgent: true,
                        agentResolved,
                    },
                };
            });
            await this.attachComputerChips(scope, projected, rows);
            return projected;
        } catch (error) {
            this.warn('recurring_task', error, degraded);
            return [];
        }
    }

    private async agentHeartbeats(
        scope: ScheduleScope,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        try {
            const where: FindOptionsWhere<Agent> = {
                ...this.scopeWhere<Agent>(scope),
                // 'manual' is stored in the cadence column but means "no
                // cron" — exclude it in the DB (not in-memory) so `take`
                // counts only real scheduled heartbeats and a page full of
                // manual-cadence agents can't crowd out scheduled ones.
                heartbeatCadence: And(Not(IsNull()), Not('manual')),
            };
            const rows = await this.readSource(mode, (batch) =>
                this.agentRepo.find(this.findOptions(where, batch)),
            );
            return rows.map((agent) => {
                const agentStatus = this.mapAgentStatus(agent.status);
                // Schedules workspace — a paused heartbeat reads paused
                // even while the Agent itself is active. An archived Agent
                // stays `ended`: there is no heartbeat left to resume.
                const heartbeatPaused = Boolean(agent.heartbeatPausedAt);
                const status: ScheduleStatus =
                    heartbeatPaused && agentStatus !== 'ended' ? 'paused' : agentStatus;
                const agentEnabled =
                    agent.status === AgentStatus.ACTIVE || agent.status === AgentStatus.RUNNING;
                const view: ScheduleView = {
                    id: `agent_heartbeat:${agent.id}`,
                    sourceType: 'agent_heartbeat',
                    ownerType: 'agent',
                    ownerId: agent.id,
                    ownerName: agent.name,
                    ownerLink: `/agents/${agent.id}`,
                    cadenceRaw: agent.heartbeatCadence ?? null,
                    cadenceHuman: describeCron(agent.heartbeatCadence),
                    nextRunAt: heartbeatPaused ? null : toIso(agent.nextHeartbeatAt),
                    lastRunAt: toIso(agent.lastRunAt),
                    lastRunStatus: agent.lastRunStatus ?? null,
                    status,
                    // A RUNNING agent is mid-run but still an active schedule
                    // (it normalizes to the 'active' pill), so treat it as
                    // enabled alongside ACTIVE — otherwise enabledOnly wrongly
                    // drops it.
                    enabled: agentEnabled && !heartbeatPaused,
                    agentId: agent.id,
                    agentName: agent.name,
                    pausedAt: toIso(agent.heartbeatPausedAt),
                    nextRunReasonKey: heartbeatPaused
                        ? 'paused'
                        : agent.nextHeartbeatAt
                          ? null
                          : agentEnabled
                            ? 'notScheduledYet'
                            : 'ownerInactive',
                };
                return {
                    view,
                    ownerStatus: agentStatus,
                    facts: {
                        sourceType: 'agent_heartbeat',
                        cadenceKind: 'cron',
                        cadence: agent.heartbeatCadence ?? null,
                        paused: heartbeatPaused || agent.status === AgentStatus.PAUSED,
                        ownerArchived: agent.status === AgentStatus.ARCHIVED,
                    },
                };
            });
        } catch (error) {
            this.warn('agent_heartbeat', error, degraded);
            return [];
        }
    }

    private async workSchedules(
        scope: ScheduleScope,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        try {
            const rows = await this.readSource(mode, (batch) => {
                const qb = this.workScheduleRepo
                    .createQueryBuilder('ws')
                    .leftJoinAndSelect('ws.work', 'work')
                    .where('ws.userId = :userId', { userId: scope.userId })
                    .andWhere('ws.status IN (:...statuses)', {
                        statuses: [WorkScheduleStatus.ACTIVE, WorkScheduleStatus.PAUSED],
                    })
                    .take(batch ? batch.take : MAX_PER_SOURCE);
                if (scope.organizationId) {
                    qb.andWhere('ws.organizationId = :orgId', { orgId: scope.organizationId });
                } else {
                    qb.andWhere('ws.organizationId IS NULL');
                }
                if (batch) {
                    if (batch.afterId) {
                        qb.andWhere('ws.id > :afterId', { afterId: batch.afterId });
                    }
                    qb.orderBy('ws.id', 'ASC');
                }
                return qb.getMany();
            });
            return rows.map((ws) => {
                const work = ws.work as { id?: string; name?: string; status?: string } | undefined;
                const status = this.mapWorkScheduleStatus(ws.status);
                const view: ScheduleView = {
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
                    status,
                    enabled: ws.status === WorkScheduleStatus.ACTIVE,
                    agentId: null,
                    agentName: null,
                    pausedAt: null,
                    nextRunReasonKey: ws.nextRunAt ? null : status === 'paused' ? 'paused' : null,
                };
                return {
                    view,
                    facts: {
                        sourceType: 'work_schedule',
                        cadenceKind: 'work-cadence',
                        cadence: ws.cadence ?? null,
                        paused: ws.status === WorkScheduleStatus.PAUSED,
                        ownerArchived: work?.status === 'archived',
                    },
                };
            });
        } catch (error) {
            this.warn('work_schedule', error, degraded);
            return [];
        }
    }

    private async missionTicks(
        scope: ScheduleScope,
        now: Date,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        try {
            const where: FindOptionsWhere<Mission> = {
                ...this.scopeWhere<Mission>(scope),
                type: MissionType.SCHEDULED,
            };
            const rows = await this.readSource(mode, (batch) =>
                this.missionRepo.find(this.findOptions(where, batch)),
            );
            return rows.map((mission) => {
                const status = this.mapMissionStatus(mission.status);
                const enabled = mission.status === MissionStatus.ACTIVE;
                // Missions persist no next-fire timestamp — compute it
                // from the cron string at query time (spec §2.1 note).
                const nextRunAt = enabled ? computeNextCronFire(mission.schedule, now) : null;
                const view: ScheduleView = {
                    id: `mission_tick:${mission.id}`,
                    sourceType: 'mission_tick',
                    ownerType: 'mission',
                    ownerId: mission.id,
                    ownerName: mission.title,
                    ownerLink: `/missions/${mission.id}`,
                    cadenceRaw: mission.schedule ?? null,
                    cadenceHuman: describeCron(mission.schedule),
                    nextRunAt,
                    lastRunAt: null,
                    lastRunStatus: null,
                    status,
                    enabled,
                    agentId: null,
                    agentName: null,
                    pausedAt: null,
                    nextRunReasonKey: nextRunAt
                        ? null
                        : status === 'paused'
                          ? 'paused'
                          : status === 'ended'
                            ? 'ended'
                            : enabled
                              ? 'beyondLookahead'
                              : 'ownerInactive',
                };
                return {
                    view,
                    facts: {
                        sourceType: 'mission_tick',
                        cadenceKind: 'cron',
                        cadence: mission.schedule ?? null,
                        paused: mission.status === MissionStatus.PAUSED,
                        // Finishing an initiative is a choice: a completed
                        // Mission's tick is Ended, never NEVER RUNS.
                        ownerCompleted: mission.status === MissionStatus.COMPLETED,
                    },
                };
            });
        } catch (error) {
            this.warn('mission_tick', error, degraded);
            return [];
        }
    }

    private async sourceValidation(
        scope: ScheduleScope,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        try {
            const where: FindOptionsWhere<Work> = {
                ...this.scopeWhere<Work>(scope),
                sourceValidationEnabled: true,
            };
            const rows = await this.readSource(mode, (batch) =>
                this.workRepo.find(this.findOptions(where, batch)),
            );
            return rows.map((work) => ({
                view: {
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
                    agentId: null,
                    agentName: null,
                    pausedAt: null,
                    nextRunReasonKey: null,
                },
                facts: {
                    sourceType: 'source_validation',
                    cadenceKind: 'work-cadence',
                    cadence: work.sourceValidationCadence ?? null,
                    paused: false,
                    ownerArchived: work.status === 'archived',
                },
            }));
        } catch (error) {
            this.warn('source_validation', error, degraded);
            return [];
        }
    }

    private async dataSync(
        scope: ScheduleScope,
        now: Date,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        try {
            const where: FindOptionsWhere<Work> = {
                ...this.scopeWhere<Work>(scope),
                syncIntervalMinutes: MoreThan(0),
            };
            const rows = await this.readSource(mode, (batch) =>
                this.workRepo.find(this.findOptions(where, batch)),
            );
            const nowMs = now.getTime();
            return rows.map((work) => {
                const lastPolled = work.lastPolledAt ?? null;
                const nextRunAt = lastPolled
                    ? new Date(lastPolled.getTime() + work.syncIntervalMinutes * 60_000)
                    : now;
                return {
                    view: {
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
                        nextRunAt: toIso(nextRunAt.getTime() < nowMs ? now : nextRunAt),
                        lastRunAt: toIso(lastPolled),
                        lastRunStatus: null,
                        status: 'active' as ScheduleStatus,
                        enabled: true,
                        agentId: null,
                        agentName: null,
                        pausedAt: null,
                        nextRunReasonKey: null,
                    },
                    facts: {
                        sourceType: 'data_sync',
                        cadenceKind: 'interval',
                        cadence: `${work.syncIntervalMinutes}m`,
                        paused: false,
                        ownerArchived: work.status === 'archived',
                    },
                };
            });
        } catch (error) {
            this.warn('data_sync', error, degraded);
            return [];
        }
    }

    /**
     * Inbound Triggers (Trigger Schedules) — event-driven rows. They have
     * no cadence/next-run by definition (an external system decides when
     * they fire), so the cadence renders the fixed 'On event' label and
     * `nextRunAt` stays null (the UI shows '—'). When the trigger assigns
     * spawned Tasks to an Agent the row reuses the 'agent' owner type and
     * links there; otherwise it is its own 'trigger' owner and links back
     * to the Schedules view (where the Triggers section lives).
     */
    private async inboundTriggers(
        scope: ScheduleScope,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        try {
            const where = this.scopeWhere<InboundTrigger>(scope);
            const rows = await this.readSource(mode, (batch) =>
                this.inboundTriggerRepo.find(this.findOptions(where, batch)),
            );
            const agents = await this.lookupAgents(
                scope,
                rows.map((trigger) => trigger.targetAgentId ?? ''),
            );
            return rows.map((trigger) => ({
                view: {
                    id: `inbound_trigger:${trigger.id}`,
                    sourceType: 'inbound_trigger' as const,
                    ownerType: trigger.targetAgentId ? ('agent' as const) : ('trigger' as const),
                    ownerId: trigger.targetAgentId ?? trigger.id,
                    ownerName: trigger.name,
                    ownerLink: trigger.targetAgentId
                        ? `/agents/${trigger.targetAgentId}`
                        : '/activity?view=schedules',
                    cadenceRaw: null,
                    cadenceHuman: describeEventDriven(),
                    nextRunAt: null,
                    lastRunAt: toIso(trigger.lastFiredAt),
                    lastRunStatus: null,
                    status: (trigger.status === 'paused' ? 'paused' : 'active') as ScheduleStatus,
                    enabled: trigger.status === 'active',
                    agentId: trigger.targetAgentId ?? null,
                    agentName: trigger.targetAgentId
                        ? (agents?.get(trigger.targetAgentId)?.name ?? null)
                        : null,
                    pausedAt: null,
                    nextRunReasonKey: 'eventDriven' as const,
                },
                facts: {
                    sourceType: 'inbound_trigger' as const,
                    cadenceKind: 'event' as const,
                    cadence: null,
                    paused: trigger.status === 'paused',
                },
            }));
        } catch (error) {
            this.warn('inbound_trigger', error, degraded);
            return [];
        }
    }

    /**
     * Schedules on computers (FL-13 P2, FR-2, CONTRACTS R-29) — a recurring
     * Task whose Agent is pinned to a computer keeps its `recurring_task`
     * source and gains the computer chip (`nodeId`, `nodeName`,
     * `nodeTimeZone`); an Agent-session schedule (the Schedules dialog's
     * label) is also marked `agentSession`. Affinity is Organization-scoped, so
     * a personal scope has none. Best-effort: a failed lookup adds no chip and
     * never fails the source.
     */
    private async attachComputerChips(
        scope: ScheduleScope,
        projected: ProjectedRow[],
        tasks: Task[],
    ): Promise<void> {
        const sessionTaskIds = new Set(
            tasks.filter((task) => isFleetSessionScheduleTask(task)).map((task) => task.id),
        );
        for (const row of projected) {
            if (sessionTaskIds.has(row.view.ownerId)) row.view.agentSession = true;
        }
        if (!this.affinityRepo || !this.fleetNodeRepo || !scope.organizationId) return;
        const agentIds = [
            ...new Set(
                projected.map((row) => row.view.agentId).filter((id): id is string => Boolean(id)),
            ),
        ];
        if (agentIds.length === 0) return;
        try {
            const nodeByAgent = new Map<string, string>();
            for (const ids of chunked(agentIds, MAX_PER_SOURCE)) {
                const affinities = await this.affinityRepo.find({
                    where: {
                        userId: scope.userId,
                        organizationId: scope.organizationId,
                        agentId: In(ids),
                    },
                });
                for (const affinity of affinities ?? [])
                    nodeByAgent.set(affinity.agentId, affinity.nodeId);
            }
            const nodeIds = [...new Set(nodeByAgent.values())];
            if (nodeIds.length === 0) return;
            const nodes = new Map<string, Pick<FleetNode, 'id' | 'name' | 'timeZone'>>();
            for (const ids of chunked(nodeIds, MAX_PER_SOURCE)) {
                const found = await this.fleetNodeRepo.find({
                    where: { id: In(ids) },
                    select: { id: true, name: true, timeZone: true },
                });
                for (const node of found ?? []) nodes.set(node.id, node);
            }
            for (const row of projected) {
                const nodeId = row.view.agentId ? nodeByAgent.get(row.view.agentId) : undefined;
                const node = nodeId ? nodes.get(nodeId) : undefined;
                if (!node) continue;
                row.view.nodeId = node.id;
                row.view.nodeName = node.name;
                row.view.nodeTimeZone = node.timeZone ?? null;
            }
        } catch (error) {
            this.logger.warn(`Schedules computer chips failed: ${String(error)}`);
        }
    }

    /**
     * Schedules on computers (FL-13, R-2) — the person's Command schedules,
     * read through `NODE_SCHEDULE_PORT` (`FleetScheduleService`). A schedule
     * is its author's and its computer's, not a workspace's: like the
     * person's Commands it shows in every scope (lane-log decision 6).
     * `ownerId` is the Command id, so `node_schedule:<id>` resolves like every
     * other row; `ownerLink` is the computer's Schedules tab.
     */
    private async nodeSchedules(
        scope: ScheduleScope,
        degraded: ScheduleSourceType[],
    ): Promise<ProjectedRow[]> {
        // The flag hides the source, not only the routes (FL-13 definition of done).
        if (!this.nodeScheduleSource || !config.fleet.isCommandsEnabled()) return [];
        try {
            const schedules = await this.nodeScheduleSource.listForUser({ userId: scope.userId });
            return schedules.map((schedule) => {
                const paused = !schedule.enabled;
                const view: ScheduleView = {
                    id: schedule.scheduleId,
                    sourceType: 'node_schedule',
                    ownerType: 'node',
                    ownerId: schedule.id,
                    ownerName: schedule.name,
                    ownerLink: `/fleet/computers/${encodeURIComponent(schedule.nodeId)}?tab=schedules`,
                    cadenceRaw: fleetScheduleCadenceRaw(schedule.cadence),
                    cadenceHuman: schedule.cadenceHuman,
                    nextRunAt: schedule.nextRunAt,
                    lastRunAt: schedule.lastRunAt,
                    lastRunStatus: schedule.lastRun?.status ?? null,
                    status: paused ? 'paused' : 'active',
                    enabled: schedule.enabled,
                    agentId: null,
                    agentName: null,
                    pausedAt: schedule.pausedAt,
                    nextRunReasonKey: paused
                        ? 'paused'
                        : schedule.nextRunAt
                          ? null
                          : 'notScheduledYet',
                    nodeId: schedule.nodeId,
                    nodeName: schedule.nodeName,
                    nodeTimeZone: schedule.nodeTimeZone,
                    nodeSchedule: schedule,
                };
                return {
                    view,
                    facts: {
                        sourceType: 'node_schedule' as const,
                        cadenceKind: 'node-cadence' as const,
                        cadence: view.cadenceRaw,
                        paused,
                        nodeNeverRuns: schedule.neverRuns?.reason ?? null,
                    },
                };
            });
        } catch (error) {
            this.warn('node_schedule', error, degraded);
            return [];
        }
    }

    /**
     * APW-02 T53 (FR-32, ACC-E2E-05) — one read-only row per App Work whose upstream sync is
     * scheduled (`nextSyncAt` set) or paused (archived / unreachable upstream, a missing Work
     * Repository). A link has no upstream sync (FR-44) and a Work whose readiness has not
     * finished has no slot yet, so neither has a row. The cron is the effective one the sync
     * run records (`syncSchedule`), or the documented default when none was recorded — the
     * same value the next slot was computed from. Its own try/catch, like every source: an
     * unreadable upstream table degrades to an empty slice.
     */
    private async appUpstreamSyncs(
        scope: ScheduleScope,
        degraded: ScheduleSourceType[],
        mode: SourceReadMode,
    ): Promise<ProjectedRow[]> {
        if (!this.upstreamStateRepo) return [];
        try {
            const where: FindOptionsWhere<Work> = {
                ...this.scopeWhere<Work>(scope),
                kind: 'app',
            } as FindOptionsWhere<Work>;
            const works = await this.readSource(mode, (batch) =>
                this.workRepo.find(this.findOptions(where, batch)),
            );
            if (works.length === 0) return [];
            const byId = new Map(works.map((work) => [work.id, work]));
            const states: WorkUpstreamState[] = [];
            for (const ids of chunked([...byId.keys()], MAX_PER_SOURCE)) {
                const rows = await this.upstreamStateRepo.find({ where: { workId: In(ids) } });
                states.push(...(rows ?? []));
            }

            const out: ProjectedRow[] = [];
            for (const state of states) {
                const work = byId.get(state.workId);
                if (!work || state.relation === 'link') continue;
                const paused =
                    state.upstreamStatus === 'archived' ||
                    state.upstreamStatus === 'unavailable' ||
                    state.dataRepositoryStatus === 'missing' ||
                    state.lastSyncResult === 'paused';
                const nextRunAt = toIso(state.nextSyncAt);
                if (!paused && !nextRunAt) continue;
                const cron = state.syncSchedule || APP_UPSTREAM_SYNC_DEFAULT_CRON;
                const view: ScheduleView = {
                    id: `app_upstream_sync:${work.id}`,
                    sourceType: 'app_upstream_sync',
                    ownerType: 'app_work',
                    ownerId: work.id,
                    ownerName: work.name,
                    ownerLink: `/works/${work.id}/upstream`,
                    cadenceRaw: cron,
                    cadenceHuman: describeCron(cron),
                    nextRunAt: paused ? null : nextRunAt,
                    lastRunAt: toIso(state.syncFinishedAt),
                    lastRunStatus: state.lastSyncResult ?? null,
                    status: paused ? 'paused' : 'active',
                    enabled: !paused,
                    agentId: null,
                    agentName: null,
                    pausedAt: null,
                    nextRunReasonKey: paused ? 'paused' : null,
                };
                out.push({
                    view,
                    facts: {
                        sourceType: 'app_upstream_sync',
                        cadenceKind: 'cron',
                        cadence: cron,
                        paused,
                        ownerArchived: work.status === 'archived',
                    },
                });
            }
            return out;
        } catch (error) {
            this.warn('app_upstream_sync', error, degraded);
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

    private warn(
        source: ScheduleSourceType,
        error: unknown,
        degraded?: ScheduleSourceType[],
    ): void {
        degraded?.push(source);
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Schedules aggregation failed for source "${source}": ${message}`);
    }
}

/**
 * The flat `GET /api/schedules` contract: exactly these thirteen keys.
 *
 * An explicit ALLOW-LIST, not a delete-list, because the failure this repairs
 * was a field arriving by accident. A row built for the Schedules workspace is
 * reused for every read, so when `171440089` added the workspace's own fields
 * — agent, health, controls, pausedAt, reason — they appeared here too. The
 * commit believed it had kept this endpoint compatible, and on the axis it
 * checked (the bare-array shape, no key REMOVED) it had.
 *
 * Two e2e specs disagreed, and they were right for a sharper reason than key
 * counting: `health.checkedAt` is `new Date()` per request, so the flat read —
 * a pure projection of persisted state, asserted twice to be byte-identical
 * across two GETs with nothing written between them — started changing on
 * every call. A read-model that moves while nothing writes is wrong on its own
 * terms, and no widening of the expected key set would have fixed it.
 *
 * The workspace additions are served where the workspace actually reads them:
 * `GET /api/schedules/page`, `/health`, `findOne`, and the pause/resume
 * responses.
 */
function narrowScheduleView(view: ScheduleView): ScheduleView {
    return {
        id: view.id,
        sourceType: view.sourceType,
        ownerType: view.ownerType,
        ownerId: view.ownerId,
        ownerName: view.ownerName,
        ownerLink: view.ownerLink,
        cadenceRaw: view.cadenceRaw,
        cadenceHuman: view.cadenceHuman,
        nextRunAt: view.nextRunAt,
        lastRunAt: view.lastRunAt,
        lastRunStatus: view.lastRunStatus,
        status: view.status,
        enabled: view.enabled,
    };
}
