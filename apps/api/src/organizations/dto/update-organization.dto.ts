import { IsOptional, IsString, Length } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * EW-658 — body for `PATCH /api/organizations/:id`. Mirrors
 * `UpdateOrganizationRequest` from `@ever-works/contracts/api`. Every
 * field is optional; an empty body is a no-op.
 */
export class UpdateOrganizationDto {
    @ApiPropertyOptional({ description: 'Display name. 1-200 chars.', maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    displayName?: string;

    @ApiPropertyOptional({ description: 'Legal entity name (e.g. "Acme, Inc.").', maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    legalName?: string;

    @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2 country code.', maxLength: 2 })
    @IsOptional()
    @IsString()
    @Length(2, 2)
    countryCode?: string;
}
