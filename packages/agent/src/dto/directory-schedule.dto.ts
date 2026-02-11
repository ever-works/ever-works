import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
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
    @IsOptional()
    @IsBoolean()
    enable?: boolean;

    @IsOptional()
    @IsEnum(DirectoryScheduleCadence)
    cadence?: DirectoryScheduleCadence;

    @IsOptional()
    @IsEnum(DirectoryScheduleBillingMode)
    billingMode?: DirectoryScheduleBillingMode;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(10)
    maxFailureBeforePause?: number;

    @IsOptional()
    @IsBoolean()
    alwaysCreatePullRequest?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providerOverrides?: ProvidersDto | null;
}
