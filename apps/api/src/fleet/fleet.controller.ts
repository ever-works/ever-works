import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Logger,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
} from '@ever-works/contracts';
import { AgentRunRepository } from '@ever-works/agent/database';
import { FLEET_AUDIT_DEFAULT_LIMIT } from '@ever-works/contracts';
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
    CreateFleetEnrollmentTokenDto,
    DrainFleetNodeDto,
    EnrollFleetNodeDto,
    FleetHeartbeatDto,
    FleetNodePauseDto,
    FleetUnenrollDto,
    RotateFleetNodeCredentialDto,
    SetFleetCostCeilingDto,
    SetFleetExecutionPreferenceDto,
    UpdateFleetNodeDto,
} from './dto/fleet.dto';
import { FleetAuditQueryDto } from './dto/fleet-kill-switch.dto';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/** How much of a node's job history the detail drawer reads. */
const NODE_HISTORY_LIMIT = 25;

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
            'List my fleet nodes (enrolled machines + live nodes of my own configured clusters), each with its current execution load',
    })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<FleetNodeView[]> {
        const nodes = await this.service.listForUser(auth.userId);
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
            ...node,
            // Cluster-sourced rows are never leased onto, so they stay null.
            load: node.persisted ? (load[node.id] ?? null) : null,
        })) as FleetNodeView[];
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
        // Ownership is settled FIRST and by the registry: if this throws
        // 404 nothing else runs, so the job history can never be read
        // for a node the caller does not own.
        const node = await this.service.getForUser(auth.userId, id);

        let recentJobs: Awaited<ReturnType<FleetJobService['historyForNode']>> = [];
        let historyUnavailable = false;
        try {
            recentJobs = await this.jobs.historyForNode(auth.userId, id, NODE_HISTORY_LIMIT);
        } catch {
            // Same degradation contract as `list`: a job-runtime hiccup
            // must not make an existing node look missing.
            historyUnavailable = true;
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
            node,
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
        return this.service.rotateCredentialForUser(auth.userId, id);
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
        // The drain itself (disable FIRST, then requeue — the order is
        // load-bearing) lives in FleetPanicService so that drain-all
        // (EW-778) performs exactly this, once per node.
        return this.panic.drainNodeForUser(auth.userId, id, body.drain);
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
            body.dailyCostCeilingCents === undefined
        ) {
            throw new BadRequestException(
                'Provide name, disabled, paused, capabilities and/or dailyCostCeilingCents',
            );
        }
        let view: FleetNodeView | null = null;
        if (typeof body.name === 'string') {
            view = await this.service.renameForUser(auth.userId, id, body.name);
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
        // Pause first, disable second: when both arrive, the harder stop
        // is the one that must be visible in the returned view.
        if (typeof body.paused === 'boolean') {
            view = await this.service.setPausedForUser(auth.userId, id, body.paused);
        }
        if (typeof body.disabled === 'boolean') {
            view = await this.service.setDisabledForUser(auth.userId, id, body.disabled);
        }
        return view as FleetNodeView;
    }

    @Delete('nodes/:id')
    @ApiOperation({ summary: 'Delete a fleet node registration' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.service.deleteForUser(auth.userId, id);
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
            diskFreeBytes: body.diskFreeBytes,
            modelIdentity: body.modelIdentity,
            workerState: body.workerState,
            workerStateReason: body.workerStateReason,
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
            diskFreeBytes: body.diskFreeBytes,
            modelIdentity: body.modelIdentity,
            workerState: body.workerState,
            workerStateReason: body.workerStateReason,
        });
        if (!result) {
            throw new UnauthorizedException('Invalid node credential');
        }
        // Self-build slice S — an eligible runner is back: clear
        // `waiting-for-runner` on the owner's queued jobs this node can
        // take, so the Fleet UI stops saying "waiting" the moment it is
        // no longer true (the node's own lease poll claims them next).
        // Only for a beat that left the node ONLINE — a paused/disabled
        // node keeps beating but will not lease — and never able to fail
        // or refuse the beat: the service re-reads the node row itself
        // and swallows its own errors; this guard is the belt.
        if (result.node.status === 'online') {
            try {
                await this.jobs.promoteWaitingForNode(result.node.id);
            } catch (err) {
                this.logger.debug(
                    `waiting-job promotion skipped for node ${result.node.id}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
        return { ok: true, node: result.node, rotationRequested: result.rotationRequested };
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
        return { ok: true };
    }
}
