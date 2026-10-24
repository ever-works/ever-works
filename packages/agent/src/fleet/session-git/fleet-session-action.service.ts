import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import {
    availableFleetSessionActions,
    fleetBranchWithoutRemote,
    fleetSessionActionHiddenHint,
    fleetSessionActionInputBytes,
    isFleetProtectedBranch,
    isFleetSessionActionDeliveryState,
    isFleetSessionActionId,
    parseFleetGitLine,
    renderFleetSessionActionPrompt,
    FLEET_SESSION_ACTION_DEFAULTS,
    FLEET_SESSION_ACTION_DELIVERY_TIMEOUT_MS,
    FLEET_SESSION_ACTION_IDS,
    FLEET_SESSION_ACTION_LABELS,
    FLEET_SESSION_ACTION_LOG_STEP,
    FLEET_SESSION_ACTION_PREVIEW_MAX_LENGTH,
    FLEET_SESSION_ACTION_RATE,
    FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH,
    type FleetGitLinePullRequest,
    type FleetSessionActionContext,
    type FleetSessionActionDeliveryState,
    type FleetSessionActionId,
    type FleetSessionActionLedgerEntry,
    type FleetSessionActionLedgerResponse,
    type FleetSessionActionRenderContext,
    type FleetSessionActionSendResponse,
    type FleetSessionActionsResponse,
    type FleetSessionActionTemplate,
    type FleetSessionTaskRef,
} from '@ever-works/contracts';
import { AgentRepository } from '../../database/repositories/agent.repository';
import type { Agent } from '../../entities/agent.entity';
import { AgentRunLog } from '../../entities/agent-run-log.entity';
import type { FleetCheckout } from '../../entities/fleet-checkout.entity';
import { FleetAudit } from '../../entities/fleet-audit.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import type { FleetSession } from '../../entities/fleet-session.entity';
import { MergePolicyService } from '../../policy/merge-policy.service';
import { redactSecrets } from '../../utils/secret-scan';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetCheckoutRepository } from '../checkouts/fleet-checkout.repository';
import { fleetSessionError, readFleetSessionError } from '../sessions/fleet-session.errors';
import { FleetSessionService, type FleetSessionActor } from '../sessions/fleet-session.service';
import { FleetSessionTaskService } from '../sessions/fleet-session-task.service';
import { readAgentFleetBlock } from './agent-fleet-block';
import { FLEET_SESSION_PR_FACTS, type FleetSessionPrFactsPort } from './fleet-session-pr-facts.port';

/** Everything one action read or send needs about a session. */
interface ActionScene {
    session: FleetSession;
    node: FleetNode;
    checkout: FleetCheckout | null;
    agent: Agent | null;
    task: FleetSessionTaskRef | null;
    rules: FleetSessionActionContext;
    render: FleetSessionActionRenderContext;
    overrides: Partial<Record<FleetSessionActionId, string>>;
    pr: FleetGitLinePullRequest | null;
    protectedBranches: string[];
}

/** What an Agent session's ledger row carries — never the prompt text (plan §11). */
interface LedgerMeta {
    actionId: FleetSessionActionId;
    sessionId: string;
    checkoutId: string | null;
    sentAt: string;
    sentBy: string;
    deliveredAt?: string | null;
    undelivered?: boolean;
    resendOf?: string | null;
    resent?: boolean;
    prNumber?: number | null;
    prUrl?: string | null;
    /** Filled by the usage scan (FL-20, T-21); "unknown" until then. */
    tokens?: number | null;
    costCents?: number | null;
}

/** Ledger rows a read lists at most. */
const LEDGER_MAX = 100;
/** A pull request is credited to the latest Open-a-pull-request action within this window. */
const PR_CREDIT_WINDOW_MS = 2 * 60 * 60_000;

/** Merge-policy default when no policy service is bound (the platform default's protected list). */
const FALLBACK_PROTECTED = ['main', 'master'];

