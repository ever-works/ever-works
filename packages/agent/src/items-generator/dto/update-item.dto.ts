import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { UpdateItemDto as IUpdateItemDto } from '@ever-works/contracts/api';

export class UpdateItemDto implements IUpdateItemDto {
    @IsString()
    item_slug: string;

    @IsOptional()
    @IsBoolean()
    featured?: boolean;

    @IsOptional()
    @IsInt()
    @Min(0)
    order?: number;

    @IsOptional()
    @IsBoolean()
    create_pull_request?: boolean;
}
