import { IsString, IsOptional, IsUrl, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ExtractItemDetailsDto as IExtractItemDetailsDto } from '@ever-works/contracts/api';

export class ExtractItemDetailsDto implements IExtractItemDetailsDto {
    @ApiProperty({
        description: 'URL to extract item details from',
        example: 'https://example.com',
    })
    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    source_url: string;

    @ApiPropertyOptional({ description: 'Existing categories to match against', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    existing_categories?: string[];
}
