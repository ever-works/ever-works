import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
    FLEET_PULL_REQUEST_BODY_MAX_LENGTH,
    FLEET_PULL_REQUEST_TITLE_MAX_LENGTH,
    FLEET_SESSION_ACTION_IDS,
    FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH,
    type FleetSessionActionId,
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

/** `POST /api/fleet/sessions/:id/actions` (FL-06 spec FR-14). */
export class SendFleetSessionActionDto {
    @ApiProperty({ enum: FLEET_SESSION_ACTION_IDS })
    @IsIn(FLEET_SESSION_ACTION_IDS as unknown as string[])
    actionId!: FleetSessionActionId;

    @ApiProperty({ description: 'The prompt as shown and edited (the rendered template when unchanged).' })
    @IsString()
    @MinLength(1)
    @MaxLength(FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH)
    prompt!: string;
}

/** `POST /api/fleet/sessions/:id/actions/:ledgerId/resend` (FL-06 spec FR-24). */
export class ResendFleetSessionActionDto {
    @ApiProperty({ required: false, description: 'The prompt the sheet still holds; the template rendered afresh when absent.' })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH)
    prompt?: string;
}

/** `POST /api/fleet/checkouts/:id/pull-request` (FL-06 spec FR-16 … FR-18). */
export class OpenFleetPullRequestDto {
    @ApiProperty({ description: `At most ${FLEET_PULL_REQUEST_TITLE_MAX_LENGTH} characters.` })
    @IsString()
    @MinLength(1)
    @MaxLength(FLEET_PULL_REQUEST_TITLE_MAX_LENGTH)
    title!: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_PULL_REQUEST_BODY_MAX_LENGTH)
    body?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    draft?: boolean;

    @ApiProperty({ required: false, format: 'uuid', description: 'The session asking (its ledger is credited).' })
    @IsOptional()
    @IsUUID()
    sessionId?: string;
}

/** `PUT /api/fleet/agents/:agentId/action-templates` (FL-06 spec FR-27). */
export class UpdateFleetAgentActionTemplatesDto {
    @ApiProperty({ required: false, nullable: true, description: 'The branch prefix; empty or null for the default (the Agent’s slug).' })
    @IsOptional()
    @IsString()
    @MaxLength(30)
    branchPrefix?: string | null;

    @ApiProperty({
        required: false,
        description: 'Templates by action id; an empty text falls back to the platform default.',
        type: Object,
        additionalProperties: { type: 'string' },
    })
    @IsOptional()
    actions?: Partial<Record<FleetSessionActionId, string | null>>;

    @ApiProperty({ required: false, description: 'The agent files’ etag the editor last saw.' })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    expectedHash?: string;
}
