import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
} from '@ever-works/agent/database';
import type { TenantEmailAddress, EmailAddressDirection } from '@ever-works/agent/entities';
import { EmailFacadeService } from '@ever-works/agent/facades';

export interface CreateEmailAddressInput {
    readonly address: string;
    readonly direction: EmailAddressDirection;
    readonly pluginId: string;
    readonly providerSettings: Record<string, unknown>;
    readonly defaultForReplies?: boolean;
}

export interface UpdateEmailAddressInput {
    readonly providerSettings?: Record<string, unknown>;
    readonly defaultForReplies?: boolean;
    readonly disabled?: boolean;
}

/**
 * EW-650 / EW-669 — Tenant email address CRUD + verification flow.
 * Per-user scoping enforced on every read/write.
 */
@Injectable()
export class EmailService {
    constructor(
        private readonly addresses: TenantEmailAddressRepository,
        private readonly assignments: AgentEmailAssignmentRepository,
        private readonly messages: EmailMessageRepository,
        private readonly emailFacade: EmailFacadeService,
    ) {}

    async listAddresses(userId: string, direction?: EmailAddressDirection): Promise<TenantEmailAddress[]> {
        return this.addresses.find({
            where: { userId, ...(direction ? { direction } : {}) },
            order: { createdAt: 'DESC' },
        });
    }

    async createAddress(userId: string, input: CreateEmailAddressInput): Promise<TenantEmailAddress> {
        const verificationToken = randomBytes(24).toString('base64url');
        const created = this.addresses.create({
            userId,
            address: input.address,
            direction: input.direction,
            pluginId: input.pluginId,
            providerSettings: input.providerSettings,
            defaultForReplies: input.defaultForReplies ?? false,
            verified: false,
            verificationToken,
        });
        return this.addresses.save(created);
    }

    async updateAddress(
        userId: string,
        id: string,
        input: UpdateEmailAddressInput,
    ): Promise<TenantEmailAddress> {
        const row = await this.findOwnedOrThrow(userId, id);
        if (input.providerSettings) row.providerSettings = input.providerSettings;
        if (typeof input.defaultForReplies === 'boolean') row.defaultForReplies = input.defaultForReplies;
        if (typeof input.disabled === 'boolean') row.disabledAt = input.disabled ? new Date() : null;
        return this.addresses.save(row);
    }

    async deleteAddress(userId: string, id: string): Promise<void> {
        const row = await this.findOwnedOrThrow(userId, id);
        await this.addresses.remove(row);
    }

    /**
     * Trigger the provider's verification flow. Persists the token on the
     * row so `GET /api/email/verify/:tokenId` can confirm it later.
     */
    async triggerVerification(userId: string, id: string): Promise<{ messageRef: string }> {
        const row = await this.findOwnedOrThrow(userId, id);
        const messageRef = `verify-${row.id}-${Date.now()}`;
        await this.emailFacade.verifyAddress(row.address, { userId, addressId: row.id });
        return { messageRef };
    }

    async confirmVerification(token: string): Promise<{ verified: boolean }> {
        const row = await this.addresses.findOne({ where: { verificationToken: token } });
        if (!row) return { verified: false };
        row.verified = true;
        row.verificationToken = null;
        await this.addresses.save(row);
        return { verified: true };
    }

    async listMessagesForAgent(
        userId: string,
        agentId: string,
        limit = 50,
        offset = 0,
    ): Promise<unknown[]> {
        return this.messages.find({
            where: { userId, agentId },
            order: { createdAt: 'DESC' },
            take: Math.min(limit, 100),
            skip: offset,
        });
    }

    private async findOwnedOrThrow(userId: string, id: string): Promise<TenantEmailAddress> {
        const row = await this.addresses.findOne({ where: { id } });
        if (!row) throw new NotFoundException('Email address not found');
        if (row.userId !== userId) throw new ForbiddenException('Not authorized');
        return row;
    }
}
