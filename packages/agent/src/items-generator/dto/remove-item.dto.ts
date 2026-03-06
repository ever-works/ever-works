import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { RemoveItemDto as IRemoveItemDto } from '@ever-works/contracts/api';

export class RemoveItemDto implements IRemoveItemDto {
    @ApiProperty({ description: 'Slug of the item to remove' })
    @IsString()
    @IsNotEmpty()
    item_slug: string;

    @ApiPropertyOptional({ description: 'Reason for removing the item' })
    @IsOptional()
    @IsString()
    reason?: string;

    @ApiPropertyOptional({
        description: 'Whether to create a pull request for this change',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    create_pull_request?: boolean;
}
