import {
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FleetAccessService,
    FleetAuditService,
    FleetJobService,
    FleetKillSwitchService,
    FleetNodeHealthService,
    FleetNodeRepository,
    FleetService,
    fleetOwnerOnlyBody,
    type FleetNode,
} from '@ever-works/agent/fleet';
import {
    effectiveConsents,
    FLEET_HEALTH_DEFAULT_RANGE,
    FLEET_HEALTH_NOW_VERB,
    FLEET_HEALTH_REFRESH_RATE_LIMIT,
    FLEET_HEALTH_REFRESH_RATE_WINDOW_MS,
    FLEET_HEALTH_REFRESH_TIMEOUT_MS,
    FLEET_WAKE_CHECK_AFTER_MS,
    FLEET_WAKE_LISTEN_MS,
    FLEET_WAKE_RATE_LIMIT,
    FLEET_WAKE_RATE_WINDOW_MS,
    FLEET_WAKE_SEND_VERB,
    fleetWakeAnswered,
    hasFleetNodeHealthReading,
    isFleetLinkEligible,
    isFleetNodeAsleep,
    isFleetNodeHealthRange,
    isFleetNodeHealthStale,
    normalizeFleetMacAddress,
    resolveComputerState,
    type FleetHealthNowResult,
    type FleetHealthRefreshAvailability,
    type FleetNodeHealthHistory,
    type FleetNodeHealthView,
    type FleetNodeView,
    type FleetNodeWakeAvailability,
    type FleetNodeWakeResult,
    type FleetNodeWakeStatus,
    type FleetViewerRole,
} from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FleetLinkException, fleetLinkError } from '../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../fleet-link/fleet-link.service';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';
import { FleetNodeRateWindow } from './fleet-node-rate-window';

/** `GET /api/fleet/nodes/:id/health` — the shared `FleetNodeHealthView` shape. */
export type FleetNodeHealthResponse = FleetNodeHealthView;

