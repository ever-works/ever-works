import {
    BadRequestException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { StripeRelayDeadLetterRepository } from '@ever-works/agent/database';
import { StripeRelayDeadLetterStatus } from '@ever-works/agent/entities';
import { IsPlatformAdminGuard } from '@src/auth/guards/platform-admin.guard';
import { StripeRelayDeadLetterNotFoundError, StripeRelayService } from './stripe-relay.service';

/** Stripe event ids are `evt_` followed by an alphanumeric token. */
const EVENT_ID = /^evt_[A-Za-z0-9]{1,250}$/;

const MAX_PAGE = 100;

/**
 * Operator tooling for the shared Stripe webhook relay's dead letters
 * (audit CC05-06). Platform admins only (`User.isPlatformAdmin`), behind the
 * global session guard.
 *
 *   GET  /api/admin/stripe-relay/dead-letters?status=open|resolved&limit=&offset=
 *   POST /api/admin/stripe-relay/dead-letters/:eventId/replay
 *   POST /api/admin/stripe-relay/dead-letters/:eventId/dismiss
 *
 * The listing never returns the stored payload (it holds what Stripe sent,
 * including customer contact details on invoice events). Replay routes that
 * stored payload exactly as the original delivery would have been routed, so
 * it is safe to repeat: the directory de-duplicates by Stripe event id.
 */
@ApiTags('Admin')
@Controller('api/admin/stripe-relay/dead-letters')
@UseGuards(IsPlatformAdminGuard)
export class StripeRelayAdminController {
    constructor(
        private readonly relayService: StripeRelayService,
        private readonly deadLetters: StripeRelayDeadLetterRepository,
    ) {}

    @Get()
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'List Stripe relay dead letters, newest failure first' })
    async list(
        @Query('status') status?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        let statusFilter: StripeRelayDeadLetterStatus | undefined;
        if (status !== undefined && status !== '' && status !== 'all') {
            if (
                status !== StripeRelayDeadLetterStatus.OPEN &&
                status !== StripeRelayDeadLetterStatus.RESOLVED
            ) {
                throw new BadRequestException('status must be open, resolved or all');
            }
            statusFilter = status;
        }
        const take = clampInt(limit, 25, 1, MAX_PAGE);
        const skip = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const [items, total] = await this.deadLetters.list({
            status: statusFilter,
            limit: take,
            offset: skip,
        });
        return { items, total, limit: take, offset: skip };
    }

    @Post(':eventId/replay')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Re-route one dead letter to its directory' })
    async replay(@Param('eventId') eventId: string) {
        assertEventId(eventId);
        try {
            return await this.relayService.replay(eventId);
        } catch (error) {
            if (error instanceof StripeRelayDeadLetterNotFoundError) {
                throw new NotFoundException('No dead letter for that event');
            }
            throw error;
        }
    }

    @Post(':eventId/dismiss')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Close one dead letter by hand (e.g. fulfilled manually)' })
    async dismiss(@Param('eventId') eventId: string) {
        assertEventId(eventId);
        try {
            return { eventId, dismissed: await this.relayService.dismiss(eventId) };
        } catch (error) {
            if (error instanceof StripeRelayDeadLetterNotFoundError) {
                throw new NotFoundException('No dead letter for that event');
            }
            throw error;
        }
    }
}

function assertEventId(eventId: string): void {
    if (!EVENT_ID.test(eventId)) {
        throw new BadRequestException('eventId must be a Stripe event id (evt_...)');
    }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value)) {
        throw new BadRequestException('limit and offset must be integers');
    }
    return Math.min(max, Math.max(min, value));
}
