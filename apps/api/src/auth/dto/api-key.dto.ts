import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsDateString,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import {
    API_KEY_ROTATION_MAX_GRACE_HOURS,
    INTEGRATION_KEY_MAX_ORGANIZATIONS,
    INTEGRATION_KINDS,
    INTEGRATION_SCOPES,
    type IntegrationKind,
    type IntegrationScope,
} from '@ever-works/contracts';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateApiKeyDto {
    @ApiProperty({ description: 'A label for the API key', maxLength: 100 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    name: string;

    @ApiPropertyOptional({ description: 'Expiration date in ISO 8601 format' })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}

/**
 * EW-P1-2 — `POST /api/auth/api-keys/integration`. A separate DTO (and route)
 * on purpose: the personal-key DTO above stays exactly `{ name, expiresAt? }`,
 * so a personal key can still never carry scopes or pins.
 */
export class CreateIntegrationKeyDto {
    @ApiProperty({ description: 'A label for the key, e.g. "Ever Gauzy — Acme"', maxLength: 100 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    name: string;

    @ApiPropertyOptional({ description: 'Free-text note', maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({ enum: INTEGRATION_KINDS, default: 'generic' })
    @IsOptional()
    @IsIn(INTEGRATION_KINDS as unknown as string[])
    integrationKind?: IntegrationKind;

    @ApiProperty({
        description: 'Granted scopes (vocabulary v1)',
        isArray: true,
        enum: INTEGRATION_SCOPES,
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(INTEGRATION_SCOPES.length)
    @IsIn(INTEGRATION_SCOPES as unknown as string[], { each: true })
    scopes: IntegrationScope[];

    @ApiProperty({
        description: 'Organizations the key is pinned to (at least one)',
        isArray: true,
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(INTEGRATION_KEY_MAX_ORGANIZATIONS)
    @IsUUID('all', { each: true })
    organizationIds: string[];

    @ApiPropertyOptional({ description: 'Expiration date in ISO 8601 format' })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}

/** EW-P1-2 — `POST /api/auth/api-keys/:id/rotate`. */
export class RotateApiKeyDto {
    @ApiPropertyOptional({
        description: 'Hours the previous secret keeps working',
        minimum: 0,
        maximum: API_KEY_ROTATION_MAX_GRACE_HOURS,
        default: 24,
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(API_KEY_ROTATION_MAX_GRACE_HOURS)
    graceHours?: number;
}
