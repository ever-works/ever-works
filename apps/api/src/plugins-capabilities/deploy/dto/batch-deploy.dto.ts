import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchDeployItemDto {
    @ApiProperty({ description: 'Work ID' })
    @IsString()
    workId: string;

    @ApiPropertyOptional({ description: 'Team scope for this work' })
    @IsString()
    @IsOptional()
    teamScope?: string;
}

export class BatchDeployDto {
    @ApiProperty({
        description: 'List of works to deploy',
        type: [BatchDeployItemDto],
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchDeployItemDto)
    works: BatchDeployItemDto[];

    @ApiPropertyOptional({ description: 'Default team scope for all deployments' })
    @IsString()
    @IsOptional()
    teamScope?: string;
}

export class BatchDeployItemResultDto {
    workId: string;
    deploymentId?: string;
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
