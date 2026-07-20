import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Teams & Prebuilt Companies — `POST /api/organizations/import-company` (spec §6). */
export class ImportCompanyDto {
    @ApiProperty({ description: 'Company template slug from the ever-works/orgs catalog' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(64)
    @Matches(/^[a-z0-9][a-z0-9-]*$/, { message: 'templateSlug must be kebab-case' })
    templateSlug: string;

    @ApiPropertyOptional({ description: 'Organization display-name override', maxLength: 200 })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    name?: string;
}
