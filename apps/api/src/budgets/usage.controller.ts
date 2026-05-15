import {
    BadRequestException,
    Controller,
    ForbiddenException,
    Get,
    Header,
    NotFoundException,
    Param,
    Query,
    Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Minimal Response surface for CSV streaming. Mirrors the convention
 * established by works.controller.ts and activity-log.controller.ts —
 * avoids pulling the full `import('express').Response` type.
 */
type DownloadResponse = {
    setHeader(name: string, value: string): void;
    send(body: string | Buffer): void;
};
import { BudgetService } from '@ever-works/agent/budgets';
import {
    WorkRepository,
    WorkMemberRepository,
    PluginUsageRepository,
    WorkBudgetRepository,
} from '@ever-works/agent/database';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

interface PeriodWindow {
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly periodLabel: string;
}

@ApiTags('Usage')
@Controller('works/:workId/usage')
export class UsageController {
    constructor(
        private readonly budgetService: BudgetService,
        private readonly usageRepository: PluginUsageRepository,
        private readonly budgetRepository: WorkBudgetRepository,
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
    ) {}

    @Get('summary')
    @ApiOperation({
        summary: 'EW-602: per-Work usage summary for a billing period',
    })
    async getSummary(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Query('period') period?: string,
    ) {
        await this.assertReadAccess(workId, auth.userId);
        const window = this.resolvePeriodWindow(period);

        const [totalSpendCents, perPlugin, globalBudget] = await Promise.all([
            this.usageRepository.getTotalSpendCents(workId, window.periodStart, window.periodEnd),
            this.usageRepository.getSpendByPlugin(workId, window.periodStart, window.periodEnd),
            this.budgetRepository.findGlobal(workId),
        ]);

        const currency = globalBudget?.currency ?? 'usd';

        return {
            workId,
            periodStart: window.periodStart.toISOString(),
            periodEnd: window.periodEnd.toISOString(),
            periodLabel: window.periodLabel,
            currency,
            totalSpendCents,
            perPlugin: perPlugin.map((p) => ({
                pluginId: p.pluginId,
                capability: p.capability,
                units: p.units,
                costCents: p.costCents,
            })),
            globalBudget: globalBudget
                ? {
                      id: globalBudget.id,
                      monthlyCapCents: globalBudget.monthlyCapCents,
                      allowOverage: globalBudget.allowOverage,
                      currency: globalBudget.currency,
                      percentUsed:
                          globalBudget.monthlyCapCents > 0
                              ? Math.round((totalSpendCents / globalBudget.monthlyCapCents) * 100)
                              : 0,
                  }
                : null,
        };
    }

    @Get('export')
    @ApiOperation({
        summary: 'EW-602: download per-Work usage events as CSV for the billing period',
    })
    @Header('Cache-Control', 'no-store')
    async exportCsv(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Res() res: DownloadResponse,
        @Query('period') period?: string,
        @Query('format') format?: string,
    ): Promise<void> {
        await this.assertReadAccess(workId, auth.userId);

        if (format && format !== 'csv') {
            throw new BadRequestException(
                `Unsupported format '${format}'. Only 'csv' is supported in V1.`,
            );
        }

        const window = this.resolvePeriodWindow(period);
        const events = await this.usageRepository.findForExport(
            workId,
            window.periodStart,
            window.periodEnd,
        );

        const header = [
            'occurredAt',
            'pluginId',
            'capability',
            'units',
            'costCents',
            'currency',
            'modelId',
            'requestId',
        ];
        const escape = (value: unknown): string => {
            if (value === null || value === undefined) return '';
            const str = typeof value === 'string' ? value : String(value);
            if (/[",\n\r]/.test(str)) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        const lines = [header.join(',')];
        for (const event of events) {
            lines.push(
                [
                    event.occurredAt instanceof Date
                        ? event.occurredAt.toISOString()
                        : String(event.occurredAt),
                    event.pluginId,
                    event.capability,
                    event.units,
                    event.costCents,
                    event.currency,
                    event.modelId,
                    event.requestId,
                ]
                    .map(escape)
                    .join(','),
            );
        }
        const body = lines.join('\n') + '\n';

        const periodSlug = window.periodStart.toISOString().slice(0, 7); // YYYY-MM
        const filename = `usage-${workId}-${periodSlug}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(body);
    }

    @Get('trend')
    @ApiOperation({
        summary: 'EW-602: per-Work daily spend buckets across the billing period',
    })
    async getTrend(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Query('period') period?: string,
        @Query('granularity') granularity?: string,
    ) {
        await this.assertReadAccess(workId, auth.userId);
        const window = this.resolvePeriodWindow(period);

        if (granularity && granularity !== 'day') {
            throw new BadRequestException(
                `Unsupported granularity '${granularity}'. Only 'day' is supported in V1.`,
            );
        }

        const buckets = await this.usageRepository.getDailySpend(
            workId,
            window.periodStart,
            window.periodEnd,
        );

        return {
            workId,
            periodStart: window.periodStart.toISOString(),
            periodEnd: window.periodEnd.toISOString(),
            granularity: 'day' as const,
            buckets,
        };
    }

    private async assertReadAccess(workId: string, userId: string): Promise<void> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work ${workId} not found`);
        }
        if (work.userId === userId) {
            return;
        }
        const isMember = await this.workMemberRepository.isMember(workId, userId);
        if (!isMember) {
            throw new ForbiddenException(`User does not have access to work ${workId}`);
        }
    }

    private resolvePeriodWindow(period: string | undefined): PeriodWindow {
        const now = new Date();
        if (!period || period === 'current') {
            const start = this.budgetService.getCurrentPeriodStart(now);
            const end = this.budgetService.getNextPeriodStart(now);
            return {
                periodStart: start,
                periodEnd: end,
                periodLabel: start.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
            };
        }

        const match = /^(\d{4})-(\d{2})$/.exec(period);
        if (!match) {
            throw new BadRequestException(
                `Invalid period '${period}'. Use 'current' or 'YYYY-MM'.`,
            );
        }
        const year = Number(match[1]);
        const month = Number(match[2]);
        if (month < 1 || month > 12) {
            throw new BadRequestException(`Invalid month in period '${period}'.`);
        }
        const start = new Date(Date.UTC(year, month - 1, 1));
        const end = new Date(Date.UTC(year, month, 1));
        return {
            periodStart: start,
            periodEnd: end,
            periodLabel: start.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        };
    }
}
