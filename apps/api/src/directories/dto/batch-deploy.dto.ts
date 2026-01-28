import { IsArray, IsOptional, IsString, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchDeployItemDto {
    @ApiProperty({ description: 'Directory ID to deploy' })
    @IsString()
    directoryId: string;

    @ApiPropertyOptional({ description: 'Vercel team scope for this directory (overrides default)' })
    @IsOptional()
    @IsString()
    vercelTeamScope?: string;
}

export class BatchDeployVercelDto {
    @ApiProperty({ description: 'List of directories to deploy', type: [BatchDeployItemDto], minItems: 1 })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchDeployItemDto)
    @ArrayMinSize(1)
    directories: BatchDeployItemDto[];

    @ApiPropertyOptional({ description: 'Vercel API token (uses account token if not provided)' })
    @IsOptional()
    @IsString()
    VERCEL_TOKEN?: string;

    @ApiPropertyOptional({ description: 'GitHub token (uses account token if not provided)' })
    @IsOptional()
    @IsString()
    GITHUB_TOKEN?: string;

    @ApiPropertyOptional({ description: 'Default Vercel team scope for all directories' })
    @IsOptional()
    @IsString()
    vercelTeamScope?: string;
}

export interface BatchDeployResult {
    directoryId: string;
    slug: string;
    status: 'pending' | 'error';
    message: string;
    owner?: string;
    repository?: string;
}

export interface BatchDeployResponseDto {
    status: 'success' | 'partial' | 'error';
    message: string;
    totalRequested: number;
    successfullyStarted: number;
    failed: number;
    results: BatchDeployResult[];
}
