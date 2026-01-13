import { IsArray, IsOptional, IsString, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';

export class BatchDeployItemDto {
    @IsString()
    directoryId: string;

    @IsOptional()
    @IsString()
    vercelTeamScope?: string;
}

export class BatchDeployVercelDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchDeployItemDto)
    @ArrayMinSize(1)
    directories: BatchDeployItemDto[];

    @IsOptional()
    @IsString()
    VERCEL_TOKEN?: string;

    @IsOptional()
    @IsString()
    GITHUB_TOKEN?: string;

    @IsOptional()
    @IsString()
    vercelTeamScope?: string; // Default team scope for all
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
