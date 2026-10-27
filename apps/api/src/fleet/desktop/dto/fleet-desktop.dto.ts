import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { COMPUTER_QUALITIES, type ComputerQuality } from '@ever-works/contracts';

/** A display id the contracts accept (`isFleetDisplayId`). */
const DISPLAY_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** `POST /api/fleet/nodes/:id/desktop/views` (FL-07 plan §5). */
export class OpenFleetDesktopViewDto {
    @ApiProperty({ required: false, enum: ['desktop'], description: 'The screen source; only `desktop` here.' })
    @IsOptional()
    @IsIn(['desktop'])
    source?: 'desktop';

    @ApiProperty({ required: false, maxLength: 64, description: 'The display to show (default: the primary).' })
    @IsOptional()
    @IsString()
    @Matches(DISPLAY_ID)
    displayId?: string;

    @ApiProperty({ required: false, enum: COMPUTER_QUALITIES, description: 'Sharp, Smooth or Steady (default Smooth).' })
    @IsOptional()
    @IsIn([...COMPUTER_QUALITIES])
    quality?: ComputerQuality;

    @ApiProperty({ required: false, format: 'uuid', description: 'The session this view sits beside (FL-04).' })
    @IsOptional()
    @IsUUID()
    fleetSessionId?: string;
}

/** `PATCH /api/fleet/nodes/:id/desktop/views/:viewId`: another display or quality. */
export class UpdateFleetDesktopViewDto {
    @ApiProperty({ required: false, maxLength: 64 })
    @IsOptional()
    @IsString()
    @Matches(DISPLAY_ID)
    displayId?: string;

    @ApiProperty({ required: false, enum: COMPUTER_QUALITIES })
    @IsOptional()
    @IsIn([...COMPUTER_QUALITIES])
    quality?: ComputerQuality;
}
