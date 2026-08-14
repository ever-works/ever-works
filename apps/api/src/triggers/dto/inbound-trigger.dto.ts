import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    Matches,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import type { InboundTriggerKind, InboundTriggerSourceType } from '@ever-works/agent/triggers';

const TRIGGER_KINDS = ['webhook', 'api'] as const;

const TRIGGER_SOURCE_TYPES = ['webhook', 'event'] as const;

/**
 * Ingest-event matcher for `'event'`-sourced triggers. Keys are the
 * whitelist — with the global `forbidNonWhitelisted` pipe, any other
 * key inside the nested object 400s. `source`/`kind` allow a
 * trailing-`*` wildcard; `workId` is an exact uuid.
 */
export class TriggerEventMatcherDto {
    @ApiPropertyOptional({
        description: "Producing plugin id (e.g. 'slack-connector'); trailing '*' wildcard allowed",
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    source?: string;

    @ApiPropertyOptional({
        description: "Source-namespaced kind (e.g. 'github.push'); trailing '*' wildcard allowed",
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    kind?: string;

    @ApiPropertyOptional({ description: 'Exact Work id the event was routed to', format: 'uuid' })
    @IsOptional()
    @IsUUID()
    workId?: string;
}

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

    @ApiPropertyOptional({
        enum: TRIGGER_SOURCE_TYPES,
        description:
            "What fires the trigger: 'webhook' (signed endpoint, default) or 'event' (ingest-spine matching). Immutable after create.",
    })
    @IsOptional()
    @IsIn(TRIGGER_SOURCE_TYPES)
    sourceType?: InboundTriggerSourceType;

    @ApiPropertyOptional({
        type: TriggerEventMatcherDto,
        description:
            "Required (with at least one key) when sourceType is 'event'; rejected otherwise.",
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => TriggerEventMatcherDto)
    eventMatcher?: TriggerEventMatcherDto;

    @ApiPropertyOptional({
        description:
            'Description template for spawned Tasks ({{event.*}} placeholders); omit for the built-in payload dump',
        maxLength: 4000,
    })
    @IsOptional()
    @IsString()
    @MaxLength(4000)
    taskDescriptionTemplate?: string;

    @ApiPropertyOptional({
        description:
            'Reserved task-template linkage (kebab-case slug, resolved lazily at fire time)',
        maxLength: 80,
    })
    @IsOptional()
    @IsString()
    @Matches(/^[a-z0-9][a-z0-9-]{0,79}$/, {
        message: 'taskTemplateSlug must be a kebab-case slug (a-z, 0-9, dashes; max 80 chars)',
    })
    taskTemplateSlug?: string;
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

    @ApiPropertyOptional({
        type: TriggerEventMatcherDto,
        description:
            "Replacement matcher — event-sourced triggers only; at least one key required (null is rejected: an event trigger can't listen for nothing)",
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => TriggerEventMatcherDto)
    eventMatcher?: TriggerEventMatcherDto;

    @ApiPropertyOptional({
        description:
            'Description template for spawned Tasks ({{event.*}} placeholders); null reverts to the built-in payload dump',
        maxLength: 4000,
    })
    @IsOptional()
    @ValidateIf((dto: UpdateInboundTriggerDto) => dto.taskDescriptionTemplate !== null)
    @IsString()
    @MaxLength(4000)
    taskDescriptionTemplate?: string | null;

    @ApiPropertyOptional({
        description: 'Reserved task-template linkage; null clears it',
        maxLength: 80,
    })
    @IsOptional()
    @ValidateIf((dto: UpdateInboundTriggerDto) => dto.taskTemplateSlug !== null)
    @IsString()
    @Matches(/^[a-z0-9][a-z0-9-]{0,79}$/, {
        message: 'taskTemplateSlug must be a kebab-case slug (a-z, 0-9, dashes; max 80 chars)',
    })
    taskTemplateSlug?: string | null;
}
