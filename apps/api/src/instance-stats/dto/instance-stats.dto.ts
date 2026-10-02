import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Body of `PUT /api/instance-stats/toggle` — the operator switch in Settings. */
export class InstanceStatsToggleDto {
    @ApiProperty({ description: 'Whether this installation sends anonymous usage statistics.' })
    @IsBoolean()
    enabled!: boolean;
}
