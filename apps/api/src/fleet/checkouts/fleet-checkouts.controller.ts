import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FleetCheckoutService,
    type FleetCheckoutActor,
    type FleetCheckoutListQuery,
} from '@ever-works/agent/fleet';
import {
    FLEET_CHECKOUT_WRITES_PER_MINUTE,
    type FleetCheckoutCreateResponse,
    type FleetCheckoutListResponse,
    type FleetCheckoutOperationResponse,
    type FleetCheckoutView,
    type FleetNodeCheckoutsResponse,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    ArchiveFleetCheckoutDto,
    CreateFleetCheckoutDto,
    DeleteFleetCheckoutDto,
    DeleteFleetCheckoutQueryDto,
    ListFleetCheckoutsQueryDto,
    ListNodeCheckoutsQueryDto,
    SyncFleetCheckoutDto,
} from './dto/fleet-checkout.dto';
import { FleetCheckoutsEnabledGuard } from './fleet-checkouts-enabled.guard';
import { FleetConfirmationInterceptor } from '../tools/fleet-confirmation.interceptor';

function actorOf(auth: AuthenticatedUser): FleetCheckoutActor {
    return { userId: auth.userId };
}

function listQuery(
    query: ListFleetCheckoutsQueryDto,
): FleetCheckoutListQuery & { nodeId?: string } {
    const out: FleetCheckoutListQuery & { nodeId?: string } = {};
    if (query.nodeId) out.nodeId = query.nodeId;
    if (query.workId) out.workId = query.workId;
    if (query.state) out.state = query.state;
    if (query.kind) out.kind = query.kind;
    if (query.limit !== undefined) out.limit = query.limit;
    if (query.cursor) out.cursor = query.cursor;
    return out;
}