function asLedgerMeta(value: unknown): LedgerMeta | null {
    if (!value || typeof value !== 'object') return null;
    const meta = value as Record<string, unknown>;
    if (!isFleetSessionActionId(meta.actionId) || typeof meta.sessionId !== 'string') return null;
    return meta as unknown as LedgerMeta;
}

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Session git & actions (FL-06 P2, spec FR-12 … FR-24, §4.4) — the Actions
 * menu's server half: which of the seven actions a session offers (the
 * shared truth table, `availableFleetSessionActions`), each one's rendered
 * template (the Agent's own `agent.yml` override or the platform default),
 * the send — typed into the session as owner input through FL-04's session
 * channel, never bypassing the agent's own permission prompts — and the
 * ledger of what was sent.
 *
 * A send runs, in order: existence and the Node's `sessions` audience (404 /
 * `permission_denied`), the action id and the prompt, the relevance rule
 * (`invalid` naming it — a hidden action is never sent, U5), the rate (one
 * per 2 s per session → `busy` naming who sent the last; 10 per minute →
 * `limit_exceeded`), the kill switch (`kill_switch`), the computer
 * (`unreachable`). An Agent session gets a ledger row on its Run's log
 * (`agent_run_logs`, step `fleet.action`; the prompt text is never stored),
 * both kinds ONE `node.session.action` audit row with a redacted 200-character
 * preview — an owner session's ledger IS those rows (R-38). A send the machine
 * did not confirm is "not delivered" and may be re-sent; it is never typed
 * twice silently (FR-24).
 */
