import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { DirectoryScheduleBillingMode, DirectoryScheduleCadence } from '@src/entities/types';
import type {
    DirectoryScheduleAllowedCadence as ContractDirectoryScheduleAllowedCadence,
    DirectoryScheduleDto as ContractDirectoryScheduleDto,
    UpdateDirectorySchedulePayload as IUpdateDirectorySchedulePayload,
} from '@ever-works/contracts/api';
import { ProvidersDto } from '@src/items-generator/dto/create-items-generator.dto';

export type DirectoryScheduleAllowedCadence = ContractDirectoryScheduleAllowedCadence;

export type DirectoryScheduleDto = Omit<ContractDirectoryScheduleDto, 'blockingCode'> & {
    blockingCode?:
        | 'SCHEDULED_UPDATES_DISABLED'
        | 'INITIAL_DIRECTORY_SETUP_REQUIRED'
        | 'CONFIG_UNAVAILABLE';
};

export class UpdateDirectoryScheduleDto implements IUpdateDirectorySchedulePayload {
    @ApiPropertyOptional({ description: 'Whether the schedule is enabled' })
    @IsOptional()
    @IsBoolean()
    enable?: boolean;

    @ApiPropertyOptional({
        description: 'Whether to trigger an immediate run after saving the active schedule',
    })
    @IsOptional()
    @IsBoolean()
    runImmediately?: boolean;

    @ApiPropertyOptional({
        description: 'Schedule cadence',
        enum: DirectoryScheduleCadence,
    })
    @IsOptional()
    @IsEnum(DirectoryScheduleCadence)
    cadence?: DirectoryScheduleCadence;

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
