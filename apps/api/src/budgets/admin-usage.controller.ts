import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { In } from 'typeorm';
import { BudgetService } from '@ever-works/agent/budgets';
import { PluginUsageRepository } from '@ever-works/agent/database';
import { InjectRepository } from '@nestjs/typeorm';
import { User, Work } from '@ever-works/agent/entities';
import { Repository } from 'typeorm';
import { IsPlatformAdminGuard } from '@src/auth/guards/platform-admin.guard';

interface AdminUsageRow {
    userId: string;
    username: string;
    email: string | null;
    workId: string;
    workName: string;
    units: number;
    costCents: number;
}

interface AdminUsageResponse {
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
    totalSpendCents: number;
    rows: AdminUsageRow[];
}

/**
 * EW-602 — Self-hosted admin view: cross-user × cross-Work spend.
 *
 *   GET /api/admin/usage[?period=current|YYYY-MM]
 *
 * Gated by IsPlatformAdminGuard (User.isPlatformAdmin = true). The
 * platform owner seeds the flag via SEED_PLATFORM_ADMIN_EMAIL on
 * first boot or by manual UPDATE.
 *
 * Returns one row per (user, work) with non-zero usage in the
 * period, joined with usernames and Work names so the admin UI can
 * render a sortable table without N+1 lookups.
 */
@ApiTags('Admin')
@Controller('admin/usage')
@UseGuards(IsPlatformAdminGuard)
export class AdminUsageController {
    constructor(
        private readonly budgetService: BudgetService,
        private readonly usageRepository: PluginUsageRepository,
        @InjectRepository(User) private readonly userRepository: Repository<User>,
        @InjectRepository(Work) private readonly workRepository: Repository<Work>,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'Cross-user and cross-Work spend for self-hosted admins',
    })
    async list(@Query('period') period?: string): Promise<AdminUsageResponse> {
        const window = this.resolvePeriodWindow(period);
        const rows = await this.usageRepository.getCrossUserSpend(
            window.periodStart,
            window.periodEnd,
        );

        const userIds = Array.from(new Set(rows.map((r) => r.userId)));
        const workIds = Array.from(new Set(rows.map((r) => r.workId)));

        const [users, works] = await Promise.all([
            userIds.length > 0
                ? this.userRepository.find({
                      where: { id: In(userIds) },
                      select: ['id', 'username', 'email'],
                  })
                : Promise.resolve([] as User[]),
            workIds.length > 0
                ? this.workRepository.find({
                      where: { id: In(workIds) },
                      select: ['id', 'name'],
                  })
                : Promise.resolve([] as Work[]),
        ]);

        const userMap = new Map<string, User>(users.map((u) => [u.id, u]));
        const workMap = new Map<string, Work>(works.map((w) => [w.id, w]));

        let totalSpendCents = 0;
        const responseRows: AdminUsageRow[] = rows.map((r) => {
            totalSpendCents += r.costCents;
            const user = userMap.get(r.userId);
            const work = workMap.get(r.workId);
            return {
                userId: r.userId,
                username: user?.username ?? r.userId,
                email: user?.email ?? null,
                workId: r.workId,
                workName: work?.name ?? r.workId,
                units: r.units,
                costCents: r.costCents,
            };
        });

        return {
            periodStart: window.periodStart.toISOString(),
            periodEnd: window.periodEnd.toISOString(),
            periodLabel: window.periodLabel,
            totalSpendCents,
            rows: responseRows,
        };
    }

    private resolvePeriodWindow(period: string | undefined): {
        periodStart: Date;
        periodEnd: Date;
        periodLabel: string;
    } {
        const now = new Date();
        if (!period || period === 'current') {
            const start = this.budgetService.getCurrentPeriodStart(now);
            const end = this.budgetService.getNextPeriodStart(now);
            return {
                periodStart: start,
                periodEnd: end,
                periodLabel: start.toLocaleString('en-US', {
                    month: 'long',
                    year: 'numeric',
                }),
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
            periodLabel: start.toLocaleString('en-US', {
                month: 'long',
                year: 'numeric',
            }),
        };
    }
}
