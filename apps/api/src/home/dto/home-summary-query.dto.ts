import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    MaxLength,
    ValidateBy,
} from 'class-validator';
import { HOME_BLOCK_IDS, isHomeTimezone, type HomeBlockId } from '@ever-works/contracts';

/** `?blocks=a,b` and `?blocks=a&blocks=b` both arrive as a list; empty segments are dropped. */
function toList({ value }: { value: unknown }): unknown {
    if (value === undefined || value === null || value === '') return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((part) =>
        typeof part === 'string' ? part.split(',') : [part],
    );
    return parts
        .map((part) => (typeof part === 'string' ? part.trim() : part))
        .filter((part) => part !== '');
}

/**
 * `GET /api/home/summary` query. There is deliberately no user or
 * organization parameter: the owner comes from the session and the scope
 * from the request scope context, never from the query string.
 */
export class HomeSummaryQueryDto {
    @ApiPropertyOptional({
        description:
            'IANA timezone "today" is computed in, e.g. `Europe/Kyiv`. Omitted = the profile timezone, else UTC.',
        maxLength: 64,
        type: String,
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    // "The runtime can compute a day in it" — the rule the Runs ledger's window
    // resolver applies — rather than a fixed list, so a browser reporting a
    // current IANA name (`Europe/Kyiv`) is not refused.
    @ValidateBy({
        name: 'isHomeTimezone',
        validator: {
            validate: (value: unknown) => isHomeTimezone(value),
            defaultMessage: () => 'tz must be a valid IANA timezone identifier',
        },
    })
    tz?: string;

    @ApiPropertyOptional({
        description: 'Comma-separated blocks to read (a per-block retry). Omitted = every block.',
        enum: HOME_BLOCK_IDS,
        isArray: true,
    })
    @IsOptional()
    @Transform(toList)
    @IsArray()
    @ArrayMaxSize(HOME_BLOCK_IDS.length)
    @IsIn(HOME_BLOCK_IDS as unknown as HomeBlockId[], { each: true })
    blocks?: HomeBlockId[];
}
