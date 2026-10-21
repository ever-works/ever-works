import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

/**
 * Tasks on computers (FL-15 P2, plan §5) — the git identity routes' shapes.
 * The identity values themselves never come from the request: the platform
 * takes them from the person's own account (spec FR-14).
 */

/** Query of `GET /api/fleet/nodes/:id/git/identity`. */
export class FleetGitIdentityQueryDto {
    @ApiProperty({ required: false, enum: ['1'], description: '`1` reads the computer again instead of the 60 s copy.' })
    @IsOptional()
    @IsIn(['1'])
    fresh?: '1';
}

/** Body of `POST /api/fleet/nodes/:id/git/identity` (CONTRACTS §2.2 class `confirm`). */
export class SetFleetGitIdentityDto {
    @ApiProperty({
        required: false,
        description: 'Must be `true`: without it the call answers `confirmation_required` naming the computer.',
    })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}
