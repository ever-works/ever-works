import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { ROLE_OPTIONS } from '@ever-works/contracts/api';

/**
 * Bounds for the role list accepted by the seeding endpoints.
 *
 * There are only `ROLE_OPTIONS.length` distinct answers, so the array
 * cap is exactly that: a caller sending more is either confused or
 * probing, and neither deserves the work. Unknown ids are then DROPPED
 * by the resolver rather than rejected — the same posture the wizard
 * state uses — so an older client sending a retired id still gets a
 * useful answer instead of a 400.
 */
export const ONBOARDING_MAX_SEED_ROLES = ROLE_OPTIONS.length;

/** Longest role id the resolver will look at; ids are short kebab-case. */
export const ONBOARDING_MAX_ROLE_ID_LENGTH = 64;

/** Request body for `POST /api/onboarding/suggestions/seed`. */
export class OnboardingSeedRequestDto {
    @ApiProperty({
        required: false,
        type: [String],
        description:
            'Role ids to seed for. Omit to use the roles already saved on the caller’s onboarding state.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(ONBOARDING_MAX_SEED_ROLES)
    @IsString({ each: true })
    @MaxLength(ONBOARDING_MAX_ROLE_ID_LENGTH, { each: true })
    roles?: string[];
}
