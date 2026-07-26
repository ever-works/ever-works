import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DigestService, type ComposedDigest } from '@ever-works/agent/digest';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { GetDigestQueryDto } from './dto/get-digest.dto';

/**
 * Digest read surface:
 *
 *   GET /api/digest?period=daily|weekly
 *     → the composed digest for the CURRENT user
 *
 * Why this exists: `DigestService.composeDigest` shipped with two ways
 * in — the `digest-dispatcher` cron (delivery) and the `get_digest`
 * agent chat tool — and no REST route. The web tool registry is
 * manifest-driven over REST operations, so `get_digest` could not be
 * registered on the web side at all: the platform and the web agent
 * disagreed about which tools exist. This is the missing read.
 *
 * Security: the digest is composed for `auth.userId` and NOTHING ELSE.
 * There is deliberately no `userId` query parameter — a digest is an
 * aggregate over the caller's runs, tasks, PRs, ingested events and
 * goals, so an accepted "compose for user X" parameter would be a
 * ready-made cross-tenant activity oracle. Delivery to OTHER users stays
 * where it was, behind the cron's internal RPC.
 *
 * Read-only: composition never writes, so calling this endpoint does not
 * consume the user's scheduled digest or change delivery state
 * (`deliverDigest` is the thing that does, and it is not exposed here).
 */
@ApiTags('digest')
@Controller('api/digest')
export class DigestController {
    constructor(private readonly digest: DigestService) {}

    @Get()
    @ApiOperation({
        summary:
            'Get my composed activity digest (runs, tasks, PRs, ingested events, goal progress) for the daily or weekly window.',
    })
    @HttpCode(HttpStatus.OK)
    async getDigest(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: GetDigestQueryDto,
    ): Promise<ComposedDigest> {
        return this.digest.composeDigest(auth.userId, { period: query.period ?? 'daily' });
    }
}
