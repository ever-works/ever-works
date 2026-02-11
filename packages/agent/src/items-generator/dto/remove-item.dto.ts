import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';
import type { RemoveItemDto as IRemoveItemDto } from '@ever-works/contracts/api';

export class RemoveItemDto implements IRemoveItemDto {
    @IsString()
    @IsNotEmpty()
    item_slug: string;

    @IsOptional()
    @IsString()
    reason?: string;

    @IsOptional()
    @IsBoolean()
    create_pull_request?: boolean;
}
