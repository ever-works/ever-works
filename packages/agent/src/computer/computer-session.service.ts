import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    ComputerChannel,
    ComputerCloseReason,
    ComputerNodeOption,
    ComputerQuality,
    ComputerSessionHolderView,
    ComputerSessionView,
    ComputerUnwatchableReason,
    FleetKillSwitchState,
    FleetNodeView,
} from '@ever-works/contracts';
import { ComputerSession } from '../entities/computer-session.entity';
import { FleetAgentNodeAffinityRepository } from '../fleet/fleet-agent-node-affinity.repository';
import { FleetAuditService } from '../fleet/fleet-audit.service';
import { FleetJobRepository } from '../fleet/fleet-job.repository';
import { FleetKillSwitchService } from '../fleet/fleet-kill-switch.service';
import { FleetService } from '../fleet/fleet.service';
import { computerAuditDetails } from './computer-audit';
import {
    COMPUTER_SESSION_DISPATCHER,
    type ComputerSessionDispatcher,
} from './computer-session.dispatcher';
import {
    defaultChannelsFor,
    resolveComputerSessionLimits,
    resolveQuality,
    resolveSessionExpiry,
    resolveWatchability,
    type ComputerSessionLimits,
} from './computer-session.policy';
import {
    ComputerSessionRepository,
    computerSessionScopeKey,
    type ComputerAdmissionLockKeys,
} from './computer-session.repository';
import { NodeAgentProfileService, type ComputerAgentRef } from './node-agent-profile.service';

/** What the admission critical section hands back when it reserved a slot. */
interface AdmittedComputerSession {
    row: ComputerSession;
    profileKey: string;
    dispatcher: ComputerSessionDispatcher;
}

/** Emitted once per session, when it ends — the relay publishes the pinned `end` frame on it. */
export class ComputerSessionEndedEvent {
    static EVENT_NAME = 'computer.session.ended';

    constructor(
        public readonly sessionId: string,
        public readonly nodeId: string,
        public readonly reason: ComputerCloseReason,
    ) {}
}

export type OpenComputerSessionRefusal =
    | { refused: 'stopped'; stop: FleetKillSwitchState | null }
    | { refused: 'no-nodes' }
    | { refused: 'node-not-found' }
    | { refused: 'node-unwatchable'; nodeId: string; reason: ComputerUnwatchableReason }
    | {
          refused: 'channel-unavailable';
          nodeId: string;
          channel: ComputerChannel;
          reason: ComputerUnwatchableReason;
      }
    | {
          refused: 'node-session-cap' | 'organization-session-cap';
          limit: number;
          sessions: ComputerSessionHolderView[];
      }
    | { refused: 'dispatcher-unavailable' };

export type OpenComputerSessionOutcome =
    | { opened: ComputerSessionView }
    | OpenComputerSessionRefusal;

export interface OpenComputerSessionInput {
    userId: string;
    agent: ComputerAgentRef;
    nodeId?: string | null;
    channels?: ComputerChannel[] | null;
    quality?: ComputerQuality | null;
}

/** Close reasons a node may report about its own session. */
const NODE_REPORTABLE_CLOSE_REASONS: ReadonlySet<ComputerCloseReason> = new Set([
    'node-restarted',
    'node-unavailable',
    'stalled',
    'error',
]);

/**
 * Agent computers — the live-view session lifecycle.
 *
 * Opening a session never touches a Run: it resolves which machine to watch
 * (the Agent's pinned node first), refuses honestly when that machine cannot
 * be watched, enforces the per-node and per-Organization caps, and asks the
 * fleet for a `computer-session` job pinned to that one machine. Pictures
 * then flow node → relay → browser without passing through here; this
 * service only accounts for them and moves the state machine.
 *
 * Every refusal is a typed VALUE, never a bare throw, so the controller maps
 * each one to a status and a sentence the owner can act on.
 *
 * Unfinished sessions are expired INLINE on every open and read — a view no
 * machine claimed within 40 seconds is ended as `abandoned` and its job is
 * withdrawn — so a stale row can never hold a slot against the caps, with or
 * without a background sweep running. The caps expire every row they count,
 * whoever opened it, and the machine side expires owner-independently too:
 * on the heartbeat hint, on a lease of the job, and on every machine-facing
 * route, so an expired view can never be claimed into going live.
 *
 * Admission (count, then insert the `requested` row) is serialized per
 * machine and per Organization by an advisory lock, so a burst of opens
 * cannot walk past a cap.
 */
