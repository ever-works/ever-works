import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { INBOX_DECISION_CURSOR_MAX_CHARS } from '@ever-works/agent/inbox';
import {
    INBOX_DECISION_KINDS,
    INBOX_DECISION_MAX_LIMIT,
    INBOX_DECISION_PAGE_SIZE,
    INBOX_ITEM_STATUSES,
    INBOX_MAX_OPTION_ID_CHARS,
    INBOX_MAX_REPLY_CHARS,
    type InboxItemKind,
    type InboxItemStatus,
} from '@ever-works/contracts';

/** Longest search term the decision view accepts. */
export const INBOX_DECISION_MAX_SEARCH_CHARS = 200;

// Why `@ApiProperty` on every field: the API build runs no `@nestjs/swagger`
// CLI plugin, so undecorated DTO fields are absent from the OpenAPI document
// — and the MCP server derives its tool schemas from that document.

export class ListInboxQueryDto {
    /** Omitted = the active view (everything not archived). */
    @ApiProperty({
        required: false,
        enum: [...INBOX_ITEM_STATUSES],
        description: 'Omitted = the active view (everything not archived).',
    })
    @IsOptional()
    @IsIn(INBOX_ITEM_STATUSES as readonly string[])
    status?: InboxItemStatus;

    /**
     * Only items linked to this Task — the Task page's lookup of the open
     * question a parked fleet run is waiting on (self-build slice Q).
     * Owner-scoped inside the repository, so a guessed id sees nothing.
     * A UUID like every other id filter on the API (review SR-4): the
     * column is `uuid`, and Postgres answers a non-UUID comparison with
     * `22P02`, which would surface as a 500 instead of this 400.
     */
    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'Only items linked to this Task.',
    })
    @IsOptional()
    @IsUUID()
    taskId?: string;

    @ApiProperty({
        required: false,
        minimum: 1,
        maximum: 100,
        description: 'Page size (default 50).',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0, description: 'Pagination offset (default 0).' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

export class ReplyInboxItemDto {
    @ApiProperty({
        required: false,
        maxLength: INBOX_MAX_REPLY_CHARS,
        description: 'Free-text answer.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_MAX_REPLY_CHARS)
    text?: string;

    @ApiProperty({
        required: false,
        maxLength: INBOX_MAX_OPTION_ID_CHARS,
        description: "Id of one of the message's offered options.",
    })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_MAX_OPTION_ID_CHARS)
    optionId?: string;

    /**
     * My Decisions — opt into the decision answer rule: a rejection, or an
     * option other than the recommended one, must carry `text` saying why.
     * Omitted or false = the reply accepts exactly what it always has.
     */
    @ApiProperty({
        required: false,
        description:
            'Opt into the decision answer rule: rejecting, or choosing an option other than the recommended one, requires text explaining why.',
    })
    @IsOptional()
    @IsBoolean()
    requireReason?: boolean;
}

/**
 * My Decisions — `GET /api/inbox/decisions`. Every id filter is a UUID
 * for the same reason as `ListInboxQueryDto.taskId`: the columns are
 * `uuid`, and Postgres answers a malformed comparison with a 500.
 */
export class ListInboxDecisionsQueryDto {
    @ApiProperty({
        required: false,
        enum: [...INBOX_ITEM_STATUSES],
        description:
            'Tab of the decision view: open (default, the ranked queue), answered, archived.',
    })
    @IsOptional()
    @IsIn(INBOX_ITEM_STATUSES as readonly string[])
    status?: InboxItemStatus;

    @ApiProperty({
        required: false,
        enum: [...INBOX_DECISION_KINDS],
        description: 'Only this kind of decision (question, approval or escalation).',
    })
    @IsOptional()
    @IsIn(INBOX_DECISION_KINDS as readonly string[])
    kind?: InboxItemKind;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'Only decisions raised by this Agent.',
    })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'Only decisions belonging to this Task (directly, or through the asking run).',
    })
    @IsOptional()
    @IsUUID()
    taskId?: string;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'Only decisions whose Task was raised under this Mission.',
    })
    @IsOptional()
    @IsUUID()
    missionId?: string;

    @ApiProperty({
        required: false,
        maxLength: INBOX_DECISION_MAX_SEARCH_CHARS,
        description: 'Case-insensitive search over the title and the message.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_DECISION_MAX_SEARCH_CHARS)
    q?: string;

    @ApiProperty({
        required: false,
        minimum: 1,
        maximum: INBOX_DECISION_MAX_LIMIT,
        description: `Page size (default ${INBOX_DECISION_PAGE_SIZE}).`,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(INBOX_DECISION_MAX_LIMIT)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0, description: 'Pagination offset (default 0).' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;

    /**
     * The previous page's `meta.nextCursor`. Unlike `offset`, it cannot
     * skip or repeat a decision when the live queue changes between two
     * reads. Shape-checked here (a URL-safe token of bounded length); the
     * service rejects one that does not decode for this tab with a 400.
     */
    @ApiProperty({
        required: false,
        maxLength: INBOX_DECISION_CURSOR_MAX_CHARS,
        description:
            'Opaque cursor from the previous page (`meta.nextCursor`): the page starts right after that row, so decisions answered or raised meanwhile never shift it. When `offset` is also given it counts from the cursor.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_DECISION_CURSOR_MAX_CHARS)
    @Matches(/^[A-Za-z0-9_-]+$/)
    cursor?: string;
}

export class SetInboxReadStateDto {
    /** `true` marks unread again; `false` (default) marks read. */
    @ApiProperty({
        required: false,
        description: 'true marks the message unread again; false (default) marks it read.',
    })
    @IsOptional()
    @IsBoolean()
    unread?: boolean;
}
