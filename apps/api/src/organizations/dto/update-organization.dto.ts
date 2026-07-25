import {
    IsOptional,
    IsString,
    Length,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
// Entity-free validation subpath on purpose — see the docstring on
// `@ever-works/agent/validation`. Importing the general `/dto` barrel here
// would pull the whole entity graph into every consumer of this DTO.
import { MergePolicyDto } from '@ever-works/agent/validation';

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

    @ApiPropertyOptional({
        description:
            'PR-6 (review §23.5) — company vision statement. Omit to leave unchanged; explicit null clears it. Any present value (including null) bumps `visionUpdatedAt` to now.',
        maxLength: 5000,
        nullable: true,
    })
    // `vision` maps to a NULLABLE column, so it keeps `@IsOptional()` —
    // an explicit null is a valid "clear this field" operation (same
    // posture as legalName / countryCode above).
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    vision?: string | null;

    @ApiPropertyOptional({
        description:
            'Merge-policy matrix (Wave 3, D4) — the organization-scoped slice. PARTIAL by design: a field ' +
            'omitted inside the object inherits from the Tenant, then the platform default. Pass `null` to ' +
            'clear the organization override entirely. Works and Agents under this organization can still ' +
            'override individual fields.',
        type: MergePolicyDto,
        nullable: true,
    })
    // Nullable column, so `@IsOptional()` is right: an explicit null is a
    // valid "clear this override" operation (same posture as vision above).
    @IsOptional()
    @ValidateNested()
    @Type(() => MergePolicyDto)
    mergePolicy?: MergePolicyDto | null;
}
