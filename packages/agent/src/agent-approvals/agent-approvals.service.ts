import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    AGENT_ACTION_PROPOSAL_ACTION_TYPES,
    AgentActionProposal,
    type AgentActionProposalActionType,
    type AgentActionProposalPayload,
    type AgentActionProposalStatus,
} from '../entities/agent-action-proposal.entity';
import { Agent } from '../entities/agent.entity';
import { RISK_SCORER } from './risk-scorer';
import { toAgentActionProposalDto, type AgentActionProposalDto } from './types';

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

        const now = new Date();
        const row = this.proposals.create({
            userId,
            agentId: input.agentId,
            runId: input.runId ?? null,
            actionType: input.actionType,
            title: title.slice(0, 200),
            payload,
            riskFlags,
            status: 'pending',
            decidedById: null,
            decidedAt: null,
            createdAt: now,
            updatedAt: now,
        });
        const saved = await this.proposals.save(row);
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
        if (row.status !== 'pending') {
            throw new ConflictException(
                `Proposal ${id} is already ${row.status} and cannot be re-decided.`,
            );
        }

        const now = new Date();
        row.status = decision;
        row.decidedById = userId;
        row.decidedAt = now;
        row.updatedAt = now;
        const saved = await this.proposals.save(row);
        return toAgentActionProposalDto(saved);
    }

    // ── internals ─────────────────────────────────────────────────

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
