import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';
import type { UpdateDirectorySchedulePayload as IUpdateDirectorySchedulePayload } from '@ever-works/contracts/api';
import { ProvidersDto } from '@src/items-generator/dto/create-items-generator.dto';

// Re-export types from contracts for convenience
export type {
    DirectoryScheduleAllowedCadence,
    DirectoryScheduleDto,
} from '@ever-works/contracts/api';

export class UpdateDirectoryScheduleDto implements IUpdateDirectorySchedulePayload {
    @ApiPropertyOptional({ description: 'Whether the schedule is enabled' })
    @IsOptional()
    @IsBoolean()
    enable?: boolean;

    @ApiPropertyOptional({
        description: 'Schedule cadence',
        enum: DirectoryScheduleCadence,
    })
    @IsOptional()
    @IsEnum(DirectoryScheduleCadence)
    cadence?: DirectoryScheduleCadence;

    @ApiPropertyOptional({
        description: 'Source validation cadence',
        enum: DirectoryScheduleCadence,
    })
    @IsOptional()
    @IsEnum(DirectoryScheduleCadence)
    sourceValidationCadence?: DirectoryScheduleCadence;

    @ApiPropertyOptional({
        description: 'Billing mode for scheduled runs',
        enum: DirectoryScheduleBillingMode,
    })
    @IsOptional()
    @IsEnum(DirectoryScheduleBillingMode)
    billingMode?: DirectoryScheduleBillingMode;

    @ApiPropertyOptional({
        description: 'Max consecutive failures before auto-pause',
        minimum: 1,
        maximum: 10,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(10)
    maxFailureBeforePause?: number;

    @ApiPropertyOptional({
        description: 'Whether to always create a pull request for scheduled updates',
    })
    @IsOptional()
    @IsBoolean()
    alwaysCreatePullRequest?: boolean;

    @ApiPropertyOptional({
        description: 'Provider plugin overrides for scheduled runs',
        type: ProvidersDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providerOverrides?: ProvidersDto | null;
}
