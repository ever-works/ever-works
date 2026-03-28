import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryScheduleCadence } from '@src/entities/types';
import type { UpdateSourceValidationPayload } from '@ever-works/contracts/api';

export class UpdateSourceValidationDto implements UpdateSourceValidationPayload {
    @ApiProperty({ description: 'Whether source validation is enabled' })
    @IsBoolean()
    enabled: boolean;

    @ApiPropertyOptional({
        description: 'How often to run source validation',
        enum: DirectoryScheduleCadence,
    })
    @IsOptional()
    @IsEnum(DirectoryScheduleCadence)
    cadence?: DirectoryScheduleCadence;
}
