import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { FLEET_PORT_OPEN_TARGETS, type FleetPortOpenTarget } from '@ever-works/contracts';

/** `GET /api/fleet/nodes/:id/ports?watch=4000,4001` — ports to watch for ("Open a port…"). */
export class ListFleetPortsQueryDto {
    @ApiPropertyOptional({
        description: 'Comma-separated ports to report as waiting until something listens on them (at most 8).',
        example: '4000,4001',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    watch?: string;
}

/** `POST /api/fleet/nodes/:id/ports/:port/open`. */
export class OpenFleetPortDto {
    @ApiPropertyOptional({
        enum: FLEET_PORT_OPEN_TARGETS,
        description:
            "Where to open it: the machine's desktop, or its preview browser. Default: the desktop when available, else the preview browser (R-3).",
    })
    @IsOptional()
    @IsIn(FLEET_PORT_OPEN_TARGETS as unknown as string[])
    target?: FleetPortOpenTarget;

    @ApiPropertyOptional({ enum: ['http', 'https'], description: '`https` when the list showed the https badge.' })
    @IsOptional()
    @IsIn(['http', 'https'])
    scheme?: 'http' | 'https';
}
