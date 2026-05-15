import {
    IsBoolean,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUrl,
    MaxLength,
    Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { UpdateItemDto as IUpdateItemDto } from '@ever-works/contracts/api';

export class UpdateItemDto implements IUpdateItemDto {
    @ApiProperty({ description: 'Slug of the item to update' })
    @IsString()
    item_slug: string;

    @ApiPropertyOptional({ description: 'Whether the item is featured' })
    @IsOptional()
    @IsBoolean()
    featured?: boolean;

    @ApiPropertyOptional({ description: 'Source URL for the item' })
    @IsOptional()
    @IsNotEmpty()
    @IsUrl({ require_protocol: true })
    source_url?: string;

    @ApiPropertyOptional({ description: 'Display order (0-based)', minimum: 0 })
    @IsOptional()
    @IsInt()
    @Min(0)
    order?: number;

    @ApiPropertyOptional({
        description: 'Whether to create a pull request for this change',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    create_pull_request?: boolean;

    @ApiPropertyOptional({
        description:
            'Long-form markdown body. When provided, replaces `data/<slug>/<slug>.md` and mirrors onto the YAML `markdown` field. Pass an empty string to clear (a stub body will be written by the generator instead on next generation).',
        maxLength: 100000,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100000)
    markdown?: string;
}
