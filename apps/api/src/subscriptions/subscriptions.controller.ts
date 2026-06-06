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
import { SubscriptionService } from '@ever-works/agent/subscriptions';
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
