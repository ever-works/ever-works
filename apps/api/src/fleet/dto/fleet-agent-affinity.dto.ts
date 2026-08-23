import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SetFleetAgentAffinityDto {
    @ApiProperty({
        format: 'uuid',
        description: 'User-owned Fleet node selected for this Organization Agent.',
    })
    @IsUUID()
    nodeId: string;
}
