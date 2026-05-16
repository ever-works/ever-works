import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { ZeroFrictionFunnelService } from '@ever-works/agent/services';
import {
    ZERO_FRICTION_FUNNEL_EVENTS,
    type ZeroFrictionFunnelEvent,
    type ZeroFrictionFunnelPayload,
} from '@ever-works/contracts/telemetry';
import { FunnelEventDto } from './dto/funnel-event.dto';

/** Hard cap on the wire payload size — 4 KB is plenty for any single
 *  funnel event; anything larger is almost certainly abuse or a bug. */
const MAX_PAYLOAD_BYTES = 4 * 1024;

const ALLOWED_EVENT_NAMES = new Set<ZeroFrictionFunnelEvent>(
    Object.values(ZERO_FRICTION_FUNNEL_EVENTS),
);

/**
 * EW-617 G8 — public client-side telemetry sink.
 *
 * Mirror of the server-side `ZeroFrictionFunnelService.emit` surface for
 * events that originate in the browser (G1 landing prompt submit, the
 * eventual G3 claim CTA click etc). Public + throttled aggressively —
 * 60 requests / minute / IP is far above the legitimate funnel rate and
 * far below what would matter for log volume.
 *
 * CORS: relies on the global `ALLOWED_ORIGINS` env var (configured in
 * `apps/api/src/main.ts`). Production envs already set this to the
 * `ever.works` / `app.ever.works` / `appstage.ever.works` family.
 */
@ApiTags('Telemetry')
@Controller('api/telemetry')
export class TelemetryController {
    constructor(private readonly funnel: ZeroFrictionFunnelService) {}

    @Public()
    @Post('funnel')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Submit a zero-friction funnel event from the client',
        description:
            'Public endpoint used by client-side funnel emit sites (landing form, claim banner). The body must match one of the canonical funnel event shapes; unknown event names + oversized payloads are rejected with 400.',
    })
    @ApiResponse({ status: 204, description: 'Event accepted and forwarded to the funnel sink' })
    @ApiResponse({ status: 400, description: 'Invalid event name / oversized payload / bad shape' })
    async ingestFunnelEvent(
        @Body() dto: FunnelEventDto,
        @Req() req?: { rawBody?: string },
    ): Promise<void> {
        // Size guard. `rawBody` is captured by main.ts's body-parser verify
        // hook so we have the exact wire bytes. Even if the captured rawBody
        // is missing for some reason (e.g. a test posts pre-parsed JSON),
        // fall back to a JSON.stringify of the parsed DTO which is a close
        // upper bound on the original size.
        const rawSize =
            typeof req?.rawBody === 'string'
                ? Buffer.byteLength(req.rawBody, 'utf8')
                : Buffer.byteLength(JSON.stringify(dto ?? {}), 'utf8');
        if (rawSize > MAX_PAYLOAD_BYTES) {
            throw new BadRequestException('telemetry payload too large');
        }

        if (!ALLOWED_EVENT_NAMES.has(dto.event)) {
            // Belt-and-braces — the DTO `@IsIn` should already reject this,
            // but the guard makes the contract explicit at the controller
            // boundary too.
            throw new BadRequestException(`unknown telemetry event: ${dto.event}`);
        }

        // Merge envelope + optional per-event passthrough fields. The funnel
        // sink takes the discriminated union type; we cast through the
        // generic payload type since the runtime shape is validated above.
        const payload: ZeroFrictionFunnelPayload = {
            event: dto.event,
            funnelStep: dto.funnelStep,
            timestamp: dto.timestamp,
            correlationId: dto.correlationId,
            ...(dto.workId ? { workId: dto.workId } : {}),
            ...(dto.userId ? { userId: dto.userId } : {}),
            ...(dto.extra ?? {}),
        } as ZeroFrictionFunnelPayload;

        this.funnel.emit(payload);
    }
}
