import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsIn,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import {
    APP_BUILD_LIST_MAX_PAGE_SIZE,
    APP_BUILD_LIST_PAGE_SIZE,
    APP_BUILD_STATUSES,
    APP_BUILD_TRIGGERS,
} from '@ever-works/contracts';

/**
 * APW-05 T23 — the request shapes of the Builds routes (plan §5).
 *
 * The API's global `ValidationPipe` runs with `whitelist`, `transform` and
 * `forbidNonWhitelisted`, so every field a route accepts is declared here and
 * nothing else reaches the controller. The answers are the shared contract types
 * in `@ever-works/contracts` (`AppBuildListResponse`, `AppBuildRequestResponse`,
 * `AppBuildCancelResponse`, `AppBuildPullTokenResponse`), so the web client and
 * the controller read one declaration.
 */

/** `a` or `a,b,c` where every entry is one of `values`. */
function commaListPattern(values: readonly string[]): RegExp {
    const one = `(?:${values.join('|')})`;
    return new RegExp(`^${one}(?:,${one})*$`);
}

/** `GET /api/works/:id/builds` query (plan §5:1194). */
export class ListAppBuildsQueryDto {
    @ApiPropertyOptional({ description: 'Page number, from 1.', minimum: 1, default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @ApiPropertyOptional({
        description: 'Rows per page.',
        minimum: 1,
        maximum: APP_BUILD_LIST_MAX_PAGE_SIZE,
        default: APP_BUILD_LIST_PAGE_SIZE,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(APP_BUILD_LIST_MAX_PAGE_SIZE)
    pageSize?: number;

    @ApiPropertyOptional({
        description: `One status or several, comma-separated: ${APP_BUILD_STATUSES.join(', ')}.`,
        example: 'running,queued',
    })
    @IsOptional()
    @IsString()
    @Matches(commaListPattern(APP_BUILD_STATUSES), {
        message: `status must be one or more of ${APP_BUILD_STATUSES.join(', ')}, comma-separated`,
    })
    status?: string;

    @ApiPropertyOptional({
        description: `One trigger or several, comma-separated: ${APP_BUILD_TRIGGERS.join(', ')}.`,
        example: 'push,manual',
    })
    @IsOptional()
    @IsString()
    @Matches(commaListPattern(APP_BUILD_TRIGGERS), {
        message: `trigger must be one or more of ${APP_BUILD_TRIGGERS.join(', ')}, comma-separated`,
    })
    trigger?: string;

    @ApiPropertyOptional({ description: 'Only Builds of this branch.' })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    branch?: string;

    @ApiPropertyOptional({ description: 'Only Builds of this pull request number.', minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    pullRequest?: number;
}

/** `POST /api/works/:id/builds` body (plan §5:1196). */
export class CreateAppBuildDto {
    @ApiPropertyOptional({
        description:
            'The commit to build — 40 hex characters, reachable from the tracked branch. Omit to build ' +
            "the tracked branch's head.",
        pattern: '^[0-9a-f]{40}$',
    })
    @IsOptional()
    @IsString()
    @Matches(/^[0-9a-f]{40}$/i, { message: 'commitSha must be a 40-character hex commit sha' })
    commitSha?: string;

    @ApiPropertyOptional({
        description: 'Only `build` is accepted over HTTP; verification Builds are internal.',
        enum: ['build'],
    })
    @IsOptional()
    @IsIn(['build'])
    mode?: 'build';
}

/** `PUT /api/works/:id/builds/pull-token` body (plan §5:1198, `APW05-G07`). */
export class SaveAppBuildPullTokenDto {
    @ApiProperty({
        description:
            'A classic GitHub token with `read:packages` only. Stored encrypted; never returned by any route.',
        writeOnly: true,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(1024)
    token: string;
}
