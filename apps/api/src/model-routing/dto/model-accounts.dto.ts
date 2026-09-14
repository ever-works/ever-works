import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MODEL_ROUTING_LIMITS } from '@ever-works/contracts';
import { StringRecordValues } from './validators/string-record-values.validator';

/**
 * Model accounts (AW-16) — request bodies for `/api/model-accounts`.
 *
 * Credential field NAMES are not validated here: they are whatever the
 * provider plugin's settings schema marks secret, and the service refuses a
 * name the provider does not declare. Values are write-only — no response
 * from these routes ever carries one back.
 */

export class CreateModelAccountDto {
    @ApiProperty({ description: 'Id of an installed AI provider plugin.' })
    @IsString()
    @Length(1, 128)
    providerPluginId: string;

    @ApiProperty({ description: 'Your name for this account, unique within its provider.' })
    @IsString()
    @Length(1, MODEL_ROUTING_LIMITS.accountLabelMaxLength)
    label: string;

    @ApiProperty({
        description:
            "The provider's secret settings, keyed as its settings schema names them. Checked with the provider before anything is saved; never returned.",
        type: 'object',
        additionalProperties: { type: 'string' },
    })
    @IsObject()
    @StringRecordValues()
    credentials: Record<string, string>;

    @ApiPropertyOptional({
        description: "Where the account goes in its provider's order. Default `last`.",
        enum: ['first', 'last'],
    })
    @IsOptional()
    @IsIn(['first', 'last'])
    position?: 'first' | 'last';
}

export class UpdateModelAccountDto {
    @ApiPropertyOptional({ description: 'Rename the account.' })
    @IsOptional()
    @IsString()
    @Length(1, MODEL_ROUTING_LIMITS.accountLabelMaxLength)
    label?: string;

    @ApiPropertyOptional({
        description:
            'false pauses the account (agents skip it), true resumes it. Position is kept.',
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}

export class ReplaceModelAccountCredentialsDto {
    @ApiProperty({
        description:
            'The replacement secret settings. Checked with the provider first; the account keeps its position, name and history.',
        type: 'object',
        additionalProperties: { type: 'string' },
    })
    @IsObject()
    @StringRecordValues()
    credentials: Record<string, string>;
}

export class ReorderModelAccountsDto {
    @ApiProperty({ description: 'The provider whose accounts are being reordered.' })
    @IsString()
    @Length(1, 128)
    providerPluginId: string;

    @ApiProperty({
        description: 'Every account id of the provider, in the new order (position 1 first).',
        type: [String],
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MODEL_ROUTING_LIMITS.accountsPerProvider)
    @IsString({ each: true })
    orderedIds: string[];

    @ApiPropertyOptional({
        description:
            'The order the editor loaded. When it no longer matches, the save is refused with 409 `stale_order` and nothing is written.',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MODEL_ROUTING_LIMITS.accountsPerProvider)
    @IsString({ each: true })
    expectedOrder?: string[];
}
