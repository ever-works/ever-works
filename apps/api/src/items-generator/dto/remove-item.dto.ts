import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class RemoveItemDto {
    @IsString()
    @IsNotEmpty()
    item_slug: string;

    @IsOptional()
    @IsString()
    reason?: string;
}
