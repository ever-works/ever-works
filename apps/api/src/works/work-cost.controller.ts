import {
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PluginUsageRepository, WorkBudgetRepository } from '@ever-works/agent/database';
import { TaskRepository } from '@ever-works/agent/tasks-domain';
import {
    WORK_COST_MONTH_PATTERN,
    WORK_COST_TASKS_LIMIT,
    totalCostCents,
    type WorkCostAlert,
    type WorkCostRollup,
    type WorkCostTask,
} from '@ever-works/contracts';

import { WorkOwnershipService } from '@ever-works/agent/services';

import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * APW-08 T56 (XC-19, FR-73) — `GET /api/works/:id/cost`: what a Work spent in a month against
 * its own budget.
 *
 * No new spend account: the spend is the usage ledger's (`getTotalSpendCents`, the query the
 * budget guard itself runs), the cap is the Work's existing global `WorkBudget`, and the alert
 * is the EW-602 threshold ladder (75 / 90 / 100 / overage). Any Work kind answers; the App Work
 * overview is the first reader. `?month=YYYY-MM` (UTC) picks a month, default the current one.
 *
 * Access: view. A missing, invisible or other account's Work is one `404 not_found`.
 *
 * T56 (ACC-08-37, FR-62) — an amount the ledger could not give as a number is **unknown**
 * (`spendCents: null`), never `0`: a zero would show the whole cap as remaining. And the answer
 * lists the month's costliest Tasks of this Work (`tasks`, at most `WORK_COST_TASKS_LIMIT`) so
 * the overview links to each Task's own Cost section instead of repeating it. Only a Task of
 * this Work that the VIEWER owns is listed: a Work viewer is not, by that alone, a reader of every
 * Task on it (record visibility), and a line must never leak another person's Task title.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkCostController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly usage: PluginUsageRepository,
        private readonly budgets: WorkBudgetRepository,
        // APW-08 T56 — the Task titles for the `tasks` lines. Appended LAST and `@Optional()`:
        // absent, the answer simply carries no `tasks` (exactly the pre-T56 shape).
        @Optional() private readonly tasks?: TaskRepository,
    ) {}

    @Get(':id/cost')
    @ApiOperation({
        summary: 'What a Work spent in a month against its budget (spend, cap, remaining, alert)',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiQuery({
        name: 'month',
        required: false,
        description: '`YYYY-MM` (UTC); default this month',
    })
    async cost(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('month') month?: unknown,
    ): Promise<WorkCostRollup> {
        await this.authorize(id, auth.userId);
        const window = monthWindow(month);
        const budget = await this.budgets.findGlobal(id);
        const currency = budget?.currency ?? 'usd';
        const spendCents = await this.usage.getTotalSpendCents(
            id,
            window.start,
            window.end,
            undefined,
            budget ? currency : undefined,
        );
        const tasks = await this.taskLines(id, auth.userId, window, budget ? currency : undefined);
        return {
            ...rollup({
                workId: id,
                month: window.label,
                start: window.start,
                end: window.end,
                currency,
                spendCents,
                capCents: budget ? budget.monthlyCapCents : null,
                allowOverage: budget?.allowOverage === true,
            }),
            ...(tasks ? { tasks } : {}),
        };
    }

    /**
     * T56 — the month's costliest Tasks of this Work that the viewer owns, costliest first, at
     * most {@link WORK_COST_TASKS_LIMIT}. `null` (the key is left out) when this build cannot
     * read them; a read that fails is an empty list, never a failed rollup — the summary's
     * spend, cap and remaining stand on their own.
     */
    private async taskLines(
        workId: string,
        viewerId: string,
        window: { start: Date; end: Date },
        currency: string | undefined,
    ): Promise<WorkCostTask[] | null> {
        if (!this.tasks || typeof this.usage.getSpendByTaskForWork !== 'function') return null;
        try {
            // Over-read: lines the viewer may not see are dropped, and the list should still fill.
            const rows = await this.usage.getSpendByTaskForWork(workId, window.start, window.end, {
                currency,
                limit: WORK_COST_TASKS_LIMIT * 4,
            });
            const lines: WorkCostTask[] = [];
            for (const row of rows) {
                if (lines.length >= WORK_COST_TASKS_LIMIT) break;
                const task = await this.tasks.findById(row.taskId).catch(() => null);
                if (!task || task.workId !== workId || task.userId !== viewerId) continue;
                lines.push({
                    taskId: task.id,
                    title: typeof task.title === 'string' && task.title ? task.title : null,
                    spendCents: row.costCents,
                });
            }
            return lines;
        } catch {
            return [];
        }
    }

    private async authorize(workId: string, userId: string): Promise<void> {
        try {
            await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (error instanceof HttpException) {
                const status = error.getStatus();
                if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                    throw new HttpException(
                        {
                            status: 'error',
                            code: 'not_found',
                            message: `Work ${workId} not found.`,
                        },
                        HttpStatus.NOT_FOUND,
                    );
                }
            }
            throw error;
        }
    }
}

