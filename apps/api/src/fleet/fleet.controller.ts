import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
    Res,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type {
    CreateEnrollmentTokenResult,
    FleetEnrollmentTokenView,
} from '@ever-works/agent/fleet';
import {
    FleetAuditService,
    FleetCostCeilingService,
    FleetExecutionPreferenceService,
    FleetJobService,
    FleetService,
    NeedsALookService,
    fleetOwnerOnlyBody,
} from '@ever-works/agent/fleet';
import type {
    FleetAuditView,
    FleetCostCeilingView,
    FleetEnrollResponse,
    FleetExecutionPreferenceView,
    FleetHeartbeatResponse,
    FleetNodeRotateCredentialResponse,
    FleetNodeView,
    FleetRunnerStatusView,
    NeedsALookItem,
} from '@ever-works/contracts';
import { AgentRunRepository } from '@ever-works/agent/database';
import {
    COMPUTER_PENDING_SESSIONS,
    type ComputerPendingSessionsLookup,
} from '@ever-works/agent/computer';
import {
    FLEET_ATTENDED_CAPABILITY,
    FLEET_AUDIT_DEFAULT_LIMIT,
    NEEDS_A_LOOK_PARTIAL_HEADER,
} from '@ever-works/contracts';
import {
    FLEET_LINK_HEARTBEAT_OBSERVER,
    FLEET_LINK_NODE_LIFECYCLE,
    FLEET_LINK_NODE_STATE,
    type FleetLinkHeartbeatObserver,
    type FleetLinkNodeLifecycle,
    type FleetLinkNodeStateLookup,
} from '../fleet-link/fleet-link.types';
import { FleetPanicService } from './fleet-panic.service';
import { FleetRunnerStatusService } from './fleet-runner-status.service';
import {
    buildNodeJobHistory,
    isFailedNodeHistoryEntry,
    nodeHistoryRunIds,
} from './fleet-node-history';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { FleetNodeDetailView, FleetNodeDrainResult } from './fleet-admin.types';
import {
    ClearFleetExecutionPreferenceDto,
    ClearFleetNodeModelThrottleDto,
    CreateFleetEnrollmentTokenDto,
    DrainFleetNodeDto,
    EnrollFleetNodeDto,
    FleetHeartbeatDto,
    FleetNodePauseDto,
    FleetUnenrollDto,
    FLEET_NODE_LIST_SCOPES,
    RotateFleetNodeCredentialDto,
    SetFleetCostCeilingDto,
    SetFleetNodeLimitCeilingDto,
    SetFleetExecutionPreferenceDto,
    UpdateFleetNodeDto,
} from './dto/fleet.dto';
import { FleetAuditQueryDto } from './dto/fleet-kill-switch.dto';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/** How much of a node's job history the detail drawer reads. */
const NODE_HISTORY_LIMIT = 25;

/**
 * Fleet hub (FL-01) — set on a needs-a-look response when at least one
 * producer failed or timed out and was skipped (spec U11): the list is what
 * the others said, not proof that nothing needs a look.
 */
export const FLEET_PARTIAL_HEADER = NEEDS_A_LOOK_PARTIAL_HEADER;

/** The one thing the needs-a-look routes do with the response (same posture as the CSV export's). */
type HeaderResponse = { setHeader(name: string, value: string): void };

