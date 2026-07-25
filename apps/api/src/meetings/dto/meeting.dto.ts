import { ApiProperty } from '@nestjs/swagger';
import {
    IsArray,
    IsDateString,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { MeetingSource } from '@ever-works/agent/meetings';
import { MEETING_TRANSCRIPT_MAX_CHARS } from '@ever-works/agent/meetings';

const MEETING_SOURCES: MeetingSource[] = ['zoom', 'google-meet', 'manual', 'import'];

/** One roster entry — provider rosters vary, so this stays minimal. */
export class MeetingParticipantDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name: string;

    @ApiProperty({ required: false, maxLength: 320 })
    @IsOptional()
    @IsString()
    @MaxLength(320)
    email?: string;
}

/**
 * Request body for `POST /api/meetings` (manual/import creation —
 * provider-synced meetings land through the connector processor).
 * Semantic rules (source membership, date parsing, title floor) are
 * re-validated in `MeetingsService.createForUser`, the single source
 * of truth the connector path reuses.
 */
export class CreateMeetingDto {
    @ApiProperty({ minLength: 1, maxLength: 500 })
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    title: string;

    @ApiProperty({ description: 'When the meeting started (ISO 8601).' })
    @IsDateString()
    startedAt: string;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsDateString()
    endedAt?: string;

    @ApiProperty({ required: false, enum: MEETING_SOURCES, default: 'manual' })
    @IsOptional()
    @IsIn(MEETING_SOURCES)
    source?: MeetingSource;

    @ApiProperty({
        required: false,
        maxLength: 200,
        description: 'Provider meeting id (dedupe key).',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    externalId?: string;

    @ApiProperty({
        required: false,
        description: 'Work to route the meeting to (org-wide when omitted).',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiProperty({ required: false, type: [MeetingParticipantDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => MeetingParticipantDto)
    participants?: MeetingParticipantDto[];

    @ApiProperty({
        required: false,
        maxLength: 2048,
        description: 'Recording / provider deep link.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    sourceUrl?: string;

    @ApiProperty({
        required: false,
        description:
            'Optional transcript captured at creation — runs the full transcript pipeline.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(MEETING_TRANSCRIPT_MAX_CHARS)
    transcriptText?: string;
}

/** Request body for `PATCH /api/meetings/:id` (partial update). */
export class UpdateMeetingDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 500 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    title?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsDateString()
    startedAt?: string;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsDateString()
    endedAt?: string;

    @ApiProperty({
        required: false,
        nullable: true,
        description: 'Re-route to a Work (null → org-wide).',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiProperty({ required: false, type: [MeetingParticipantDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => MeetingParticipantDto)
    participants?: MeetingParticipantDto[];

    @ApiProperty({ required: false, maxLength: 2048 })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    sourceUrl?: string;
}

/**
 * Request body for `POST /api/meetings/:id/transcript` — size-capped
 * at the service-level bound (the service defensively re-truncates).
 */
export class IngestTranscriptDto {
    @ApiProperty({
        minLength: 1,
        maxLength: MEETING_TRANSCRIPT_MAX_CHARS,
        description: 'The transcript text to attach (plain text).',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(MEETING_TRANSCRIPT_MAX_CHARS)
    transcriptText: string;
}
