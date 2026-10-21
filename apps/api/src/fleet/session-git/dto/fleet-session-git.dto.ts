import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import {
    FLEET_CHANGES_MAX_BYTES,
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    FLEET_SESSION_TITLE_MAX_LENGTH,
} from '@ever-works/contracts';

/** `GET /api/fleet/sessions/branch-proposal` (FL-06 plan §5). */
export class FleetSessionBranchProposalQueryDto {
    @ApiProperty({ format: 'uuid', description: 'The computer the session starts on.' })
    @IsUUID()
    nodeId!: string;

    @ApiProperty({ format: 'uuid', description: 'The checkout the new worktree is made of.' })
    @IsUUID()
    checkoutId!: string;

    @ApiProperty({ required: false, format: 'uuid', description: 'An Agent session: the prefix is the Agent’s slug.' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiProperty({ required: false, description: 'The first message (the slug comes from it).' })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH)
    firstMessage?: string;

    @ApiProperty({ required: false, description: 'The session title (the slug when there is no first message).' })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SESSION_TITLE_MAX_LENGTH)
    title?: string;

    @ApiProperty({ required: false, format: 'uuid', description: 'A session from a Task keeps the Task’s branch.' })
    @IsOptional()
    @IsUUID()
    taskId?: string;
}

/** `GET /api/fleet/checkouts/:id/changes` (FL-06 spec FR-9). */
export class FleetCheckoutChangesQueryDto {
    @ApiProperty({ required: false, description: 'At most this many bytes of patch text (4 KiB … 1 MiB).' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(4096)
    @Max(FLEET_CHANGES_MAX_BYTES)
    maxBytes?: number;
}
