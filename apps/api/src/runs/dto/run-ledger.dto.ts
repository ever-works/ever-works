import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateBy,
    type ValidationOptions,
} from 'class-validator';
import {
    isRunLedgerCalendarDate,
    RUN_LEDGER_GRANULARITIES,
    RUN_LEDGER_MAX_AGENT_FILTERS,
    RUN_LEDGER_MAX_LIMIT,
    RUN_LEDGER_SEARCH_MAX_LENGTH,
    RUN_LEDGER_SEARCH_MIN_LENGTH,
    RUN_LEDGER_STATUSES,
    RUN_LEDGER_TRIGGER_KINDS,
    type RunLedgerFilters,
    type RunLedgerGranularity,
    type RunLedgerStatus,
    type RunLedgerTriggerKind,
} from '@ever-works/contracts';

/**
 * Valid IANA timezones, computed once. `Intl.supportedValuesOf` omits the
 * universally valid `UTC` / `GMT` aliases, so they are added explicitly —
 * the same allowance the notification quiet-hours DTO makes.
 */
const VALID_TIMEZONES = new Set<string>([
    ...(Intl as typeof Intl & { supportedValuesOf(key: string): string[] }).supportedValuesOf(
        'timeZone',
    ),
    'UTC',
    'GMT',
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `<epochMillis>_<uuid>` — the same cursor shape the session timeline uses. */
const CURSOR_PATTERN = /^\d{1,15}_[0-9a-fA-F-]{36}$/;

/**
 * A real Gregorian calendar date. The `YYYY-MM-DD` shape alone admits
 * `2026-02-31`, which the window resolver would otherwise treat as "no
 * anchor" and silently answer with today's runs — so an impossible date is
 * rejected here, at the edge, with the predicate the dashboard's URL parser
 * shares.
 */
function IsCalendarDate(validationOptions?: ValidationOptions): PropertyDecorator {
    return ValidateBy(
        {
            name: 'isCalendarDate',
            validator: {
                // A wrong type or shape is already reported by `@IsString` /
                // `@Matches`; only a well-shaped impossible date fails here.
                validate: (value: unknown): boolean =>
                    typeof value !== 'string' ||
                    !DATE_PATTERN.test(value) ||
                    isRunLedgerCalendarDate(value),
                defaultMessage: () => 'date must be a real calendar date',
            },
        },
        validationOptions,
    );
}

/**
 * A multi-value query parameter arrives as a string (`?status=failed`) or an
 * array (`?status=failed&status=cancelled`); a comma-separated single value
 * is accepted too. Normalised to a trimmed, de-duplicated string array.
 */
function toStringArray({ value }: { value: unknown }): string[] | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const raw = Array.isArray(value) ? value : [value];
    const parts = raw
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return parts.length > 0 ? Array.from(new Set(parts)) : undefined;
}

/**
 * The window + filter fields every ledger read shares. No field names a
 * user, Organization or tenant: the caller is always the authenticated user
 * and the Organization comes from the request scope, never from the query.
 */
export class RunLedgerFilterQueryDto {
    @ApiProperty({ required: false, enum: RUN_LEDGER_GRANULARITIES, default: 'day' })
    @IsOptional()
    @IsIn(RUN_LEDGER_GRANULARITIES as unknown as string[])
    granularity?: RunLedgerGranularity;

    @ApiProperty({
        required: false,
        description: 'Anchor date `YYYY-MM-DD` in `timezone`; today when omitted.',
    })
    @IsOptional()
    @IsString()
    @Matches(DATE_PATTERN, { message: 'date must be YYYY-MM-DD' })
    @IsCalendarDate()
    date?: string;

    @ApiProperty({ required: false, description: 'IANA timezone; UTC when omitted.' })
    @IsOptional()
    @IsString()
    @IsIn([...VALID_TIMEZONES], { message: 'timezone must be a valid IANA timezone identifier' })
    timezone?: string;

    @ApiProperty({ required: false, type: [String], format: 'uuid' })
    @IsOptional()
    @Transform(toStringArray)
    @ArrayMaxSize(RUN_LEDGER_MAX_AGENT_FILTERS)
    @IsUUID('all', { each: true })
    agentId?: string[];

    @ApiProperty({ required: false, isArray: true, enum: RUN_LEDGER_TRIGGER_KINDS })
    @IsOptional()
    @Transform(toStringArray)
    @IsIn(RUN_LEDGER_TRIGGER_KINDS as unknown as string[], { each: true })
    kind?: RunLedgerTriggerKind[];

    @ApiProperty({ required: false, isArray: true, enum: RUN_LEDGER_STATUSES })
    @IsOptional()
    @Transform(toStringArray)
    @IsIn(RUN_LEDGER_STATUSES as unknown as string[], { each: true })
    status?: RunLedgerStatus[];

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID('all')
    workId?: string;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID('all')
    missionId?: string;

    @ApiProperty({
        required: false,
        minLength: RUN_LEDGER_SEARCH_MIN_LENGTH,
        maxLength: RUN_LEDGER_SEARCH_MAX_LENGTH,
        description: 'Matched against the run summary and error message.',
    })
    @IsOptional()
    @IsString()
    @MinLength(RUN_LEDGER_SEARCH_MIN_LENGTH)
    @MaxLength(RUN_LEDGER_SEARCH_MAX_LENGTH)
    q?: string;
}

/** `GET /api/runs` — one cursor page of the ledger. */
export class ListRunsQueryDto extends RunLedgerFilterQueryDto {
    @ApiProperty({ required: false, minimum: 1, maximum: RUN_LEDGER_MAX_LIMIT, default: 50 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(RUN_LEDGER_MAX_LIMIT)
    limit?: number;

    @ApiProperty({ required: false, description: 'Opaque cursor from the previous page.' })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    @Matches(CURSOR_PATTERN, { message: 'cursor is malformed' })
    cursor?: string;
}

/** `GET /api/runs/stats` — the window totals. */
export class RunStatsQueryDto extends RunLedgerFilterQueryDto {}

/** `GET /api/runs/calendar` — days with runs in one month. */
export class RunCalendarQueryDto extends RunLedgerFilterQueryDto {
    @ApiProperty({ required: true, description: 'Calendar month `YYYY-MM`.' })
    @IsString()
    @Matches(MONTH_PATTERN, { message: 'month must be YYYY-MM' })
    month!: string;
}

/** Map the shared query fields onto the read model's filter shape. */
export function toRunLedgerFilters(query: RunLedgerFilterQueryDto): RunLedgerFilters {
    return {
        agentIds: query.agentId,
        triggerKinds: query.kind,
        statuses: query.status,
        workId: query.workId,
        missionId: query.missionId,
        search: query.q,
    };
}