/**
 * Checkouts on computers (FL-14, plan §5, CONTRACTS §11.2) — the REST surface
 * over `FleetCheckoutService`, the one writer of `fleet_checkouts`.
 *
 * Gates, in order: `FleetEnabledGuard` (the whole fleet), then
 * `FleetCheckoutsEnabledGuard` (`FLEET_CHECKOUTS_ENABLED`, default off; 404),
 * then the global auth guard (no route here is public), then the service's
 * own chain for every act: the checkout or computer exists and sits in the
 * caller's family audience (reads under `view`, acts under `checkouts`; a
 * stranger reads the 404 of an unknown id, a member outside the audience
 * `permission_denied` naming who to ask), the write rate, the kill switch,
 * the act's rules, the machine through the node link, then one `fleet_audit`
 * row. Every refusal is the CONTRACTS §8 envelope with its status, thrown by
 * the service and passed through untouched.
 *
 * P2 adds create (`POST /checkouts`), pull and push, and delete
 * (`DELETE /checkouts/:id`, with FL-06's `?cleanUp=1` gate). The node-facing
 * credential route lives in `FleetCheckoutsNodeController` (node-authenticated).
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetCheckoutsEnabledGuard)
// FL-19 (CONTRACTS §2.2) — one `confirmation_required` answer for every caller: the class from
// the catalogue, the hint that says what to send; token-style fields are ignored.
@UseInterceptors(FleetConfirmationInterceptor)
export class FleetCheckoutsController {
    constructor(private readonly checkouts: FleetCheckoutService) {}

    @Get('checkouts')
    @ApiOperation({
        summary:
            'Every checkout (git clone or worktree) on every computer I may see, by path, one page at a time. The bin (`state=archived`) is left out unless asked for.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListFleetCheckoutsQueryDto,
    ): Promise<FleetCheckoutListResponse> {
        return this.checkouts.list(actorOf(auth), listQuery(query));
    }

    @Get('nodes/:id/checkouts')
    @ApiOperation({
        summary:
            "One computer's checkouts and its code folders. Asks the computer first when it is connected (git lines older than five minutes are recomputed); otherwise answers the last-known rows with `stale` saying why. `rescan=true` scans the code folders now (needs `--manage`).",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async listForNode(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListNodeCheckoutsQueryDto,
    ): Promise<FleetNodeCheckoutsResponse> {
        return this.checkouts.listForNode(id, actorOf(auth), {
            rescan: query.rescan === true,
            refresh: query.refresh === true,
            ...(query.state ? { state: query.state } : {}),
        });
    }

    @Get('checkouts/:id')
    @ApiOperation({ summary: 'One checkout. A checkout on a computer I may not see answers 404.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCheckoutView> {
        return this.checkouts.get(id, actorOf(auth));
    }

    @Post('checkouts/:id/refresh')
    @ApiOperation({
        summary:
            "Recompute one checkout's git line on the computer now (at most once per 10 seconds per checkout). Never contacts the remote.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async refresh(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCheckoutOperationResponse> {
        return this.checkouts.refresh(id, actorOf(auth));
    }

    @Post('checkouts/:id/sync')
    @ApiOperation({
        summary:
            'Fetch, pull (fast-forward only) or push a checkout on the computer. Fetch needs no confirmation and is allowed while a session runs in it; pull and push need `confirm: true` (without it: `confirmation_required` naming the branch and remote) and wait for any session working in it. Answers at once with the operation id when the computer is still working.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: FLEET_CHECKOUT_WRITES_PER_MINUTE, ttl: 60_000 } })
    async sync(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SyncFleetCheckoutDto,
    ): Promise<FleetCheckoutOperationResponse> {
        return this.checkouts.sync(id, actorOf(auth), {
            op: body.op,
            ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
        });
    }

    @Post('checkouts')
    @ApiOperation({
        summary:
            'Create a checkout on a computer: a fresh clone (with a repository-scoped, short-lived credential when a GitHub App installation covers the repository) or a worktree of a checkout on the same computer, on a new branch made unique by the branch rule. Answers at once with the checkout in `creating` and the link operation id.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: FLEET_CHECKOUT_WRITES_PER_MINUTE, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateFleetCheckoutDto,
    ): Promise<FleetCheckoutCreateResponse> {
        const source =
            body.source.kind === 'worktree'
                ? {
                      kind: 'worktree' as const,
                      parentCheckoutId: body.source.parentCheckoutId ?? '',
                  }
                : { kind: 'clone' as const, repoUrl: body.source.repoUrl ?? '' };
        return this.checkouts.create(actorOf(auth), {
            nodeId: body.nodeId,
            source,
            ...(body.branch !== undefined ? { branch: body.branch } : {}),
            ...(body.baseRef !== undefined ? { baseRef: body.baseRef } : {}),
            ...(body.isolation !== undefined ? { isolation: body.isolation } : {}),
            ...(body.sharedFolders !== undefined ? { sharedFolders: body.sharedFolders } : {}),
        });
    }

    @Delete('checkouts/:id')
    @ApiOperation({
        summary:
            'Delete a checkout Ever Works created (its folder; a worktree keeps its branch) or forget one (`mode: forget`, row only). Without a confirmation the answer is 409 `confirmation_required` with what the computer says would be lost: `confirm: true` when nothing would be, else `confirmName` = the folder name. `?cleanUp=1` applies FL-06’s Clean up gate first.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: FLEET_CHECKOUT_WRITES_PER_MINUTE, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: DeleteFleetCheckoutDto,
        @Query() query: DeleteFleetCheckoutQueryDto,
    ): Promise<FleetCheckoutView | { forgotten: true; id: string }> {
        return this.checkouts.remove(
            id,
            actorOf(auth),
            {
                ...(body?.mode ? { mode: body.mode } : {}),
                ...(body?.confirm !== undefined ? { confirm: body.confirm } : {}),
                ...(body?.confirmName !== undefined ? { confirmName: body.confirmName } : {}),
                ...(body?.expected ? { expected: body.expected } : {}),
            },
            { cleanUp: query.cleanUp === true },
        );
    }

    @Post('checkouts/:id/archive')
    @ApiOperation({
        summary:
            'Move a checkout to the bin. The folder on the computer is not touched. Needs `confirm: true` (without it: `confirmation_required` and the sentence to show). Refused while a session works in it.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_CHECKOUT_WRITES_PER_MINUTE, ttl: 60_000 } })
    async archive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ArchiveFleetCheckoutDto,
    ): Promise<FleetCheckoutView> {
        return this.checkouts.archive(id, actorOf(auth), { confirm: body?.confirm === true });
    }

    @Post('checkouts/:id/restore')
    @ApiOperation({
        summary:
            'Bring a checkout back from the bin — only while its folder is still on the computer (the computer is asked).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_CHECKOUT_WRITES_PER_MINUTE, ttl: 60_000 } })
    async restore(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetCheckoutView> {
        return this.checkouts.restore(id, actorOf(auth));
    }
}
