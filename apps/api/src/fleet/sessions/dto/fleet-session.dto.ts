import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsISO8601,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    FLEET_SESSION_ANSWER_TEXT_MAX_CHARS,
    FLEET_SESSION_ATTACH_ROLES,
    FLEET_SESSION_CWD_MAX_LENGTH,
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    FLEET_SESSION_KINDS,
    FLEET_SESSION_MAX_COLS,
    FLEET_SESSION_MAX_ROWS,
    FLEET_SESSION_MIN_COLS,
    FLEET_SESSION_MIN_ROWS,
    FLEET_SESSION_STARTABLE_PROVIDERS,
    FLEET_SESSION_TITLE_MAX_LENGTH,
    type FleetSessionAttachRole,
    type FleetSessionKind,
    type FleetSessionStartableProvider,
} from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04, plan §5) — request shapes. Every bound comes
 * from the shared contract so the web tier, the tools and the API agree on it
 * at compile time. The service re-checks what it relies on (it is also called
 * by tools that never pass through these classes).
 */

/** The terminal size a start, restart or attach may name (clamped again by the service). */
class FleetSessionSizeDto {
    @ApiProperty({ required: false, minimum: FLEET_SESSION_MIN_COLS, maximum: FLEET_SESSION_MAX_COLS })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(FLEET_SESSION_MIN_COLS)
    @Max(FLEET_SESSION_MAX_COLS)
    cols?: number;

    @ApiProperty({ required: false, minimum: FLEET_SESSION_MIN_ROWS, maximum: FLEET_SESSION_MAX_ROWS })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(FLEET_SESSION_MIN_ROWS)
    @Max(FLEET_SESSION_MAX_ROWS)
    rows?: number;
}

/** Body for `POST /api/fleet/nodes/:id/sessions`. */
export class StartFleetSessionDto extends FleetSessionSizeDto {
    @ApiProperty({
        enum: FLEET_SESSION_KINDS,
        description:
            '`owner`: a terminal of my own on the computer (needs `--manage`). `agent`: an Agent works in it (needs `--work`; arrives in a later phase).',
    })
    @IsIn(FLEET_SESSION_KINDS as unknown as string[])
    kind!: FleetSessionKind;

    @ApiProperty({ enum: FLEET_SESSION_STARTABLE_PROVIDERS })
    @IsIn(FLEET_SESSION_STARTABLE_PROVIDERS as unknown as string[])
    provider!: FleetSessionStartableProvider;

    @ApiProperty({
        maxLength: FLEET_SESSION_CWD_MAX_LENGTH,
        description: 'The folder on the computer the session starts in (`~` is the home folder).',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(FLEET_SESSION_CWD_MAX_LENGTH)
    cwd!: string;

    @ApiProperty({ required: false, maxLength: FLEET_SESSION_TITLE_MAX_LENGTH })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SESSION_TITLE_MAX_LENGTH)
    title?: string;

    @ApiProperty({
        required: false,
        maxLength: FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
        description:
            'What the CLI is asked first (Claude Code, Codex). Stored redacted; never written to the audit trail.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH)
    firstMessage?: string;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    checkoutId?: string;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    newWorktreeOf?: string;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'Start this ended session again (the same act as `POST /api/fleet/sessions/:id/restart`).',
    })
    @IsOptional()
    @IsUUID()
    restartOf?: string;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description:
            'FL-15: the Task this Agent session works on. Its Run carries the Task (history, board, chat follow it); refused `busy` while the same Agent already works the Task, `invalid` on a computer other than the Agent’s pinned one, `limit_exceeded` when the computer has no free agent slot.',
    })
    @IsOptional()
    @IsUUID()
    taskId?: string;
}

/** Body for `PATCH /api/fleet/sessions/:id`. */
export class RenameFleetSessionDto {
    @ApiProperty({ minLength: 1, maxLength: FLEET_SESSION_TITLE_MAX_LENGTH })
    @IsString()
    @MinLength(1)
    @MaxLength(FLEET_SESSION_TITLE_MAX_LENGTH)
    title!: string;
}

/**
 * Body for `PATCH /api/fleet/sessions/:id` (FL-05 widens FL-04's rename, plan
 * §5): `{ title }` renames, `{ acknowledge: <attention key> }` marks the
 * session's attention seen (FR-26). Exactly one of the two.
 */
