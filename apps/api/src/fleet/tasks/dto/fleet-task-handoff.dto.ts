import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Tasks on computers (FL-15, plan §5) — the query of
 * `GET /api/fleet/tasks/:taskId/handoff-options`. The start itself is FL-04's
 * `POST /api/fleet/nodes/:id/sessions` with `taskId` (its DTO carries it).
 */
export class FleetTaskHandoffOptionsQueryDto {
    @ApiProperty({
        required: false,
        format: 'uuid',
        description:
            'The Agent to judge the computers for (one of the candidates); the first candidate when absent.',
    })
    @IsOptional()
    @IsUUID()
    agentId?: string;
}
