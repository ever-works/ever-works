import { BadRequestException } from '@nestjs/common';
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
import { Transform } from 'class-transformer';
import { IsValidCapabilityConstraint } from './validators/capability.validator';

// Security: strip prototype-polluting keys (__proto__, constructor, prototype) from
// open-ended Record<string, unknown> plugin settings fields, and clamp nesting depth
// to prevent stack-overflow DoS from deeply nested payloads.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SETTINGS_DEPTH = 10;

// Exported for direct unit testing of the prototype-pollution + depth guard.
export function sanitizeSettingsObject(value: unknown, depth = 0): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    // Reject (do NOT pass through) payloads nested beyond the limit. Returning
    // the raw subtree here — the previous behaviour — persisted any dangerous
    // keys (__proto__/constructor) and arbitrarily deep structures *below* the
    // cap unchecked, defeating both the prototype-pollution and depth/DoS
    // guards for inputs like `settings.a.a.…(11 deep).constructor = {...}`.
    if (depth > MAX_SETTINGS_DEPTH) {
        throw new BadRequestException(
            `Plugin settings exceed the maximum nesting depth of ${MAX_SETTINGS_DEPTH}.`,
        );
    }
    if (Array.isArray(value)) {
        // Recurse into array entries too: a dangerous key nested inside an array
        // element (e.g. `settings.list[0].__proto__`) must not slip past the
        // sanitizer just because its parent is an array.
        return value.map((entry) => sanitizeSettingsObject(entry, depth + 1));
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!DANGEROUS_KEYS.has(k)) {
            result[k] = sanitizeSettingsObject(v, depth + 1);
        }
    }
    return result;
}

/**
 * DTO for updating user plugin settings
 */
export class UpdateUserPluginSettingsDto {
    @ApiPropertyOptional({ description: 'Plugin settings to update' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Secret settings to update (API keys, tokens)' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    secretSettings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Metadata to update' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    metadata?: Record<string, unknown>;
}

/**
 * DTO for enabling a plugin for user
 */
export class EnableUserPluginDto {
    @ApiPropertyOptional({ description: 'Initial settings when enabling' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Initial secret settings when enabling' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    secretSettings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Auto-enable this plugin for all works' })
    @IsBoolean()
    @IsOptional()
    autoEnableForWorks?: boolean;
}

/**
 * DTO for updating work plugin settings
 */
export class UpdateWorkPluginSettingsDto {
    @ApiPropertyOptional({ description: 'Work-specific settings' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Work-specific secret settings' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    secretSettings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Work-specific metadata' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
    @IsObject()
    @IsOptional()
    metadata?: Record<string, unknown>;
}

/**
 * DTO for enabling a plugin for a work
 */
export class EnableWorkPluginDto {
    @ApiPropertyOptional({ description: 'Initial work-specific settings' })
    @Transform(({ value }) =>
        value !== undefined && value !== null ? sanitizeSettingsObject(value) : value,
    )
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
 * DTO for setting active capability for a work
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
 * DTO for updating work plugin priority
 */
export class UpdateWorkPluginPriorityDto {
    @ApiProperty({ description: 'New priority value (lower = higher priority)' })
    @IsNumber()
    @Min(0)
    priority: number;
}

/**
 * DTO for setting the user's global pipeline default
 */
export class SetGlobalPipelineDefaultDto {
    @ApiPropertyOptional({
        description: 'Pipeline plugin ID to set as global default, or null to clear',
        example: 'standard-pipeline',
        nullable: true,
    })
    @IsString()
    @IsOptional()
    pluginId?: string | null;

    @ApiProperty({
        description:
            'When true, this pipeline is pre-selected in the generator form across all works, overriding work-level defaults. The user can still change the selection manually.',
        example: false,
    })
    @IsBoolean()
    enforce: boolean;
}
