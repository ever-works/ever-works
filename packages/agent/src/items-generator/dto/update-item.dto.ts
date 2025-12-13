import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateItemDto {
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
