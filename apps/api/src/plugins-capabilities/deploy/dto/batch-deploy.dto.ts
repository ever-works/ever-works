import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchDeployItemDto {
    @ApiProperty({ description: 'Directory ID' })
    @IsString()
    directoryId: string;

    @ApiPropertyOptional({ description: 'Team scope for this directory' })
    @IsString()
    @IsOptional()
    teamScope?: string;
}

export class BatchDeployDto {
    @ApiProperty({
        description: 'List of directories to deploy',
        type: [BatchDeployItemDto],
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchDeployItemDto)
    directories: BatchDeployItemDto[];

    @ApiPropertyOptional({ description: 'Default team scope for all deployments' })
    @IsString()
    @IsOptional()
    teamScope?: string;
}

export class BatchDeployItemResultDto {
    directoryId: string;
    slug: string;
    status: 'pending' | 'error';
    message: string;
    owner?: string;
    repository?: string;
}

export class BatchDeployResponseDto {
    status: 'success' | 'partial' | 'error';
    message: string;
    totalRequested: number;
    successfullyStarted: number;
    failed: number;
    results: BatchDeployItemResultDto[];
}
