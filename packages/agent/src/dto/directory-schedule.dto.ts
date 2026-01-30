import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';
import type { UpdateDirectorySchedulePayload as IUpdateDirectorySchedulePayload } from '@ever-works/contracts/api';

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
}
