import { IsString, IsOptional, IsUrl, IsArray } from 'class-validator';

export class ExtractItemDetailsDto {
    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    source_url: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    existing_categories?: string[];
}
