import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BudgetService, type UserBudgetSummary } from '@ever-works/agent/budgets';
import { WorkAgentService } from '@ever-works/agent/work-agent';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * Phase 7 PR II — `GET /me/usage/account-wide`.
 *
 * Reports the user's current-month total spend across every
 * Work + Mission + Idea + plugin-call attributed to them, plus
 * the account-wide cap (from the `accountWideMonthlyCapCents` +
 * `accountWideAllowOverage` prefs added by Phase 0 PR 0.6).
 *
 * Drives the Dashboard's `Month Spend` 6th stats tile (spec
 * §5.1) which clicks through to `/settings/work-agent#account-
 * budgets` so the user can adjust the cap in one place.
 *
 * Pref shape narrowing: `accountWideMonthlyCapCents` is a bigint
 * serialized as a string on the wire (Phase 0 PR 0.6 chose
 * bigint so power-user caps survive). We narrow it through
 * `Number(...)` here at the boundary — same trade-off as the
 * frontend's `bigint-cents.ts` helper, with the same
 * MAX_SAFE_INTEGER ceiling that's still ~$90 quadrillion in
 * cents, well past any realistic monthly cap.
 */
@ApiTags('Usage')
@Controller('api/me/usage')
export class AccountUsageController {
    constructor(
        private readonly budgetService: BudgetService,
        private readonly workAgentService: WorkAgentService,
    ) {}

    @Get('account-wide')
    @ApiOperation({
        summary:
            'Current-month total spend across the user account + account-wide cap status (Phase 7 PR II).',
    })
    @HttpCode(HttpStatus.OK)
    async accountWide(@CurrentUser() auth: AuthenticatedUser): Promise<UserBudgetSummary> {
        const prefs = await this.workAgentService.getPreferences(auth.userId);
        const capCentsRaw = prefs.accountWideMonthlyCapCents;
        const capCents = capCentsRaw === null ? null : Number(capCentsRaw);
        return this.budgetService.summarizeForUser(auth.userId, {
            capCents: Number.isFinite(capCents) ? capCents : null,
            allowOverage: prefs.accountWideAllowOverage,
        });
    }
}
