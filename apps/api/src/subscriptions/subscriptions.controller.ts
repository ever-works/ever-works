import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthSessionGuard, AuthService, CurrentUser } from '@src/auth';
import {
    ENTITLEMENT_KEYS,
    EntitlementsService,
    SubscriptionService,
} from '@ever-works/agent/subscriptions';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { SubscriptionPlanCode } from '@ever-works/agent/entities';
import { IsEnum } from 'class-validator';

class UpdateSubscriptionPlanDto {
    @IsEnum(SubscriptionPlanCode)
    planCode: SubscriptionPlanCode;
}

@ApiTags('Subscriptions')
@ApiBearerAuth('JWT-auth')
@Controller('api/subscriptions')
@UseGuards(AuthSessionGuard)
export class SubscriptionsController {
    constructor(
        private readonly subscriptionService: SubscriptionService,
        private readonly authService: AuthService,
        // Wave 13 (Billing page) — per-plan daily-free-credits for the
        // credits-forward plan switcher (`GET plans` below).
        private readonly entitlementsService: EntitlementsService,
    ) {}

    @Get('plan')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get subscription plan',
        description: 'Get the current subscription plan for the user',
    })
    @ApiResponse({ status: 200, description: 'Subscription plan details' })
    async getPlan(@CurrentUser() auth: AuthenticatedUser) {
        const user = await this.authService.getUser(auth.userId);
        const summary = await this.subscriptionService.summarizePlan(user);
        if (!summary.enabled) {
            // Subscriptions module is disabled in this deploy; every user is
            // effectively on the free tier. Returning `plan: null` here used
            // to leak the disabled-state to the client and broke any caller
            // that read `plan.code` (web UI, e2e tier-gating contract).
            return {
                status: 'success',
                enabled: false,
                plan: { code: 'free', name: 'Free' },
            };
        }

        return {
            status: 'success',
            enabled: true,
            plan: {
                code: summary.plan.code,
                name: summary.plan.displayName,
                allowedCadences: summary.allowances,
            },
        };
    }

    @Get('plans')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List subscription plans',
        description:
            'All active plans with their feature/limit gates + credits levers (Wave 13 Billing page — ' +
            'credits-forward plan switcher). Read-only and additive; works (degraded) when subscriptions ' +
            'are disabled so the switcher can still render the catalog.',
    })
    @ApiResponse({ status: 200, description: 'Active plans + current plan code' })
    async listPlans(@CurrentUser() auth: AuthenticatedUser) {
        const user = await this.authService.getUser(auth.userId);
        const [summary, plans, licences] = await Promise.all([
            this.subscriptionService.summarizePlan(user),
            this.subscriptionService.listPlans(),
            this.subscriptionService.listSelfHostedPlans(),
        ]);
        const currentPlanCode = summary.enabled ? summary.plan.code : 'free';

        // Plan count is tiny (seeded catalog) and EntitlementsService
        // caches reads — this is one lookup per plan, not a per-row N+1.
        const items = await Promise.all(
            plans.map(async (plan) => ({
                code: plan.code,
                name: plan.displayName,
                // Echoed so the response is self-describing: the switcher can tell a hosted tier
                // from a self-hosted licence instead of inferring it from the plan name. Today
                // `listPlans` only returns cloud plans, so this is always 'cloud' — it exists so a
                // future self-hosted build does not have to guess, and so the omission that caused
                // six undifferentiated cards cannot silently recur.
                hosting: plan.hosting,
                maxWorks: plan.maxWorks,
                allowedCadences: plan.allowedCadences ?? [],
                monthlyPrice: plan.monthlyPrice,
                // The yearly total, NOT a per-month figure (cloud Pro stores
                // '204'). Rendering it against a '/mo' suffix shows $204/mo.
                annualPrice: plan.annualPrice,
                lifetimePrice: plan.lifetimePrice,
                seatsIncluded: plan.seatsIncluded,
                seatMonthlyPrice: plan.seatMonthlyPrice,
                monthlyCredits: plan.monthlyCredits,
                overagePricePerRun: plan.overagePricePerRun,
                currency: plan.currency,
                isCurrent: plan.code === currentPlanCode,
                dailyFreeCredits: await this.entitlementsService.getNumber(
                    plan.code,
                    ENTITLEMENT_KEYS.DAILY_FREE_CREDITS,
                    0,
                ),
            })),
        );

        // Self-hosted editions ship as a SEPARATE array, never merged into
        // `plans`. They are purchasable but not self-assignable, so a card in
        // the switcher would be a button whose only outcome is a 403 from
        // `changePlanSelfService`. The switcher keeps its three cards; the
        // licence surface renders from this.
        const licenceItems = licences.map((plan) => ({
            code: plan.code,
            name: plan.displayName,
            hosting: plan.hosting,
            maxWorks: plan.maxWorks,
            allowedCadences: plan.allowedCadences ?? [],
            monthlyPrice: plan.monthlyPrice,
            annualPrice: plan.annualPrice,
            lifetimePrice: plan.lifetimePrice,
            seatsIncluded: plan.seatsIncluded,
            seatMonthlyPrice: plan.seatMonthlyPrice,
            monthlyCredits: plan.monthlyCredits,
            overagePricePerRun: plan.overagePricePerRun,
            currency: plan.currency,
            // A licence never becomes "your current plan" on this deployment.
            isCurrent: false,
            dailyFreeCredits: 0,
        }));

        return {
            status: 'success',
            enabled: summary.enabled,
            currentPlanCode,
            plans: items,
            licences: licenceItems,
        };
    }

    @Post('plan')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update subscription plan (self-service)',
        description:
            'Self-service plan change for the authenticated user. Only FREE plans may be set this way (sign-up default / downgrade / cancel); a paid plan must be activated through billing and is rejected with 403. (EW-711 #23.)',
    })
    @ApiResponse({ status: 200, description: 'Subscription plan updated' })
    @ApiResponse({ status: 400, description: 'Subscriptions are disabled' })
    @ApiResponse({ status: 403, description: 'Paid plans cannot be self-assigned' })
    async updatePlan(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: UpdateSubscriptionPlanDto,
    ) {
        if (!this.subscriptionService.isEnabled()) {
            throw new BadRequestException('Subscriptions are disabled');
        }

        const user = await this.authService.getUser(auth.userId);
        // Security (EW-711 #23): self-service may only set a FREE plan; a paid
        // plan requires a billing-verified grant. `changePlanSelfService`
        // enforces this (403 on a paid plan), closing the free->paid escalation.
        const plan = await this.subscriptionService.changePlanSelfService(user, dto.planCode);
        const summary = await this.subscriptionService.summarizePlan(user);

        return {
            status: 'success',
            enabled: true,
            plan: {
                code: plan.code,
                name: plan.displayName,
                allowedCadences: summary.allowances,
            },
        };
    }
}
