import { IsEnum, IsOptional, IsString } from 'class-validator';
import { GenerateStatusType } from '@packages/agent/entities';

export class ScheduleRunCompleteDto {
    @IsEnum(GenerateStatusType)
    status: GenerateStatusType;

    @IsOptional()
    @IsString()
    historyId?: string;
}

export class ScheduleRunFailureDto {
    @IsOptional()
    @IsString()
    reason?: string;
}
