import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsEnum,
    IsInt,
    IsOptional,
    IsUUID,
    Max,
    Min,
} from 'class-validator';
import { AGENT_ACTION_PROPOSAL_STATUSES } from '@ever-works/agent/agent-approvals';

/**
 * Query params for `GET /api/agent-approvals`. Defaults to the PENDING
 * queue; `status` narrows to approved/rejected, `organizationId` to a
 * single Org's queue.
 */
export class ListAgentApprovalsQueryDto {
    @ApiProperty({ required: false, enum: AGENT_ACTION_PROPOSAL_STATUSES as unknown as string[] })
    @IsOptional()
    @IsEnum(AGENT_ACTION_PROPOSAL_STATUSES as unknown as Record<string, string>)
    status?: (typeof AGENT_ACTION_PROPOSAL_STATUSES)[number];

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    organizationId?: string;

    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * Body for `POST /api/agent-approvals/approve-all`. `ids` optionally
 * narrows the bulk approval to a subset of proposals; omitted means
 * "all my pending proposals".
 */
export class ApproveAllAgentApprovalsDto {
    @ApiProperty({ required: false, type: [String], format: 'uuid' })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(200)
    @IsUUID(undefined, { each: true })
    ids?: string[];
}
