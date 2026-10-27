import {
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PluginUsageRepository, WorkBudgetRepository } from '@ever-works/agent/database';
import {
    WORK_COST_MONTH_PATTERN,
    type WorkCostAlert,
    type WorkCostRollup,
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
        @Query('month') month?: string,
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
        return rollup({
            workId: id,
            month: window.label,
            start: window.start,
            end: window.end,
            currency,
            spendCents,
            capCents: budget ? budget.monthlyCapCents : null,
            allowOverage: budget?.allowOverage === true,
        });
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

/** The UTC month `month` names (default: this month), or a `400 invalidMonth`. */
export function monthWindow(
    month?: string,
    now: Date = new Date(),
): { label: string; start: Date; end: Date } {
    let year = now.getUTCFullYear();
    let index = now.getUTCMonth();
    if (month !== undefined && month !== '') {
        if (!WORK_COST_MONTH_PATTERN.test(month)) {
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

/** The rollup for one month: remaining never below zero, the EW-602 alert ladder. */
export function rollup(input: {
    workId: string;
    month: string;
    start: Date;
    end: Date;
    currency: string;
    spendCents: number;
    capCents: number | null;
    allowOverage: boolean;
}): WorkCostRollup {
    const spendCents = Number.isFinite(input.spendCents) ? input.spendCents : 0;
    const cap = input.capCents;
    const hasCap = typeof cap === 'number' && cap > 0;
    const percent = hasCap ? (spendCents / cap) * 100 : null;
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
        remainingCents: hasCap ? Math.max(0, cap - spendCents) : null,
        percentUsed: percent === null ? null : Math.round(percent),
        allowOverage: input.allowOverage,
        alert,
    };
}
