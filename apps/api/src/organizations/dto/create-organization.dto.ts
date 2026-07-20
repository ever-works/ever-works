import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * EW-658 — body for `POST /api/organizations`. Mirrors
 * `CreateOrganizationRequest` from `@ever-works/contracts/api`.
 */
export class CreateOrganizationDto {
    @ApiProperty({
        description: 'Display name for the Organization. 1-200 chars.',
        example: 'Acme Inc.',
        minLength: 1,
        maxLength: 200,
    })
    @IsString()
    @Length(1, 200)
    name!: string;

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

    @ApiPropertyOptional({
        description:
            'PR-6 (review §23.5) — optional company vision statement. Trimmed and capped at 5000 chars; empty/whitespace-only is stored as NULL. When set, `visionUpdatedAt` is stamped.',
        maxLength: 5000,
    })
    // Nullable column — `@IsOptional()` lets an explicit null through
    // (treated the same as omitted at create time: stored as NULL).
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    vision?: string | null;
}
