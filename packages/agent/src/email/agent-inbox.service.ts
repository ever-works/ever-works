import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
    AGENT_INBOX_DEFAULT_MODE,
    AGENT_INBOX_MODES,
    normalizeEmailSendCapValue,
    type AgentInboxDto,
    type AgentInboxMode,
} from '@ever-works/contracts';
import { Agent } from '../entities/agent.entity';
import type { AgentInbox } from '../entities/agent-inbox.entity';
import { AgentInboxRepository } from '../database/repositories/agent-inbox.repository';
import { TenantEmailAddressRepository } from '../database/repositories/tenant-email-address.repository';

/**
 * What a person may change on an Agent's inbox settings. Every ceiling:
 * `undefined` = leave as is, `null` = inherit, `0` = no ceiling.
 */
export interface AgentInboxSettingsPatch {
    mode?: AgentInboxMode;
    emailAddressId?: string | null;
    dailySendCap?: number | null;
    burstSendCap?: number | null;
    recipientBurstCap?: number | null;
    recipientsPerMessageCap?: number | null;
}

const CAP_COLUMNS = [
    'dailySendCap',
    'burstSendCap',
    'recipientBurstCap',
    'recipientsPerMessageCap',
] as const;

/**
 * Agent email (AW-05) — create and change an Agent's inbox settings (mode
 * + per-inbox ceilings). Owner-scoped throughout: a foreign Agent or inbox
 * id is indistinguishable from a missing one.
 *
 * Creating settings is idempotent — an Agent has at most one row, and a
 * second request returns the first. A created row starts in
 * `draft-review` unless the request names a mode, so turning settings on
 * for an Agent can only make it safer by default.
 */
@Injectable()
export class AgentInboxService {
    constructor(
        private readonly inboxes: AgentInboxRepository,
        private readonly addresses: TenantEmailAddressRepository,
        @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    ) {}

    async list(userId: string): Promise<AgentInbox[]> {
        return this.inboxes.listForUser(userId);
    }

    async get(userId: string, id: string): Promise<AgentInbox> {
        const row = await this.inboxes.findByIdForUser(id, userId);
        if (!row) throw new NotFoundException('Inbox not found');
        return row;
    }

    async findForAgent(userId: string, agentId: string): Promise<AgentInbox | null> {
        await this.requireOwnedAgent(userId, agentId);
        return this.inboxes.findByAgentForUser(agentId, userId);
    }

    /** Returns `{ inbox, created }` — `created: false` when the Agent already had settings. */
    async ensure(
        userId: string,
        agentId: string,
        patch: AgentInboxSettingsPatch = {},
    ): Promise<{ inbox: AgentInbox; created: boolean }> {
        const agent = await this.requireOwnedAgent(userId, agentId);
        const existing = await this.inboxes.findByAgentForUser(agentId, userId);
        if (existing) return { inbox: existing, created: false };

        const row = this.inboxes.create({
            userId,
            agentId,
            mode: AGENT_INBOX_DEFAULT_MODE,
            state: 'active',
            organizationId: agent.organizationId ?? null,
            tenantId: agent.tenantId ?? null,
        });
        await this.applyPatch(userId, row, patch);
        try {
            return { inbox: await this.inboxes.save(row), created: true };
        } catch (error) {
            // Two concurrent creates: the unique index on agentId let one win.
            const winner = await this.inboxes.findByAgentForUser(agentId, userId);
            if (winner) return { inbox: winner, created: false };
            throw error;
        }
    }

    async update(userId: string, id: string, patch: AgentInboxSettingsPatch): Promise<AgentInbox> {
        const row = await this.get(userId, id);
        await this.applyPatch(userId, row, patch);
        return this.inboxes.save(row);
    }

    private async applyPatch(
        userId: string,
        row: AgentInbox,
        patch: AgentInboxSettingsPatch,
    ): Promise<void> {
        if (patch.mode !== undefined) {
            if (!AGENT_INBOX_MODES.includes(patch.mode)) {
                throw new BadRequestException('Unknown inbox mode');
            }
            row.mode = patch.mode;
        }
        if (patch.emailAddressId !== undefined) {
            if (patch.emailAddressId === null) {
                row.emailAddressId = null;
            } else {
                const address = await this.addresses.findByIdForUser(patch.emailAddressId, userId);
                if (!address) throw new NotFoundException('Email address not found');
                // A disabled address is retired: the send path would skip the
                // pin, so pinning it would only claim an address that is not used.
                if (address.disabledAt) {
                    throw new BadRequestException(
                        'This email address is disabled and cannot be used to send.',
                    );
                }
                if (address.direction === 'inbound') {
                    throw new BadRequestException(
                        'This address only receives mail and cannot be used to send.',
                    );
                }
                row.emailAddressId = address.id;
            }
        }
        for (const column of CAP_COLUMNS) {
            const value = patch[column];
            if (value === undefined) continue;
            row[column] = value === null ? null : (normalizeEmailSendCapValue(value) ?? null);
        }
        // A ceiling change re-evaluates the pause on the next send.
        if (CAP_COLUMNS.some((column) => patch[column] !== undefined)) {
            row.capPausedUntil = null;
        }
    }

    private async requireOwnedAgent(userId: string, agentId: string): Promise<Agent> {
        const agent = await this.agents.findOne({
            where: { id: agentId, userId },
            select: { id: true, userId: true, organizationId: true, tenantId: true },
        });
        if (!agent) throw new NotFoundException('Agent not found');
        return agent;
    }
}

export function toAgentInboxDto(row: AgentInbox): AgentInboxDto {
    return {
        id: row.id,
        agentId: row.agentId,
        emailAddressId: row.emailAddressId ?? null,
        mode: row.mode,
        state: row.state,
        caps: {
            inboxDailySends: row.dailySendCap ?? null,
            inboxBurstSends: row.burstSendCap ?? null,
            inboxBurstRecipients: row.recipientBurstCap ?? null,
            recipientsPerMessage: row.recipientsPerMessageCap ?? null,
        },
        capPausedUntil: row.capPausedUntil ? new Date(row.capPausedUntil).toISOString() : null,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
    };
}
