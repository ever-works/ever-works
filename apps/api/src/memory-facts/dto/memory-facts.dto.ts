import { Transform, Type } from 'class-transformer';
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
    ValidateIf,
} from 'class-validator';
import {
    MEMORY_FACT_LIST_LIMIT_MAX,
    MEMORY_FACT_SCOPES,
    MEMORY_FACT_STATUSES,
    type MemoryFactScope,
    type MemoryFactStatus,
} from '@ever-works/contracts';

/**
 * Transport bound on a body BEFORE the service trims and counts it.
 *
 * Deliberately looser than the 500-character fact limit: the service is the
 * one place that limit is enforced, and it answers with the character count
 * ("this one is 612") — a class-validator `MaxLength(500)` here would refuse
 * first with a generic message and hide the number the owner needs.
 */
const BODY_TRANSPORT_MAX = 4000;

/** `?pinnedOnly=true` arrives as a string; anything but `true` is false. */
function toBoolean({ value }: { value: unknown }): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}

/** Query for `GET /api/memory/facts`. The workspace comes from the scope context. */
export class ListMemoryFactsQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    q?: string;

    @IsOptional()
    @IsIn(MEMORY_FACT_STATUSES as unknown as readonly string[])
    status?: MemoryFactStatus;

    @IsOptional()
    @IsIn(MEMORY_FACT_SCOPES as unknown as readonly string[])
    scope?: MemoryFactScope;

    @IsOptional()
    @IsUUID()
    agentId?: string;

    @IsOptional()
    @Transform(toBoolean)
    @IsBoolean()
    pinnedOnly?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(MEMORY_FACT_LIST_LIMIT_MAX)
    limit?: number;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    cursor?: string;
}

/** Body for `POST /api/memory/facts`. */
export class CreateMemoryFactDto {
    @IsString()
    @MaxLength(BODY_TRANSPORT_MAX)
    body: string;

    @IsOptional()
    @IsIn(MEMORY_FACT_SCOPES as unknown as readonly string[])
    scope?: MemoryFactScope;

    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsUUID()
    agentId?: string | null;

    @IsOptional()
    @IsBoolean()
    pinned?: boolean;

    /** The chat conversation a "remember…" turn came from, when there was one. */
    @IsOptional()
    @IsUUID()
    sourceConversationId?: string;
}

/** Body for `PATCH /api/memory/facts/:id`. Every field optional. */
export class UpdateMemoryFactDto {
    @IsOptional()
    @IsString()
    @MaxLength(BODY_TRANSPORT_MAX)
    body?: string;

    @IsOptional()
    @IsIn(MEMORY_FACT_SCOPES as unknown as readonly string[])
    scope?: MemoryFactScope;

    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsUUID()
    agentId?: string | null;

    @IsOptional()
    @IsBoolean()
    pinned?: boolean;
}

/**
 * Body for `POST /api/memory/facts/forget-all`.
 *
 * Validated as a plain string, NOT with `@Equals('FORGET ALL')`: a wrong
 * confirmation is a 422 "type it exactly" from the controller, never a 400
 * validation error that looks like a malformed request.
 */
export class ForgetAllMemoryFactsDto {
    @IsOptional()
    @IsString()
    @MaxLength(64)
    confirm?: string;
}
