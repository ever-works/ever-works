import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Put,
    ServiceUnavailableException,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthSessionGuard, CurrentUser } from '@src/auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    BillingProviderError,
    BillingProviderNotConfiguredError,
    PaygCapOutOfRangeError,
    PaygPaymentMethodRequiredError,
    PaygService,
    type PaygStateView,
} from '@ever-works/agent/subscriptions';
import { UpdatePaygDto } from './dto/payg.dto';

/**
 * Pay-as-you-go (billing spec §3.5 / FR-31) — owner-scoped, session-guarded.
 *
 * `GET /api/billing/payg`  — current state (on/off, cap, this cycle's usage
 *                            + estimate, period, tiers).
 * `PUT /api/billing/payg`  — `{ enabled, monthlyCapCredits? }`. Enabling
 *                            requires a stored payment method (409
 *                            otherwise); the cap is validated server-side
 *                            against the catalog/deployment bounds (400).
 *
 * The body carries no price and no amount: what a credit costs under
 * pay-as-you-go is the catalog's metered price, resolved by lookup key on
 * the server. Provider-not-configured degrades to 503 like every other
 * money route, which is what lets the Billing page render the feature as
 * unavailable rather than as a toggle that always errors.
 */
@ApiTags('Billing')
@ApiBearerAuth('JWT-auth')
@Controller('api/billing/payg')
@UseGuards(AuthSessionGuard)
export class PaygController {
    constructor(private readonly paygService: PaygService) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Pay-as-you-go state',
        description:
            'Whether pay-as-you-go is available/enabled for the authenticated user, the monthly cap, ' +
            'usage and estimated charge for the current cycle, and the graduated per-credit tiers.',
    })
    @ApiResponse({ status: 200, description: 'Pay-as-you-go state' })
    async getState(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<{ status: string } & PaygStateView> {
        const state = await this.paygService.getState(auth.userId);
        return { status: 'success', ...state };
    }

    @Put()
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Enable, disable or re-cap pay-as-you-go',
        description:
            'Turns pay-as-you-go on (creating the metered usage subscription at the provider; requires a ' +
            'stored payment method), off (cancelling it immediately and invoicing accrued usage), or ' +
            'updates the monthly cap in credits. The body never carries a price.',
    })
    @ApiResponse({ status: 200, description: 'Updated pay-as-you-go state' })
    @ApiResponse({ status: 400, description: 'Cap out of range' })
    @ApiResponse({ status: 409, description: 'No stored payment method / provider refused' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdatePaygDto,
    ): Promise<{ status: string } & PaygStateView> {
        if (body.enabled === undefined && body.monthlyCapCredits === undefined) {
            throw new BadRequestException('Specify enabled or monthlyCapCredits');
        }
        if (body.enabled === false && body.monthlyCapCredits !== undefined) {
            throw new BadRequestException('monthlyCapCredits cannot be changed while disabling');
        }
        try {
            let state: PaygStateView;
            if (body.enabled) {
                state = await this.paygService.enable(auth.userId, {
                    monthlyCapCredits: body.monthlyCapCredits ?? null,
                });
            } else if (body.monthlyCapCredits !== undefined && body.enabled === undefined) {
                state = await this.paygService.updateCap(auth.userId, body.monthlyCapCredits);
            } else {
                state = await this.paygService.disable(auth.userId);
            }
            return { status: 'success', ...state };
        } catch (error) {
            throw mapPaygError(error);
        }
    }
}

/** Stable-named domain errors → HTTP statuses (billing PRD §6: never an unmapped 500). */
function mapPaygError(error: unknown): unknown {
    if (error instanceof BillingProviderNotConfiguredError) {
        return new ServiceUnavailableException(error.message);
    }
    if (error instanceof PaygCapOutOfRangeError) {
        return new BadRequestException(error.message);
    }
    if (error instanceof PaygPaymentMethodRequiredError) {
        return new ConflictException(error.message);
    }
    if (error instanceof BillingProviderError) {
        return new ConflictException(error.message);
    }
    return error;
}
