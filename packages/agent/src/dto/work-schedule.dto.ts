import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { WorkScheduleBillingMode, WorkScheduleCadence } from '@src/entities/types';
import type {
    WorkScheduleAllowedCadence as ContractWorkScheduleAllowedCadence,
    WorkScheduleDto as ContractWorkScheduleDto,
    UpdateWorkSchedulePayload as IUpdateWorkSchedulePayload,
} from '@ever-works/contracts/api';
import { ProvidersDto } from '@src/items-generator/dto/create-items-generator.dto';

export type WorkScheduleAllowedCadence = ContractWorkScheduleAllowedCadence;

export type WorkScheduleDto = ContractWorkScheduleDto;

export class UpdateWorkScheduleDto implements IUpdateWorkSchedulePayload {
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
        enum: WorkScheduleCadence,
    })
    @IsOptional()
    @IsEnum(WorkScheduleCadence)
    cadence?: WorkScheduleCadence;

    @ApiPropertyOptional({
        description: 'Billing mode for scheduled runs',
        enum: WorkScheduleBillingMode,
    })
    @IsOptional()
    @IsEnum(WorkScheduleBillingMode)
    billingMode?: WorkScheduleBillingMode;

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
