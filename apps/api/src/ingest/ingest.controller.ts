import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    ParseUUIDPipe,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { EventIngestService, IngestedEventRepository } from '@ever-works/agent/ingest';
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
    constructor(
        private readonly eventIngestService: EventIngestService,
        private readonly events: IngestedEventRepository,
    ) {}

    /**
     * Owner-scoped recent ingested events, newest first.
     *
     * `workId` narrows to a single Work — this is the query the per-Work
     * Activities feed reads. The owner scope is applied first and
     * unconditionally, so passing a Work the caller does not own returns
     * an empty page rather than someone else's events.
     */
    @Get('events')
    @ApiOperation({
        summary: 'List my recent ingested external events (optionally filtered by Work / source).',
    })
    @HttpCode(HttpStatus.OK)
    async listEvents(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('workId', new ParseUUIDPipe({ optional: true })) workId?: string,
        @Query('source') source?: string,
        @Query('limit') limit?: string,
    ) {
        const rows = await this.events.findRecentByUser(auth.userId, {
            limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 20)) : 20,
            ...(workId ? { workId } : {}),
            ...(source ? { source } : {}),
        });
        return {
            data: rows.map((row) => ({
                id: row.id,
                source: row.source,
                kind: row.kind,
                occurredAt: row.occurredAt,
                actorName: row.actorName ?? null,
                title: row.title ?? null,
                sourceUrl: row.sourceUrl ?? null,
                workId: row.workId ?? null,
                processed: !!row.processedAt,
            })),
        };
    }

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
