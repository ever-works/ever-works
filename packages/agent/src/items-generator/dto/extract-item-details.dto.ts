import { IsString, IsOptional, IsUrl, IsArray, IsUUID } from 'class-validator';
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

    @ApiPropertyOptional({
        description: 'Optional work context for provider resolution and usage attribution',
        example: 'a0499a65-9b8c-4bf7-857e-895f52da30b3',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({ description: 'Existing categories to match against', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    existing_categories?: string[];
}
