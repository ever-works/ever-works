import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    ArrayUnique,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    COMPUTER_CHANNELS,
    COMPUTER_CLOSE_REASONS,
    COMPUTER_CONTROL_DECISIONS,
    COMPUTER_QUALITIES,
    type ComputerChannel,
    type ComputerCloseReason,
    type ComputerControlDecision,
    type ComputerQuality,
} from '@ever-works/contracts';
import { FleetJobNodeCredentialDto } from '../../fleet/dto/fleet-job.dto';

/** `POST /api/agents/:id/computer/sessions` — open a live view. */
export class OpenComputerSessionDto {
    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'The machine to watch. Defaults to the Agent’s pinned machine.',
    })
    @IsOptional()
    @IsUUID()
    nodeId?: string;

    @ApiProperty({ required: false, enum: COMPUTER_CHANNELS, isArray: true })
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(COMPUTER_CHANNELS.length)
    @ArrayUnique()
    @IsIn(COMPUTER_CHANNELS, { each: true })
    channels?: ComputerChannel[];

    @ApiProperty({ required: false, enum: COMPUTER_QUALITIES })
    @IsOptional()
    @IsIn(COMPUTER_QUALITIES)
    quality?: ComputerQuality;
}

/** `PATCH /api/agents/:id/computer/sessions/:sessionId`. */
export class UpdateComputerSessionDto {
    @ApiProperty({ required: false, enum: COMPUTER_QUALITIES })
    @IsOptional()
    @IsIn(COMPUTER_QUALITIES)
    quality?: ComputerQuality;

    @ApiProperty({ required: false, enum: COMPUTER_CHANNELS })
    @IsOptional()
    @IsIn(COMPUTER_CHANNELS)
    activeChannel?: ComputerChannel;
}

/** `POST /api/agents/:id/computer/sessions/:sessionId/control` — take control, or ask for it. */
export class ComputerControlDto {
    @ApiProperty({
        required: false,
        description: 'Ask whoever holds control to hand it over, instead of taking a free machine.',
    })
    @IsOptional()
    @IsBoolean()
    request?: boolean;
}

/** `POST /api/agents/:id/computer/sessions/:sessionId/control/handover` — the holder answers. */
export class AnswerComputerControlRequestDto {
    @ApiProperty({ format: 'uuid', description: 'The request being answered.' })
    @IsUUID()
    requestId: string;

    @ApiProperty({ enum: COMPUTER_CONTROL_DECISIONS })
    @IsIn(COMPUTER_CONTROL_DECISIONS)
    decision: ComputerControlDecision;
}

/** `POST /api/agents/:id/computer/profile/reset`. */
export class ResetNodeAgentProfileDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    nodeId: string;

    @ApiProperty({ description: 'The Agent’s name, typed to confirm.', maxLength: 200 })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    confirmAgentName: string;
}

/** Largest number of frames (pictures plus stats, banners and the end frame) one publish may carry. */
export const COMPUTER_PUBLISH_MAX_ITEMS = 32;

/** `POST /api/internal/computer/:sessionId/frames` — the machine publishes what it captured. */
export class PublishComputerFramesDto extends FleetJobNodeCredentialDto {
    @ApiProperty({ type: 'array', maxItems: COMPUTER_PUBLISH_MAX_ITEMS, items: { type: 'object' } })
    @IsArray()
    frames: unknown[];
}

/** `POST /api/internal/computer/:sessionId/heartbeat` — the machine's lifecycle report. */
export class ComputerSessionHeartbeatDto extends FleetJobNodeCredentialDto {
    @ApiProperty({ required: false, enum: ['live', 'stalled', 'ended'] })
    @IsOptional()
    @IsIn(['live', 'stalled', 'ended'])
    status?: 'live' | 'stalled' | 'ended';

    @ApiProperty({ required: false, enum: COMPUTER_CLOSE_REASONS })
    @IsOptional()
    @IsIn(COMPUTER_CLOSE_REASONS)
    closeReason?: ComputerCloseReason;
}

/** `POST /api/internal/computer/:sessionId/profile` — the machine's report of the Agent's profile. */
export class ComputerProfileReportDto extends FleetJobNodeCredentialDto {
    @ApiProperty({ maxLength: 64 })
    @IsString()
    @Matches(/^[0-9a-f]{16,64}$/)
    profileKey: string;

    @ApiProperty({ minimum: 0 })
    @IsInt()
    @Min(0)
    signedInSiteCount: number;

    @ApiProperty({ minimum: 0 })
    @IsInt()
    @Min(0)
    diskBytes: number;
}
