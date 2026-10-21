import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetCheckoutService, type FleetCheckoutActor } from '@ever-works/agent/fleet';
import type { FleetCheckoutChangesReply, FleetCheckoutPullRequestFacts } from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetCheckoutsEnabledGuard } from '../checkouts/fleet-checkouts-enabled.guard';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetSessionsEnabledGuard } from '../sessions/fleet-sessions-enabled.guard';
import { FleetCheckoutChangesQueryDto } from './dto/fleet-session-git.dto';
import { FleetPrEnrichmentService } from './fleet-pr-enrichment.service';

function actorOf(auth: AuthenticatedUser): FleetCheckoutActor {
    return { userId: auth.userId };
}

/**
 * Session git & actions (FL-06, plan §5, CONTRACTS §11.2) — the checkout
 * routes a session's git line and Changes view read. Dark unless both
 * `FLEET_SESSIONS_ENABLED` and `FLEET_CHECKOUTS_ENABLED` are on (404).
 *
 * `GET /api/fleet/sessions/branch-proposal` lives on FL-04's sessions
 * controller, above `sessions/:id`, so the literal segment is never read as
 * an id.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetSessionsEnabledGuard, FleetCheckoutsEnabledGuard)
export class FleetSessionGitController {
    constructor(
        private readonly checkouts: FleetCheckoutService,
        private readonly enrichment: FleetPrEnrichmentService,
    ) {}

    @Get('checkouts/:id/changes')
    @ApiOperation({
        summary:
            'The uncommitted diff of one checkout, read on the computer: changed files with lines added and removed, each patch as plain text (staged and unstaged against HEAD, untracked text files too), capped at 1 MiB in all and 64 KiB per file, saying what was left out. Needs `--manage` on the computer (`--work` for a Task’s worktree). Refused while the computer is offline (`unreachable`) or the kill switch is on.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async changes(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetCheckoutChangesQueryDto,
    ): Promise<FleetCheckoutChangesReply> {
        return this.checkouts.changes(id, actorOf(auth), query.maxBytes);
    }

    @Get('checkouts/:id/pull-request')
    @ApiOperation({
        summary:
            'The pull request whose head is this checkout’s branch, resolved through the GitHub App (at most once a minute): state, checks roll-up, mergeability, open review comments, the default branch. When GitHub cannot be reached the last good answer is returned with `unknownSince`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async pullRequest(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCheckoutPullRequestFacts> {
        return this.enrichment.factsFor(id, actorOf(auth));
    }
}
