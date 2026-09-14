import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, Repository, type FindOptionsWhere } from 'typeorm';
import {
    AGENT_ACTION_PROPOSAL_ACTION_TYPES,
    AgentActionProposal,
    type AgentActionProposalActionType,
    type AgentActionProposalPayload,
    type AgentActionProposalStatus,
} from '../entities/agent-action-proposal.entity';
import { Agent } from '../entities/agent.entity';
// Leaf token file — no runtime graph (see inbox-producer.port.ts).
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import { evaluateGuardrails } from '../agents/guardrails';
import { RISK_SCORER } from './risk-scorer';
import { toAgentActionProposalDto, type AgentActionProposalDto } from './types';
import { AgentActionProposalDecidedEvent } from './agent-action-proposal-decided.event';

/**
 * Create-proposal input — the writable subset an Agent (or the
 * platform on its behalf) supplies when it wants a side-effectful
 * action gated by a human. `riskFlags` and scope are computed /
 * stamped by the service, not passed in.
 */
export interface CreateAgentActionProposalInput {
    agentId: string;
    actionType: AgentActionProposalActionType;
    title: string;
    payload?: AgentActionProposalPayload | null;
    /** Optional originating `agent_runs.id`. */
    runId?: string | null;
    /**
     * Merge approval (self-build slice AE) — the canonical subject this
     * decision is about, so an approved row can be looked up by equality
     * later. PLATFORM-SUPPLIED ONLY: there is no route that creates a
     * proposal, and the merge gate derives this from provider state, never
     * from anything a model wrote.
     */
    subjectKey?: string | null;
    /**
     * AW-05 — the action must be decided by a PERSON: a guardrail may still
     * block it (saved `rejected`), but never auto-approve it — the proposal
     * stays `pending` in the queue. PLATFORM-SUPPLIED ONLY (a held email
     * draft, whose approval sends mail). Absent = the guardrails decide
     * exactly as before.
     */
    humanDecisionRequired?: boolean;
}

export interface ListAgentActionProposalsFilter {
    status?: AgentActionProposalStatus;
    organizationId?: string | null;
    limit?: number;
    offset?: number;
}

/**
 * Core service for the Agent Action Approval Queue. Owns proposal
 * creation (with pure risk scoring + scope stamping via the global
 * subscriber), the pending-queue read path, and the approve/reject
 * decision — which is idempotent: re-deciding an already-decided
 * proposal returns 409 rather than silently flipping the record.
 *
 * Cross-user reads return 404 (never 403 — don't leak existence),
 * matching the rest of the Agents surface.
 */
@Injectable()
export class AgentApprovalsService {
    private readonly logger = new Logger(AgentApprovalsService.name);

