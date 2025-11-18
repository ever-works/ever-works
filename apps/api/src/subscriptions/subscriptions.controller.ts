import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, AuthService, CurrentUser } from '@src/auth';
import { SubscriptionService } from '@packages/agent/subscriptions';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';
import { SubscriptionPlanCode } from '@packages/agent/entities';
import { IsEnum } from 'class-validator';

class UpdateSubscriptionPlanDto {
    @IsEnum(SubscriptionPlanCode)
    planCode: SubscriptionPlanCode;
}

@Controller('api/subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
    constructor(
        private readonly subscriptionService: SubscriptionService,
        private readonly authService: AuthService,
    ) {}

    @Get('plan')
    @HttpCode(HttpStatus.OK)
    async getPlan(@CurrentUser() auth: AuthenticatedUser) {
        const user = await this.authService.getUser(auth.userId);
        const summary = await this.subscriptionService.summarizePlan(user);

        return {
            status: 'success',
            plan: {
                code: summary.plan.code,
                name: summary.plan.displayName,
                allowedCadences: summary.allowances,
            },
        };
    }

    @Post('plan')
    @HttpCode(HttpStatus.OK)
    async updatePlan(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: UpdateSubscriptionPlanDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const plan = await this.subscriptionService.assignPlanToUser(user, dto.planCode);
        const summary = await this.subscriptionService.summarizePlan(user);

        return {
            status: 'success',
            plan: {
                code: plan.code,
                name: plan.displayName,
                allowedCadences: summary.allowances,
            },
        };
    }
}
