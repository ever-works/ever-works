import { IsOptional, IsString, Length, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * EW-658 — body for `PATCH /api/organizations/:id`. Mirrors
 * `UpdateOrganizationRequest` from `@ever-works/contracts/api`. Every
 * field is optional; an empty body is a no-op.
 */
export class UpdateOrganizationDto {
    @ApiPropertyOptional({
        description: 'Display name. 1-200 chars. Required — cannot be set to null.',
        maxLength: 200,
    })
    // `displayName` maps to a NOT NULL column. `@IsOptional()` treats an
    // explicit `null` like an omitted field (skips validation), so the null
    // used to reach `repo.update()` and hit the DB constraint → unmapped 500.
    // `@ValidateIf(o => o.displayName !== undefined)` keeps "omitted = no-op"
    // but makes an explicit `null` fail `@IsString` → a clean 400. (legalName /
    // countryCode are NULLABLE columns, so they keep `@IsOptional()` — an
    // explicit null there is a valid "clear this field" operation.)
    @ValidateIf((o) => o.displayName !== undefined)
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