@Injectable()
export class FleetSessionActionService {
    private readonly logger = new Logger(FleetSessionActionService.name);
    /** Send times and the last sender per session (this API process; CONTRACTS §10 rates). */
    private readonly sends = new Map<string, { at: number[]; last: { at: number; by: string } | null }>();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly sessions: FleetSessionService,
        private readonly checkouts: FleetCheckoutRepository,
        private readonly killSwitch: FleetKillSwitchService,
        @InjectRepository(AgentRunLog) private readonly logs: Repository<AgentRunLog>,
        @InjectRepository(FleetAudit) private readonly auditRows: Repository<FleetAudit>,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly taskRules?: FleetSessionTaskService,
        @Optional() private readonly mergePolicy?: MergePolicyService,
        @Optional() @Inject(FLEET_SESSION_PR_FACTS) private readonly prFacts?: FleetSessionPrFactsPort,
    ) {}

    // ─── Reads ─────────────────────────────────────────────────────────────

    /** `GET /api/fleet/sessions/:id/actions` (spec FR-12, FR-13, FR-15, U1 … U8). */
    async list(id: string, actor: FleetSessionActor): Promise<FleetSessionActionsResponse> {
        const scene = await this.scene(id, actor);
        const actions = availableFleetSessionActions(scene.rules);
        const templates = {} as Record<FleetSessionActionId, FleetSessionActionTemplate>;
        for (const actionId of FLEET_SESSION_ACTION_IDS) {
            const override = scene.overrides[actionId];
            templates[actionId] = {
                text: renderFleetSessionActionPrompt(override ?? FLEET_SESSION_ACTION_DEFAULTS[actionId], scene.render),
                source: override ? 'agent' : 'default',
            };
        }
        const reachable = this.sessions.isReachable(scene.session.nodeId);
        const stopped = await this.isStopped();
        return {
            sessionId: scene.session.id,
            actions,
            templates,
            context: {
                branch: scene.render.branch,
                base: scene.render.base,
                pullNumber: scene.render.pullNumber,
                taskSlug: scene.task?.slug ?? null,
                agentName: scene.agent?.name ?? null,
                protectedBranch: isFleetProtectedBranch(scene.render.branch, scene.protectedBranches),
                reachable,
                killSwitch: stopped,
            },
            disabled: stopped
                ? { code: 'kill_switch', hint: 'Paused by the fleet stop — clear it under Settings → Fleet' }
                : !reachable
                  ? { code: 'unreachable', hint: `${scene.node.name} is offline` }
                  : null,
        };
    }

    /**
     * `GET /api/fleet/sessions/:id/actions/ledger` (spec FR-21, FR-22, R-38):
     * an Agent session's rows from its Run's log, with the tokens and cost the
     * usage scan attributes (unknown until then); an owner session's from its
     * audit rows, its cost "session total only".
     */
    async ledger(id: string, actor: FleetSessionActor): Promise<FleetSessionActionLedgerResponse> {
        const { session } = await this.sessions.resolve(id, actor);
        const now = this.now();
        if (session.agentRunId) {
            const rows = await this.logs.find({
                where: { runId: session.agentRunId, step: FLEET_SESSION_ACTION_LOG_STEP },
                order: { createdAt: 'DESC' },
                take: LEDGER_MAX,
            });
            const entries: FleetSessionActionLedgerEntry[] = [];
            for (const row of rows) {
                const meta = asLedgerMeta(row.metadata);
                if (!meta || meta.sessionId !== session.id) continue;
                entries.push({
                    id: row.id,
                    actionId: meta.actionId,
                    sentAt: meta.sentAt ?? iso(row.createdAt) ?? new Date(0).toISOString(),
                    sentBy: meta.sentBy ?? 'user:unknown',
                    delivery: this.deliveryOf(meta, now),
                    deliveredAt: meta.deliveredAt ?? null,
                    prNumber: typeof meta.prNumber === 'number' ? meta.prNumber : null,
                    prUrl: typeof meta.prUrl === 'string' ? meta.prUrl : null,
                    tokens: typeof meta.tokens === 'number' ? meta.tokens : null,
                    costCents: typeof meta.costCents === 'number' ? meta.costCents : null,
                    costScope: 'action',
                });
            }
            return { sessionId: session.id, entries, sessionCostCents: null };
        }
        // An owner session has no Run (CONTRACTS R-1): its ledger is its audit rows (R-38).
        const rows = await this.auditRows
            .createQueryBuilder('audit')
            .where('audit.nodeId = :nodeId', { nodeId: session.nodeId })
            .andWhere('audit.action IN (:...actions)', {
                actions: ['node.session.action', 'node.session.pull-request.open'],
            })
            .andWhere('audit.details LIKE :target', { target: `%"target":"${session.id}"%` })
            .orderBy('audit.occurredAt', 'DESC')
            .take(LEDGER_MAX)
            .getMany();
        const entries: FleetSessionActionLedgerEntry[] = [];
        for (const row of rows) {
            const details = (row.details ?? {}) as Record<string, unknown>;
            const isPullRequest = row.action === 'node.session.pull-request.open';
            const actionId = isPullRequest ? 'pullRequest' : details.action;
            if (!isFleetSessionActionId(actionId)) continue;
            if (!isPullRequest && details.outcome === 'refused') continue;
            const delivery = isPullRequest
                ? 'delivered'
                : isFleetSessionActionDeliveryState(details.delivery)
                  ? details.delivery
                  : 'delivered';
            entries.push({
                id: row.id,
                actionId,
                sentAt: iso(row.occurredAt) ?? new Date(0).toISOString(),
                sentBy: typeof details.requestedBy === 'string' ? details.requestedBy : `user:${row.actorUserId ?? ''}`,
                delivery,
                deliveredAt: delivery === 'delivered' ? iso(row.occurredAt) : null,
                prNumber: typeof details.number === 'number' ? details.number : null,
                prUrl: typeof details.url === 'string' ? details.url : null,
                tokens: null,
                costCents: null,
                costScope: 'session-total',
            });
        }
        return { sessionId: session.id, entries, sessionCostCents: null };
    }

    // ─── Sending (spec FR-14, FR-21, FR-23, FR-24) ─────────────────────────

    /** `POST /api/fleet/sessions/:id/actions`. */
    async send(
        id: string,
        actor: FleetSessionActor,
        request: { actionId?: unknown; prompt?: unknown },
        options: { resendOf?: string | null } = {},
    ): Promise<FleetSessionActionSendResponse> {
        if (!isFleetSessionActionId(request?.actionId)) {
            throw fleetSessionError('invalid', 'actionId is one of the seven actions', { field: 'actionId' });
        }
        const actionId = request.actionId;
        const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
        if (prompt.length === 0 || prompt.length > FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH || prompt.includes('\0')) {
            throw fleetSessionError(
                'invalid',
                `the prompt is 1–${FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH} characters`,
                { field: 'prompt' },
            );
        }
        const scene = await this.scene(id, actor);
        const { session, node } = scene;
        const offered = availableFleetSessionActions(scene.rules).find((entry) => entry.id === actionId);
        if (!offered || !offered.available) {
            const reason = offered?.reason ?? 'not-in-checkout';
            throw fleetSessionError(
                'invalid',
                fleetSessionActionHiddenHint(actionId, reason, { branch: scene.render.branch }),
                { field: 'actionId', actionId, rule: reason },
            );
        }
        // FR-18: in an owner session the pull request is opened from the dialog, by the platform.
        if (session.kind === 'owner' && actionId === 'pullRequest') {
            throw fleetSessionError('invalid', 'in your own session, open the pull request from the dialog', {
                field: 'actionId',
                actionId,
                rule: 'owner-dialog',
            });
        }
        // An Agent prompts its OWN sessions; another session (an owner's interactive one, another
        // Agent's) only when its owner switched on "may answer other sessions" (CONTRACTS R-32's reading).
        if (actor.agentId && session.agentId !== actor.agentId && !(await this.agentMayPromptOthers(actor.agentId))) {
            throw fleetSessionError(
                'permission_denied',
                'an Agent sends actions to its own sessions; ask its owner to allow "may answer other sessions"',
                { setting: 'canAnswerOtherSessions' },
            );
        }
        const requestedBy = actor.agentId ? `agent:${actor.agentId}` : `user:${actor.userId}`;
        this.consumeRate(session.id, requestedBy);
        const preview = redactSecrets(prompt).cleaned.slice(0, FLEET_SESSION_ACTION_PREVIEW_MAX_LENGTH);
        const auditBase: Record<string, unknown> = {
            family: 'sessions',
            target: session.id,
            action: actionId,
            promptPreview: preview,
            requestedBy,
            confirmationClass: 'plain',
            ...(scene.checkout ? { checkoutId: scene.checkout.id } : {}),
            ...(options.resendOf ? { resendOf: options.resendOf } : {}),
        };
        if (await this.isStopped()) {
            await this.record(node, actor, { ...auditBase, outcome: 'refused', code: 'kill_switch' });
            throw fleetSessionError('kill_switch', 'Paused by the fleet stop — actions are not sent');
        }

        // An Agent session's ledger row first ("pending"), so a crash between the
        // typing and the write still leaves a row that reads "not delivered".
        const sentAt = new Date(this.now()).toISOString();
        const meta: LedgerMeta = {
            actionId,
            sessionId: session.id,
            checkoutId: scene.checkout?.id ?? null,
            sentAt,
            sentBy: requestedBy,
            deliveredAt: null,
            ...(options.resendOf ? { resendOf: options.resendOf } : {}),
        };
        let ledgerRow: AgentRunLog | null = null;
        if (session.agentRunId) {
            try {
                ledgerRow = await this.logs.save(
                    this.logs.create({
                        runId: session.agentRunId,
                        level: 'INFO',
                        step: FLEET_SESSION_ACTION_LOG_STEP,
                        message: `Action: ${FLEET_SESSION_ACTION_LABELS[actionId]}`,
                        metadata: meta as unknown as Record<string, unknown>,
                        organizationId: session.organizationId ?? null,
                    }),
                );
            } catch (error) {
                this.logger.warn(
                    `Ledger row for session ${session.id} could not be written: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        let delivery: FleetSessionActionDeliveryState = 'delivered';
        try {
            await this.sessions.typeAction(session, actor, fleetSessionActionInputBytes(prompt), {
                actionId,
                ledgerId: ledgerRow?.id ?? null,
            });
        } catch (error) {
            const typed = readFleetSessionError(error);
            const lost = !typed || typed.code === 'unreachable' || typed.code === 'operation_failed' || typed.code === 'internal';
            if (!lost) {
                // Refused before anything was typed: nothing to deliver, no ledger row stays.
                if (ledgerRow) await this.logs.delete(ledgerRow.id).catch(() => undefined);
                await this.record(node, actor, { ...auditBase, outcome: 'refused', code: typed!.code });
                throw error;
            }
            delivery = 'undelivered';
        }
        if (ledgerRow) {
            const next: LedgerMeta =
                delivery === 'delivered'
                    ? { ...meta, deliveredAt: new Date(this.now()).toISOString() }
                    : { ...meta, undelivered: true };
            await this.logs
                .update(ledgerRow.id, { metadata: next as unknown as Record<string, unknown> })
                .catch(() => undefined);
        }
        if (options.resendOf) await this.markResent(session, options.resendOf);
        const audited = await this.record(node, actor, {
            ...auditBase,
            delivery,
            outcome: delivery === 'delivered' ? 'sent' : 'undelivered',
            ...(ledgerRow ? { ledgerId: ledgerRow.id } : {}),
        });
        return { ledgerId: ledgerRow?.id ?? audited ?? randomUUID(), delivery };
    }

    /**
     * `POST /api/fleet/sessions/:id/actions/:ledgerId/resend` (spec FR-24,
     * U13): only an entry that was NOT delivered may be sent again — never one
     * the machine confirmed. The prompt is the one the sheet still holds, else
     * the action's template rendered afresh (the ledger never stores a prompt).
     */
    async resend(
        id: string,
        ledgerId: string,
        actor: FleetSessionActor,
        prompt?: string,
    ): Promise<FleetSessionActionSendResponse> {
        const { session } = await this.sessions.resolve(id, actor);
        const entry = (await this.ledger(id, actor)).entries.find((candidate) => candidate.id === ledgerId);
        if (!entry) throw fleetSessionError('not_found', 'no such action on this session', { field: 'ledgerId' });
        if (entry.delivery === 'delivered') {
            throw fleetSessionError('invalid', 'that action was delivered; it is never sent twice', {
                field: 'ledgerId',
            });
        }
        let text = typeof prompt === 'string' ? prompt.trim() : '';
        if (!text) {
            const listing = await this.list(session.id, actor);
            text = listing.templates[entry.actionId].text;
        }
        return this.send(session.id, actor, { actionId: entry.actionId, prompt: text }, { resendOf: ledgerId });
    }

    /**
     * Credit a pull request to the session's latest "Open a pull request"
     * action (spec FR-22: the ledger names the pull request an action
     * produced). Agent sessions only — an owner session's ledger reads the
     * pull-request audit row itself. Never throws.
     */
    async creditPullRequest(session: FleetSession, pr: { number: number; url: string }): Promise<void> {
        if (!session.agentRunId) return;
        try {
            const rows = await this.logs.find({
                where: { runId: session.agentRunId, step: FLEET_SESSION_ACTION_LOG_STEP },
                order: { createdAt: 'DESC' },
                take: 20,
            });
            const cutoff = this.now() - PR_CREDIT_WINDOW_MS;
            for (const row of rows) {
                const meta = asLedgerMeta(row.metadata);
                if (!meta || meta.sessionId !== session.id || meta.actionId !== 'pullRequest') continue;
                if (Date.parse(meta.sentAt) < cutoff) return;
                await this.logs.update(row.id, {
                    metadata: { ...meta, prNumber: pr.number, prUrl: pr.url } as unknown as Record<string, unknown>,
                });
                return;
            }
        } catch (error) {
            this.logger.debug(
                `Pull request could not be credited on session ${session.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    /** The session, its computer, checkout, Agent, Task, the rules' inputs and the render values. */
    private async scene(id: string, actor: FleetSessionActor): Promise<ActionScene> {
        const { session, node } = await this.sessions.resolve(id, actor);
        const row = session.checkoutId ? await this.checkouts.findById(session.checkoutId) : null;
        const checkout = row && row.state === 'ready' ? row : null;
        const line = row ? parseFleetGitLine(row.gitLine ?? null) : null;
        const facts = checkout && this.prFacts ? await this.prFacts.cachedFacts(checkout) : null;
        let agent: Agent | null = null;
        if (session.agentId && this.agents) {
            try {
                agent = await this.agents.findById(session.agentId);
            } catch {
                agent = null;
            }
        }
        let task: FleetSessionTaskRef | null = null;
        if (session.agentRunId && this.taskRules) {
            try {
                task = (await this.taskRules.refsForRuns([session.agentRunId])).get(session.agentRunId) ?? null;
            } catch {
                task = null;
            }
        }
        const branch = line?.branch ?? row?.branch ?? null;
        const pr = facts?.pr ?? line?.pr ?? null;
        const open = pr && (pr.state === 'open' || pr.state === 'draft') ? pr : null;
        const ownBase = fleetBranchWithoutRemote(line?.baseRef ?? row?.baseRef ?? null);
        const base = facts?.baseRef ?? (ownBase && ownBase !== branch ? ownBase : null) ?? facts?.defaultBranch ?? null;
        const protectedBranches = await this.protectedBranches(session, row);
        return {
            session,
            node,
            checkout,
            agent,
            task,
            pr,
            protectedBranches,
            overrides: agent ? readAgentFleetBlock(agent.agentYml ?? null).block.actions : {},
            rules: {
                kind: session.kind,
                provider: session.provider,
                state: session.state,
                hasCheckout: checkout !== null,
                branch,
                baseRef: line?.baseRef ?? row?.baseRef ?? null,
                defaultBranch: facts?.defaultBranch ?? null,
                protectedBranches,
                pr: pr ? { number: pr.number, state: pr.state } : null,
                unresolvedComments: facts?.unresolvedComments ?? null,
                mergeable: facts?.mergeable ?? null,
            },
            render: {
                branch,
                base,
                pullNumber: open ? open.number : null,
                task: task ? { slug: task.slug, title: task.title } : null,
            },
        };
    }

    /** The merge policy's protected branches for this session's Agent / Work / Organization (FR-15). */
    private async protectedBranches(session: FleetSession, checkout: FleetCheckout | null): Promise<string[]> {
        if (!this.mergePolicy) return [...FALLBACK_PROTECTED];
        try {
            const resolved = await this.mergePolicy.resolve({
                agentId: session.agentId ?? null,
                workId: checkout?.workId ?? null,
                organizationId: session.organizationId ?? null,
            });
            return [...(resolved.policy.protectedBranches ?? FALLBACK_PROTECTED)];
        } catch {
            return [...FALLBACK_PROTECTED];
        }
    }

    /** R-32: may this Agent prompt a session that is not its own? Absent permission = no. */
    private async agentMayPromptOthers(agentId: string): Promise<boolean> {
        if (!this.agents) return false;
        try {
            const agent = await this.agents.findById(agentId);
            const permissions = agent?.permissions as unknown as Record<string, unknown> | undefined;
            return permissions?.canAnswerOtherSessions === true;
        } catch {
            return false;
        }
    }

    /** `pending` past the delivery window reads "not delivered" (FR-24). */
    private deliveryOf(meta: LedgerMeta, now: number): FleetSessionActionDeliveryState {
        if (meta.deliveredAt) return 'delivered';
        if (meta.undelivered || meta.resent) return 'undelivered';
        const sent = Date.parse(meta.sentAt);
        return Number.isFinite(sent) && now - sent < FLEET_SESSION_ACTION_DELIVERY_TIMEOUT_MS ? 'pending' : 'undelivered';
    }

    /** Mark a re-sent entry so it is not offered again. */
    private async markResent(session: FleetSession, ledgerId: string): Promise<void> {
        if (!session.agentRunId) return;
        try {
            const row = await this.logs.findOne({ where: { id: ledgerId, runId: session.agentRunId } });
            const meta = row ? asLedgerMeta(row.metadata) : null;
            if (row && meta) {
                await this.logs.update(row.id, {
                    metadata: { ...meta, resent: true } as unknown as Record<string, unknown>,
                });
            }
        } catch {
            // Best-effort: the new entry is what the ledger shows next.
        }
    }

    /** CONTRACTS §10: 10 per minute per session, 2 s apart (`busy` naming who sent the last). */
    private consumeRate(sessionId: string, by: string): void {
        const now = this.now();
        const state = this.sends.get(sessionId) ?? { at: [], last: null };
        state.at = state.at.filter((at) => now - at < 60_000);
        if (state.last && now - state.last.at < FLEET_SESSION_ACTION_RATE.minSpacingMs) {
            const seconds = Math.max(1, Math.round((now - state.last.at) / 1000));
            throw fleetSessionError('busy', `another action was sent ${seconds} s ago`, {
                sentBy: state.last.by,
                retryAfterMs: FLEET_SESSION_ACTION_RATE.minSpacingMs - (now - state.last.at),
            });
        }
        if (state.at.length >= FLEET_SESSION_ACTION_RATE.perMinute) {
            throw fleetSessionError('limit_exceeded', `${FLEET_SESSION_ACTION_RATE.perMinute} actions per minute`, {
                limit: `${FLEET_SESSION_ACTION_RATE.perMinute} per minute`,
            });
        }
        state.at.push(now);
        state.last = { at: now, by };
        this.sends.set(sessionId, state);
        if (this.sends.size > 5000) {
            for (const [key, value] of this.sends) {
                if (value.at.every((at) => now - at >= 60_000)) this.sends.delete(key);
            }
        }
    }

    private async isStopped(): Promise<boolean> {
        try {
            return await this.killSwitch.isStopped();
        } catch {
            return true;
        }
    }

    /** One `node.session.action` row; answers its id (an owner session's ledger id), or null. */
    private async record(
        node: Pick<FleetNode, 'id' | 'userId'>,
        actor: FleetSessionActor,
        details: Record<string, unknown>,
    ): Promise<string | null> {
        if (!this.audit) return null;
        try {
            const view = await this.audit.record({
                action: 'node.session.action',
                actorUserId: actor.userId,
                ownerUserId: node.userId,
                nodeId: node.id,
                details,
            });
            return view.id;
        } catch (error) {
            this.logger.error(
                `fleet audit row for node.session.action could not be written: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}
