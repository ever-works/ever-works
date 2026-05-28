import { IsOptional, IsString, Length } from 'class-validator';
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
}
