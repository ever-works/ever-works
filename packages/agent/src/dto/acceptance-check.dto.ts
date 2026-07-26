import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    TASK_ACCEPTANCE_CHECK_KINDS,
    type TaskAcceptanceCheck,
    type TaskAcceptanceCheckKind,
} from '@ever-works/contracts';
import { ENV_NAME_PATTERN, MAX_ENV_PASSTHROUGH } from '../tasks-domain/check-env';

/**
 * Slug-safe check id: lowercase alphanumeric start, then up to 40 more of
 * `[a-z0-9-_]`. The id is the override/suppression merge key between Task
 * checks and Work defaults, so it must be stable and unambiguous — no
 * whitespace, case variants, or exotic characters.
 */
export const ACCEPTANCE_CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,40}$/;

/**
 * Validated body shape for one acceptance check (quality gates, Wave 3 M1).
 * Shared by the Task create/update DTOs (`apps/api/src/tasks/tasks.dto.ts`)
 * and the Work `checkDefaults` update path (`update-work.dto.ts`) so both
 * surfaces enforce identical constraints on what is, at rest, the same
 * `simple-json` shape.
 */
export class AcceptanceCheckDto implements TaskAcceptanceCheck {
    @ApiProperty({
        description:
            'Stable slug identifying the check; also the merge key that overrides/suppresses a same-id Work default.',
        pattern: ACCEPTANCE_CHECK_ID_PATTERN.source,
    })
    @IsString()
    @Matches(ACCEPTANCE_CHECK_ID_PATTERN, {
        message: 'id must be slug-safe: start with [a-z0-9], then up to 40 chars of [a-z0-9-_].',
    })
    id: string;

    @ApiProperty({ description: 'Human-readable label shown in run reports.', maxLength: 120 })
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name: string;

    @ApiProperty({
        description: 'Category of the check (display/grouping only).',
        enum: TASK_ACCEPTANCE_CHECK_KINDS,
    })
    @IsIn(TASK_ACCEPTANCE_CHECK_KINDS)
    kind: TaskAcceptanceCheckKind;

    @ApiProperty({
        description: 'Command to execute; exit code 0 = green, anything else = red.',
        maxLength: 2000,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(2000)
    command: string;

    @ApiPropertyOptional({
        description: 'Working directory relative to the checkout root; omitted = root.',
        maxLength: 512,
    })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    cwd?: string;

    @ApiPropertyOptional({
        description: 'Wall-clock budget in seconds; exceeding it reports `timeout`, not `red`.',
        minimum: 1,
        maximum: 3600,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(3600)
    timeoutSec?: number;

    @ApiProperty({
        description: 'Required checks decide the gate; non-required ones only report.',
    })
    @IsBoolean()
    required: boolean;

    @ApiPropertyOptional({
        description:
            'true removes the check from the resolved list; on a Task entry this suppresses the same-id inherited Work default.',
    })
    @IsOptional()
    @IsBoolean()
    disabled?: boolean;

    @ApiPropertyOptional({
        description:
            'Environment variable NAMES (never values) granted to this check. Checks run with a scrubbed environment; listing a name is a deliberate grant of that value. Platform-owned configuration (database/auth/trigger/plugin credentials) is never granted, even when listed.',
        type: [String],
        maxItems: MAX_ENV_PASSTHROUGH,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_ENV_PASSTHROUGH)
    @IsString({ each: true })
    @Matches(ENV_NAME_PATTERN, {
        each: true,
        message:
            'envPassthrough entries must be environment variable NAMES: [A-Za-z_][A-Za-z0-9_]* (values are read from the platform environment).',
    })
    envPassthrough?: string[];
}
