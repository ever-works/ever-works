import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsObject,
    IsOptional,
    IsString,
    IsNumber,
    Min,
    Validate,
} from 'class-validator';
import { IsValidCapabilityConstraint } from './validators/capability.validator';

/**
 * DTO for updating user plugin settings
 */
export class UpdateUserPluginSettingsDto {
    @ApiPropertyOptional({ description: 'Plugin settings to update' })
    @IsObject()
    @IsOptional()
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Secret settings to update (API keys, tokens)' })
    @IsObject()
    @IsOptional()
    secretSettings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Metadata to update' })
    @IsObject()
    @IsOptional()
    metadata?: Record<string, unknown>;
}

/**
 * DTO for enabling a plugin for user
 */
export class EnableUserPluginDto {
    @ApiPropertyOptional({ description: 'Initial settings when enabling' })
    @IsObject()
    @IsOptional()
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Initial secret settings when enabling' })
    @IsObject()
    @IsOptional()
    secretSettings?: Record<string, unknown>;
}

/**
 * DTO for updating directory plugin settings
 */
export class UpdateDirectoryPluginSettingsDto {
    @ApiPropertyOptional({ description: 'Directory-specific settings' })
    @IsObject()
    @IsOptional()
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Directory-specific secret settings' })
    @IsObject()
    @IsOptional()
    secretSettings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Directory-specific metadata' })
    @IsObject()
    @IsOptional()
    metadata?: Record<string, unknown>;
}

/**
 * DTO for enabling a plugin for a directory
 */
export class EnableDirectoryPluginDto {
    @ApiPropertyOptional({ description: 'Initial directory-specific settings' })
    @IsObject()
    @IsOptional()
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'Active capability to set',
        example: 'ai-provider',
    })
    @IsString()
    @IsOptional()
    @Validate(IsValidCapabilityConstraint)
    activeCapability?: string;

    @ApiPropertyOptional({ description: 'Priority order (lower = higher priority)' })
    @IsNumber()
    @Min(0)
    @IsOptional()
    priority?: number;
}

/**
 * DTO for setting active capability for a directory
 */
export class SetActiveCapabilityDto {
    @ApiProperty({
        description: 'Capability to set as active',
        example: 'ai-provider',
    })
    @IsString()
    @Validate(IsValidCapabilityConstraint)
    capability: string;
}

/**
 * DTO for updating directory plugin priority
 */
export class UpdateDirectoryPluginPriorityDto {
    @ApiProperty({ description: 'New priority value (lower = higher priority)' })
    @IsNumber()
    @Min(0)
    priority: number;
}
