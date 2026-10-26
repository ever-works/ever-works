import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { FLEET_CLIP_MAX_BYTES } from '@ever-works/contracts';

/**
 * Paste into a desktop (FL-11 P2, plan §5) — request shapes. The view is the
 * live view (computer session) and the Agent whose computer it shows; the
 * service proves both belong to the caller and are still live, and measures
 * the text in UTF-8 bytes (256 KiB); this only keeps the request to the shape.
 */

const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class FleetClipViewQueryDto {
    @ApiProperty({ description: 'The live view (computer session) id.' })
    @IsString()
    @Matches(VIEW_ID)
    viewId!: string;

    @ApiProperty({ description: 'The Agent whose computer the view shows.' })
    @IsUUID()
    agentId!: string;
}

/** `PUT /api/fleet/nodes/:id/desktop/paste-switch`. */
export class FleetClipSwitchDto extends FleetClipViewQueryDto {
    @ApiProperty({
        description: 'Allow paste into this desktop (off by default; ends with the view).',
    })
    @IsBoolean()
    allowed!: boolean;
}

/** `POST /api/fleet/nodes/:id/desktop/paste`. */
export class FleetClipPasteDto extends FleetClipViewQueryDto {
    @ApiProperty({
        description: 'The text to paste where the focus is (UTF-8, at most 256 KB).',
        maxLength: FLEET_CLIP_MAX_BYTES,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(FLEET_CLIP_MAX_BYTES)
    text!: string;
}
