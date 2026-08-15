import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import {
    MAX_AGENT_PROMPT_LENGTH,
    MAX_DEFAULT_VARIABLES,
    MAX_REPLAY_WINDOW_SEC,
    MAX_VARIABLE_LABEL_LENGTH,
    MIN_REPLAY_WINDOW_SEC,
    type InboundTriggerAutoStart,
    type InboundTriggerKind,
    type InboundTriggerMode,
    type InboundTriggerSourceType,
} from '@ever-works/agent/triggers';

const TRIGGER_KINDS = ['webhook', 'api'] as const;

const TRIGGER_SOURCE_TYPES = ['webhook', 'event'] as const;

const TRIGGER_MODES = ['single-task', 'template'] as const;

const TRIGGER_AUTO_STARTS = ['always', 'manual'] as const;

/** One declared payload variable — `{key, label?, required}`. */
export class TriggerVariableDto {
    @ApiProperty({ description: 'Top-level payload key', maxLength: 64 })
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
        message: 'defaultVariables key must be 1-64 chars of [A-Za-z0-9_-]',
    })
    key: string;

    @ApiPropertyOptional({ description: 'Display label; defaults to the key' })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_VARIABLE_LABEL_LENGTH)
    label?: string;

    @ApiPropertyOptional({
        description: 'A fire whose payload lacks this key is refused (and logged)',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    required?: boolean;
}

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

    @ApiPropertyOptional({
        enum: TRIGGER_MODES,
        description:
            "What a fire produces: 'single-task' (agent + prompt, default) or 'template' (build from taskTemplateSlug, which then becomes required). LOCKED after create.",
    })
    @IsOptional()
    @IsIn(TRIGGER_MODES)
    mode?: InboundTriggerMode;

    @ApiPropertyOptional({
        description:
            "'single-task' instructions for the agent. The delivery payload is appended in neutralized <webhook_body> tags.",
        maxLength: MAX_AGENT_PROMPT_LENGTH,
    })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_AGENT_PROMPT_LENGTH)
    agentPrompt?: string;

    @ApiPropertyOptional({
        description: 'Show the primary Task of each fire on the Kanban board',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    showOnBoard?: boolean;

    @ApiPropertyOptional({
        description:
            'Replay window in seconds — how stale a signed timestamp may be, and how long a repeated delivery id is treated as a duplicate.',
        minimum: MIN_REPLAY_WINDOW_SEC,
        maximum: MAX_REPLAY_WINDOW_SEC,
        default: 300,
    })
    @IsOptional()
    @IsInt()
    @Min(MIN_REPLAY_WINDOW_SEC)
    @Max(MAX_REPLAY_WINDOW_SEC)
    replayWindowSec?: number;

    @ApiPropertyOptional({
        enum: TRIGGER_AUTO_STARTS,
        description:
            "'always' (default) dispatches the first Task to the target agent; 'manual' leaves it in the backlog.",
    })
    @IsOptional()
    @IsIn(TRIGGER_AUTO_STARTS)
    autoStart?: InboundTriggerAutoStart;

    @ApiPropertyOptional({
        type: [TriggerVariableDto],
        description:
            'Payload contract. A fire missing a required key is refused and the reason is recorded in the fire log.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_DEFAULT_VARIABLES)
    @ValidateNested({ each: true })
    @Type(() => TriggerVariableDto)
    defaultVariables?: TriggerVariableDto[];
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

    // NOTE: `mode` is deliberately absent — it is locked at create time,
    // so `{"mode":…}` 400s with "property mode should not exist".

    @ApiPropertyOptional({
        description: "'single-task' instructions for the agent; null clears them",
        maxLength: MAX_AGENT_PROMPT_LENGTH,
    })
    @IsOptional()
    @ValidateIf((dto: UpdateInboundTriggerDto) => dto.agentPrompt !== null)
    @IsString()
    @MaxLength(MAX_AGENT_PROMPT_LENGTH)
    agentPrompt?: string | null;

    @ApiPropertyOptional({ description: 'Show the primary Task of each fire on the Kanban board' })
    @IsOptional()
    @IsBoolean()
    showOnBoard?: boolean;

    @ApiPropertyOptional({
        description: 'Replay window in seconds',
        minimum: MIN_REPLAY_WINDOW_SEC,
        maximum: MAX_REPLAY_WINDOW_SEC,
    })
    @IsOptional()
    @IsInt()
    @Min(MIN_REPLAY_WINDOW_SEC)
    @Max(MAX_REPLAY_WINDOW_SEC)
    replayWindowSec?: number;

    @ApiPropertyOptional({ enum: TRIGGER_AUTO_STARTS, description: 'First-task auto-start policy' })
    @IsOptional()
    @IsIn(TRIGGER_AUTO_STARTS)
    autoStart?: InboundTriggerAutoStart;

    @ApiPropertyOptional({
        type: [TriggerVariableDto],
        description: 'Replacement payload contract; null clears it',
    })
    @IsOptional()
    @ValidateIf((dto: UpdateInboundTriggerDto) => dto.defaultVariables !== null)
    @IsArray()
    @ArrayMaxSize(MAX_DEFAULT_VARIABLES)
    @ValidateNested({ each: true })
    @Type(() => TriggerVariableDto)
    defaultVariables?: TriggerVariableDto[] | null;
}
