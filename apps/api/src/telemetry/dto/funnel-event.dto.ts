import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsIn,
    IsInt,
    IsISO8601,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import {
    ZERO_FRICTION_FUNNEL_EVENTS,
    type ZeroFrictionFunnelEvent,
} from '@ever-works/contracts/telemetry';

const ALLOWED_EVENT_NAMES: readonly ZeroFrictionFunnelEvent[] = Object.values(
    ZERO_FRICTION_FUNNEL_EVENTS,
);

/**
 * EW-617 G8 — wire format for `POST /api/telemetry/funnel`.
 *
 * The endpoint accepts client-emitted funnel events (G1 landing page,
 * G3 claim banner, anything that runs purely in the browser). The shape
 * mirrors the union of `ZeroFrictionFunnelPayload` variants, but the DTO
 * validates only the cross-cutting envelope fields. Per-event extras
 * are forwarded as-is via the additional-fields-permitting `extra` map,
 * which is merged back onto the payload before it hits the funnel sink.
 *
 * Validation is intentionally strict on the envelope (event name in the
 * allowed set, correlationId roughly UUID-shaped, timestamp ISO-8601,
 * funnelStep 1..8) so spurious posts get a 400 instead of polluting the
 * downstream log/PostHog feeds.
 */
export class FunnelEventDto {
    @ApiProperty({
        description: 'One of the canonical zero-friction funnel event names.',
        enum: ALLOWED_EVENT_NAMES,
    })
    @IsString()
    @IsIn(ALLOWED_EVENT_NAMES as readonly string[])
    event: ZeroFrictionFunnelEvent;

    @ApiProperty({ description: 'Funnel step (1..8).', minimum: 1, maximum: 8 })
    @IsInt()
    @Min(1)
    @Max(8)
    funnelStep: number;

    @ApiProperty({ description: 'ISO 8601 timestamp the event was emitted.' })
    @IsISO8601()
    timestamp: string;

    @ApiProperty({
        description:
            'Funnel correlation id. UUID v4 in practice, but we accept any 8-64 char hex/uuid-ish string.',
    })
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
        message: 'correlationId must be 8-64 chars, alphanumeric/_-',
    })
    correlationId: string;

    @ApiPropertyOptional({
        description: 'Free-form per-event payload. Forwarded verbatim to the funnel sink.',
        type: Object,
    })
    @IsOptional()
    @IsObject()
    extra?: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'Optional pass-through for the event-specific `workId` field.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    workId?: string;

    @ApiPropertyOptional({
        description: 'Optional pass-through for the event-specific `userId` field.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    userId?: string;
}
