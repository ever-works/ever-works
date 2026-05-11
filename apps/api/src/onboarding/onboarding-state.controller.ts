import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { OnboardingStateService } from './onboarding-state.service';
import {
    OnboardingStatePatchBodyDto,
    OnboardingStateResponseDto,
} from './dto/onboarding-state.dto';

/**
 * REST endpoints that back the v2 onboarding wizard's server-side state.
 *
 * Routes (all auth-required):
 *  - `GET /api/onboarding/state`     — load current state
 *  - `PATCH /api/onboarding/state`   — partial update
 *  - `POST /api/onboarding/complete` — mark completed (idempotent)
 *  - `POST /api/onboarding/dismiss`  — mark dismissed (idempotent)
 */
@ApiTags('onboarding')
@Controller('api/onboarding')
export class OnboardingStateController {
    constructor(private readonly stateService: OnboardingStateService) {}

    @Get('state')
    @ApiOperation({ summary: 'Get the current user’s onboarding wizard state' })
    @ApiResponse({ status: 200, type: OnboardingStateResponseDto })
    async getState(@CurrentUser() auth: AuthenticatedUser): Promise<OnboardingStateResponseDto> {
        return this.stateService.getState(auth.userId);
    }

    @Patch('state')
    @ApiOperation({ summary: 'Partially update the onboarding wizard state' })
    @ApiResponse({ status: 200, type: OnboardingStateResponseDto })
    async patchState(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: OnboardingStatePatchBodyDto,
    ): Promise<OnboardingStateResponseDto> {
        return this.stateService.patchState(auth.userId, body);
    }

    @Post('complete')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Mark the onboarding wizard completed (idempotent)' })
    @ApiResponse({ status: 200, type: OnboardingStateResponseDto })
    async markCompleted(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<OnboardingStateResponseDto> {
        return this.stateService.markCompleted(auth.userId);
    }

    @Post('dismiss')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Mark the onboarding wizard dismissed (idempotent)' })
    @ApiResponse({ status: 200, type: OnboardingStateResponseDto })
    async markDismissed(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<OnboardingStateResponseDto> {
        return this.stateService.markDismissed(auth.userId);
    }
}
