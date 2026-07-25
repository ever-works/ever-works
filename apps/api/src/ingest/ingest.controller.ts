import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { EventIngestService } from '@ever-works/agent/ingest';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { IngestEventsDto } from './dto/ingest-events.dto';

/**
 * Event-ingest spine (Wave 6) — push surface for normalized external
 * events. Connectors and (later, per-connector) webhook handlers POST
 * `IngestedEventEnvelope` batches here; the pull model rides the
 * `event-ingest-tick` cron instead.
 *
 * Auth: current user — events land owner-scoped under the caller.
 * Dedupe: `(source, sourceEventId)` per owner, so retries are no-ops
 * (the response's `duplicates` count makes that visible).
 * Caps: ≤100 envelopes per call, ≤32 KB serialized payload each
 * (class-validator DTO, shared constants from `@ever-works/contracts`).
 */
@ApiTags('ingest')
@Controller('api/ingest')
export class IngestController {
    constructor(private readonly eventIngestService: EventIngestService) {}

    @Post('events')
    @ApiOperation({
        summary:
            'Ingest a batch of normalized external events (dedupe-insert; processing fans out asynchronously).',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async ingestEvents(@CurrentUser() auth: AuthenticatedUser, @Body() dto: IngestEventsDto) {
        return this.eventIngestService.ingest(auth.userId, dto.events);
    }
}
