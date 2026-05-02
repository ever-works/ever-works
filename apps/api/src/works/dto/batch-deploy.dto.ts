import { IsArray, IsOptional, IsString, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchDeployItemDto {
    @ApiProperty({ description: 'Work ID to deploy' })
    @IsString()
    workId: string;

    @ApiPropertyOptional({ description: 'Team scope for this work (overrides default)' })
    @IsOptional()
    @IsString()
    teamScope?: string;
}

export class BatchDeployDto {
    @ApiProperty({
        description: 'List of works to deploy',
        type: [BatchDeployItemDto],
        minItems: 1,
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchDeployItemDto)
    @ArrayMinSize(1)
    works: BatchDeployItemDto[];

    @ApiPropertyOptional({ description: 'Default team scope for all works' })
    @IsOptional()
    @IsString()
    teamScope?: string;
}

export interface BatchDeployResult {
    workId: string;
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
