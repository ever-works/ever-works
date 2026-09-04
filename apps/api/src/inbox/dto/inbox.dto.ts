import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
    INBOX_ITEM_STATUSES,
    INBOX_MAX_OPTION_ID_CHARS,
    INBOX_MAX_REPLY_CHARS,
    type InboxItemStatus,
} from '@ever-works/contracts';

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
