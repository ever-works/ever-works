import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsUrl, IsArray } from 'class-validator';

export class SubmitItemDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    description: string;

    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    source_url: string;

    @IsString()
    @IsNotEmpty()
    category: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];

    @IsOptional()
    @IsBoolean()
    featured?: boolean;

    @IsOptional()
    @IsBoolean()
    pay_and_publish_now?: boolean;

    @IsOptional()
    @IsString()
    slug?: string;
}
