import {
    IsString,
    IsNotEmpty,
    IsOptional,
    IsBoolean,
    IsUrl,
    IsArray,
    IsInt,
    Min,
} from 'class-validator';

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
    @IsInt()
    @Min(0)
    order?: number;

    @IsOptional()
    @IsBoolean()
    pay_and_publish_now?: boolean;

    @IsOptional()
    @IsString()
    slug?: string;

    @IsOptional()
    @IsString()
    brand?: string;

    @IsOptional()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    brand_logo_url?: string;

    @IsOptional()
    @IsArray()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true }, { each: true })
    images?: string[];
}
