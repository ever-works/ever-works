import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DIGEST_PERIODS, type DigestPeriod } from '@ever-works/agent/digest';

/**
 * Query for `GET /api/digest`.
 *
 * `period` is the only knob: the digest is always composed for the
 * CURRENT user over the trailing window of that period. There is no
 * `userId` parameter by design — see the controller header.
 *
 * The allowed values come from `DIGEST_PERIODS` in the agent package, so
 * adding a period there cannot leave this DTO behind.
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
}
