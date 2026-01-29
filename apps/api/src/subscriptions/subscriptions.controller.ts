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
import { JwtAuthGuard, AuthService, CurrentUser } from '@src/auth';
import { SubscriptionService } from '@packages/agent/subscriptions';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';
import { SubscriptionPlanCode } from '@packages/agent/entities';
import { IsEnum } from 'class-validator';

class UpdateSubscriptionPlanDto {
    @IsEnum(SubscriptionPlanCode)
    planCode: SubscriptionPlanCode;
}

@ApiTags('Subscriptions')
@ApiBearerAuth('JWT-auth')
@Controller('api/subscriptions')
@UseGuards(JwtAuthGuard)
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
            return {
                status: 'success',
                enabled: false,
                plan: null,
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
        summary: 'Update subscription plan',
        description: 'Update the subscription plan for the user',
    })
    @ApiResponse({ status: 200, description: 'Subscription plan updated' })
    @ApiResponse({ status: 400, description: 'Subscriptions are disabled' })
    async updatePlan(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: UpdateSubscriptionPlanDto,
    ) {
        if (!this.subscriptionService.isEnabled()) {
            throw new BadRequestException('Subscriptions are disabled');
        }

        const user = await this.authService.getUser(auth.userId);
        const plan = await this.subscriptionService.assignPlanToUser(user, dto.planCode);
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
