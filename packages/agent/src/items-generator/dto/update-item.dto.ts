import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
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
}
