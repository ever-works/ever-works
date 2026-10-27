import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import {
    COMPUTER_CONTROL_DECISIONS,
    COMPUTER_QUALITIES,
    type ComputerControlDecision,
    type ComputerQuality,
} from '@ever-works/contracts';

/** A display id the contracts accept (`isFleetDisplayId`). */
const DISPLAY_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** `POST /api/fleet/nodes/:id/desktop/views` (FL-07 plan §5). */
export class OpenFleetDesktopViewDto {
    @ApiProperty({
        required: false,
        enum: ['desktop'],
        description: 'The screen source; only `desktop` here.',
    })
    @IsOptional()
    @IsIn(['desktop'])
    source?: 'desktop';

    @ApiProperty({
        required: false,
        maxLength: 64,
        description: 'The display to show (default: the primary).',
    })
    @IsOptional()
    @IsString()
    @Matches(DISPLAY_ID)
    displayId?: string;

    @ApiProperty({
        required: false,
        enum: COMPUTER_QUALITIES,
        description: 'Sharp, Smooth or Steady (default Smooth).',
    })
    @IsOptional()
    @IsIn([...COMPUTER_QUALITIES])
    quality?: ComputerQuality;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'The session this view sits beside (FL-04).',
    })
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

/** `POST …/views/:viewId/control` (FL-07 P2): take control (`confirm: true`), or ask for it (`request: true`). */
export class FleetDesktopControlDto {
    @ApiProperty({
        required: false,
        description: 'Ask whoever holds control to hand it over, instead of taking it.',
    })
    @IsOptional()
    @IsBoolean()
    request?: boolean;

    @ApiProperty({
        required: false,
        description:
            'CONTRACTS §2.2 class `confirm`: without it a take answers 409 `confirmation_required`.',
    })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** `POST …/views/:viewId/control/handover`: the holding view answers a request. */
export class AnswerFleetDesktopControlDto {
    @ApiProperty({
        format: 'uuid',
        description: 'The requesting view (the request id the control state names).',
    })
    @IsUUID()
    requestId!: string;

    @ApiProperty({ enum: COMPUTER_CONTROL_DECISIONS })
    @IsIn([...COMPUTER_CONTROL_DECISIONS])
    decision!: ComputerControlDecision;
}

/** `DELETE …/desktop/recordings/:viewId` (FL-07 P2.C): CONTRACTS §2.2 class `confirm`. */
export class DeleteFleetDesktopRecordingDto {
    @ApiProperty({
        required: false,
        description: 'Without it the answer is 409 `confirmation_required`.',
    })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}
