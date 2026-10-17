import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * EW-P2-4 — body of `POST /api/works/projects`: a repo-less Project Work.
 * Only a name is required; nothing about repositories, templates or deploy
 * applies to the kind.
 */
export class CreateProjectWorkDto {
    @ApiProperty({ description: 'Project name.', maxLength: 100, example: 'Website relaunch' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    name: string;

    @ApiPropertyOptional({
        description:
            'Explicit slug for the Project Work. Derived from `name` (and de-duplicated) when omitted.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'Slug can only contain lowercase letters, numbers, and hyphens',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    slug?: string;

    @ApiPropertyOptional({ description: 'What the project is about.', maxLength: 2000 })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    description?: string;
}
