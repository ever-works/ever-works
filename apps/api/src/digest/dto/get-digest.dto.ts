import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    DIGEST_PERIODS,
    DIGEST_SCOPES,
    type DigestPeriod,
    type DigestScope,
} from '@ever-works/agent/digest';

/**
 * Query for `GET /api/digest`.
 *
 * `period` picks the trailing window; `scope` picks WHAT is aggregated.
 *
 * There is still no `userId` parameter, and deliberately no
 * `organizationId` one either: the personal digest is always composed
 * for the session's own user, and the organization digest is always
 * composed for the session's ACTIVE organization (resolved from the
 * request scope context, then re-checked against the caller's tenant).
 * Accepting either id from the client would turn this read into a
 * cross-tenant activity oracle — see the controller header.
 *
 * The allowed values come from `DIGEST_PERIODS` / `DIGEST_SCOPES` in the
 * agent package, so adding one there cannot leave this DTO behind.
 */
export class GetDigestQueryDto {
    @ApiPropertyOptional({
        description: 'Digest window. Defaults to `daily`.',
        enum: DIGEST_PERIODS as unknown as string[],
        default: 'daily',
    })
    @IsOptional()
    @IsIn(DIGEST_PERIODS as unknown as string[])
    period?: DigestPeriod;

    @ApiPropertyOptional({
        description:
            "What to aggregate: `personal` (the caller's own activity, default) or `organization` (the active organization's activity). The organization is taken from the request scope, never from a parameter.",
        enum: DIGEST_SCOPES as unknown as string[],
        default: 'personal',
    })
    @IsOptional()
    @IsIn(DIGEST_SCOPES as unknown as string[])
    scope?: DigestScope;
}
