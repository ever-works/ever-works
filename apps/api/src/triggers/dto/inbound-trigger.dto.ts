import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateIf } from 'class-validator';
import type { InboundTriggerKind } from '@ever-works/agent/triggers';

const TRIGGER_KINDS = ['webhook', 'api'] as const;

/**
 * Inbound Triggers — request DTOs. Validated by the global
 * ValidationPipe (whitelist + transform + forbidNonWhitelisted), so
 * unknown fields 400 instead of silently passing through.
 */
export class CreateInboundTriggerDto {
    @ApiProperty({ description: 'Display name (1-120 chars)', maxLength: 120 })
    @IsString()
    @Length(1, 120)
    name: string;

    @ApiPropertyOptional({ description: 'What fires this trigger (free text)' })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    @ApiPropertyOptional({
        enum: TRIGGER_KINDS,
        description:
            "Delivery style — informational; both kinds share the same fire endpoint. Defaults to 'webhook'.",
    })
    @IsOptional()
    @IsIn(TRIGGER_KINDS)
    kind?: InboundTriggerKind;

    @ApiPropertyOptional({
        description: 'Agent assigned to spawned Tasks (must belong to the caller)',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID()
    targetAgentId?: string;

    @ApiPropertyOptional({
        description: "Title template for spawned Tasks; '{name}' expands to the trigger name",
        maxLength: 200,
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    taskTitleTemplate?: string;
}

export class UpdateInboundTriggerDto {
    @ApiPropertyOptional({ description: 'Display name (1-120 chars)', maxLength: 120 })
    @IsOptional()
    @IsString()
    @Length(1, 120)
    name?: string;

    @ApiPropertyOptional({ description: 'What fires this trigger (free text); null clears' })
    @IsOptional()
    @ValidateIf((dto: UpdateInboundTriggerDto) => dto.description !== null)
    @IsString()
    @MaxLength(2000)
    description?: string | null;

    @ApiPropertyOptional({
        description: 'Agent assigned to spawned Tasks; null clears the assignment',
        format: 'uuid',
    })
    @IsOptional()
    @ValidateIf((dto: UpdateInboundTriggerDto) => dto.targetAgentId !== null)
    @IsUUID()
    targetAgentId?: string | null;

    @ApiPropertyOptional({
        description:
            "Title template for spawned Tasks; '{name}' expands to the trigger name; null resets to the default",
        maxLength: 200,
    })
    @IsOptional()
    @ValidateIf((dto: UpdateInboundTriggerDto) => dto.taskTitleTemplate !== null)
    @IsString()
    @MaxLength(200)
    taskTitleTemplate?: string | null;
}
