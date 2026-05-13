import {
    IsEnum,
    IsISO8601,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ActivityActionType } from '@ever-works/agent/entities';

const WEBSITE_ACTION_TYPES = [
    ActivityActionType.WEBSITE_USER_REGISTERED,
    ActivityActionType.WEBSITE_ITEM_SUBMITTED,
    ActivityActionType.WEBSITE_REPORT_FILED,
    ActivityActionType.WEBSITE_REPORT_RESOLVED,
] as const;

type WebsiteActionType = (typeof WEBSITE_ACTION_TYPES)[number];

export class IngestEventDto {
    @ApiProperty({ description: 'Work ID this event belongs to' })
    @IsUUID()
    @IsNotEmpty()
    workId: string;

    @ApiProperty({
        description:
            'Client-generated UUID used for idempotency. Retries of the same eventId for the same workId return the existing row.',
    })
    @IsUUID()
    @IsNotEmpty()
    eventId: string;

    @ApiProperty({
        description: 'Event kind. Only WEBSITE_* action types are accepted by the ingest endpoint.',
        enum: WEBSITE_ACTION_TYPES,
    })
    @IsEnum(WEBSITE_ACTION_TYPES, {
        message: `actionType must be one of ${WEBSITE_ACTION_TYPES.join(', ')}`,
    })
    actionType: WebsiteActionType;

    @ApiProperty({ description: 'ISO 8601 timestamp from the deployed site when the event occurred' })
    @IsISO8601()
    occurredAt: string;

    @ApiProperty({ description: 'Human-readable one-line summary shown in the feed', maxLength: 500 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    summary: string;

    @ApiPropertyOptional({
        description: 'Free-form metadata (actor name, target id, admin URL, etc.)',
    })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;
}
