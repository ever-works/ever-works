import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
    boundFleetSessionScreen,
    clampFleetSessionSize,
    effectiveConsents,
    fleetFamilyAllows,
    FLEET_AGENT_SESSION_DEFAULT_PERMISSION_MODE,
    FLEET_AGENT_SESSION_LEASE_TTL_SEC,
    FLEET_AGENT_SESSION_QUEUED_TIMEOUT_MS,
    FLEET_SESSION_FIRST_MESSAGE_MIN_LENGTH,
    isFleetAgentSessionProvider,
    FLEET_SESSION_CWD_MAX_LENGTH,
    FLEET_SESSION_END_GRACE_MS,
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    FLEET_SESSION_MAX_OWNER_PER_NODE,
    FLEET_SESSION_STARTING_TIMEOUT_MS,
    FLEET_SESSION_TITLE_MAX_LENGTH,
    isFleetSessionAgentProvider,
    isFleetSessionKind,
    isFleetSessionLive,
    isFleetSessionStartableProvider,
    type FleetAgentSessionResult,
    type FleetAuditAction,
    type FleetSessionEndedReason,
    type FleetSessionOutcome,
    type FleetSessionEventMessage,
    type FleetSessionListMessage,
    type FleetSessionListResponse,
    type FleetSessionStartRequest,
    type FleetSessionStartableProvider,
    type FleetSessionView,
} from '@ever-works/contracts';
import type { FleetNode } from '../../entities/fleet-node.entity';
import type { FleetSession } from '../../entities/fleet-session.entity';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import { redactSecrets } from '../../utils/secret-scan';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { fleetSessionError, readFleetSessionError } from './fleet-session.errors';
import {
    FLEET_SESSION_NODE_PORT,
    type FleetSessionNodePort,
    type FleetSessionNodeRequest,
    type FleetSessionPortCaller,
} from './fleet-session-node.port';
import {
    applyFleetSessionEvent,
    canAttachFleetSession,
    canStartFleetSession,
    endFleetSessionPatch,
    FLEET_SESSION_PROVIDER_LABELS,
    type FleetSessionPatch,
    type FleetSessionRowFacts,
} from './fleet-session.policy';
import {
    FLEET_SESSION_LIST_DEFAULT_LIMIT,
    FLEET_SESSION_LIST_MAX_LIMIT,
    fleetSessionCursor,
    FleetSessionRepository,
    type FleetSessionListQuery,
} from './fleet-session.repository';
import { toFleetSessionView } from './fleet-session.view';
import { AGENT_SESSION_DISPATCHER, type AgentSessionDispatcher } from './agent-session.dispatcher';

/**
 * Sessions on computers (FL-04) — the platform's one writer of
 * `fleet_sessions` (CONTRACTS §4.2, §5, §7; spec FR-12 … FR-20, FR-34 … FR-41).
 *
 * Every act runs, in order: existence and the Node's `sessions` family
 * audience (FL-01's role derivation — a stranger gets the 404 of an unknown
 * id, a member outside the audience `permission_denied` with who to ask),
 * the kill switch (fail-closed), then the act's own rules
 * (`fleet-session.policy.ts`), then the machine through the node link, then
 * the row, then one `fleet_audit` row with `family: 'sessions'`, the session
 * as `target`, the requester and the confirmation class — never a terminal
 * byte, a keystroke or the first message (FR-36).
 *
 * The machine is the source of truth for the PROCESS, the platform for the
 * ROW: a start writes its row only once the node said the process runs (no
 * phantom sessions); an end the node cannot hear (it is offline) ends the row
 * here and the node is told when it returns (`reconcileList`).
 */

/** Who acts. P1: a person; P2 adds Agents (always Agent sessions, FR-51). */
export interface FleetSessionActor {
    userId: string;
    /**
     * Set when an Agent acts through its tools (FL-04 P2, FR-51): every start is
     * then an Agent session of THIS Agent, never an owner session, whatever the
     * request says. `userId` is the Agent's owner.
     */
    agentId?: string;
}

/** How an `agent-session` job settled (the API's job listener reports it). */
export interface FleetAgentSessionJobSettlement {
    succeeded: boolean;
    result: Partial<FleetAgentSessionResult> | null;
    error: string | null;
}

export interface FleetSessionEndRequest {
    /** CONTRACTS §2.2 class `confirm`: without it the call answers `confirmation_required`. */
    confirm?: boolean;
}

/** How long an event that beat its row is kept to apply once the row exists. */
const EARLY_EVENT_TTL_MS = 10_000;
/** A row younger than this is never ended by a `session.list` that may have raced its start. */
const RECONCILE_GRACE_MS = 30_000;

function describeAgo(since: Date | string | null | undefined, now: number): string | null {
    if (!since) return null;
    const at = since instanceof Date ? since.getTime() : Date.parse(since);
    if (!Number.isFinite(at)) return null;
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 90) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}

function rowFacts(row: FleetSession): FleetSessionRowFacts {
    return {
        state: row.state,
        outcome: row.outcome ?? null,
        endedReason: row.endedReason ?? null,
        title: row.title,
        startedAt: row.startedAt ?? null,
        lastScreen: row.lastScreen ?? null,
        exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
    };
}

function isPathSeparator(char: string): boolean {
    return char === '/' || char === '\\';
}

/**
 * The last folder name of a path. A plain scan, never a regex anchored at the
 * end of a separator run: the folder is the caller's input, and
 * `/[\\/]+$/` backtracks polynomially on a long run of separators that does
 * not end the string (CodeQL js/polynomial-redos).
 */
export function fleetSessionFolderTitle(cwd: string): string {
    let end = cwd.length;
    while (end > 0 && isPathSeparator(cwd.charAt(end - 1))) end -= 1;
    const trimmed = cwd.slice(0, end);
    if (trimmed === '~' || trimmed === '') return '~';
    let start = end;
    while (start > 0 && !isPathSeparator(trimmed.charAt(start - 1))) start -= 1;
    return trimmed.slice(start) || trimmed;
}

