import { IsString, IsOptional, IsUrl, IsArray } from 'class-validator';
import type { ExtractItemDetailsDto as IExtractItemDetailsDto } from '@ever-works/contracts/api';

export class ExtractItemDetailsDto implements IExtractItemDetailsDto {
    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    source_url: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    existing_categories?: string[];
}
