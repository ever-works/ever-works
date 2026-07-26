import {
    ArrayMaxSize,
    ArrayNotEmpty,
    IsArray,
    IsIn,
    IsISO8601,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    Validate,
    ValidateNested,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    INGEST_EVENT_BATCH_MAX,
    INGEST_EVENT_PAYLOAD_MAX_BYTES,
    INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS,
    INGEST_WORK_HINT_LABEL_MAX_CHARS,
    type IngestedEventWorkHintKind,
} from '@ever-works/contracts';

/**
 * Every hint kind the platform resolver understands. Kept as a literal
 * tuple (rather than derived at runtime) so `IsIn` rejects an unknown
 * kind at the edge, and `satisfies` makes adding a kind to the contract
 * without teaching this DTO a compile error.
 */
const WORK_HINT_KINDS = [
    'repo',
    'chat-channel',
    'tracker-team',
    'doc-database',
    'meeting',
] as const satisfies readonly IngestedEventWorkHintKind[];

/**
 * Event-ingest spine (Wave 6) — request shape for
 * `POST /api/ingest/events`. Mirrors `IngestedEventEnvelope`
 * (`@ever-works/contracts`) with the two hard edge caps:
 * ≤ {@link INGEST_EVENT_BATCH_MAX} envelopes per call, and each
 * `payload` ≤ {@link INGEST_EVENT_PAYLOAD_MAX_BYTES} bytes serialized
 * (same constraint style as the activity-log ingest metadata cap).
 */
@ValidatorConstraint({ name: 'payloadByteCap', async: false })
class PayloadByteCapConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (value === undefined || value === null) return false;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        try {
            const serialized = JSON.stringify(value);
            return Buffer.byteLength(serialized, 'utf8') <= INGEST_EVENT_PAYLOAD_MAX_BYTES;
        } catch {
            return false;
        }
    }

    defaultMessage(): string {
        return `payload must serialise to <= ${INGEST_EVENT_PAYLOAD_MAX_BYTES} bytes`;
    }
}

export class IngestedEventActorDto {
    @ApiProperty({ description: 'Display name as the source reports it', maxLength: 200 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    name: string;

    @ApiPropertyOptional({ description: 'Stable id in the source system', maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    externalId?: string;
}

export class IngestedEventSubjectDto {
    @ApiProperty({ description: 'Source-namespaced subject type (channel, page, issue, …)' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    type: string;

    @ApiProperty({ description: 'Stable id of the subject in the source system', maxLength: 200 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    externalId: string;

    @ApiPropertyOptional({ description: 'Human-readable subject title', maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    title?: string;
}

export class IngestedEventWorkHintDto {
    @ApiProperty({
        description: 'External container kind the platform resolves to a Work',
        enum: WORK_HINT_KINDS,
    })
    @IsIn(WORK_HINT_KINDS)
    kind: IngestedEventWorkHintKind;

    @ApiProperty({
        description:
            'Stable id of the container in the source system (owner/repo, channel id, team key, database id, meeting id)',
        maxLength: INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS)
    externalId: string;

    @ApiPropertyOptional({
        description: 'Human-readable label — diagnostics only, never matched on',
        maxLength: INGEST_WORK_HINT_LABEL_MAX_CHARS,
    })
    @IsOptional()
    @IsString()
    @MaxLength(INGEST_WORK_HINT_LABEL_MAX_CHARS)
    label?: string;
}

export class IngestedEventEnvelopeDto {
    @ApiProperty({ description: 'Connector-assigned envelope id (uuid recommended)' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    id: string;

    @ApiProperty({ description: 'Producing plugin id' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    source: string;

    @ApiProperty({
        description:
            'Stable event id in the source system. (source, sourceEventId) is the dedupe identity — retries are no-ops.',
        maxLength: 200,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    sourceEventId: string;

    @ApiProperty({ description: 'Source-namespaced event kind, e.g. slack.message' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    kind: string;

    @ApiProperty({ description: 'ISO 8601 timestamp of when the event happened at the source' })
    @IsISO8601()
    occurredAt: string;

    @ApiPropertyOptional({ type: IngestedEventActorDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IngestedEventActorDto)
    actor?: IngestedEventActorDto;

    @ApiPropertyOptional({ type: IngestedEventSubjectDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IngestedEventSubjectDto)
    subject?: IngestedEventSubjectDto;

    @ApiPropertyOptional({
        description: 'Deep link back to the original message / PR / page / commit',
        maxLength: 2048,
    })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    sourceUrl?: string;

    @ApiProperty({
        description: `Source-specific details. Capped at ${INGEST_EVENT_PAYLOAD_MAX_BYTES} bytes after JSON serialisation.`,
    })
    @IsObject()
    @Validate(PayloadByteCapConstraint)
    payload: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Work routing hint resolved by the connector' })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({
        type: IngestedEventWorkHintDto,
        description:
            'External container this event belongs to. Resolved to a workId within the ingesting user’s own Works; unresolvable hints leave the event user-scoped. Ignored when workId is set.',
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => IngestedEventWorkHintDto)
    workHint?: IngestedEventWorkHintDto;

    @ApiPropertyOptional({ description: 'Organization scope hint' })
    @IsOptional()
    @IsUUID()
    organizationId?: string;
}

export class IngestEventsDto {
    @ApiProperty({
        type: [IngestedEventEnvelopeDto],
        description: `Normalized envelopes to ingest (1..${INGEST_EVENT_BATCH_MAX} per call).`,
    })
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(INGEST_EVENT_BATCH_MAX)
    @ValidateNested({ each: true })
    @Type(() => IngestedEventEnvelopeDto)
    events: IngestedEventEnvelopeDto[];
}