/** The default title: the first message's opening words for an agent, else the folder. */
export function defaultFleetSessionTitle(
    provider: FleetSessionStartableProvider,
    cwd: string,
    firstMessage?: string,
): string {
    if (isFleetSessionAgentProvider(provider) && firstMessage?.trim()) {
        const preview = redactSecrets(firstMessage.trim().replace(/\s+/g, ' ')).cleaned;
        return preview.length > 60 ? `${preview.slice(0, 57)}…` : preview;
    }
    return fleetSessionFolderTitle(cwd).slice(0, FLEET_SESSION_TITLE_MAX_LENGTH);
}

@Injectable()
export class FleetSessionService {
    private readonly logger = new Logger(FleetSessionService.name);
    /** Node reports that arrived before their row existed, by `nodeId:sessionId`. */
    private readonly early = new Map<
        string,
        { at: number; messages: FleetSessionEventMessage[] }
    >();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly sessions: FleetSessionRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() @Inject(FLEET_SESSION_NODE_PORT) private readonly node?: FleetSessionNodePort,
        // FL-04 P2 — Agent sessions: the Agent (ownership), its Run, and the
        // `agent-session` job. `@Optional()` so a context without them (a
        // test, the worker) answers "this deployment does not run Agent
        // sessions" instead of failing to boot.
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly runs?: AgentRunRepository,
        @Optional()
        @Inject(AGENT_SESSION_DISPATCHER)
        private readonly agentDispatcher?: AgentSessionDispatcher,
    ) {}

    // ─── Reads ─────────────────────────────────────────────────────────────

    /** One session, with its last screen (the detail page). */
    async get(id: string, actor: FleetSessionActor): Promise<FleetSessionView> {
        const { session } = await this.resolve(id, actor);
        return toFleetSessionView(session, { includeScreen: true });
    }

    /** A node's sessions, most recently active first (the computer page's Sessions tab). */
    async listForNode(
        nodeId: string,
        actor: FleetSessionActor,
        query: FleetSessionListQuery = {},
    ): Promise<FleetSessionView[]> {
        const { node } = await this.nodeFor(nodeId, actor);
        const rows = await this.sessions.listForNodes([node.id], query);
        return rows.map((row) => toFleetSessionView(row));
    }

    /** Sessions on every node the person may see sessions on. */
    async list(
        actor: FleetSessionActor,
        query: FleetSessionListQuery & { nodeId?: string } = {},
    ): Promise<FleetSessionView[]> {
        if (query.nodeId) return this.listForNode(query.nodeId, actor, query);
        const nodeIds = await this.visibleNodeIds(actor);
        const rows = await this.sessions.listForNodes(nodeIds, query);
        return rows.map((row) => toFleetSessionView(row));
    }

    /**
     * One page for the REST list routes and the tools: the views, most
     * recently active first, and the next page's cursor (null on the last).
     * With `nodeId` the node's own audience check runs first (404 / 403);
     * without it only the nodes the person may see sessions on are read.
     */
    async listPage(
        actor: FleetSessionActor,
        query: FleetSessionListQuery & { nodeId?: string } = {},
    ): Promise<FleetSessionListResponse> {
        const limit = Math.min(
            FLEET_SESSION_LIST_MAX_LIMIT,
            Math.max(1, Math.floor(query.limit ?? FLEET_SESSION_LIST_DEFAULT_LIMIT)),
        );
        const nodeIds = query.nodeId
            ? [(await this.nodeFor(query.nodeId, actor)).node.id]
            : await this.visibleNodeIds(actor);
        const rows = await this.sessions.listForNodes(nodeIds, { ...query, limit });
        const last = rows.length === limit ? rows[rows.length - 1] : undefined;
        return {
            sessions: rows.map((row) => toFleetSessionView(row)),
            nextCursor: last ? fleetSessionCursor(last) : null,
        };
    }

    /** The start dialog's "Recent" folders for a node (spec FR-15). */
    async recentFolders(nodeId: string, actor: FleetSessionActor): Promise<string[]> {
        const { node } = await this.nodeFor(nodeId, actor);
        return this.sessions.recentFolders(node.id);
    }

    /**
     * A node after the `sessions` audience check, refusals in the CONTRACTS
     * §8 envelope: outside the node's `view` audience the 404 of an unknown
     * id, inside it but not `sessions` `permission_denied` with who to ask.
     */
    async nodeFor(nodeId: string, actor: FleetSessionActor): Promise<{ node: FleetNode }> {
        try {
            const { node } = await this.access.resolveForFamily(nodeId, actor.userId, 'sessions');
            return { node };
        } catch (error) {
            const typed = readFleetSessionError(error);
            if (typed?.code === 'permission_denied')
                throw fleetSessionError(typed.code, typed.hint, typed.details);
            throw fleetSessionError('not_found', 'no such computer');
        }
    }

    /** The node a session runs on, after the audience check (attach, tools). */
    async resolve(
        id: string,
        actor: FleetSessionActor,
    ): Promise<{ session: FleetSession; node: FleetNode }> {
        const session =
            typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)
                ? await this.sessions.findById(id)
                : null;
        if (!session) throw fleetSessionError('not_found', 'no such session');
        try {
            const { node } = await this.access.resolveForFamily(
                session.nodeId,
                actor.userId,
                'sessions',
            );
            return { session, node };
        } catch (error) {
            // A session on a node the person may not see is as unknown as a missing one.
            const typed = readFleetSessionError(error);
            if (typed?.code === 'permission_denied') throw error;
            throw fleetSessionError('not_found', 'no such session');
        }
    }

    // ─── Start ─────────────────────────────────────────────────────────────

    /**
     * Start an OWNER session (spec FR-12 … FR-17). Refusals, in order:
     * existence / audience, the request's own shape, then the policy's chain
     * (kill switch → node state → `--manage` → reachable → daemon → CLI →
     * eight owner sessions), then the machine's own answer.
     */
    async start(
        nodeId: string,
        actor: FleetSessionActor,
        request: FleetSessionStartRequest,
        options: { restartOf?: FleetSession } = {},
    ): Promise<FleetSessionView> {
        const { node } = await this.nodeFor(nodeId, actor);
        // FR-51: an Agent acting through its tools only ever starts an Agent session of itself.
        const kind = actor.agentId ? 'agent' : request.kind;
        if (!isFleetSessionKind(kind)) throw fleetSessionError('invalid', 'kind');
        if (kind === 'agent') {
            return this.startAgent(
                node,
                actor,
                actor.agentId ? { ...request, kind: 'agent', agentId: actor.agentId } : request,
                options,
            );
        }
        if (!isFleetSessionStartableProvider(request.provider))
            throw fleetSessionError('invalid', 'provider');
        const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';
        if (cwd.length === 0 || cwd.length > FLEET_SESSION_CWD_MAX_LENGTH || cwd.includes('\0')) {
            throw fleetSessionError('invalid', 'choose a folder on the computer', { field: 'cwd' });
        }
        if (request.newWorktreeOf || request.checkoutId) {
            throw fleetSessionError('invalid', 'New worktrees arrive with Checkouts', {
                field: 'checkout',
            });
        }
        const firstMessage =
            isFleetSessionAgentProvider(request.provider) &&
            typeof request.firstMessage === 'string'
                ? request.firstMessage
                : undefined;
        if (
            firstMessage !== undefined &&
            firstMessage.length > FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH
        ) {
            throw fleetSessionError('invalid', 'the first message is at most 4 000 characters', {
                field: 'firstMessage',
            });
        }
        const title = (
            request.title?.trim() || defaultFleetSessionTitle(request.provider, cwd, firstMessage)
        ).slice(0, FLEET_SESSION_TITLE_MAX_LENGTH);
        const size = clampFleetSessionSize(request.cols, request.rows);
        const killSwitchOn = await this.isStopped();
        const linkConnected = this.node?.isConnected(node.id) ?? false;
        const consents =
            this.node?.liveConsents(node.id) ??
            effectiveConsents({
                consents: node.consents,
                capabilities: node.capabilities,
                workerState: node.workerState,
            });
        const live = await this.sessions.findLiveOwnerForNode(node.id);
        const refusal = canStartFleetSession({
            node: {
                name: node.name,
                status: node.status,
                kind: node.kind,
                capabilities: node.capabilities ?? [],
                lastHeartbeatAt: node.lastHeartbeatAt ?? null,
                sessionDaemon: node.sessionDaemon ?? null,
            },
            consents,
            kind,
            provider: request.provider,
            killSwitchOn,
            linkConnected,
            liveOwnerSessions: live.map((row) => this.listing(row)),
            lastSeenAgo: describeAgo(node.lastHeartbeatAt ?? null, this.now()),
        });
        const requestedBy = `user:${actor.userId}`;
        const action: FleetAuditAction = options.restartOf
            ? 'node.session.restart'
            : 'node.session.start';
        if (refusal) {
            await this.record(action, actor.userId, node, null, {
                kind,
                provider: request.provider,
                confirmationClass: 'plain',
                outcome: 'refused',
                code: refusal.code,
                ...(options.restartOf ? { restartOf: options.restartOf.id } : {}),
            });
            throw fleetSessionError(refusal.code, refusal.hint, refusal.details);
        }

        const id = randomUUID();
        const caller: FleetSessionPortCaller = { kind: 'user', userId: actor.userId };
        try {
            await this.requireNode().request({
                nodeId: node.id,
                sessionId: id,
                kind,
                mode: 'driver',
                verb: options.restartOf ? 'session.restart' : 'session.start',
                params: {
                    kind,
                    provider: request.provider,
                    cwd,
                    title,
                    cols: size.cols,
                    rows: size.rows,
                    startedBy: requestedBy,
                    ...(firstMessage?.trim() ? { firstMessage } : {}),
                    ...(options.restartOf ? { restartOf: options.restartOf.daemonSessionId } : {}),
                },
                caller,
                stateChanging: true,
            });
        } catch (error) {
            const typed = readFleetSessionError(error) ?? {
                code: 'internal' as const,
                hint: 'the session could not start',
            };
            await this.record(action, actor.userId, node, null, {
                kind,
                provider: request.provider,
                confirmationClass: 'plain',
                outcome: 'refused',
                code: typed.code,
            });
            throw fleetSessionError(typed.code, typed.hint, typed.details);
        }

        // The process runs. Admit the row under the node's lock: a start that
        // raced past the limit ends the process it just started, and says why.
        const now = new Date(this.now());
        const row = await this.sessions.withAdmissionLock(node.id, async () => {
            const current = await this.sessions.findLiveOwnerForNode(node.id);
            if (current.length >= FLEET_SESSION_MAX_OWNER_PER_NODE) return { over: current };
            return {
                row: await this.sessions.create({
                    id,
                    nodeId: node.id,
                    userId: actor.userId,
                    organizationId: node.organizationId ?? null,
                    kind,
                    provider: request.provider,
                    agentId: null,
                    agentRunId: null,
                    checkoutId: null,
                    cwd,
                    title,
                    state: 'working',
                    outcome: null,
                    daemonSessionId: id,
                    providerSessionId: null,
                    firstMessage: firstMessage?.trim() ? redactSecrets(firstMessage).cleaned : null,
                    lastScreen: null,
                    restartOfSessionId: options.restartOf?.id ?? null,
                    startedBy: requestedBy,
                    lastActivityAt: now,
                    startedAt: now,
                    endedAt: null,
                    endedReason: null,
                    exitCode: null,
                    recordingState: 'off',
                }),
            };
        });
        if ('over' in row) {
            void this.tellNode(
                node.id,
                id,
                kind,
                'session.end',
                { reason: 'user', graceMs: 0 },
                {
                    kind: 'system',
                    job: 'session-admission',
                },
            );
            throw fleetSessionError(
                'limit_exceeded',
                `${node.name} already has ${row.over.length} sessions. End one to start another.`,
                {
                    limit: FLEET_SESSION_MAX_OWNER_PER_NODE,
                    sessions: row.over.map((entry) => this.listing(entry)),
                },
            );
        }
        await this.record(action, actor.userId, node, id, {
            kind,
            provider: request.provider,
            confirmationClass: 'plain',
            outcome: 'started',
            ...(options.restartOf ? { restartOf: options.restartOf.id } : {}),
        });
        const applied = await this.drainEarly(node.id, row.row);
        return toFleetSessionView(applied);
    }

    /** Restart an ended session: a new one, same kind, provider, folder and title, linked back (FR-20). */
    async restart(
        id: string,
        actor: FleetSessionActor,
        size: { cols?: number; rows?: number } = {},
        options: { expectNodeId?: string } = {},
    ): Promise<FleetSessionView> {
        const { session, node } = await this.resolve(id, actor);
        // The start route's `restartOf` names the computer in its path too:
        // a session of another computer is not this computer's to restart.
        if (options.expectNodeId !== undefined && options.expectNodeId !== node.id) {
            throw fleetSessionError('invalid', 'that session ran on another computer', {
                field: 'restartOf',
            });
        }
        if (isFleetSessionLive(session.state)) {
            throw fleetSessionError('invalid', 'the session is still running; end it first', {
                state: session.state,
            });
        }
        if (!isFleetSessionStartableProvider(session.provider)) {
            throw fleetSessionError(
                'unsupported_on_node',
                'this kind of session cannot be restarted',
            );
        }
        return this.start(
            node.id,
            actor,
            {
                kind: session.kind,
                provider: session.provider,
                cwd: session.cwd,
                title: session.title,
                // An Agent session starts again as the same Agent, with the
                // first message it kept (redacted when it was stored).
                ...(session.kind === 'agent' && session.agentId ? { agentId: session.agentId } : {}),
                ...(session.kind === 'agent' && session.firstMessage
                    ? { firstMessage: session.firstMessage }
                    : {}),
                ...(size.cols !== undefined ? { cols: size.cols } : {}),
                ...(size.rows !== undefined ? { rows: size.rows } : {}),
            },
            { restartOf: session },
        );
    }

    // ─── Rename, end ───────────────────────────────────────────────────────

    /** Rename (FR-19): the platform's title wins; the daemon is told so it survives a node restart. */
    async rename(
        id: string,
        actor: FleetSessionActor,
        rawTitle: string,
    ): Promise<FleetSessionView> {
        const { session, node } = await this.resolve(id, actor);
        const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
        if (title.length === 0 || title.length > FLEET_SESSION_TITLE_MAX_LENGTH) {
            throw fleetSessionError('invalid', 'a title is 1–200 characters', { field: 'title' });
        }
        if (await this.isStopped())
            throw fleetSessionError('kill_switch', 'clear it under Settings → Fleet');
        if (title === session.title) return toFleetSessionView(session);
        if (isFleetSessionLive(session.state)) {
            await this.tellNode(
                node.id,
                session.daemonSessionId,
                session.kind,
                'session.rename',
                { title },
                {
                    kind: 'user',
                    userId: actor.userId,
                },
            );
        }
        await this.sessions.update(session.id, { title });
        await this.record('node.session.rename', actor.userId, node, session.id, {
            confirmationClass: 'plain',
            outcome: 'renamed',
        });
        return toFleetSessionView({ ...session, title });
    }

    /**
     * End (FR-18): CONTRACTS §2.2 class `confirm`. The machine stops the
     * process (terminate, kill after 5 s); a machine that cannot be reached
     * still has its row ended here, and is told when it returns. Idempotent:
     * ending an ended session answers it as it is.
     */
    async end(
        id: string,
        actor: FleetSessionActor,
        request: FleetSessionEndRequest = {},
    ): Promise<FleetSessionView> {
        const { session, node } = await this.resolve(id, actor);
        if (!isFleetSessionLive(session.state))
            return toFleetSessionView(session, { includeScreen: true });
        if (request.confirm !== true) {
            throw fleetSessionError(
                'confirmation_required',
                `End "${session.title}" on ${node.name}?`,
                {
                    class: 'confirm',
                    summary: `End "${session.title}" on ${node.name}? The process is stopped; its screen is kept.`,
                },
            );
        }
        if (await this.isStopped())
            throw fleetSessionError('kill_switch', 'clear it under Settings → Fleet');
        let reached = false;
        try {
            await this.requireNode().request({
                nodeId: node.id,
                sessionId: session.daemonSessionId,
                kind: session.kind,
                mode: 'driver',
                verb: 'session.end',
                params: { reason: 'user', graceMs: FLEET_SESSION_END_GRACE_MS },
                caller: { kind: 'user', userId: actor.userId },
                stateChanging: true,
            });
            reached = true;
        } catch (error) {
            const typed = readFleetSessionError(error);
            // Unreachable (or the daemon no longer knows it): end the row here;
            // the node reconciles on return. Anything else is a real refusal.
            if (
                typed &&
                typed.code !== 'unreachable' &&
                typed.code !== 'not_found' &&
                typed.code !== 'unsupported_on_node'
            ) {
                throw fleetSessionError(typed.code, typed.hint, typed.details);
            }
        }
        const ended = await this.endRow(session, 'user');
        if (session.kind === 'agent') {
            // Ending either ends both (R-1): withdraw the job (a queued one is
            // dropped, a claimed one sees the cancel on its next keep-alive) and
            // settle the Run.
            await this.withdrawAgentJob(session.id);
            await this.settleAgentRun(ended, 'cancelled', 'the session was ended by a person');
        }
        await this.record('node.session.end', actor.userId, node, session.id, {
            reason: 'user',
            confirmationClass: 'confirm',
            outcome: reached ? 'ended' : 'ended-platform-side',
        });
        return toFleetSessionView(ended, { includeScreen: true });
    }

    // ─── Attach (FL-04 P1b) ────────────────────────────────────────────────

    /**
     * May this person attach in `role` (spec FR-21 … FR-26)? Existence and the
     * `sessions` audience first (a stranger reads the 404 of an unknown id),
     * then the policy: the kill switch (drivers only — a watcher reads the stop
     * banner), an ended session (its page shows the last screen instead), the
     * link, and the five-viewer cap over `attached` (who the caller's replica
     * counts right now). Answers the session and its node; the API mints the
     * viewer token through FL-02.
     */
    async authorizeAttach(
        id: string,
        actor: FleetSessionActor,
        role: 'viewer' | 'driver',
        attached: readonly string[],
    ): Promise<{ session: FleetSession; node: FleetNode }> {
        const { session, node } = await this.resolve(id, actor);
        const refusal = canAttachFleetSession({
            state: session.state,
            killSwitchOn: await this.isStopped(),
            linkConnected: this.node?.isConnected(node.id) ?? false,
            nodeName: node.name,
            attached,
            role,
        });
        if (refusal) {
            await this.record('node.session.attach', actor.userId, node, session.id, {
                role,
                confirmationClass: 'plain',
                outcome: 'refused',
                code: refusal.code,
            });
            throw fleetSessionError(refusal.code, refusal.hint, refusal.details);
        }
        return { session, node };
    }

    /**
     * The live view's audit rows (spec FR-35): `node.session.attach` when a
     * viewer's channel opened, and ONE `node.session.input` per driver span
     * (its start, end and byte count — never a keystroke). Best effort: a
     * session or node that is gone writes nothing.
     */
    async recordViewer(
        action: 'node.session.attach' | 'node.session.input',
        userId: string,
        sessionId: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        try {
            const session = await this.sessions.findById(sessionId);
            if (!session) return;
            const node = await this.nodes.findById(session.nodeId);
            if (!node) return;
            await this.record(action, userId, node, session.id, {
                confirmationClass: 'plain',
                ...details,
            });
        } catch (error) {
            this.logger.debug(
                `${action} audit for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * Whether this person may still see the session (the live view's 30 s
     * re-check). Only a refusal says no; a database that cannot answer right
     * now keeps the viewer (the next tick asks again).
     */
    async canStillSee(id: string, actor: FleetSessionActor): Promise<boolean> {
        try {
            await this.resolve(id, actor);
            return true;
        } catch (error) {
            const typed = readFleetSessionError(error);
            return !(typed && (typed.code === 'not_found' || typed.code === 'permission_denied'));
        }
    }

    // ─── What the node reports (channel 0) ─────────────────────────────────

    /**
     * One `session.event` from a node (CONTRACTS §3.2–3.3, §5.1). An event
     * for a session the platform does not know yet (its row is being
     * written) is held briefly and applied when the row lands. Never throws:
     * a bad report is logged and dropped.
     */
    async applyNodeEvent(nodeId: string, message: FleetSessionEventMessage): Promise<void> {
        try {
            const row = await this.sessions.findByDaemonId(nodeId, message.sessionId);
            if (!row) {
                this.holdEarly(nodeId, message);
                return;
            }
            await this.applyToRow(nodeId, row, message);
        } catch (error) {
            this.logger.warn(
                `session.event ${message.event} for ${message.sessionId} on node ${nodeId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * The node's `session.list` after a (re)connect (FR-11, U13):
     *
     *  - a live row the RUNNING daemon does not hold is a session whose process
     *    is gone — ended `node-restart`, `unconfirmed`, keeping any screen;
     *  - a session the daemon still runs whose row ENDED (ended here while the
     *    node was away) is ended on the machine with the row's reason;
     *  - a daemon that is not running decides nothing (it may come back).
     *
     * Ended sessions the daemon still holds arrive as their own `exited` /
     * `lost` events with their screens, right after the list.
     */
    async reconcileList(nodeId: string, message: FleetSessionListMessage): Promise<void> {
        try {
            const held = new Map(message.sessions.map((entry) => [entry.sessionId, entry]));
            const now = this.now();
            if (message.daemon.state === 'running') {
                for (const row of await this.sessions.findLiveForNode(nodeId)) {
                    const entry = held.get(row.daemonSessionId);
                    if (entry) {
                        if (row.state === 'starting' && entry.alive) {
                            await this.applyToRow(nodeId, row, {
                                type: 'session.event',
                                sessionId: row.daemonSessionId,
                                event: 'started',
                            });
                        }
                        continue;
                    }
                    const created =
                        row.createdAt instanceof Date
                            ? row.createdAt.getTime()
                            : Date.parse(String(row.createdAt));
                    if (Number.isFinite(created) && now - created < RECONCILE_GRACE_MS) continue;
                    await this.endRow(row, 'node-restart');
                }
            }
            for (const entry of message.sessions) {
                if (!entry.alive) continue;
                const row = await this.sessions.findByDaemonId(nodeId, entry.sessionId);
                if (!row || isFleetSessionLive(row.state)) continue;
                await this.tellNode(
                    nodeId,
                    row.daemonSessionId,
                    row.kind,
                    'session.end',
                    { reason: row.endedReason ?? 'user', graceMs: FLEET_SESSION_END_GRACE_MS },
                    { kind: 'system', job: 'session-reconcile' },
                );
            }
        } catch (error) {
            this.logger.warn(
                `session.list from node ${nodeId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * The sweeper (cron, CONTRACTS §10): owner sessions still `starting` a
     * minute after they were asked for are ended `timeout`, `unconfirmed`.
     * Sessions on an offline node are NEVER ended here — the daemon may hold
     * them; the node reports their fate when it returns.
     */
    async sweepStale(): Promise<{ ended: number }> {
        const cutoff = new Date(this.now() - FLEET_SESSION_STARTING_TIMEOUT_MS);
        let ended = 0;
        for (const row of await this.sessions.findStartingBefore(cutoff)) {
            const next = await this.endRow(row, 'timeout');
            if (next.state === 'ended' && next.endedReason === 'timeout') ended += 1;
        }
        // FL-04 P2: an Agent session waits for a slot (its job is queued) — up
        // to ten minutes, then it is ended `timeout` with its job and Run.
        const agentCutoff = new Date(this.now() - FLEET_AGENT_SESSION_QUEUED_TIMEOUT_MS);
        for (const row of await this.sessions.findAgentStartingBefore(agentCutoff)) {
            const next = await this.endRow(row, 'timeout');
            if (next.state === 'ended' && next.endedReason === 'timeout') {
                ended += 1;
                await this.withdrawAgentJob(row.id);
                await this.settleAgentRun(next, 'unconfirmed', 'no computer slot became free within ten minutes');
            }
        }
        return { ended };
    }

    // ─── Agent sessions (FL-04 P2) ─────────────────────────────────────────

    /**
     * Start an AGENT session (spec FR-42 … FR-51): the Agent (the caller's own),
     * an agent CLI, a first message of 3–4 000 characters, the policy's chain
     * (kill switch → node state → `--work` → reachable → daemon → CLI), then:
     *
     *   1. the session row, `starting` (its id is the daemon's session id);
     *   2. its Run, trigger `session`, linked both ways (R-1);
     *   3. the durable `agent-session` job pinned to the node, counted against
     *      its `--concurrency` like `agent-task` (R-28) — the session stays
     *      `starting` while the job waits for a slot.
     *
     * A start that cannot be queued ends the row and fails the Run, so there is
     * never a session waiting on a job that does not exist. The first message
     * is stored redacted; the job carries it as typed (like a Task's prompt).
     */
    private async startAgent(
        node: FleetNode,
        actor: FleetSessionActor,
        request: FleetSessionStartRequest,
        options: { restartOf?: FleetSession } = {},
    ): Promise<FleetSessionView> {
        const provider = request.provider;
        if (!isFleetAgentSessionProvider(provider)) {
            throw fleetSessionError('invalid', 'an Agent drives Claude Code or Codex in a session', {
                field: 'provider',
            });
        }
        const agentId = typeof request.agentId === 'string' ? request.agentId : '';
        if (!/^[0-9a-f-]{36}$/i.test(agentId)) {
            throw fleetSessionError('invalid', 'choose the Agent that works in this session', {
                field: 'agentId',
            });
        }
        const firstMessage = typeof request.firstMessage === 'string' ? request.firstMessage : '';
        const trimmed = firstMessage.trim();
        if (
            trimmed.length < FLEET_SESSION_FIRST_MESSAGE_MIN_LENGTH ||
            firstMessage.length > FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH ||
            firstMessage.includes('\0')
        ) {
            throw fleetSessionError(
                'invalid',
                'an Agent session starts with a first message of 3–4 000 characters',
                { field: 'firstMessage' },
            );
        }
        const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';
        if (cwd.length === 0 || cwd.length > FLEET_SESSION_CWD_MAX_LENGTH || cwd.includes('\0')) {
            throw fleetSessionError('invalid', 'choose a folder on the computer', { field: 'cwd' });
        }
        if (request.newWorktreeOf || request.checkoutId) {
            throw fleetSessionError('invalid', 'New worktrees arrive with Checkouts', {
                field: 'checkout',
            });
        }
        if (!this.agents || !this.runs || !this.agentDispatcher) {
            throw fleetSessionError('unreachable', 'this deployment does not run Agent sessions yet');
        }
        const agent = await this.agents.findByIdAndUser(agentId, actor.userId);
        if (!agent) throw fleetSessionError('not_found', 'no such Agent', { field: 'agentId' });
        // A node leases only its own owner's jobs, so an Agent session runs on the
        // person's own computer (lane-log decision 36, question Q5).
        if (node.userId !== actor.userId) {
            throw fleetSessionError(
                'unsupported_on_node',
                `Agent sessions run on your own computers for now; ${node.name} belongs to someone else`,
            );
        }

        const title = (
            request.title?.trim() || defaultFleetSessionTitle(provider, cwd, firstMessage)
        ).slice(0, FLEET_SESSION_TITLE_MAX_LENGTH);
        const size = clampFleetSessionSize(request.cols, request.rows);
        const consents =
            this.node?.liveConsents(node.id) ??
            effectiveConsents({
                consents: node.consents,
                capabilities: node.capabilities,
                workerState: node.workerState,
            });
        const action: FleetAuditAction = options.restartOf
            ? 'node.session.restart'
            : 'node.session.start';
        const refusal = canStartFleetSession({
            node: {
                name: node.name,
                status: node.status,
                kind: node.kind,
                capabilities: node.capabilities ?? [],
                lastHeartbeatAt: node.lastHeartbeatAt ?? null,
                sessionDaemon: node.sessionDaemon ?? null,
            },
            consents,
            kind: 'agent',
            provider,
            killSwitchOn: await this.isStopped(),
            linkConnected: this.node?.isConnected(node.id) ?? false,
            liveOwnerSessions: [],
            lastSeenAgo: describeAgo(node.lastHeartbeatAt ?? null, this.now()),
        });
        if (refusal) {
            await this.record(action, actor.userId, node, null, {
                kind: 'agent',
                provider,
                agentId,
                confirmationClass: 'plain',
                outcome: 'refused',
                code: refusal.code,
            });
            throw fleetSessionError(refusal.code, refusal.hint, refusal.details);
        }

        const id = randomUUID();
        const now = new Date(this.now());
        let row = await this.sessions.create({
            id,
            nodeId: node.id,
            userId: actor.userId,
            organizationId: node.organizationId ?? null,
            kind: 'agent',
            provider,
            agentId,
            agentRunId: null,
            checkoutId: null,
            cwd,
            title,
            state: 'starting',
            outcome: null,
            daemonSessionId: id,
            providerSessionId: null,
            firstMessage: redactSecrets(firstMessage).cleaned,
            lastScreen: null,
            restartOfSessionId: options.restartOf?.id ?? null,
            startedBy: `agent:${agentId}`,
            lastActivityAt: now,
            startedAt: null,
            endedAt: null,
            endedReason: null,
            exitCode: null,
            recordingState: 'off',
        });
        let runId: string;
        try {
            const run = await this.runs.createQueued({
                agentId,
                userId: actor.userId,
                triggerKind: 'session',
                organizationId: node.organizationId ?? null,
                runnerKind: 'fleet-session',
                fleetSessionId: id,
            });
            runId = run.id;
            await this.sessions.update(id, { agentRunId: run.id });
            row = { ...row, agentRunId: run.id } as FleetSession;
        } catch (error) {
            this.logger.warn(
                `Agent session ${id}: its Run could not be created: ${error instanceof Error ? error.message : String(error)}`,
            );
            await this.endRow(row, 'exit');
            throw fleetSessionError('internal', 'the Agent session could not start');
        }

        try {
            await this.agentDispatcher.enqueue({
                payload: {
                    fleetSessionId: id,
                    agentId,
                    agentRunId: runId,
                    nodeId: node.id,
                    provider,
                    cwd,
                    title,
                    firstMessage,
                    cols: size.cols,
                    rows: size.rows,
                    permissionMode: FLEET_AGENT_SESSION_DEFAULT_PERMISSION_MODE,
                    leaseTtlSec: FLEET_AGENT_SESSION_LEASE_TTL_SEC,
                },
                userId: actor.userId,
                organizationId: node.organizationId ?? null,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Agent session ${id}: its job could not be queued: ${reason}`);
            await this.runs.markDispatchFailed(runId, 'the Agent session could not be queued');
            await this.endRow(row, 'exit');
            await this.record(action, actor.userId, node, id, {
                kind: 'agent',
                provider,
                agentId,
                confirmationClass: 'plain',
                outcome: 'refused',
                code: 'unreachable',
            });
            throw fleetSessionError('unreachable', `${node.name} could not be asked to start the session`);
        }
        await this.record(action, actor.userId, node, id, {
            kind: 'agent',
            provider,
            agentId,
            agentRunId: runId,
            confirmationClass: 'plain',
            outcome: 'queued',
            ...(options.restartOf ? { restartOf: options.restartOf.id } : {}),
        });
        return toFleetSessionView(row);
    }

    /**
     * The `agent-session` job was leased (the API's job listener): the Run is
     * running. A lease of a session that is already over is withdrawn at once
     * (the machine ends it on its next keep-alive). Never throws.
     */
    async agentSessionLeased(fleetSessionId: string): Promise<void> {
        try {
            const row = await this.sessions.findById(fleetSessionId);
            if (!row || row.kind !== 'agent') return;
            if (!isFleetSessionLive(row.state)) {
                await this.withdrawAgentJob(row.id);
                return;
            }
            if (row.agentRunId && this.runs) await this.runs.markStarted(row.agentRunId, null);
        } catch (error) {
            this.logger.warn(
                `Agent session ${fleetSessionId}: lease not applied: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * The `agent-session` job settled (done, failed, cancelled, expired): the
     * session ends if it has not already (its exit evidence, else
     * `unconfirmed`), and the Run settles with it. Idempotent; never throws.
     */
    async agentSessionJobSettled(
        fleetSessionId: string,
        settlement: FleetAgentSessionJobSettlement,
    ): Promise<void> {
        try {
            const row = await this.sessions.findById(fleetSessionId);
            if (!row || row.kind !== 'agent') return;
            let current = row;
            if (isFleetSessionLive(row.state)) {
                const reason = settlement.result?.endedReason ?? 'exit';
                current = await this.endRow(row, reason);
                const exitCode =
                    typeof settlement.result?.exitCode === 'number' ? settlement.result.exitCode : null;
                if (exitCode !== null && current.exitCode === null) {
                    await this.sessions.update(row.id, { exitCode });
                    current = { ...current, exitCode } as FleetSession;
                }
            }
            const outcome: FleetSessionOutcome =
                settlement.result?.outcome ??
                current.outcome ??
                (settlement.succeeded ? 'success' : 'failure');
            await this.settleAgentRun(
                current,
                outcome,
                settlement.error ?? (settlement.succeeded ? 'the session ended' : 'the session failed'),
            );
        } catch (error) {
            this.logger.warn(
                `Agent session ${fleetSessionId}: settlement not applied: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Withdraw an Agent session's job; best effort. */
    private async withdrawAgentJob(fleetSessionId: string): Promise<void> {
        try {
            await this.agentDispatcher?.cancelForSession?.(fleetSessionId);
        } catch (error) {
            this.logger.debug(
                `Agent session ${fleetSessionId}: job not withdrawn: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Settle the Run of an ended Agent session (CAS on non-terminal: a second settle is a no-op). */
    private async settleAgentRun(
        row: Pick<FleetSession, 'id' | 'agentRunId' | 'userId'>,
        outcome: FleetSessionOutcome,
        summary: string,
    ): Promise<void> {
        if (!row.agentRunId || !this.runs) return;
        try {
            if (outcome === 'success') await this.runs.markCompleted(row.agentRunId, summary);
            else if (outcome === 'cancelled') await this.runs.cancel(row.agentRunId, row.userId);
            else await this.runs.markFailed(row.agentRunId, summary);
        } catch (error) {
            this.logger.warn(
                `Agent session ${row.id}: its Run ${row.agentRunId} was not settled: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private async applyToRow(
        nodeId: string,
        row: FleetSession,
        message: FleetSessionEventMessage,
    ): Promise<void> {
        const patch = applyFleetSessionEvent(rowFacts(row), message, new Date(this.now()));
        if (!patch) {
            if (
                (message.event === 'exited' || message.event === 'lost') &&
                row.lastScreen !== null
            ) {
                this.node?.ack(nodeId, [row.daemonSessionId]);
            }
            return;
        }
        const written = this.toColumns(patch);
        const wasLive = isFleetSessionLive(row.state);
        if (patch.state === 'ended' && wasLive) {
            const won = await this.sessions.updateIfLive(row.id, written);
            if (!won) {
                // Somebody else ended it first: fill in what this report knows.
                const fresh = await this.sessions.findById(row.id);
                if (fresh) await this.applyToRow(nodeId, fresh, message);
                return;
            }
            if (patch.endedReason === 'drain' || patch.endedReason === 'kill-switch') {
                await this.recordSystem('node.session.end', row, {
                    reason: patch.endedReason,
                    confirmationClass: 'plain',
                    outcome: 'ended',
                    requestedBy: `system:${patch.endedReason}`,
                });
            }
            if (row.kind === 'agent') {
                await this.settleAgentRun(
                    { ...row, ...written } as FleetSession,
                    patch.outcome ?? 'unconfirmed',
                    patch.endedReason ? `the session ended (${patch.endedReason})` : 'the session ended',
                );
            }
        } else {
            await this.sessions.update(row.id, written);
        }
        if (
            (message.event === 'exited' || message.event === 'lost') &&
            (written.lastScreen !== undefined || row.lastScreen !== null)
        ) {
            // The platform holds the screen: the daemon may forget the session (FR-9).
            this.node?.ack(nodeId, [row.daemonSessionId]);
        }
    }

    private toColumns(patch: FleetSessionPatch): Partial<FleetSession> {
        const out: Partial<FleetSession> = {};
        if (patch.state !== undefined) out.state = patch.state;
        if (patch.outcome !== undefined) out.outcome = patch.outcome;
        if (patch.endedReason !== undefined) out.endedReason = patch.endedReason;
        if (patch.endedAt !== undefined) out.endedAt = patch.endedAt;
        if (patch.startedAt !== undefined) out.startedAt = patch.startedAt;
        if (patch.lastActivityAt !== undefined) out.lastActivityAt = patch.lastActivityAt;
        if (patch.title !== undefined) out.title = patch.title;
        if (patch.lastScreen !== undefined)
            out.lastScreen = boundFleetSessionScreen(patch.lastScreen);
        if (patch.exitCode !== undefined) out.exitCode = patch.exitCode;
        return out;
    }

    /** End a row (if still live) and answer the row as it now stands. */
    private async endRow(
        row: FleetSession,
        reason: FleetSessionEndedReason,
    ): Promise<FleetSession> {
        const patch = endFleetSessionPatch(rowFacts(row), reason, new Date(this.now()));
        if (!patch) return row;
        const written = this.toColumns(patch);
        const won = await this.sessions.updateIfLive(row.id, written);
        if (won) return { ...row, ...written } as FleetSession;
        return (await this.sessions.findById(row.id)) ?? row;
    }

    private holdEarly(nodeId: string, message: FleetSessionEventMessage): void {
        const now = this.now();
        for (const [key, entry] of this.early) {
            if (now - entry.at > EARLY_EVENT_TTL_MS) this.early.delete(key);
        }
        if (this.early.size > 1000) return;
        const key = `${nodeId}:${message.sessionId}`;
        const entry = this.early.get(key) ?? { at: now, messages: [] };
        if (entry.messages.length < 16) entry.messages.push(message);
        this.early.set(key, entry);
    }

    private async drainEarly(nodeId: string, row: FleetSession): Promise<FleetSession> {
        const key = `${nodeId}:${row.daemonSessionId}`;
        const entry = this.early.get(key);
        if (!entry) return row;
        this.early.delete(key);
        let current = row;
        for (const message of entry.messages) {
            await this.applyToRow(nodeId, current, message);
            current = (await this.sessions.findById(row.id)) ?? current;
        }
        return current;
    }

    private listing(row: FleetSession): {
        id: string;
        title: string;
        startedBy: string;
        startedAt: string | null;
    } {
        const startedAt = row.startedAt ?? row.createdAt ?? null;
        return {
            id: row.id,
            title: row.title,
            startedBy: row.startedBy,
            startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        };
    }

    private async visibleNodeIds(actor: FleetSessionActor): Promise<string[]> {
        const own = await this.nodes.findByUser(actor.userId);
        const shared = await this.access.listSharedWith(actor.userId);
        const ids = own.filter((node) => node.status !== 'enrolling').map((node) => node.id);
        for (const { node, role } of shared) {
            if (fleetFamilyAllows(node, role, 'sessions') && !ids.includes(node.id))
                ids.push(node.id);
        }
        return ids;
    }

    private requireNode(): FleetSessionNodePort {
        if (!this.node)
            throw fleetSessionError('unreachable', 'this deployment does not reach computers');
        return this.node;
    }

    /** A best-effort request whose failure never fails the caller's act. */
    private async tellNode(
        nodeId: string,
        sessionId: string,
        kind: FleetSession['kind'],
        verb: FleetSessionNodeRequest['verb'],
        params: Record<string, unknown>,
        caller: FleetSessionPortCaller,
    ): Promise<boolean> {
        if (!this.node || !this.node.isConnected(nodeId)) return false;
        try {
            await this.node.request({
                nodeId,
                sessionId,
                kind,
                mode: 'driver',
                verb,
                params,
                caller,
                stateChanging: true,
            });
            return true;
        } catch (error) {
            this.logger.debug(
                `${verb} for ${sessionId} on node ${nodeId} was not delivered: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    private async isStopped(): Promise<boolean> {
        try {
            return await this.killSwitch.isStopped();
        } catch {
            return true;
        }
    }

    private async record(
        action: FleetAuditAction,
        actorUserId: string | null,
        node: Pick<FleetNode, 'id' | 'userId'>,
        sessionId: string | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: {
                family: 'sessions',
                target: sessionId,
                requestedBy: actorUserId ? `user:${actorUserId}` : 'system:sessions',
                ...details,
            },
        });
    }

    private async recordSystem(
        action: FleetAuditAction,
        row: FleetSession,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        const node = await this.nodes.findById(row.nodeId);
        await this.audit.tryRecord({
            action,
            actorUserId: null,
            ownerUserId: node?.userId ?? row.userId,
            nodeId: row.nodeId,
            details: { family: 'sessions', target: row.id, ...details },
        });
    }
}

export { FLEET_SESSION_PROVIDER_LABELS };
