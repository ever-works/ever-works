import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
    clampTaskBoardColumnLimit,
    clampTaskBoardTerminalWindowDays,
    findTaskBoardColumn,
    taskBoardColumnsFor,
    taskBoardStallCutoff,
    TASK_BOARD_DEFAULT_STALL_AFTER_DAYS,
    type TaskBoardColumnDef,
    type TaskBoardLayout,
} from '@ever-works/contracts';
import type { TaskPriority, TaskStatus } from '../entities/task.entity';
import type { ListTasksFilter } from '../database/repositories/task.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import { TasksService, type TaskWithRun } from './tasks.service';

const DAY_MS = 86_400_000;

/** Everything a board read can be asked for. Every field is optional. */
export interface TaskBoardInput {
    /** Column table to group by. Default `status`. */
    layout?: TaskBoardLayout;
    /** Cards per column, clamped 1..100. Default 50. */
    columnLimit?: number;
    /** Days of `done` / `cancelled` history, clamped 1..90. Default 7. */
    terminalWindowDays?: number;
    /**
     * Restrict the board to these statuses. A column holding none of them
     * reads as empty without a query. Omitted = every status.
     */
    status?: TaskStatus[];
    priority?: TaskPriority | TaskPriority[];
    label?: string;
    search?: string;
    missionId?: string;
    ideaId?: string;
    workId?: string;
    teamId?: string;
    agentId?: string;
    goalId?: string;
    /** Default false: only top-level Tasks become cards. */
    includeSubtasks?: boolean;
    /** Default false: recurring templates are schedules, not cards. */
    includeTemplates?: boolean;
    /** Default false: Tasks a Trigger keeps off the board stay off. */
    includeHidden?: boolean;
    /** Focus layout only — show the toggle-only Cancelled column. */
    includeCancelled?: boolean;
    /** Clock override for tests; production reads the wall clock. */
    now?: Date;
}

export interface TaskBoardColumnResult {
    key: string;
    statuses: TaskStatus[];
    /**
     * True total of Tasks in this column under the active filters — never the
     * number of cards returned. Comes from the same query as the cards.
     */
    total: number;
    cards: TaskWithRun[];
    offset: number;
    limit: number;
    /** True when this column's read failed; the other columns still render. */
    failed: boolean;
}

export interface TaskBoardResult {
    layout: TaskBoardLayout;
    columns: TaskBoardColumnResult[];
    columnLimit: number;
    terminalWindowDays: number;
}

/**
 * Task board — the read model behind the board view of `/tasks`.
 *
 * Why it exists: the board used to be handed one 50-row page with no status
 * filter and render each column's header as the length of whatever that page
 * happened to contain. Every count was a page count. This service reads each
 * column on its own, so a header is the column's true total and "show more"
 * pages one column without re-reading the others.
 *
 * Each column is ONE call to {@link TasksService.list}: its `total` is the
 * count under the exact predicate that produced its cards, so a count and its
 * cards cannot disagree by construction. Reusing `list` also reuses what it
 * already guarantees — owner + Organization scoping, the reachable-Work
 * filter, and the batched latest-run embed — rather than re-implementing any
 * of it here.
 *
 * Columns read in parallel and fail independently: a column whose read
 * throws comes back `failed` and empty while the rest render. Only when every
 * column fails does the read itself fail.
 */
@Injectable()
export class TaskBoardService {
    private readonly logger = new Logger(TaskBoardService.name);

    constructor(private readonly tasks: TasksService) {}