/**
 * Fleet (Wave 12, slice 1) — thin HTTP surface over the agent-side
 * `FleetService`.
 *
 * Owner-scoped (session/API-key auth via the global guard):
 *   GET    /api/fleet/nodes                   list mine (incl. live
 *                                             own-cluster nodes)
 *   GET    /api/fleet/nodes/:id               node detail + job/failure
 *                                             history
 *   POST   /api/fleet/nodes/enrollment-token  issue one-time token
 *   PATCH  /api/fleet/nodes/:id               rename / disable / enable /
 *                                             edit capability tags
 *   POST   /api/fleet/nodes/:id/rotate        re-key: new one-time token,
 *                                             old secret dies immediately
 *   GET    /api/fleet/nodes/:id/audit         this node's lifecycle trail
 *   POST   /api/fleet/nodes/:id/drain         drain: disable AND requeue
 *                                             the node's in-flight claims
 *   PUT    /api/fleet/nodes/:id/limits        platform-side ceiling on the
 *                                             node's resource limits (AS)
 *   PATCH  /api/fleet/nodes/:id               rename / pause / disable
 *   DELETE /api/fleet/nodes/:id               remove registration
 *   GET    /api/fleet/enrollment-tokens       outstanding (unused) tokens
 *   DELETE /api/fleet/enrollment-tokens/:id   revoke one BEFORE it is used
 *   GET    /api/fleet/runner-status           compact N-of-M runner status
 *                                             behind the sidebar pill
 *   GET    /api/fleet/execution-preferences   local-vs-cloud routing rows
 *   PUT    /api/fleet/execution-preference    set one scope's routing
 *   DELETE /api/fleet/execution-preference    clear one scope's routing
 *   GET    /api/fleet/cost-ceiling            fleet-wide daily model-spend
 *                                             ceiling + today's spend
 *   PUT    /api/fleet/cost-ceiling            set / clear that ceiling
 *
 * Panic controls (EW-778), on their own controllers:
 *   POST   /api/fleet/drain-all               drain EVERY node I own
 *   POST   /api/fleet/cancel-in-flight        cancel my running fleet work
 *                                             (explicit second step)
 *   POST   /api/fleet/rotate-all              QUEUE a credential rotation
 *                                             on every node I own; each
 *                                             machine re-keys itself on
 *                                             its next beat
 *   GET    /api/fleet/kill-switch             is the global stop flag set?
 *   POST   /api/fleet/kill-switch/stop        platform admin: set it
 *   POST   /api/fleet/kill-switch/clear       platform admin: clear it
 *   GET    /api/fleet/kill-switch/audit       platform admin: audit trail
 *
 * Public, self-authenticating (called by the node apps — throttled,
 * fail-closed: any invalid credential path is one undifferentiated
 * 401, mirroring the terminal internal endpoints' posture):
 *   POST   /api/fleet/enroll                  consume token → secret
 *   POST   /api/fleet/heartbeat               node secret → last-seen
 *
 * **Scoping.** EVERY owner-scoped route resolves its target through
 * `FleetService`'s owner-scoped lookups, which answer 404 for another
 * account's node id — indistinguishable from one that does not exist.
 * No route accepts an owner/organization id from the caller; the scope
 * comes from the session. That is what stops a node id (a value that
 * travels: it is printed in UIs, logs and job payloads) from being a
 * cross-account read primitive.
 *
 * `FleetEnabledGuard` gates the class on `FLEET_ENABLED`, so the
 * registry and the node work channel go dark together.
 *   POST   /api/fleet/pause                   node drains/resumes itself
 *   POST   /api/fleet/unenroll                node retires itself
 *   POST   /api/fleet/rotate-credential       node re-keys itself; both
 *                                             credentials work for a
 *                                             bounded overlap
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetController {
    private readonly logger = new Logger(FleetController.name);

    constructor(
        private readonly service: FleetService,
        private readonly jobs: FleetJobService,
        private readonly runners: FleetRunnerStatusService,
        private readonly preferences: FleetExecutionPreferenceService,
        private readonly costCeiling: FleetCostCeilingService,
        // EW-778 — owns the per-node drain so that drain-all reuses it.
        private readonly panic: FleetPanicService,
        // EW-776 — the reconciled run outcome behind each history row.
        // Appended LAST and @Optional() so every positional construction
        // (the controller spec's included) keeps working, and so a missing
        // binding degrades to `reconciled: null` instead of a 500 on the
        // node drawer.
        @Optional() private readonly runs?: AgentRunRepository,
        // EW-799 — the one `fleet_audit` reader. @Optional() for the same
        // reason as `runs` above: every positional construction in the
        // specs keeps working, and a missing binding degrades to an empty
        // audit list rather than a 500 on the drawer.
        @Optional() private readonly audit?: FleetAuditService,
        // Agent computers — the live views waiting for a machine, read for
        // the heartbeat hint. Appended LAST + @Optional() like the two
        // above: unbound, the heartbeat response is exactly what it was.
        @Optional()
        @Inject(COMPUTER_PENDING_SESSIONS)
        private readonly pendingComputerSessions?: ComputerPendingSessionsLookup,
        // Fleet hub (FL-01) — the needs-a-look registry. Appended LAST and
        // @Optional() like the three above: unbound, both needs-a-look routes
        // answer an empty, complete list.
        @Optional() private readonly needsALook?: NeedsALookService,
        // Fleet node link (FL-02) — the consents a beat reported reach the
        // link (a withdrawn consent closes its channels), and the node views
        // show the link as the platform's own socket sees it. Appended LAST +
        // @Optional() like the four above: unbound, every response keeps
        // its exact shape.
        @Optional()
        @Inject(FLEET_LINK_HEARTBEAT_OBSERVER)
        private readonly linkHeartbeat?: FleetLinkHeartbeatObserver,
        @Optional()
        @Inject(FLEET_LINK_NODE_STATE)
        private readonly linkState?: FleetLinkNodeStateLookup,
        // A removed or re-keyed node's live link closes at once (FL-02).
        @Optional()
        @Inject(FLEET_LINK_NODE_LIFECYCLE)
        private readonly linkLifecycle?: FleetLinkNodeLifecycle,
    ) {}

    @Get('cost-ceiling')
    @ApiOperation({
        summary:
            "This account's FLEET-WIDE daily (UTC) model-spend ceiling — the owner's value, the deployment default it falls back to, the day it last drained the fleet, and today's spend across every node. Sums only what the owner's own machines reported, never cloud spend.",
    })
    @HttpCode(HttpStatus.OK)
    async getCostCeiling(@CurrentUser() auth: AuthenticatedUser): Promise<FleetCostCeilingView> {
        return this.costCeiling.describeForUser(auth.userId);
    }

    @Put('cost-ceiling')
    @ApiOperation({
        summary:
            'Set (or clear, with null) the fleet-wide daily model-spend ceiling. Crossing it drains every node of the account until they are re-enabled — a stop, not a rate limit.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async setCostCeiling(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: SetFleetCostCeilingDto,
    ): Promise<FleetCostCeilingView> {
        return this.costCeiling.setFleetCeilingForUser(auth.userId, body.dailyCeilingCents);
    }

    @Get('runner-status')
    @ApiOperation({
        summary:
            'Compact runner status for the always-visible runner indicator: N of M online, plus a per-node row (status, last heartbeat, daemon + agent-CLI version, free disk, busy). Owner-scoped; cluster-sourced nodes are excluded because the platform never leases work onto them.',
    })
    @HttpCode(HttpStatus.OK)
    // The pill polls this from every dashboard page. The throttle is
    // sized well above the 30s cadence the payload itself advertises, so
    // a couple of open tabs plus a manual refresh cannot trip it.
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async runnerStatus(@CurrentUser() auth: AuthenticatedUser): Promise<FleetRunnerStatusView> {
        return this.runners.snapshot(auth.userId);
    }

    @Get('execution-preferences')
    @ApiOperation({
        summary:
            'Every execution routing preference this owner has configured (account-wide, per Work, per Goal). Narrowest wins at dispatch time.',
    })
    @HttpCode(HttpStatus.OK)
    async listExecutionPreferences(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<FleetExecutionPreferenceView[]> {
        return this.preferences.listForUser(auth.userId);
    }

    @Put('execution-preference')
    @ApiOperation({
        summary:
            "Set where runs in one scope execute: 'local-wait' (fleet, waiting for a free runner slot), 'local-fallback' (fleet, falling back to the cloud with a notification) or 'cloud'.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async setExecutionPreference(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: SetFleetExecutionPreferenceDto,
    ): Promise<FleetExecutionPreferenceView> {
        // Every field the DTO accepts is forwarded — a body-mapping
        // whitelist that quietly drops one is how a shipped setting ends
        // up doing nothing.
        return this.preferences.setForUser(auth.userId, {
            scopeType: body.scopeType,
            scopeId: body.scopeId ?? null,
            mode: body.mode,
        });
    }

    @Delete('execution-preference')
    @ApiOperation({
        summary:
            'Clear one scope’s execution preference so it inherits from the next scope out. Idempotent — clearing an unset scope is a no-op, because "inherit" is already true when there is no row.',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async clearExecutionPreference(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ClearFleetExecutionPreferenceDto,
    ): Promise<void> {
        await this.preferences.clearForUser(auth.userId, query.scopeType, query.scopeId ?? null);
    }

    @Get('nodes')
    @ApiOperation({
        summary:
            'List my fleet nodes (enrolled machines + live nodes of my own configured clusters), each with its current execution load. `scope=visible` (the Fleet hub) also lists computers other people own that are shared with me through an Organization, each row carrying my role on it (`viewerRole`).',
    })
    @HttpCode(HttpStatus.OK)
    @ApiQuery({
        name: 'scope',
        required: false,
        enum: FLEET_NODE_LIST_SCOPES,
        description:
            '`own` (default): my computers. `visible`: also the computers shared with me through an Organization.',
    })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('scope') scope?: string,
    ): Promise<FleetNodeView[]> {
        // The default stays OWNER-ONLY, byte for byte: Settings → Fleet, the
        // panic controls and every existing caller keep reading exactly what
        // they read before the hub existed (spec FR-15). A single named query
        // value, not a whitelisted DTO, so any other query parameter is still
        // ignored rather than refused; an unknown scope reads as `own`.
        const nodes =
            scope === 'visible'
                ? await this.service.listVisibleForUser(auth.userId)
                : await this.service.listForUser(auth.userId);
        // Per-node load (Desktop PRD §4.1 "current load (running Tasks)")
        // is composed at the edge rather than inside `FleetService`, so
        // the registry stays independent of the job runtime. Strictly
        // best-effort: a load-lookup failure must never take down the
        // node list, which is the page's whole reason to exist.
        let load: Record<string, { activeJobCount: number }> = {};
        try {
            load = await this.jobs.loadByNodeForUser(auth.userId);
        } catch {
            load = {};
        }
        return nodes.map((node) => ({
            ...this.withLink(node),
            // Cluster-sourced rows are never leased onto, so they stay null.
            // A shared row is someone else's runner: its load is not in the
            // caller's job ledger, so it is not shown (null = idle/unknown).
            load: node.persisted ? (load[node.id] ?? null) : null,
        })) as FleetNodeView[];
    }

    @Get('needs-a-look')
    @ApiOperation({
        summary:
            'Fleet hub — what needs a look across every computer I may see (CONTRACTS §4.6): critical first, then warn, then info, the longest-standing first. Computed from the registered producers, never stored; a producer that fails is skipped and the response carries `X-Fleet-Partial: true`.',
    })
    @HttpCode(HttpStatus.OK)
    async needsALookFleet(
        @CurrentUser() auth: AuthenticatedUser,
        @Res({ passthrough: true }) res?: HeaderResponse,
    ): Promise<NeedsALookItem[]> {
        if (!this.needsALook) return [];
        const nodes = (
            await this.service.listVisibleForUser(auth.userId, { includeClusters: false })
        ).filter((node) => node.persisted);
        const result = await this.needsALook.forNodes(nodes, { userId: auth.userId });
        if (result.partial) res?.setHeader(FLEET_PARTIAL_HEADER, 'true');
        return result.items;
    }

    @Get('nodes/:id/needs-a-look')
    @ApiOperation({
        summary:
            'Fleet hub — what needs a look on one computer I may see. A computer outside my view answers 404, exactly like an unknown id.',
    })
    @HttpCode(HttpStatus.OK)
    async needsALookNode(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res?: HeaderResponse,
    ): Promise<NeedsALookItem[]> {
        // Visibility FIRST: a hidden node 404s before any producer runs.
        const { view } = await this.service.getVisibleForUser(auth.userId, id);
        if (!this.needsALook) return [];
        const result = await this.needsALook.forNodes([view], { userId: auth.userId });
        if (result.partial) res?.setHeader(FLEET_PARTIAL_HEADER, 'true');
        return result.items;
    }

    @Get('nodes/:id')
    @ApiOperation({
        summary:
            'One fleet node with its recent job history and the failed subset of it (owner-scoped; another account’s node id answers 404, exactly like an unknown one)',
    })
    @HttpCode(HttpStatus.OK)
    async detail(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeDetailView> {
        // Visibility is settled FIRST and by the registry: if this throws
        // 404 nothing else runs. The job history is the OWNER's ledger, so it
        // is read only for the owner — someone the node is shared with
        // (Fleet hub, `view` grants listing only) gets the node, no history.
        const { view: node, role } = await this.service.getVisibleForUser(auth.userId, id);

        let recentJobs: Awaited<ReturnType<FleetJobService['historyForNode']>> = [];
        let historyUnavailable = false;
        if (role === 'owner') {
            try {
                recentJobs = await this.jobs.historyForNode(auth.userId, id, NODE_HISTORY_LIMIT);
            } catch {
                // Same degradation contract as `list`: a job-runtime hiccup
                // must not make an existing node look missing.
                historyUnavailable = true;
            }
        }

        // The RECONCILED outcome (EW-776): a fleet job and the Agent run it
        // carried settle separately, so a job the node called `done` can
        // sit in front of a run that failed. One bulk read, owner-scoped in
        // the query, and strictly best-effort — a run-table hiccup leaves
        // `reconciled: null` ("not known") rather than taking the drawer
        // down or, worse, inventing an outcome.
        const runs = await this.readReconciledRuns(auth.userId, recentJobs);
        // `buildNodeJobHistory` also strips `payload` from every row. A
        // node's job payload is executor input composed from user content;
        // a settings endpoint has no reason to ship it.
        const history = buildNodeJobHistory(recentJobs, runs);

        return {
            node: this.withLink(node),
            recentJobs: history,
            // Reconciled-aware, so the subset agrees with the badge each
            // row renders: a job the node called `done` whose run failed
            // belongs here, and one it called `failed` whose run the
            // reconciler settled `completed` does not.
            failures: history.filter(isFailedNodeHistoryEntry),
            historyUnavailable,
        };
    }

    /** Runs behind a page of node history, by id. Never throws. */
    private async readReconciledRuns(
        userId: string,
        jobs: Awaited<ReturnType<FleetJobService['historyForNode']>>,
    ): Promise<
        Map<
            string,
            { id: string; status: string; summary?: string | null; errorMessage?: string | null }
        >
    > {
        const runIds = nodeHistoryRunIds(jobs);
        if (!this.runs || runIds.length === 0) return new Map();
        try {
            const rows = await this.runs.findByIds(runIds, userId);
            return new Map(rows.map((run) => [run.id, run]));
        } catch (error) {
            this.logger.debug(
                `Node history degraded to job outcomes only: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return new Map();
        }
    }

    @Get('enrollment-tokens')
    @ApiOperation({
        summary:
            'Outstanding (minted but never used) enrollment tokens for my fleet. Lists the token metadata only — the plaintext token was returned exactly once at mint time and is not recoverable.',
    })
    @HttpCode(HttpStatus.OK)
    async listOutstandingTokens(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<FleetEnrollmentTokenView[]> {
        return this.service.listOutstandingTokensForUser(auth.userId);
    }

    @Delete('enrollment-tokens/:id')
    @ApiOperation({
        summary:
            'Revoke an outstanding enrollment token BEFORE it is used. Only unused tokens qualify — for an already-enrolled node use rotate (re-key) or delete (remove the machine).',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async revokeEnrollmentToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.service.revokeEnrollmentTokenForUser(auth.userId, id);
    }

    @Post('nodes/:id/rotate')
    @ApiOperation({
        summary:
            'Rotate a node credential: mints a fresh one-time enrollment token (returned exactly once) and invalidates the old node secret immediately, so the machine must re-enroll.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async rotate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<CreateEnrollmentTokenResult> {
        const result = await this.service.rotateCredentialForUser(auth.userId, id);
        // The old secret is dead the instant the hash is replaced; so is the
        // link it authenticated.
        this.closeLink(id, 'credential replaced');
        return result;
    }

    @Get('nodes/:id/audit')
    @ApiOperation({
        summary:
            'This node’s lifecycle audit trail (newest first): every enroll, rotation, rename, capability edit, pause, disable, drain and delete, with the actor, the time and a before/after. Never contains a credential. Owner-scoped: another account’s node id answers 404, exactly like an unknown one.',
    })
    @HttpCode(HttpStatus.OK)
    async nodeAudit(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetAuditQueryDto,
    ): Promise<FleetAuditView[]> {
        // Ownership is settled FIRST and by the registry — a foreign id
        // throws 404 here and nothing else runs, so the trail can never be
        // read for a node the caller does not own. The audit read is then
        // owner-scoped a SECOND time in `recentForOwnerNode`: the
        // platform-wide `recent()` stays admin-only on the kill-switch
        // controller, because one method whose scoping depends on which
        // arguments happen to be passed is how a leak gets shipped.
        await this.service.getForUser(auth.userId, id);
        return this.audit.recentForOwnerNode(
            auth.userId,
            id,
            query.limit ?? FLEET_AUDIT_DEFAULT_LIMIT,
        );
    }

    @Post('nodes/:id/drain')
    @ApiOperation({
        summary:
            'Drain a node: disable it AND return its in-flight claims to the queue so the work is picked up elsewhere immediately instead of waiting out each lease. `drain: false` returns it to service.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async drain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: DrainFleetNodeDto,
    ): Promise<FleetNodeDrainResult> {
        // Fleet hub (FL-01, FR-22): drain / return is a `machines`-family
        // act, answered server-side before anything moves. The owner drains
        // exactly as before.
        const actor = await this.service.resolveMachinesActor(auth.userId, id);
        // The drain itself (disable FIRST, then requeue — the order is
        // load-bearing) lives in FleetPanicService so that drain-all
        // (EW-778) performs exactly this, once per node.
        if (actor.role === 'owner') return this.panic.drainNodeForUser(auth.userId, id, body.drain);
        // Someone the family admits drains the OWNER's node (their row, their
        // claims), recorded as themselves, and is answered with the view the
        // owner shares with them — never the owner's full row.
        const result = await this.panic.drainNodeForUser(actor.ownerUserId, id, body.drain, {
            actorUserId: auth.userId,
            details: actor.ctx.details,
        });
        return { ...result, node: (await this.service.getVisibleForUser(auth.userId, id)).view };
    }

    @Post('nodes/:id/clear-model-throttle')
    @ApiOperation({
        summary:
            'Clear a model usage-limit throttle on one node before its reset ("clear limit now"): the lease offers that CLI’s agent work to the node again on its next poll, and the node lifts its own copy from its next heartbeat. `provider` names one CLI; omitted clears all. Audited as node.model-throttle-clear. Owner-scoped: another account’s node id answers 404.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async clearModelThrottle(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ClearFleetNodeModelThrottleDto,
    ): Promise<FleetNodeView> {
        return this.service.clearModelThrottlesForUser(auth.userId, id, body?.provider ?? null);
    }

    @Put('nodes/:id/limits')
    @ApiOperation({
        summary:
            'Set (or clear, with nulls) the platform-side CEILING on one node’s resource limits — concurrent jobs, CPU % and memory MB. The node enforces the lower of its own start flags and this, from its next heartbeat; a ceiling can only lower what a machine does. Survives a reinstall on the machine, which only re-applies its local flags. Audited as node.limits. Owner-scoped: another account’s node id answers 404.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async setLimitCeiling(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SetFleetNodeLimitCeilingDto,
    ): Promise<FleetNodeView> {
        // Every field is forwarded by name: a body-mapping whitelist that
        // quietly drops one is how a shipped setting ends up doing nothing.
        return this.service.setLimitCeilingForUser(auth.userId, id, {
            maxConcurrentJobs: body.maxConcurrentJobs,
            maxCpuPercent: body.maxCpuPercent,
            maxMemoryMb: body.maxMemoryMb,
        });
    }

    @Post('nodes/enrollment-token')
    @ApiOperation({
        summary:
            'Issue a one-time enrollment token for a new node (single-use, 15-minute expiry; the token is returned exactly once)',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async createEnrollmentToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateFleetEnrollmentTokenDto,
    ): Promise<CreateEnrollmentTokenResult> {
        return this.service.createEnrollmentToken(auth.userId, body);
    }

    @Patch('nodes/:id')
    @ApiOperation({
        summary: 'Rename, disable/enable, and/or hand-edit the capability tags of a fleet node',
    })
    @ApiOperation({ summary: 'Rename and/or pause/disable a fleet node' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateFleetNodeDto,
    ): Promise<FleetNodeView> {
        // Reject only when NOTHING actionable arrived. Each field is an
        // independent edit, so the guard has to name all five — dropping
        // one here would 400 a perfectly valid single-field PATCH.
        if (
            typeof body.name !== 'string' &&
            typeof body.disabled !== 'boolean' &&
            typeof body.paused !== 'boolean' &&
            !Array.isArray(body.capabilities) &&
            body.dailyCostCeilingCents === undefined &&
            typeof body.isFavorite !== 'boolean' &&
            body.controlPolicyFamilies === undefined
        ) {
            throw new BadRequestException(
                'Provide name, disabled, paused, capabilities, dailyCostCeilingCents, isFavorite and/or controlPolicyFamilies',
            );
        }
        // Fleet hub (FL-01, FR-22): rename, pause / resume and disable /
        // enable are `machines`-family acts — resolved once, server-side,
        // before anything is written (404 outside `view`, permission_denied
        // outside the family). The owner acts exactly as before; a role the
        // family admits acts on the owner's row and is audited as themselves.
        const actor =
            typeof body.name === 'string' ||
            typeof body.paused === 'boolean' ||
            typeof body.disabled === 'boolean'
                ? await this.service.resolveMachinesActor(auth.userId, id)
                : null;
        const sharedActor = actor && actor.role !== 'owner' ? actor : null;
        if (
            sharedActor &&
            (Array.isArray(body.capabilities) ||
                body.dailyCostCeilingCents !== undefined ||
                typeof body.isFavorite === 'boolean' ||
                body.controlPolicyFamilies !== undefined)
        ) {
            // Owner-only edits beside a lifecycle act are refused before ANY
            // write, so a mixed body can never half-apply.
            throw new ForbiddenException(fleetOwnerOnlyBody({ name: sharedActor.nodeName }));
        }
        let view: FleetNodeView | null = null;
        if (typeof body.name === 'string') {
            view = sharedActor
                ? await this.service.renameForUser(
                      sharedActor.ownerUserId,
                      id,
                      body.name,
                      sharedActor.ctx,
                  )
                : await this.service.renameForUser(auth.userId, id, body.name);
        }
        // Fleet cost accounting (EW-777): `null` is a value here (clear the
        // ceiling), so the test is on `undefined`, never on truthiness.
        if (body.dailyCostCeilingCents !== undefined) {
            view = await this.service.setDailyCostCeilingForUser(
                auth.userId,
                id,
                body.dailyCostCeilingCents,
            );
        }
        if (Array.isArray(body.capabilities)) {
            // Writing tags pins them by default: an admin edit the
            // machine silently reverts on its next heartbeat would not
            // be an edit. `capabilitiesPinned: false` opts back out.
            view = await this.service.setCapabilitiesForUser(
                auth.userId,
                id,
                body.capabilities,
                body.capabilitiesPinned ?? true,
            );
        }
        // Fleet hub (FL-01): the owner's star and the per-family policy —
        // both owner-only, refused with permission_denied for anyone else who
        // may see the node. The policy write audits node.policy.change.
        if (typeof body.isFavorite === 'boolean') {
            view = await this.service.setFavoriteForUser(auth.userId, id, body.isFavorite);
        }
        if (body.controlPolicyFamilies !== undefined) {
            view = await this.service.setControlPolicyFamiliesForUser(
                auth.userId,
                id,
                body.controlPolicyFamilies,
            );
        }
        // Pause first, disable second: when both arrive, the harder stop
        // is the one that must be visible in the returned view.
        if (typeof body.paused === 'boolean') {
            view = sharedActor
                ? await this.service.setPausedForUser(
                      sharedActor.ownerUserId,
                      id,
                      body.paused,
                      sharedActor.ctx,
                  )
                : await this.service.setPausedForUser(auth.userId, id, body.paused);
        }
        if (typeof body.disabled === 'boolean') {
            view = sharedActor
                ? await this.service.setDisabledForUser(
                      sharedActor.ownerUserId,
                      id,
                      body.disabled,
                      sharedActor.ctx,
                  )
                : await this.service.setDisabledForUser(auth.userId, id, body.disabled);
        }
        // A non-owner is answered with the view the owner shares with them.
        if (sharedActor) return (await this.service.getVisibleForUser(auth.userId, id)).view;
        return view as FleetNodeView;
    }

    @Delete('nodes/:id')
    @ApiOperation({ summary: 'Delete a fleet node registration' })
    @ApiBody({
        required: false,
        description:
            '`confirmName` is the typed-name confirmation (CONTRACTS §2.2 `confirm-destructive`): when sent it must be the node’s name, or nothing is deleted (400 `invalid`). Optional for the node’s OWNER — without it the owner’s delete works exactly as it always has. Required for anyone else the node’s Lifecycle (`machines`) family admits: without it they get 409 `confirmation_required`.',
        schema: { type: 'object', properties: { confirmName: { type: 'string' } } },
    })
    @ApiResponse({
        status: 409,
        description:
            '`confirmation_required` — someone other than the owner sent no `confirmName`; `error.details` carries `{ class: "confirm-destructive", summary }`.',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        // Read by name, not through a DTO: a body this route never validated
        // must keep being accepted exactly as it was (no field = no check).
        @Body('confirmName') confirmName?: unknown,
    ): Promise<void> {
        // Fleet hub (FL-01, FR-22): remove is a `machines`-family act.
        const actor = await this.service.resolveMachinesActor(auth.userId, id);
        if (actor.role !== 'owner' && confirmName === undefined) {
            // "No field = as before" protects the owner's existing callers. Someone
            // else removing the owner's computer has no such history: the act is
            // `confirm-destructive` (CONTRACTS §2.2), so the typed name is required.
            const summary = `Remove ${actor.nodeName} from Fleet?`;
            throw new ConflictException({
                statusCode: 409,
                message: summary,
                error: {
                    code: 'confirmation_required',
                    hint: `Type ${actor.nodeName} as confirmName to remove it.`,
                    details: { class: 'confirm-destructive', summary },
                },
            });
        }
        if (actor.role === 'owner' && confirmName === undefined) {
            await this.service.deleteForUser(auth.userId, id);
        } else {
            await this.service.deleteForUser(
                actor.ownerUserId,
                id,
                actor.ctx,
                confirmName === undefined ? {} : { confirmName },
            );
        }
        this.closeLink(id, 'node removed');
    }

    @Public()
    @Post('enroll')
    @ApiOperation({
        summary:
            'Enroll a node with a one-time token (public, token-authenticated, single-use). Returns the node id + heartbeat secret exactly once.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async enroll(@Body() body: EnrollFleetNodeDto): Promise<FleetEnrollResponse> {
        // Every self-description field the DTO accepts is forwarded.
        // This mapping is explicit rather than a spread, so a field
        // added to the DTO and forgotten here would be silently dropped
        // — the exact failure mode this comment exists to prevent.
        const result = await this.service.enroll(body.token, {
            platform: body.platform,
            version: body.version,
            capabilities: body.capabilities,
            cliVersion: body.cliVersion,
            // Node lifecycle (slice AR): the pinned per-provider CLI versions.
            cliVersions: body.cliVersions,
            diskFreeBytes: body.diskFreeBytes,
            modelIdentity: body.modelIdentity,
            workerState: body.workerState,
            workerStateReason: body.workerStateReason,
            // Node housekeeping (EW-803). Named here, like everything
            // above, because this mapping is the thing that decides what
            // actually reaches the service — a field added to the DTO and
            // forgotten on this line is accepted at the edge and then
            // silently dropped.
            minFreeDiskBytes: body.minFreeDiskBytes,
            workspaceCount: body.workspaceCount,
            workspaceBytes: body.workspaceBytes,
            lastReclaimAt: body.lastReclaimAt,
            lastReclaimFreedBytes: body.lastReclaimFreedBytes,
            // Remote node limits (slice AS): what the worker is enforcing.
            maxConcurrentJobs: body.maxConcurrentJobs,
            maxCpuPercent: body.maxCpuPercent,
            maxMemoryMb: body.maxMemoryMb,
            // Computer health (FL-03): sanitised by the service, never trusted.
            health: body.health,
            // Fleet node link (FL-02): the consents, should an enrolling node send them.
            consents: body.consents,
        });
        if (!result) {
            // One undifferentiated message — never say WHICH check failed.
            throw new UnauthorizedException('Invalid or expired enrollment token');
        }
        return result;
    }

    @Public()
    @Post('heartbeat')
    @ApiOperation({
        summary:
            'Node heartbeat (public, node-secret-authenticated). Server-stamps last-seen and optionally refreshes the self-description.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async heartbeat(@Body() body: FleetHeartbeatDto): Promise<FleetHeartbeatResponse> {
        // Same explicit mapping as `enroll` — and the same warning.
        const result = await this.service.heartbeat(body.nodeId, body.secret, {
            platform: body.platform,
            version: body.version,
            capabilities: body.capabilities,
            cliVersion: body.cliVersion,
            // Node lifecycle (slice AR): the pinned per-provider CLI versions.
            cliVersions: body.cliVersions,
            diskFreeBytes: body.diskFreeBytes,
            modelIdentity: body.modelIdentity,
            workerState: body.workerState,
            workerStateReason: body.workerStateReason,
            // Node housekeeping (EW-803). Named here, like everything
            // above, because this mapping is the thing that decides what
            // actually reaches the service — a field added to the DTO and
            // forgotten on this line is accepted at the edge and then
            // silently dropped.
            minFreeDiskBytes: body.minFreeDiskBytes,
            workspaceCount: body.workspaceCount,
            workspaceBytes: body.workspaceBytes,
            lastReclaimAt: body.lastReclaimAt,
            lastReclaimFreedBytes: body.lastReclaimFreedBytes,
            // Remote node limits (slice AS): what the worker is enforcing.
            maxConcurrentJobs: body.maxConcurrentJobs,
            maxCpuPercent: body.maxCpuPercent,
            maxMemoryMb: body.maxMemoryMb,
            // Computer health (FL-03): the snapshot, sanitised by the service.
            health: body.health,
            // Fleet node link (FL-02): the four consents the node runs with.
            consents: body.consents,
        });
        if (!result) {
            throw new UnauthorizedException('Invalid node credential');
        }
        // Fleet node link (FL-02, spec FR-22): a consent the node no longer
        // holds closes the link channels that needed it. Never able to fail
        // the beat.
        if (result.consents && this.linkHeartbeat) {
            try {
                this.linkHeartbeat.onHeartbeat(result.node.id, result.consents);
            } catch (err) {
                this.logger.debug(
                    `link consent update skipped for node ${result.node.id}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
        // Two independent follow-ups, started together and awaited together
        // (neither can reject: each swallows its own failure), so the beat
        // pays for the slower of the two, not their sum.
        //
        // Self-build slice S — an eligible runner is back: clear
        // `waiting-for-runner` on the owner's queued jobs this node can
        // take, so the Fleet UI stops saying "waiting" the moment it is
        // no longer true (the node's own lease poll claims them next).
        // Only for a beat that left the node ONLINE — a paused/disabled
        // node keeps beating but will not lease — and never able to fail
        // or refuse the beat: the service re-reads the node row itself
        // and swallows its own errors; this guard is the belt.
        //
        // Agent computers — tell an attended machine a live view is already
        // waiting for it, so it claims the view now rather than on its next
        // poll. Added ONLY when non-empty (an older daemon ignores the field;
        // every other response keeps its exact shape), only for an online
        // machine that switched live viewing on, and never able to fail the
        // beat.
        const [, pending] = await Promise.all([
            this.promoteWaitingJobsFor(result.node),
            this.pendingComputerSessionsFor(result.node),
        ]);
        const response: FleetHeartbeatResponse = {
            ok: true,
            node: result.node,
            rotationRequested: result.rotationRequested,
            // Node lifecycle (self-build slice AR) — the daemon version
            // floor, on EVERY accepted beat. The beat itself is never
            // refused for being below it (liveness and the settling of
            // in-flight work are not gated); the lease is, independently,
            // so a daemon too old to read these two fields is still held.
            minNodeVersion: result.minNodeVersion,
            upgradeRequired: result.upgradeRequired,
            // Remote node limits (self-build slice AS) — the owner's ceiling,
            // on every beat (all-null when none), so the machine clamps itself
            // to it, or lifts the clamp, before its next lease.
            limitCeiling: result.limitCeiling,
        };
        if (pending.length > 0) {
            response.pendingComputerSessions = pending;
        }
        // Fleet node link (FL-02, CONTRACTS §1.1): the recommended daemon
        // version, only when the operator named one.
        if (result.recommendedNodeVersion) {
            response.recommendedNodeVersion = result.recommendedNodeVersion;
        }
        return response;
    }

    /**
     * Fleet node link (FL-02) — the link as the platform's own socket sees it
     * (spec FR-42), on an enrolled row the caller owns; a cluster row and a
     * build without the link module keep their exact shape. A row someone
     * else sees through an Organization (FL-01's shared view, an allow-list)
     * does not gain it: the link's traffic counters and generation are the
     * owner's, and a shared field is a decision, not a side effect.
     */
    /** Close a gone node's live link; never the reason a lifecycle call fails. */
    private closeLink(
        nodeId: string,
        reason: Parameters<FleetLinkNodeLifecycle['nodeGone']>[1],
    ): void {
        if (!this.linkLifecycle) return;
        try {
            this.linkLifecycle.nodeGone(nodeId, reason);
        } catch (error) {
            this.logger.warn(
                `node ${nodeId}: its link could not be closed (${reason}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private withLink<T extends FleetNodeView>(node: T): T {
        if (!this.linkState || node.persisted === false) return node;
        if (node.viewerRole !== undefined && node.viewerRole !== 'owner') return node;
        try {
            return { ...node, link: this.linkState.linkView({ id: node.id, kind: node.kind }) };
        } catch {
            return node;
        }
    }

    private async promoteWaitingJobsFor(node: FleetHeartbeatResponse['node']): Promise<void> {
        if (node?.status !== 'online') {
            return;
        }
        try {
            await this.jobs.promoteWaitingForNode(node.id);
        } catch (err) {
            this.logger.debug(
                `waiting-job promotion skipped for node ${node.id}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    private async pendingComputerSessionsFor(
        node: FleetHeartbeatResponse['node'],
    ): Promise<string[]> {
        if (
            !this.pendingComputerSessions ||
            node?.status !== 'online' ||
            !(node.capabilities ?? []).includes(FLEET_ATTENDED_CAPABILITY)
        ) {
            return [];
        }
        try {
            return await this.pendingComputerSessions.pendingForNode(node.id);
        } catch (err) {
            this.logger.debug(
                `pending live-view lookup skipped for node ${node.id}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return [];
        }
    }

    @Public()
    @Post('rotate-credential')
    @ApiOperation({
        summary:
            'Node self-rotation (public, node-secret-authenticated). Mints a NEW node secret — returned exactly once — while the credential presented here keeps working for a bounded overlap, so the machine can finish its in-flight job and persist the new secret before the old one dies. The old credential expires on a clock, not on a callback. Requires the CURRENT credential: a previous-window one, a still-enrolling node, or a second rotation while a window is open are all refused.',
    })
    @HttpCode(HttpStatus.OK)
    // Tighter than `pause` (30/min): rotation mints 32 random bytes and
    // writes on every call, and six machines beating every 30s need
    // nothing like ten a minute between them.
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async rotateCredential(
        @Body() body: RotateFleetNodeCredentialDto,
    ): Promise<FleetNodeRotateCredentialResponse> {
        const result = await this.service.rotateCredentialByCredential(body.nodeId, body.secret);
        if (!result) {
            // The SAME message every refused node credential gets — never
            // say which check failed, or this becomes a probe for which
            // node ids exist and which are mid-rotation.
            throw new UnauthorizedException('Invalid node credential');
        }
        return {
            ok: true,
            nodeId: result.nodeId,
            secret: result.secret,
            previousCredentialExpiresAt: result.previousCredentialExpiresAt.toISOString(),
            overlapSec: result.overlapSec,
            node: result.node,
        };
    }

    @Public()
    @Post('pause')
    @ApiOperation({
        summary:
            'Node self-pause/resume (public, node-secret-authenticated). Pausing DRAINS: no new work is leased onto the node, the jobs it already holds keep reporting, and heartbeats stay accepted so it remains observable.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async pause(@Body() body: FleetNodePauseDto): Promise<{ ok: true; node: FleetNodeView }> {
        const result = await this.service.setPausedByCredential(
            body.nodeId,
            body.secret,
            body.paused,
        );
        if (!result) {
            throw new UnauthorizedException('Invalid node credential');
        }
        return { ok: true, node: result.node };
    }

    @Public()
    @Post('unenroll')
    @ApiOperation({
        summary:
            'Node self-unenrollment (public, node-secret-authenticated). Deletes the registration the presented credential belongs to, which is what renders that credential worthless.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async unenroll(@Body() body: FleetUnenrollDto): Promise<{ ok: true }> {
        const removed = await this.service.unenrollByCredential(body.nodeId, body.secret);
        if (!removed) {
            throw new UnauthorizedException('Invalid node credential');
        }
        this.closeLink(body.nodeId, 'node unenrolled');
        return { ok: true };
    }
}
