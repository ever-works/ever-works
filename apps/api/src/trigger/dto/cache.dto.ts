import { IsString, IsNumber, IsOptional, IsNotEmpty } from 'class-validator';

export class CacheDto {
    @IsString()
    @IsNotEmpty()
    key: string;

    @IsNotEmpty()
    value: any;

    @IsNumber()
    @IsOptional()
    ttl?: number;
}