    async getBoard(
        userId: string,
        input: TaskBoardInput = {},
        scope?: OwnershipScope,
    ): Promise<TaskBoardResult> {
        const layout = input.layout ?? 'status';
        const columnLimit = clampTaskBoardColumnLimit(input.columnLimit);
        const terminalWindowDays = clampTaskBoardTerminalWindowDays(input.terminalWindowDays);
        const filter = this.buildBoardFilter(input);
        const columns = taskBoardColumnsFor(layout, {
            includeCancelled: input.includeCancelled === true,
        });

        const settled = await Promise.allSettled(
            columns.map((column) =>
                this.readColumn(userId, filter, input, column, 0, columnLimit, scope),
            ),
        );
        const failures = settled.filter(
            (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
        );
        if (failures.length > 0 && failures.length === settled.length) {
            throw failures[0].reason;
        }

        return {
            layout,
            columnLimit,
            terminalWindowDays,
            columns: settled.map((entry, index) => {
                if (entry.status === 'fulfilled') return entry.value;
                const column = columns[index];
                this.logger.warn(
                    `Task board column "${column.key}" failed to load: ${String(entry.reason)}`,
                );
                return {
                    key: column.key,
                    statuses: [...column.statuses] as TaskStatus[],
                    total: 0,
                    cards: [],
                    offset: 0,
                    limit: columnLimit,
                    failed: true,
                };
            }),
        };
    }

    /**
     * One column, for "show more". Same predicate and same order as the
     * column in {@link getBoard}, so offset N here is exactly the row the
     * board read would have returned at position N.
     */
    async getColumn(
        userId: string,
        input: TaskBoardInput,
        columnKey: string,
        offset: number,
        scope?: OwnershipScope,
    ): Promise<TaskBoardColumnResult> {
        const layout = input.layout ?? 'status';
        const column = findTaskBoardColumn(layout, columnKey);
        if (!column) {
            throw new BadRequestException(`Unknown ${layout} board column: ${columnKey}`);
        }
        const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
        return this.readColumn(
            userId,
            this.buildBoardFilter(input),
            input,
            column,
            safeOffset,
            clampTaskBoardColumnLimit(input.columnLimit),
            scope,
        );
    }

    /**
     * THE board predicate. Built once per read and handed unchanged to every
     * column, so the only thing that differs between two columns is their
     * statuses. Every toggle flips exactly one field.
     */
    private buildBoardFilter(input: TaskBoardInput): ListTasksFilter {
        const now = input.now ?? new Date();
        const terminalWindowDays = clampTaskBoardTerminalWindowDays(input.terminalWindowDays);
        const filter: ListTasksFilter = {
            priority: input.priority,
            label: input.label,
            search: input.search,
            missionId: input.missionId,
            ideaId: input.ideaId,
            workId: input.workId,
            teamId: input.teamId,
            agentId: input.agentId,
            goalId: input.goalId,
            includeHidden: input.includeHidden === true,
            terminalUpdatedSince: new Date(now.getTime() - terminalWindowDays * DAY_MS),
            orderBy: 'stalledThenPriority',
            stallCutoff: taskBoardStallCutoff(now, TASK_BOARD_DEFAULT_STALL_AFTER_DAYS),
        };
        if (input.includeSubtasks !== true) filter.parentTaskId = 'none';
        if (input.includeTemplates !== true) filter.isRecurring = false;
        return filter;
    }

    private async readColumn(
        userId: string,
        filter: ListTasksFilter,
        input: TaskBoardInput,
        column: TaskBoardColumnDef,
        offset: number,
        limit: number,
        scope?: OwnershipScope,
    ): Promise<TaskBoardColumnResult> {
        const columnStatuses = [...column.statuses] as TaskStatus[];
        const statuses = input.status?.length
            ? columnStatuses.filter((status) => input.status!.includes(status))
            : columnStatuses;
        const empty: TaskBoardColumnResult = {
            key: column.key,
            statuses: columnStatuses,
            total: 0,
            cards: [],
            offset,
            limit,
            failed: false,
        };
        if (statuses.length === 0) return empty;

        const { rows, total } = await this.tasks.list(
            userId,
            {
                ...filter,
                status: statuses.length === 1 ? statuses[0] : statuses,
                limit,
                offset,
            },
            { includeRun: true },
            scope,
        );
        return { ...empty, total, cards: rows };
    }
}
