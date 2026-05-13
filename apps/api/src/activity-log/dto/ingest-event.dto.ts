import {
    IsEnum,
    IsISO8601,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    Validate,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ActivityActionType } from '@ever-works/agent/entities';

const METADATA_BYTE_CAP = 8 * 1024;

@ValidatorConstraint({ name: 'metadataByteCap', async: false })
class MetadataByteCapConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (value === undefined || value === null) return true;
        if (typeof value !== 'object') return false;
        try {
            const serialized = JSON.stringify(value);
            return Buffer.byteLength(serialized, 'utf8') <= METADATA_BYTE_CAP;
        } catch {
            return false;
        }
    }

    defaultMessage(): string {
        return `metadata must serialise to <= ${METADATA_BYTE_CAP} bytes`;
    }
}

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

    @ApiProperty({
        description: 'ISO 8601 timestamp from the deployed site when the event occurred',
    })
    @IsISO8601()
    occurredAt: string;

    @ApiProperty({
        description: 'Human-readable one-line summary shown in the feed',
        maxLength: 500,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    summary: string;

    @ApiPropertyOptional({
        description: `Free-form metadata (actor name, target id, admin URL, etc.). Capped at ${METADATA_BYTE_CAP} bytes after JSON serialisation.`,
    })
    @IsOptional()
    @IsObject()
    @Validate(MetadataByteCapConstraint)
    metadata?: Record<string, unknown>;
}