export class PatchFleetSessionDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: FLEET_SESSION_TITLE_MAX_LENGTH })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(FLEET_SESSION_TITLE_MAX_LENGTH)
    title?: string;

    @ApiProperty({
        required: false,
        maxLength: 200,
        description: 'The attention key the reader saw (fleet-session:<id>:<reason>:<prompt>): clears unread, never the prompt.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    acknowledge?: string;
}

/** Body for `POST /api/fleet/sessions/:id/answer` (FL-05, plan §5, spec FR-28 … FR-31). */
export class AnswerFleetSessionDto {
    @ApiProperty({ maxLength: 200, description: 'The attention key being answered (it must still be current).' })
    @IsString()
    @MaxLength(200)
    key!: string;

    @ApiProperty({ required: false, maxLength: 64, description: 'One of the options the CLI showed.' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    optionId?: string;

    @ApiProperty({
        required: false,
        maxLength: FLEET_SESSION_ANSWER_TEXT_MAX_CHARS,
        description: 'A free-text answer, for a question that takes one. Typed into the session; never stored.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SESSION_ANSWER_TEXT_MAX_CHARS)
    text?: string;

    @ApiProperty({ required: false, enum: ['card', 'detail', 'inbox', 'decisions', 'cli'] })
    @IsOptional()
    @IsIn(['card', 'detail', 'inbox', 'decisions', 'cli'])
    source?: 'card' | 'detail' | 'inbox' | 'decisions' | 'cli';
}

/** Body for `POST /api/fleet/sessions/:id/end` (CONTRACTS §2.2 class `confirm`). */
export class EndFleetSessionDto {
    @ApiProperty({
        required: false,
        description:
            'Must be `true`: without it the call answers `confirmation_required` with the sentence to show.',
    })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiProperty({ required: false, enum: ['user'] })
    @IsOptional()
    @IsIn(['user'])
    reason?: 'user';
}

/** Body for `POST /api/fleet/sessions/:id/restart`. */
export class RestartFleetSessionDto extends FleetSessionSizeDto {}

/** Query for `GET /api/fleet/nodes/:id/sessions` and `GET /api/fleet/sessions`. */
export class ListFleetSessionsQueryDto {
    @ApiProperty({
        required: false,
        enum: ['board', 'list'],
        description:
            'FL-05: `board` answers the four columns (needs you · working · done · idle) of the live sessions instead of a page.',
    })
    @IsOptional()
    @IsIn(['board', 'list'])
    view?: 'board' | 'list';

    @ApiProperty({ required: false, enum: ['live', 'ended'] })
    @IsOptional()
    @IsIn(['live', 'ended'])
    state?: 'live' | 'ended';

    @ApiProperty({ required: false, enum: FLEET_SESSION_KINDS })
    @IsOptional()
    @IsIn(FLEET_SESSION_KINDS as unknown as string[])
    kind?: FleetSessionKind;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    nodeId?: string;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'FL-15: only sessions whose Run works on this Task (the Task page’s Computer block).',
    })
    @IsOptional()
    @IsUUID()
    taskId?: string;

    @ApiProperty({ required: false, description: 'ISO 8601: sessions active since then.' })
    @IsOptional()
    @IsISO8601()
    since?: string;

    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiProperty({ required: false, description: 'The `nextCursor` of the previous page.' })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    cursor?: string;
}

/** Body for `POST /api/fleet/sessions/:id/attach-token` (FL-04 P1b). */
export class FleetSessionAttachTokenDto extends FleetSessionSizeDto {
    @ApiProperty({
        enum: FLEET_SESSION_ATTACH_ROLES,
        description:
            '`viewer` watches (never types); `driver` types and sizes the terminal. Both need the computer’s `sessions` audience.',
    })
    @IsIn(FLEET_SESSION_ATTACH_ROLES as unknown as string[])
    role!: FleetSessionAttachRole;
}

/** Body for `POST /api/fleet/sessions/:id/recording` (FL-04 P3). */
export class FleetSessionRecordingDto {
    @ApiProperty({ description: 'true starts recording the session from now; false stops it.' })
    @IsBoolean()
    on!: boolean;
}

/** Query for `GET /api/fleet/sessions/:id/recording` (FL-04 P3): `from` asks for a page of chunks. */
export class FleetSessionRecordingQueryDto {
    @ApiProperty({ required: false, minimum: 0, description: 'The first sequence number of the page.' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    from?: number;

    @ApiProperty({ required: false, minimum: 1, maximum: 500 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(500)
    limit?: number;
}
