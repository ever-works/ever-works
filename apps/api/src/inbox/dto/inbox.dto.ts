import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
    INBOX_ITEM_STATUSES,
    INBOX_MAX_OPTION_ID_CHARS,
    INBOX_MAX_REPLY_CHARS,
    type InboxItemStatus,
} from '@ever-works/contracts';

export class ListInboxQueryDto {
    /** Omitted = the active view (everything not archived). */
    @IsOptional()
    @IsIn(INBOX_ITEM_STATUSES as readonly string[])
    status?: InboxItemStatus;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

export class ReplyInboxItemDto {
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_MAX_REPLY_CHARS)
    text?: string;

    @IsOptional()
    @IsString()
    @MaxLength(INBOX_MAX_OPTION_ID_CHARS)
    optionId?: string;
}

export class SetInboxReadStateDto {
    /** `true` marks unread again; `false` (default) marks read. */
    @IsOptional()
    @IsBoolean()
    unread?: boolean;
}