@Injectable()
export class ComputerSessionService {
    private readonly logger = new Logger(ComputerSessionService.name);

    constructor(
        private readonly sessions: ComputerSessionRepository,
        private readonly fleet: FleetService,
        private readonly affinities: FleetAgentNodeAffinityRepository,
        private readonly jobs: FleetJobRepository,
        private readonly profiles: NodeAgentProfileService,
        @Optional() private readonly killSwitch?: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional()
        @Inject(COMPUTER_SESSION_DISPATCHER)
        private readonly dispatcher?: ComputerSessionDispatcher,
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    /** Limits are read per call so an operator change needs no restart. */
    limits(): ComputerSessionLimits {
        return resolveComputerSessionLimits(process.env);
    }

    /**
     * Every machine the owner has, as the picker lists them: the Agent's
     * pinned node first, then online machines by most recent heartbeat, then
     * the rest — each with whether it can be watched and, if not, why.
     * Cluster nodes are listed as unwatchable, never hidden.
     */
    async listNodeOptions(userId: string, agent: ComputerAgentRef): Promise<ComputerNodeOption[]> {
        const [nodes, boundNodeId] = await Promise.all([
            this.fleet.listForUser(userId),
            this.boundNodeId(userId, agent.id),
        ]);
        return orderNodeOptions(nodes.map((node) => toNodeOption(node, boundNodeId)));
    }

    async open(input: OpenComputerSessionInput): Promise<OpenComputerSessionOutcome> {
        if (await this.isStopped()) {
            return { refused: 'stopped', stop: await this.stopState() };
        }

        const nodes = await this.fleet.listEnrolledForUser(input.userId);
        if (nodes.length === 0) {
            return { refused: 'no-nodes' };
        }
        const boundNodeId = await this.boundNodeId(input.userId, input.agent.id);
        const options = orderNodeOptions(nodes.map((node) => toNodeOption(node, boundNodeId)));

        let chosen: ComputerNodeOption | undefined;
        if (input.nodeId) {
            chosen = options.find((option) => option.id === input.nodeId);
            if (!chosen) return { refused: 'node-not-found' };
        } else {
            // The Agent's pinned machine is ITS computer, so it is the one
            // opened — and refused with its own reason when it cannot be
            // watched, rather than silently swapped for another machine.
            // With no pin, the first machine that can be watched.
            chosen =
                options.find((option) => option.boundToAgent) ??
                options.find((option) => option.watchable) ??
                options[0];
        }
        if (!chosen.watchable) {
            return {
                refused: 'node-unwatchable',
                nodeId: chosen.id,
                reason: chosen.unwatchableReason as ComputerUnwatchableReason,
            };
        }

        // No channel named: the screen when the machine can show one, else
        // its terminal. A named channel it cannot serve is refused HERE, by
        // value, naming the channel and why — never enqueued as a job no
        // machine could lease.
        const channels: ComputerChannel[] =
            input.channels && input.channels.length > 0
                ? [...new Set(input.channels)]
                : defaultChannelsFor(chosen.servableChannels);
        const missing = channels.find((channel) => !chosen.servableChannels.includes(channel));
        if (missing) {
            return {
                refused: 'channel-unavailable',
                nodeId: chosen.id,
                channel: missing,
                reason: chosen.channelReasons[missing] ?? unavailableReasonFor(missing),
            };
        }

        const target = chosen;
        const limits = this.limits();
        const quality = resolveQuality(input.quality);
        const scope = { userId: input.userId, organizationId: input.agent.organizationId };

        // Count-then-insert is ONE critical section per machine and per
        // Organization: two opens racing each other would otherwise both see
        // the pre-burst count and both insert, walking past the caps. The
        // `requested` row IS the reservation, so it is written inside the lock
        // and the job is enqueued after it is released.
        const admitted = await this.withAdmissionLock(
            { nodeId: target.id, scopeKey: computerSessionScopeKey(scope) },
            async (): Promise<OpenComputerSessionRefusal | AdmittedComputerSession> => {
                await this.expireDue(await this.sessions.findOpenForOwner(input.userId), limits);

                // Every unfinished row the caps read is expired first — including
                // another member's rows in the same Organization — and only the
                // rows still within their time hold a slot.
                const onNode = await this.holdingSlots(
                    await this.sessions.findOpenForNode(target.id),
                    limits,
                );
                if (onNode.length >= limits.perNode) {
                    return {
                        refused: 'node-session-cap',
                        limit: limits.perNode,
                        sessions: onNode.map(toHolder),
                    };
                }
                const inScope = await this.holdingSlots(
                    await this.sessions.findOpenForScope(scope),
                    limits,
                );
                if (inScope.length >= limits.perOrganization) {
                    return {
                        refused: 'organization-session-cap',
                        limit: limits.perOrganization,
                        sessions: inScope.map(toHolder),
                    };
                }

                const dispatcher = this.dispatcher;
                if (!dispatcher) {
                    return { refused: 'dispatcher-unavailable' };
                }

                // Read under the machine's lock, which a profile reset also
                // takes: a view can never carry a key a concurrent reset is
                // rotating away.
                const profile = await this.profiles.ensure({
                    userId: input.userId,
                    organizationId: input.agent.organizationId,
                    nodeId: target.id,
                    agentId: input.agent.id,
                });
                const row = await this.sessions.create({
                    userId: input.userId,
                    organizationId: input.agent.organizationId,
                    agentId: input.agent.id,
                    nodeId: target.id,
                    openedByUserId: input.userId,
                    channels,
                    activeChannel: channels[0],
                    quality,
                    status: 'requested',
                    controlSpans: [],
                });
                return { row, profileKey: profile.profileKey, dispatcher };
            },
        );
        if ('refused' in admitted) {
            return admitted;
        }
        const { row, profileKey, dispatcher } = admitted;

        try {
            const { jobId } = await dispatcher.enqueue({
                sessionId: row.id,
                userId: input.userId,
                organizationId: input.agent.organizationId,
                agentId: input.agent.id,
                nodeId: target.id,
                profileKey,
                channels,
                quality,
            });
            await this.sessions.setFleetJob(row.id, jobId);
            row.fleetJobId = jobId;
        } catch (error) {
            // A session nothing will ever claim must not hold a slot.
            await this.sessions.close(row.id, { closeReason: 'error', endedAt: new Date() });
            throw error;
        }

        await this.audit?.tryRecord({
            action: 'computer.session-open',
            actorUserId: input.userId,
            ownerUserId: input.userId,
            nodeId: chosen.id,
            details: computerAuditDetails('computer.session-open', {
                sessionId: row.id,
                agentId: input.agent.id,
                channels,
                quality,
                runId: null,
            }),
        });
        return { opened: toSessionView(row) };
    }

    /** One session, owner-scoped (a foreign id is null, like an unknown one), expired if due. */
    async getForOwner(
        userId: string,
        agentId: string,
        sessionId: string,
    ): Promise<ComputerSessionView | null> {
        const row = await this.sessions.findForOwner(sessionId, userId, agentId);
        if (!row) return null;
        const expired = await this.expireDue([row], this.limits());
        return toSessionView(expired.get(row.id) ?? row);
    }

    /** Change quality or the active channel of an unfinished session. Null when it is not one. */
    async updateForOwner(
        userId: string,
        agentId: string,
        sessionId: string,
        patch: { quality?: ComputerQuality; activeChannel?: ComputerChannel },
    ): Promise<ComputerSessionView | null> {
        const row = await this.sessions.findForOwner(sessionId, userId, agentId);
        if (!row) return null;
        const next: Partial<ComputerSession> = {};
        if (patch.quality) next.quality = patch.quality;
        if (patch.activeChannel && (row.channels ?? []).includes(patch.activeChannel)) {
            next.activeChannel = patch.activeChannel;
        }
        if (Object.keys(next).length > 0 && !(await this.sessions.updateOpen(row.id, next))) {
            return toSessionView(row);
        }
        return toSessionView({ ...row, ...next } as ComputerSession);
    }

    /** End a session the owner holds. Idempotent: an ended session answers true. */
    async closeForOwner(userId: string, agentId: string, sessionId: string): Promise<boolean> {
        const row = await this.sessions.findForOwner(sessionId, userId, agentId);
        if (!row) return false;
        await this.close(row, 'closed-by-user', userId);
        return true;
    }

    /**
     * End a session by id, whoever holds it — for the platform's own
     * reasons (`no-viewer`, `stopped`, …), never an owner's request. False
     * when it is unknown or already ended.
     */
    async closeById(sessionId: string, reason: ComputerCloseReason): Promise<boolean> {
        const row = await this.sessions.findById(sessionId);
        if (!row || row.status === 'ended') return false;
        return this.close(row, reason, null);
    }

    /**
     * End a session. The CAS makes it once-only: the audit row and the
     * `ended` event fire for the caller that actually ended it, and the
     * fleet job is withdrawn so no machine claims a view nobody is waiting for.
     */
    async close(
        row: ComputerSession,
        reason: ComputerCloseReason,
        actorUserId: string | null,
    ): Promise<boolean> {
        const endedAt = new Date();
        if (!(await this.sessions.close(row.id, { closeReason: reason, endedAt }))) {
            return false;
        }
        if (row.fleetJobId) {
            await this.withdrawJob(row.id, row.fleetJobId);
        }
        const startedMs = row.startedAt ? new Date(row.startedAt).getTime() : NaN;
        await this.audit?.tryRecord({
            action: 'computer.session-close',
            actorUserId,
            ownerUserId: row.userId,
            nodeId: row.nodeId,
            details: computerAuditDetails('computer.session-close', {
                sessionId: row.id,
                agentId: row.agentId,
                closeReason: reason,
                durationMs: Number.isFinite(startedMs) ? endedAt.getTime() - startedMs : 0,
                frameCount: row.frameCount ?? 0,
                recorded: Boolean(row.recorded),
            }),
        });
        this.emit(new ComputerSessionEndedEvent(row.id, row.nodeId, reason));
        return true;
    }

    // ── Node-facing ───────────────────────────────────────────────────────

    /** The session a node may publish into: it must be THAT node's, and unfinished. */
    async findForNode(sessionId: string, nodeId: string): Promise<ComputerSession | null> {
        return this.sessions.findForNode(sessionId, nodeId);
    }

    /**
     * Account for pictures the relay accepted. The first one makes the session
     * `live` and binds it to the Run the node is executing for this Agent at
     * that moment — once; a Run that changes later does not re-bind it.
     */
    async recordPublished(
        row: ComputerSession,
        accepted: { frames: number; bytes: number },
    ): Promise<void> {
        if (accepted.frames <= 0) return;
        const { becameLive } = await this.sessions.recordFrames(
            row.id,
            accepted.frames,
            accepted.bytes,
            new Date(),
        );
        if (becameLive && !row.runId) {
            const runId = await this.runInFlight(row);
            if (runId) await this.sessions.bindRun(row.id, runId);
        }
    }

    /** A node's lifecycle report about its own session — enum-whitelisted. */
    async recordNodeReport(
        row: ComputerSession,
        report: { status?: unknown; closeReason?: unknown },
    ): Promise<void> {
        if (report.status === 'stalled') {
            await this.sessions.markStalled(row.id);
            return;
        }
        if (report.status === 'ended') {
            const reason =
                typeof report.closeReason === 'string' &&
                NODE_REPORTABLE_CLOSE_REASONS.has(report.closeReason as ComputerCloseReason)
                    ? (report.closeReason as ComputerCloseReason)
                    : 'node-unavailable';
            await this.close(row, reason, null);
        }
    }

    /**
     * The fleet stop switch ends every live view (spec: within 5 seconds —
     * the machine reports that often). True when this session was ended
     * here, or already had been, because the fleet is stopped.
     */
    async endIfStopped(row: ComputerSession): Promise<boolean> {
        if (!(await this.isStopped())) return false;
        if (row.status !== 'ended') {
            await this.close(row, 'stopped', null);
        }
        return true;
    }

    /**
     * Ids of views waiting for this node — the heartbeat hint. Every
     * unfinished view on the machine is expired first, whoever opened it, so
     * a view nobody claimed in time is ended as `abandoned` (and its job
     * withdrawn) before the machine is told to go and claim it.
     */
    async pendingForNode(nodeId: string): Promise<string[]> {
        await this.expireDue(await this.sessions.findOpenForNode(nodeId), this.limits());
        return this.sessions.findPendingIdsForNode(nodeId);
    }

    /**
     * End one unfinished session now if it is past its claim timeout, dead
     * stall or ceiling — owner-independent, for the machine-facing routes.
     * Returns the session as it stands afterwards (ended when it expired,
     * whoever's close won), or the row unchanged when it was not due.
     */
    async expireIfDue(row: ComputerSession): Promise<ComputerSession> {
        const limits = this.limits();
        const now = new Date();
        if (!resolveSessionExpiry(row, now, limits)) return row;
        const ended = await this.expireDue([row], limits, now);
        return ended.get(row.id) ?? (await this.sessions.findById(row.id)) ?? row;
    }

    /**
     * A machine just leased a `computer-session` job. If the view it carries
     * is already over — ended while the claim was racing its withdrawal, or
     * past its claim timeout with nobody having noticed yet — end it (as
     * `abandoned` when it was never claimed in time) and withdraw the job,
     * so the machine aborts on its next job heartbeat instead of showing a
     * view nobody is waiting for. True when the lease was withdrawn.
     *
     * The node-facing routes refuse to make such a view live on their own
     * (see {@link expireIfDue}); this only makes the machine stop sooner.
     */
    async withdrawLeaseIfOver(sessionId: string, jobId: string): Promise<boolean> {
        const row = await this.sessions.findById(sessionId);
        if (row && row.fleetJobId && row.fleetJobId !== jobId) {
            // Not the job that carries this session — nothing of ours to settle.
            return false;
        }
        if (row && row.status !== 'ended') {
            const current = await this.expireIfDue(row);
            if (current.status !== 'ended') return false;
            // `close` already withdrew the job it knew about.
            if (row.fleetJobId === jobId) return true;
        }
        await this.withdrawJob(sessionId, jobId);
        return true;
    }

    /**
     * The fleet job that carried a session settled on its own — the node
     * finished or dropped it, its lease lapsed, or the queue gave up on it.
     * A view still waiting for a claim is `abandoned`; one that was showing
     * pictures lost its machine (`node-unavailable`). An already-ended
     * session (the usual case: closing it withdrew the job) is left alone.
     */
    async closeForSettledJob(sessionId: string, jobId?: string): Promise<void> {
        const row = await this.sessions.findById(sessionId);
        if (!row || row.status === 'ended') return;
        // A job that is not the one carrying this session settles nothing here.
        if (jobId && row.fleetJobId && row.fleetJobId !== jobId) return;
        await this.close(row, row.status === 'requested' ? 'abandoned' : 'node-unavailable', null);
    }

    /**
     * The floor under inline expiry: end every unfinished session of this
     * owner that is past its claim timeout, dead stall or ceiling. Returns
     * how many ended.
     */
    async reapExpired(userId: string): Promise<number> {
        const ended = await this.expireDue(
            await this.sessions.findOpenForOwner(userId),
            this.limits(),
        );
        return [...ended.values()].filter((row) => row.status === 'ended').length;
    }

    /**
     * Expire what is due among `rows`, then answer the rows that still hold a
     * slot: those NOT past their time at the same instant. A row that was due
     * is not counted even when another caller's close won it, or its close
     * failed — it is over either way, and must never refuse a new view.
     */
    private async holdingSlots(
        rows: ComputerSession[],
        limits: ComputerSessionLimits,
    ): Promise<ComputerSession[]> {
        const now = new Date();
        const expired = await this.expireDue(rows, limits, now);
        return rows.filter(
            (row) =>
                !expired.has(row.id) &&
                row.status !== 'ended' &&
                resolveSessionExpiry(row, now, limits) === null,
        );
    }

    private async withAdmissionLock<T>(
        keys: ComputerAdmissionLockKeys,
        fn: () => Promise<T>,
    ): Promise<T> {
        // Optional on the repository so hand-built doubles keep working; the
        // real repository always has it (a no-op off Postgres).
        return typeof this.sessions.withAdmissionLock === 'function'
            ? this.sessions.withAdmissionLock(keys, fn)
            : fn();
    }

    private async withdrawJob(sessionId: string, jobId: string): Promise<void> {
        if (!this.dispatcher?.cancel) return;
        try {
            await this.dispatcher.cancel(jobId);
        } catch (error) {
            this.logger.warn(
                `computer session ${sessionId}: job ${jobId} could not be withdrawn: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async expireDue(
        rows: ComputerSession[],
        limits: ComputerSessionLimits,
        now: Date = new Date(),
    ): Promise<Map<string, ComputerSession>> {
        const out = new Map<string, ComputerSession>();
        for (const row of rows) {
            const reason = resolveSessionExpiry(row, now, limits);
            if (!reason) continue;
            try {
                if (await this.close(row, reason, null)) {
                    out.set(row.id, { ...row, status: 'ended', closeReason: reason, endedAt: now });
                }
            } catch (error) {
                this.logger.warn(
                    `computer session ${row.id} could not be expired: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        return out;
    }

    private async runInFlight(row: ComputerSession): Promise<string | null> {
        try {
            const active = await this.jobs.findActiveForUser(row.userId);
            for (const job of active) {
                const payload = job.payload as Record<string, unknown> | null;
                if (
                    job.nodeId === row.nodeId &&
                    job.kind === 'agent-task' &&
                    payload?.agentId === row.agentId &&
                    typeof payload.runId === 'string'
                ) {
                    return payload.runId;
                }
            }
        } catch (error) {
            this.logger.debug(
                `computer session ${row.id}: run lookup skipped: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return null;
    }

    private async boundNodeId(userId: string, agentId: string): Promise<string | null> {
        try {
            return (await this.affinities.findForOwnedAgent(userId, agentId))?.nodeId ?? null;
        } catch {
            // The binding only ORDERS the picker; an unreadable one must not refuse a watch.
            return null;
        }
    }

    private async isStopped(): Promise<boolean> {
        if (!this.killSwitch) return false;
        try {
            return await this.killSwitch.isStopped();
        } catch {
            return true; // fail closed, like every other reader of the stop flag
        }
    }

    private async stopState(): Promise<FleetKillSwitchState | null> {
        try {
            return (await this.killSwitch?.publicState()) ?? null;
        } catch {
            return null;
        }
    }

    private emit(event: ComputerSessionEndedEvent): void {
        try {
            this.events?.emit(ComputerSessionEndedEvent.EVENT_NAME, event);
        } catch (error) {
            this.logger.warn(
                `computer session ${event.sessionId}: ended event failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

/** The per-channel reason a channel is missing when the policy named none. */
function unavailableReasonFor(channel: ComputerChannel): ComputerUnwatchableReason {
    return channel === 'terminal' ? 'no-terminal' : 'no-browser';
}

export function toNodeOption(node: FleetNodeView, boundNodeId: string | null): ComputerNodeOption {
    const { watchable, reason, servableChannels, channelReasons } = resolveWatchability(node);
    return {
        id: node.id,
        name: node.name,
        kind: node.kind,
        status: node.status,
        platform: node.platform ?? null,
        lastHeartbeatAt: node.lastHeartbeatAt ?? null,
        servableChannels,
        channelReasons,
        watchable,
        unwatchableReason: reason,
        boundToAgent: boundNodeId !== null && node.id === boundNodeId,
        controlPolicy: node.controlPolicy ?? 'owner',
    };
}

/** Bound first, then online by most recent heartbeat, then the rest (stable). */
export function orderNodeOptions(options: ComputerNodeOption[]): ComputerNodeOption[] {
    const beat = (option: ComputerNodeOption) =>
        option.lastHeartbeatAt ? new Date(option.lastHeartbeatAt).getTime() || 0 : 0;
    const rank = (option: ComputerNodeOption) =>
        option.boundToAgent ? 0 : option.status === 'online' ? 1 : 2;
    return options
        .map((option, index) => ({ option, index }))
        .sort(
            (a, b) =>
                rank(a.option) - rank(b.option) ||
                (rank(a.option) === 1 ? beat(b.option) - beat(a.option) : 0) ||
                a.index - b.index,
        )
        .map(({ option }) => option);
}

function iso(value?: Date | string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toHolder(row: ComputerSession): ComputerSessionHolderView {
    return {
        sessionId: row.id,
        nodeId: row.nodeId,
        openedByUserId: row.openedByUserId,
        status: row.status,
        since: iso(row.startedAt ?? row.createdAt),
    };
}

export function toSessionView(row: ComputerSession): ComputerSessionView {
    const bytes = Number(row.bytesOut ?? 0);
    return {
        id: row.id,
        agentId: row.agentId,
        nodeId: row.nodeId,
        openedByUserId: row.openedByUserId,
        runId: row.runId ?? null,
        channels: Array.isArray(row.channels) ? row.channels : ['screen'],
        activeChannel: row.activeChannel ?? 'screen',
        quality: resolveQuality(row.quality),
        status: row.status,
        closeReason: row.closeReason ?? null,
        controlSpans: Array.isArray(row.controlSpans) ? row.controlSpans : [],
        recorded: Boolean(row.recorded),
        recordingSkippedReason: row.recordingSkippedReason ?? null,
        frameCount: row.frameCount ?? 0,
        bytesOut: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
        lastFrameAt: iso(row.lastFrameAt),
        startedAt: iso(row.startedAt),
        endedAt: iso(row.endedAt),
        createdAt: iso(row.createdAt),
    };
}
