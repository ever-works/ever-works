import { IsString, IsOptional, IsNumber, IsArray, IsUUID, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchDto {
    @ApiProperty({ description: 'Search query', example: 'best project management tools' })
    @IsString()
    query: string;

    @ApiPropertyOptional({
        description: 'Optional work context for provider resolution and usage attribution',
        example: 'a0499a65-9b8c-4bf7-857e-895f52da30b3',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({
        description: 'Maximum number of results',
        example: 10,
        minimum: 1,
        maximum: 50,
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(50)
    maxResults?: number;

    @ApiPropertyOptional({
        description: 'Only include results from these domains',
        example: ['github.com', 'stackoverflow.com'],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    includeDomains?: string[];

    @ApiPropertyOptional({
        description: 'Exclude results from these domains',
        example: ['pinterest.com'],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    excludeDomains?: string[];
}
