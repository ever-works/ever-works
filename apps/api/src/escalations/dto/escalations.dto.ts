import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    AGENT_ESCALATION_MAX_DECISION_CHARS,
    AGENT_ESCALATION_STATUSES,
    type AgentEscalationStatus,
} from '@ever-works/contracts';

/**
 * Query for `GET /api/escalations`.
 *
 * There is deliberately no `userId` parameter: an escalation queue is a
 * per-person work list, so "list for user X" would be a ready-made
 * cross-tenant activity oracle. The controller always reads
 * `auth.userId` — same posture as `GET /api/digest`.
 */
export class ListEscalationsQueryDto {
    @ApiPropertyOptional({
        description:
            'Narrow to one status. Omit for every escalation, resolved ones included (the queue needs its own history).',
        enum: AGENT_ESCALATION_STATUSES as unknown as string[],
    })
    @IsOptional()
    @IsIn(AGENT_ESCALATION_STATUSES as unknown as string[])
    status?: AgentEscalationStatus;

    @ApiPropertyOptional({ description: 'Max rows (1..100). Defaults to 50.', default: 50 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;

    @ApiPropertyOptional({ description: 'Rows to skip (pagination).', default: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/** Body for `POST /api/escalations/:id/resolve`. */
export class ResolveEscalationBodyDto {
    @ApiPropertyOptional({ description: 'What was decided. Stored on the escalation.' })
    @IsOptional()
    @IsString()
    @MaxLength(AGENT_ESCALATION_MAX_DECISION_CHARS)
    note?: string;
}
