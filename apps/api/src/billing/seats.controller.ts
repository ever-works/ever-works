import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Post,
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
    SeatsBelowUsageError,
    SeatsNotPurchasableError,
    SeatsService,
    type SeatsView,
} from '@ever-works/agent/subscriptions';
import { UpdateSeatsDto } from './dto/seats.dto';

/**
 * Seats (billing spec §3.6 / FR-31) — owner-scoped, session-guarded.
 *
 * `GET  /api/billing/seats` — allowance, what is using it (members vs
 *                             agents), what is left, and the per-seat price.
 * `POST /api/billing/seats` — set the TOTAL seats wanted; the server bills
 *                             the extras from the stored plan row.
 *
 * Both resolve the billing owner from the AUTHENTICATED user, so a member
 * cannot access another tenant by guessing an id. Reads are tenant-visible;
 * only the billing owner may change the provider subscription.
 */
@ApiTags('Billing')
@ApiBearerAuth('JWT-auth')
@Controller('api/billing/seats')
@UseGuards(AuthSessionGuard)
export class SeatsController {
    constructor(private readonly seatsService: SeatsService) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Seat allowance and usage',
        description:
            'Seats included by the plan, additional seats bought, how many are in use (members and ' +
            'agents counted separately), how many are left, and the per-additional-seat price.',
    })
    @ApiResponse({ status: 200, description: 'Seat allowance and usage' })
    async getSeats(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<{ status: string } & SeatsView> {
        const owner = await this.seatsService.resolveBillingOwner(auth.userId);
        const seats = await this.seatsService.getSeats(owner);
        return { status: 'success', ...seats };
    }

    @Post()
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Set total seats',
        description:
            'Sets the TOTAL number of seats the account wants. The server bills the difference above ' +
            "the plan's included allowance (prorated by the provider) and refuses to drop the " +
            'allowance below the seats already in use.',
    })
    @ApiResponse({ status: 200, description: 'Updated seat allowance and usage' })
    @ApiResponse({ status: 400, description: 'Fewer seats than are already in use' })
    @ApiResponse({ status: 409, description: 'No manageable subscription / plan sells no seats' })
    @ApiResponse({ status: 503, description: 'Payment provider not configured' })
    async setSeats(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdateSeatsDto,
    ): Promise<{ status: string } & SeatsView> {
        try {
            const owner = await this.seatsService.resolveBillingOwner(auth.userId);
            if (owner !== auth.userId) {
                throw new ForbiddenException(
                    'Only the billing owner can change the subscription seat quantity',
                );
            }
            const seats = await this.seatsService.setSeats(owner, body.seats);
            return { status: 'success', ...seats };
        } catch (error) {
            throw mapSeatsError(error);
        }
    }
}

/** Stable-named domain errors → HTTP statuses (never an unmapped 500). */
function mapSeatsError(error: unknown): unknown {
    if (error instanceof BillingProviderNotConfiguredError) {
        return new ServiceUnavailableException((error as Error).message);
    }
    if (error instanceof SeatsBelowUsageError) {
        return new BadRequestException((error as Error).message);
    }
    if (error instanceof SeatsNotPurchasableError) {
        return new ConflictException((error as Error).message);
    }
    if (error instanceof BillingProviderError) {
        return new ConflictException((error as Error).message);
    }
    return error;
}
