import {
    IsString,
    IsNotEmpty,
    IsOptional,
    IsBoolean,
    IsUrl,
    IsArray,
    IsInt,
    Min,
    ValidateIf,
    ArrayMinSize,
} from 'class-validator';
import type { SubmitItemDto as ISubmitItemDto } from '@ever-works/contracts/api';

export class SubmitItemDto implements ISubmitItemDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    description: string;

    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    source_url: string;

    // Backward compatibility: accept single category string
    // Required if categories array is not provided or empty
    @ValidateIf((o) => !Array.isArray(o.categories) || o.categories.length === 0)
    @IsString()
    @IsNotEmpty()
    category?: string;

    @ValidateIf((o) => typeof o.category !== 'string' || o.category.length === 0)
    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    categories?: string[];

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

    @IsOptional()
    @IsBoolean()
    create_pull_request?: boolean;
}