/**
 * The UTC month `month` names (default: this month), or a `400 invalidMonth`.
 *
 * `month` is typed `unknown` on purpose: a repeated query parameter (`?month=a&month=b`) arrives
 * as an ARRAY, and `['2026-09']` stringifies to a value the pattern accepts. Only a string is a
 * month; anything else is refused before the pattern is consulted.
 */
export function monthWindow(
    month?: unknown,
    now: Date = new Date(),
): { label: string; start: Date; end: Date } {
    let year = now.getUTCFullYear();
    let index = now.getUTCMonth();
    if (month !== undefined && month !== '') {
        if (typeof month !== 'string' || !WORK_COST_MONTH_PATTERN.test(month)) {
            throw new HttpException(
                { status: 'error', code: 'invalidMonth', message: 'month must be YYYY-MM.' },
                HttpStatus.BAD_REQUEST,
            );
        }
        year = Number(month.slice(0, 4));
        index = Number(month.slice(5, 7)) - 1;
    }
    const start = new Date(Date.UTC(year, index, 1));
    const end = new Date(Date.UTC(year, index + 1, 1));
    return { label: `${year}-${String(index + 1).padStart(2, '0')}`, start, end };
}

/**
 * The rollup for one month: remaining never below zero, the EW-602 alert ladder.
 *
 * T56 (ACC-08-37) — the spend is totalled with the App Works rule (`totalCostCents`): an
 * amount that is not a finite number is UNKNOWN, so the spend is `null` and so are the
 * remaining amount and the percent (the alert stays `none`: nothing is known to have crossed).
 * It used to read as `0`, which showed the whole cap as remaining.
 */
export function rollup(input: {
    workId: string;
    month: string;
    start: Date;
    end: Date;
    currency: string;
    spendCents: number | null;
    capCents: number | null;
    allowOverage: boolean;
}): WorkCostRollup {
    const spendCents = totalCostCents([input.spendCents]);
    const cap = input.capCents;
    const hasCap = typeof cap === 'number' && cap > 0;
    const percent = hasCap && spendCents !== null ? (spendCents / cap) * 100 : null;
    let alert: WorkCostAlert = 'none';
    if (percent !== null) {
        if (percent > 100 && input.allowOverage) alert = 'overage';
        else if (percent >= 100) alert = '100';
        else if (percent >= 90) alert = '90';
        else if (percent >= 75) alert = '75';
    }
    return {
        workId: input.workId,
        month: input.month,
        periodStart: input.start.toISOString(),
        periodEnd: input.end.toISOString(),
        currency: input.currency,
        spendCents,
        capCents: hasCap ? cap : null,
        remainingCents: hasCap && spendCents !== null ? Math.max(0, cap - spendCents) : null,
        percentUsed: percent === null ? null : Math.round(percent),
        allowOverage: input.allowOverage,
        alert,
    };
}