/**
 * Computer health (FL-03) — a computer's health, and the two reach acts.
 *
 * Reads (`view` family, CONTRACTS §2.1, default org-members — spec §7):
 *
 *  - `GET  /nodes/:id/health` — the snapshot the row holds (one read, no
 *    history join), whether it is stale, the computer's state sentence with
 *    its fix (`resolveComputerState`, the same pure function every surface
 *    uses), and — second phase — whether THIS viewer can wake it and whether
 *    Refresh now can reach it.
 *  - `GET  /nodes/:id/health/history?range=1h|24h|7d|90d` — at most 500
 *    points, gaps kept, `{ disabled: true }` with `FLEET_HEALTH_HISTORY_ENABLED`
 *    off (FR-20, FR-22).
 *  - `POST /nodes/:id/health` — Refresh now: `health.now` over FL-02's link
 *    (any open link, no consent beyond it — R-31), within 3 s or
 *    `unreachable`; the fresh snapshot replaces the stored one; 10 a minute
 *    per computer (FR-27, FR-28). Refused `kill_switch` by the link (R-24).
 *  - `GET  /nodes/:id/wake` — has the computer beat since the last wake (FR-26)?
 *
 * The one state-changing act (`machines` family on the TARGET, confirmation
 * `plain`, audited `node.wake`, kill-switch refused):
 *
 *  - `POST /nodes/:id/wake` — send Wake-on-LAN through a sibling on the same
 *    network: the owner's online computer with the same network identity,
 *    advertising `wake` and `managed` (FR-24, FR-25); 3 per 5 minutes per
 *    computer. The sibling is asked as the platform itself (a system caller):
 *    the person's right to wake is checked on the TARGET, which is what the
 *    act is about; the sibling's own `manage` consent is still checked, on the
 *    platform and again on the machine. One `node.wake` row per attempt that
 *    reached a sibling — sent or refused — naming both computers.
 *
 * Visibility is FL-01's: a computer outside the caller's `view` audience is
 * the 404 of an unknown id on every route here, and nothing else is read.
 * Reads are not audited (§2.3).
 *
 * Rates are per API replica (`FleetNodeRateWindow`).
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetHealthController {
    private readonly refreshWindow = new FleetNodeRateWindow(
        FLEET_HEALTH_REFRESH_RATE_LIMIT,
        FLEET_HEALTH_REFRESH_RATE_WINDOW_MS,
    );
    private readonly wakeWindow = new FleetNodeRateWindow(
        FLEET_WAKE_RATE_LIMIT,
        FLEET_WAKE_RATE_WINDOW_MS,
    );

    constructor(
        private readonly service: FleetService,
        private readonly jobs: FleetJobService,
        private readonly history: FleetNodeHealthService,
        // FL-03 second phase. Appended LAST and @Optional(): this controller is
        // also mounted where the node link is not (the api-side TasksModule
        // imports FleetApiModule); without them the reach acts answer
        // `unreachable` and the health read carries no `wake` / `refresh`.
        @Optional() private readonly link?: FleetLinkService,
        @Optional() private readonly nodes?: FleetNodeRepository,
        @Optional() private readonly access?: FleetAccessService,
        @Optional() private readonly killSwitch?: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    @Get('nodes/:id/health')
    @ApiOperation({
        summary:
            "One computer's health: the latest snapshot (CPU, memory, disk, load, uptime, GPU, pending reboot, failed services) stamped with the platform's receipt time, whether it is stale, its plain-language state with its one fix, and whether I can wake it or refresh it now. Readable by anyone who can see the computer (the `view` family); a computer outside my view answers 404, exactly like an unknown id.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async health(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeHealthResponse> {
        // Visibility first: a 404 here means nothing else is read.
        const { view: node, role } = await this.service.getVisibleForUser(auth.userId, id);
        const withLoad = role === 'owner' ? await this.withLoad(auth.userId, node) : node;
        const now = Date.now();
        const offlineAfterMs = offlineThresholdMs();
        // A row holding only the platform's disk-low marker (an older daemon)
        // has no reading: it answers "no snapshot", never a page of dashes.
        const snapshot = hasFleetNodeHealthReading(node.health) ? (node.health ?? null) : null;
        const reach = await this.reach(auth.userId, id, role, now, offlineAfterMs);
        return {
            nodeId: node.id,
            snapshot,
            stale: isFleetNodeHealthStale(snapshot, now, offlineAfterMs),
            state: resolveComputerState(withLoad, {
                now,
                offlineAfterMs,
                canWake: reach?.wake.available === true,
            }),
            historyEnabled: this.history.isHistoryEnabled(),
            ...(reach ? { wake: reach.wake, refresh: reach.refresh } : {}),
        };
    }

    @Get('nodes/:id/health/history')
    @ApiOperation({
        summary:
            "One computer's health history over a range (1h, 24h from one-minute samples; 7d, 90d from hourly roll-ups): at most 500 points of CPU, memory and disk percent with each bucket's peak, gaps where the computer was offline kept as breaks. Answers { disabled: true } when this deployment keeps no history. `view` family.",
    })
    @ApiQuery({ name: 'range', required: false, enum: ['1h', '24h', '7d', '90d'] })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async healthHistory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('range') range?: string,
    ): Promise<FleetNodeHealthHistory> {
        const chosen = range === undefined || range === '' ? FLEET_HEALTH_DEFAULT_RANGE : range;
        if (!isFleetNodeHealthRange(chosen)) {
            throw fleetLinkError('invalid', 'range must be one of 1h, 24h, 7d, 90d', {
                field: 'range',
            });
        }
        // Visibility first (404), then one indexed range read.
        await this.service.getVisibleForUser(auth.userId, id);
        return this.history.history(id, chosen);
    }

    @Post('nodes/:id/health')
    @ApiOperation({
        summary:
            'Refresh now: ask a connected computer for a fresh health snapshot over its node link instead of waiting for its next check-in. Any open link will do (no consent beyond it); answers within 3 seconds or `unreachable`, `consent_missing` for a computer that can open no link, `kill_switch` while all computers are stopped, `limit_exceeded` past 10 a minute. Returns the same shape as the health read. `view` family.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async refreshHealth(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeHealthResponse> {
        const { view } = await this.service.getVisibleForUser(auth.userId, id);
        if (!this.link) {
            throw fleetLinkError('unreachable', 'this deployment does not accept node links yet');
        }
        if (!this.refreshWindow.tryHit(id)) {
            throw fleetLinkError(
                'limit_exceeded',
                `at most ${FLEET_HEALTH_REFRESH_RATE_LIMIT} refreshes a minute for ${view.name}`,
                {
                    limit: FLEET_HEALTH_REFRESH_RATE_LIMIT,
                    windowMs: FLEET_HEALTH_REFRESH_RATE_WINDOW_MS,
                },
            );
        }
        let snapshot: unknown;
        try {
            const outcome = await this.link.request<FleetHealthNowResult>({
                nodeId: id,
                verb: FLEET_HEALTH_NOW_VERB,
                caller: { kind: 'user', userId: auth.userId },
                timeoutMs: FLEET_HEALTH_REFRESH_TIMEOUT_MS,
            });
            if (outcome.operationId !== undefined) {
                // The machine could not answer inline: a refresh that is not
                // back within its window is, to the person waiting, unreachable.
                throw fleetLinkError(
                    'unreachable',
                    `${view.name} did not answer within ${FLEET_HEALTH_REFRESH_TIMEOUT_MS / 1000} seconds; try again`,
                    { nodeId: id },
                );
            }
            snapshot = outcome.result?.snapshot;
        } catch (error) {
            throw await this.withWakeHint(error, auth.userId, id, view);
        }
        const stored = await this.service.applyRefreshedHealth(id, snapshot);
        if (!stored) {
            throw fleetLinkError(
                'operation_failed',
                `${view.name} answered without a usable health reading`,
            );
        }
        return this.health(auth, id);
    }

    @Post('nodes/:id/wake')
    @ApiOperation({
        summary:
            "Wake an offline computer: send a Wake-on-LAN packet through another online computer of the same owner on the same network (one started with --manage). Needs the `machines` family on the computer being woken; refused `unsupported_on_node` when it never reported a hardware address or no computer on its network can wake it, `kill_switch` while all computers are stopped, `limit_exceeded` past 3 attempts in 5 minutes. Answers 202 with the computer the packet went through; ask GET /nodes/:id/wake at 20 s and 60 s whether it came back. Audited (`node.wake`).",
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async wake(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeWakeResult> {
        const userId = auth.userId;
        // Visibility (404) through FL-01, then the target's row.
        const { role } = await this.service.getVisibleForUser(userId, id);
        const target = await this.loadNode(id);
        await this.assertMachines(target, userId, role);
        if (!this.link) {
            throw fleetLinkError('unreachable', 'this deployment does not accept node links yet');
        }
        if (await this.isStopped()) {
            throw fleetLinkError('kill_switch', 'clear it under Settings → Fleet');
        }
        const now = Date.now();
        if (!isFleetNodeAsleep(target, now, offlineThresholdMs())) {
            throw fleetLinkError('invalid', `${target.name} is not offline`, { field: 'status' });
        }
        const macAddress = normalizeFleetMacAddress(target.macAddress);
        if (!macAddress) {
            throw fleetLinkError(
                'unsupported_on_node',
                `${target.name} has not reported a hardware address yet — start it once with --manage`,
                { reason: 'no-hardware-address' },
            );
        }
        const siblings = await this.service.listWakeSiblings(target);
        if (siblings.length === 0) {
            throw fleetLinkError(
                'unsupported_on_node',
                `No online computer on ${target.name}'s network can wake it`,
                { reason: 'no-sibling' },
            );
        }
        if (!this.wakeWindow.tryHit(id)) {
            throw fleetLinkError(
                'limit_exceeded',
                `Already tried ${FLEET_WAKE_RATE_LIMIT} times; give it a minute`,
                { limit: FLEET_WAKE_RATE_LIMIT, windowMs: FLEET_WAKE_RATE_WINDOW_MS },
            );
        }

        // A sibling whose link is open right now first; the rest in beat order.
        const link = this.link;
        const ordered = [...siblings].sort(
            (a, b) => Number(link.isConnected(b.id)) - Number(link.isConnected(a.id)),
        );
        let lastError: unknown = null;
        for (const sibling of ordered) {
            try {
                await link.request({
                    nodeId: sibling.id,
                    verb: FLEET_WAKE_SEND_VERB,
                    params: { macAddress },
                    caller: { kind: 'system', job: `wake:${userId}` },
                    requirement: { target: target.id },
                });
            } catch (error) {
                lastError = error;
                // A sibling that cannot be reached or does not hold `manage`
                // any more: try the next one. Anything else is the answer.
                if (
                    error instanceof FleetLinkException &&
                    (error.code === 'unreachable' ||
                        error.code === 'consent_missing' ||
                        error.code === 'unsupported_on_node')
                ) {
                    continue;
                }
                break;
            }
            const sentAt = new Date();
            await this.service.recordWakeAttempt(target.id, sentAt);
            await this.recordWake(target, userId, sibling.id, 'sent');
            return {
                nodeId: target.id,
                via: { nodeId: sibling.id, name: sibling.name },
                sentAt: sentAt.toISOString(),
                listenUntil: new Date(sentAt.getTime() + FLEET_WAKE_LISTEN_MS).toISOString(),
                checkAfterMs: FLEET_WAKE_CHECK_AFTER_MS,
            };
        }
        const code = lastError instanceof FleetLinkException ? lastError.code : 'internal';
        await this.recordWake(target, userId, ordered[0]?.id ?? null, 'refused', code);
        if (lastError instanceof FleetLinkException && lastError.code === 'unreachable') {
            throw fleetLinkError(
                'unreachable',
                `No computer on ${target.name}'s network is connected right now to send the wake`,
                { nodeId: target.id },
            );
        }
        throw lastError ?? fleetLinkError('internal', 'the wake could not be sent');
    }

    @Get('nodes/:id/wake')
    @ApiOperation({
        summary:
            'Has a computer answered its last wake? The last wake attempt, the last check-in, whether the computer checked in after the attempt, and whether the platform is still listening (60 s after the attempt). `view` family.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async wakeStatus(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeWakeStatus> {
        const { view } = await this.service.getVisibleForUser(auth.userId, id);
        const row = this.nodes ? await this.nodes.findById(id) : null;
        const lastWakeAttemptAt = row?.lastWakeAttemptAt
            ? new Date(row.lastWakeAttemptAt).toISOString()
            : (view.lastWakeAttemptAt ?? null);
        const lastHeartbeatAt = view.lastHeartbeatAt ?? null;
        const wokeAt = lastWakeAttemptAt ? Date.parse(lastWakeAttemptAt) : Number.NaN;
        return {
            nodeId: view.id,
            lastWakeAttemptAt,
            lastHeartbeatAt,
            answered: fleetWakeAnswered(lastWakeAttemptAt, lastHeartbeatAt),
            listening: Number.isFinite(wokeAt) && Date.now() - wokeAt < FLEET_WAKE_LISTEN_MS,
        };
    }

    /** The job count behind "Busy · 2 jobs" — best-effort, like the node list. */
    private async withLoad(userId: string, node: FleetNodeView): Promise<FleetNodeView> {
        try {
            const load = await this.jobs.loadByNodeForUser(userId);
            return { ...node, load: load[node.id] ?? null };
        } catch {
            return node;
        }
    }

    /**
     * Whether this viewer can wake the computer and whether Refresh now can
     * reach it — null on a context without the link (an older platform's
     * answer carries neither). Best-effort: a failed read answers "not now"
     * rather than failing the health read.
     */
    private async reach(
        userId: string,
        nodeId: string,
        role: FleetViewerRole,
        now: number,
        offlineAfterMs: number,
    ): Promise<{ wake: FleetNodeWakeAvailability; refresh: FleetHealthRefreshAvailability } | null> {
        if (!this.link || !this.nodes) return null;
        let row: FleetNode | null;
        try {
            row = await this.nodes.findById(nodeId);
        } catch {
            return null;
        }
        if (!row) return null;
        const stopped = await this.isStopped();
        return {
            wake: await this.wakeAvailability(row, userId, role, stopped, now, offlineAfterMs),
            refresh: this.refreshAvailability(row, stopped, now, offlineAfterMs),
        };
    }

    private async wakeAvailability(
        row: FleetNode,
        userId: string,
        role: FleetViewerRole,
        stopped: boolean,
        now: number,
        offlineAfterMs: number,
    ): Promise<FleetNodeWakeAvailability> {
        const lastWakeAttemptAt = row.lastWakeAttemptAt
            ? new Date(row.lastWakeAttemptAt).toISOString()
            : null;
        const no = (reason: FleetNodeWakeAvailability['reason']): FleetNodeWakeAvailability => ({
            available: false,
            reason,
            via: null,
            lastWakeAttemptAt,
        });
        if (!isFleetNodeAsleep(row, now, offlineAfterMs)) return no('not-offline');
        if (!(await this.mayAct(row, userId, role))) return no('not-allowed');
        if (stopped) return no('kill-switch');
        if (!normalizeFleetMacAddress(row.macAddress)) return no('no-hardware-address');
        let siblings: FleetNode[];
        try {
            siblings = await this.service.listWakeSiblings(row);
        } catch {
            siblings = [];
        }
        const first = siblings[0];
        if (!first) return no('no-sibling');
        if (this.wakeWindow.remaining(row.id) === 0) return no('rate-limited');
        return {
            available: true,
            reason: null,
            // The owner's other machines are the owner's to know.
            via: role === 'owner' ? { nodeId: first.id, name: first.name } : null,
            lastWakeAttemptAt,
        };
    }

    private refreshAvailability(
        row: FleetNode,
        stopped: boolean,
        now: number,
        offlineAfterMs: number,
    ): FleetHealthRefreshAvailability {
        const no = (
            reason: FleetHealthRefreshAvailability['reason'],
        ): FleetHealthRefreshAvailability => ({ available: false, reason });
        if (!config.fleet.isNodeLinkEnabled()) return no('link-disabled');
        if (isFleetNodeAsleep(row, now, offlineAfterMs)) return no('offline');
        const consents = effectiveConsents({
            consents: row.consents,
            capabilities: row.capabilities,
            workerState: row.workerState,
        });
        if (!isFleetLinkEligible(consents)) return no('no-link');
        if (stopped) return no('kill-switch');
        if (!this.link?.isConnected(row.id)) return no('not-connected');
        return { available: true, reason: null };
    }

    /** May this person act in the `machines` family on this computer? Pure read. */
    private async mayAct(row: FleetNode, userId: string, role: FleetViewerRole): Promise<boolean> {
        if (role === 'owner') return true;
        if (!this.access) return false;
        try {
            return await this.access.canAct(row, userId, 'machines');
        } catch {
            return false;
        }
    }

    /** The `machines` family on the target: FL-01's check, else owner-only (fail-closed). */
    private async assertMachines(
        row: FleetNode,
        userId: string,
        role: FleetViewerRole,
    ): Promise<void> {
        if (this.access) {
            await this.access.assertFamily(row, userId, 'machines');
            return;
        }
        if (role !== 'owner') throw new ForbiddenException(fleetOwnerOnlyBody(row));
    }

    private async loadNode(id: string): Promise<FleetNode> {
        const row = this.nodes ? await this.nodes.findById(id) : null;
        if (!row) throw fleetLinkError('not_found', 'no such computer');
        return row;
    }

    /** The fleet kill switch, read fail-closed (an unreadable flag is "stopped"). */
    private async isStopped(): Promise<boolean> {
        if (!this.killSwitch) return false;
        try {
            return await this.killSwitch.isStopped();
        } catch {
            return true;
        }
    }

    /**
     * `unreachable` from a refresh names when the computer was last seen;
     * for its owner, when a sibling can wake it, the hint offers that too
     * (CONTRACTS §8: "last seen 12 min ago; wake it from build-02?").
     */
    private async withWakeHint(
        error: unknown,
        userId: string,
        nodeId: string,
        view: FleetNodeView,
    ): Promise<unknown> {
        if (!(error instanceof FleetLinkException) || error.code !== 'unreachable') return error;
        if (view.viewerRole !== undefined && view.viewerRole !== 'owner') return error;
        const route = view.canWake ?? null;
        if (!route) return error;
        return fleetLinkError('unreachable', `${error.linkError.hint}; wake it from ${route.name}?`, {
            ...(error.linkError.details ?? {}),
            nodeId,
            wakeVia: route.nodeId,
        });
    }

    private async recordWake(
        target: FleetNode,
        userId: string,
        viaNodeId: string | null,
        outcome: 'sent' | 'refused',
        code?: string,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action: 'node.wake',
            actorUserId: userId,
            ownerUserId: target.userId,
            nodeId: target.id,
            details: {
                target: target.id,
                via: viaNodeId,
                outcome,
                ...(code ? { code } : {}),
            },
        });
    }
}

/** The silence after which a node sweeps offline — the same threshold staleness is judged by. */
export function offlineThresholdMs(): number {
    return config.fleet.getNodeOfflineAfterMs();
}