    constructor(
        @InjectRepository(AgentActionProposal)
        private readonly proposals: Repository<AgentActionProposal>,
        // Ownership validation for `createProposal`: the referenced
        // Agent must belong to the calling user. Raw repository so the
        // module only needs the two entities in `forFeature`.
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
        // Inbox (operator message center). @Optional() and appended LAST
        // so existing positional constructions keep working; bound by the
        // api-side @Global() InboxModule. Absent = pre-inbox behaviour.
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
        // Decision event (AW-05). @Optional() and appended LAST like the
        // inbox producer above: absent = decisions are records only, which
        // is the pre-event behaviour.
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    /**
     * Record a new PENDING proposal for a side-effectful Agent action.
     * Validates the Agent belongs to the caller, computes `riskFlags`
     * from the pure scorer, and persists. `tenantId`/`organizationId`
     * are auto-stamped from the active request scope by
     * `ScopeStampingSubscriber`.
     */
    async createProposal(
        userId: string,
        input: CreateAgentActionProposalInput,
    ): Promise<AgentActionProposalDto> {
        const title = input.title?.trim();
        if (!title) {
            throw new BadRequestException('Proposal title must not be empty.');
        }
        if (!AGENT_ACTION_PROPOSAL_ACTION_TYPES.includes(input.actionType)) {
            throw new BadRequestException(`Unknown actionType: ${input.actionType}`);
        }

        // Security (IDOR): the proposal is only ever created against an
        // Agent the caller owns. 404 (not 403) — don't leak existence.
        const agent = await this.agents.findOne({
            where: { id: input.agentId, userId },
        });
        if (!agent) {
            throw new NotFoundException(`Agent ${input.agentId} not found.`);
        }

        const payload = input.payload ?? {};
        const riskFlags = RISK_SCORER({ actionType: input.actionType, payload });

        // Agent Dispatch Guardrails — the owning Agent's policy may
        // auto-approve an unflagged action or block a forbidden one.
        // A missing/null policy (or a missing agent row — impossible
        // here, the ownership gate above 404s first) queues, which is
        // exactly the pre-guardrails behavior.
        const decision = evaluateGuardrails(agent.guardrails ?? null, input.actionType, riskFlags);

        const now = new Date();
        const row = this.proposals.create({
            userId,
            agentId: input.agentId,
            runId: input.runId ?? null,
            actionType: input.actionType,
            title: title.slice(0, 200),
            payload,
            riskFlags,
            subjectKey: input.subjectKey ?? null,
            status: 'pending',
            decidedById: null,
            decidedAt: null,
            decidedVia: null,
            createdAt: now,
            updatedAt: now,
        });
        if (decision === 'auto_approve' && !input.humanDecisionRequired) {
            // Auto-decided rows keep decidedById null — no human made
            // the call; `decidedVia: 'guardrail'` is the audit marker.
            row.status = 'approved';
            row.decidedAt = now;
            row.decidedVia = 'guardrail';
        } else if (decision === 'block') {
            // Durable audit trail — a blocked action is persisted as a
            // rejected proposal, never silently dropped.
            row.status = 'rejected';
            row.decidedAt = now;
            row.decidedVia = 'guardrail';
        }
        const saved = await this.proposals.save(row);
        // Inbox mirror — PENDING proposals only (a guardrail-decided row
        // never needed a human), additive alongside the proposal row,
        // idempotent per proposalId inside the producer, best-effort.
        if (saved.status === 'pending' && this.inbox) {
            try {
                await this.inbox.proposalPending({
                    userId: saved.userId,
                    proposalId: saved.id,
                    title: saved.title,
                    actionType: saved.actionType,
                    riskFlags: saved.riskFlags,
                    agentId: saved.agentId,
                    runId: saved.runId ?? null,
                    // The Task a merge approval is about — platform-derived
                    // by the merge gate. Only that action type is trusted:
                    // any other payload may carry model-authored fields.
                    taskId:
                        saved.actionType === 'merge_pull_request' &&
                        typeof payload.taskId === 'string'
                            ? payload.taskId
                            : null,
                    organizationId: saved.organizationId ?? null,
                });
            } catch (error) {
                this.logger.warn(
                    `Proposal ${saved.id} inbox mirror failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        return toAgentActionProposalDto(saved);
    }

    /**
     * List the caller's PENDING proposals (default), newest first.
     * Optional `organizationId` narrows to a single Org's queue.
     */
    async listPending(
        userId: string,
        organizationId?: string | null,
    ): Promise<AgentActionProposalDto[]> {
        const { rows } = await this.list(userId, { status: 'pending', organizationId });
        return rows;
    }

    /** Filterable list — used by the controller's `?status=` surface. */
    async list(
        userId: string,
        filter: ListAgentActionProposalsFilter = {},
    ): Promise<{ rows: AgentActionProposalDto[]; total: number }> {
        const status = filter.status ?? 'pending';
        const limit = clampLimit(filter.limit);
        const offset = filter.offset && filter.offset > 0 ? filter.offset : 0;

        const where: Record<string, unknown> = { userId, status };
        if (filter.organizationId) {
            where.organizationId = filter.organizationId;
        }

        const [rows, total] = await this.proposals.findAndCount({
            where,
            order: { createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
        return { rows: rows.map(toAgentActionProposalDto), total };
    }

    async getOne(userId: string, id: string): Promise<AgentActionProposalDto> {
        const row = await this.requireOwned(userId, id);
        return toAgentActionProposalDto(row);
    }

    /**
     * Approve or reject a PENDING proposal. Idempotent guard:
     * re-deciding an already-decided proposal throws 409 (the decision
     * is final for this increment; re-opening is not modelled).
     *
     * The decision is a compare-and-set (`UPDATE … WHERE status =
     * 'pending'`), not a read-then-save: two people deciding the same
     * proposal at once record exactly one decision, and only that one emits
     * the decision event — the loser gets the same 409 a late re-decide
     * gets. Without it both saves land, both events fire, and an approval
     * could send an email whose proposal ends up recorded as rejected.
     */
    async decide(
        userId: string,
        id: string,
        decision: 'approved' | 'rejected',
    ): Promise<AgentActionProposalDto> {
        if (decision !== 'approved' && decision !== 'rejected') {
            throw new BadRequestException(`Invalid decision: ${decision}`);
        }
        const row = await this.requireOwned(userId, id);
        if (row.status !== 'pending' || !(await this.claimDecision(row, userId, decision))) {
            const current =
                row.status !== 'pending'
                    ? row
                    : await this.proposals.findOne({ where: { id, userId } });
            throw new ConflictException(
                `Proposal ${id} is already ${current?.status ?? 'decided'} and cannot be re-decided.`,
            );
        }
        this.emitDecided(row);
        await this.closeInboxMirror(row.id, decision, userId);
        return toAgentActionProposalDto(row);
    }

    /**
     * Approve every PENDING proposal owned by the caller — optionally
     * narrowed to `ids` — in a single call (one throttle hit instead of
     * one per row). Already-decided rows in the subset are skipped
     * rather than 409ing: bulk approval is best-effort by design.
     * Cross-user / unknown ids are silently ignored (no existence leak).
     *
     * `merge_pull_request` proposals are NEVER decided here (merge
     * approval, self-build slice AE). Bulk approve is a "clear the queue"
     * gesture; a merge onto a real branch is the one thing in this queue
     * that cannot be undone by a follow-up commit, so it has to be the
     * human's deliberate, per-pull-request act — through `decide` or the
     * Inbox reply, where they have the repository, the base branch and the
     * head commit in front of them.
     *
     * They are counted as `excluded`, NOT as `skipped`. The two mean
     * opposite things to the person reading the toast: `skipped` is
     * "somebody already decided this, there is nothing left to do", and
     * the web client renders it as exactly that. A still-pending merge
     * counted there would tell the user the one irreversible item in their
     * queue had been handled while it sits there untouched — the precise
     * misreport that makes an unattended merge approval expire, or get
     * clicked later without being read.
     *
     * Agent email drafts (AW-05, `payload.kind === 'email-draft'`) are
     * excluded for the same reason: approving one SENDS it, and a sent
     * message cannot be recalled. Each is read and released on its own.
     */
    async approveAll(
        userId: string,
        ids?: string[],
    ): Promise<{ approved: number; skipped: number; excluded: number }> {
        if (ids && ids.length === 0) {
            return { approved: 0, skipped: 0, excluded: 0 };
        }
        const where: FindOptionsWhere<AgentActionProposal> = ids
            ? { userId, id: In(ids) }
            : { userId, status: 'pending' };
        const rows = await this.proposals.find({ where });
        const excluded = rows.filter(
            (row) => row.status === 'pending' && requiresIndividualDecision(row),
        ).length;
        const pending = rows.filter(
            (row) => row.status === 'pending' && !requiresIndividualDecision(row),
        );
        const skipped = rows.length - pending.length - excluded;
        if (pending.length === 0) {
            return { approved: 0, skipped, excluded };
        }

        // Each row is claimed with the same compare-and-set `decide` uses: a
        // row somebody decided between the read above and this write is not
        // overwritten, emits nothing, and is counted as skipped.
        const now = new Date();
        const decided: AgentActionProposal[] = [];
        for (const row of pending) {
            if (await this.claimDecision(row, userId, 'approved', now)) {
                decided.push(row);
            }
        }
        for (const row of decided) {
            this.emitDecided(row);
            await this.closeInboxMirror(row.id, 'approved', userId);
        }
        return {
            approved: decided.length,
            skipped: skipped + (pending.length - decided.length),
            excluded,
        };
    }

    // ── internals ─────────────────────────────────────────────────

    /**
     * My Decisions — a proposal decided here (the approvals endpoints,
     * approve-all) closes its Inbox mirror too, so the owner never finds
     * an approval still "waiting" in the Inbox after deciding it on Home.
     * The Inbox reply claims its item before calling `decide`, so on that
     * door this is a no-op. Best-effort: the decision stands regardless.
     */
    private async closeInboxMirror(
        proposalId: string,
        decision: 'approved' | 'rejected',
        decidedByUserId: string,
    ): Promise<void> {
        if (!this.inbox?.proposalDecided) return;
        try {
            await this.inbox.proposalDecided({ proposalId, decision, decidedByUserId });
        } catch (error) {
            this.logger.warn(
                `Proposal ${proposalId} inbox close failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Record a person's decision on a proposal only if it is still pending.
     * Returns `false` when another decision got there first; on `true` the
     * in-memory row carries the recorded decision.
     */
    private async claimDecision(
        row: AgentActionProposal,
        userId: string,
        decision: 'approved' | 'rejected',
        now: Date = new Date(),
    ): Promise<boolean> {
        const result = await this.proposals.update(
            { id: row.id, userId, status: 'pending' },
            {
                status: decision,
                decidedById: userId,
                decidedAt: now,
                decidedVia: 'user',
                updatedAt: now,
            },
        );
        if ((result.affected ?? 0) === 0) return false;
        row.status = decision;
        row.decidedById = userId;
        row.decidedAt = now;
        row.decidedVia = 'user';
        row.updatedAt = now;
        return true;
    }

    /**
     * Fire-and-forget: a listener that throws (or an emitter that is not
     * bound) never turns a recorded decision into a failed request.
     */
    private emitDecided(row: AgentActionProposal): void {
        if (!this.events || (row.status !== 'approved' && row.status !== 'rejected')) {
            return;
        }
        try {
            this.events.emit(
                AgentActionProposalDecidedEvent.EVENT_NAME,
                new AgentActionProposalDecidedEvent(
                    row.id,
                    row.userId,
                    row.agentId,
                    row.actionType,
                    row.status,
                    row.decidedById ?? null,
                    row.decidedVia ?? null,
                    row.payload ?? {},
                ),
            );
        } catch (error) {
            this.logger.warn(
                `Proposal ${row.id} decision event failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async requireOwned(userId: string, id: string): Promise<AgentActionProposal> {
        const row = await this.proposals.findOne({ where: { id, userId } });
        if (!row) {
            // 404 (not 403) — don't leak existence.
            throw new NotFoundException(`Proposal ${id} not found.`);
        }
        return row;
    }
}

function clampLimit(limit?: number): number {
    if (!limit || limit < 1) {
        return 50;
    }
    return Math.min(limit, 200);
}

/**
 * Proposals whose approval does something that cannot be undone, so bulk
 * approval never decides them: a merge onto a real branch, and the release
 * of a held Agent email draft (AW-05).
 */
export function requiresIndividualDecision(
    row: Pick<AgentActionProposal, 'actionType' | 'payload'>,
): boolean {
    if (row.actionType === 'merge_pull_request') return true;
    return row.actionType === 'send_message' && row.payload?.kind === 'email-draft';
}
