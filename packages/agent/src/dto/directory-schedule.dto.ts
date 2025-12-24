import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';

export type DirectoryScheduleAllowedCadence = {
    cadence: DirectoryScheduleCadence;
    reason?: string;
    payPerUse?: boolean;
    allowed: boolean;
};

export interface DirectoryScheduleDto {
    status: DirectoryScheduleStatus;
    cadence: DirectoryScheduleCadence | null;
    billingMode: DirectoryScheduleBillingMode;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: GenerateStatusType | null;
    failureCount: number;
    maxFailureBeforePause: number;
    alwaysCreatePullRequest: boolean;
    allowedCadences: DirectoryScheduleAllowedCadence[];
    planCode?: string;
    subscriptionsEnabled: boolean;
}

export class UpdateDirectoryScheduleDto {
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
