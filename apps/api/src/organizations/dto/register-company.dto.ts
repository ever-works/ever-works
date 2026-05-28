import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * EW-662 (Tenants & Organizations Phase 10) — body for
 * `POST /api/organizations/register-company`.
 *
 * Mirrors the chip-driven Register-Company form on `+ New` (the
 * "Company" chip). All fields except `name` are optional; the
 * Stripe-Atlas integration is deferred to a later phase, so v1
 * lands the Org with `registrationProvider = 'manual'` and
 * `registrationStatus = 'registered'` regardless of what the
 * client passes (the service hard-codes those, this DTO only
 * captures the user-supplied bits).
 */
export class RegisterCompanyDto {
    @ApiProperty({
        description: 'Display name for the Company. 1-200 chars.',
        example: 'Acme Inc.',
        minLength: 1,
        maxLength: 200,
    })
    @IsString()
    @Length(1, 200)
    name!: string;

    @ApiPropertyOptional({
        description: 'Registered legal name (defaults to `name` if omitted).',
        example: 'Acme, Inc.',
        maxLength: 200,
    })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    legalName?: string;

    @ApiPropertyOptional({
        description:
            'ISO 3166-1 alpha-2 country code (e.g. "US", "DE"). Used by the registration provider to pick the right entity-formation pipeline.',
        example: 'US',
        minLength: 2,
        maxLength: 2,
    })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z]{2}$/, {
        message: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code',
    })
    countryCode?: string;

    @ApiPropertyOptional({
        description:
            'Optional slug override. If omitted, allocated from `name` via UsernameAllocatorService.',
        example: 'acme',
        minLength: 1,
        maxLength: 64,
    })
    @IsOptional()
    @IsString()
    @Length(1, 64)
    slug?: string;
}
