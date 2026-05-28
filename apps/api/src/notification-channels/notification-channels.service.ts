import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { NotificationChannelRepository } from '@ever-works/agent/database';
import type { NotificationChannel } from '@ever-works/agent/entities';
import { NotificationChannelFacadeService } from '@ever-works/agent/facades';

export interface CreateChannelInput {
    readonly pluginId: string;
    readonly name: string;
    readonly targetConfig: Record<string, unknown>;
}

export interface UpdateChannelInput {
    readonly name?: string;
    readonly targetConfig?: Record<string, unknown>;
    readonly disabled?: boolean;
}

/**
 * EW-663 / EW-673 — Notification channel CRUD + test-send wiring.
 * Per-user scoping enforced on every read/write.
 */
@Injectable()
export class NotificationChannelsService {
    constructor(
        private readonly channels: NotificationChannelRepository,
        private readonly facade: NotificationChannelFacadeService,
    ) {}

    async list(userId: string): Promise<NotificationChannel[]> {
        return this.channels.find({ where: { userId }, order: { createdAt: 'DESC' } });
    }

    async create(userId: string, input: CreateChannelInput): Promise<NotificationChannel> {
        const created = this.channels.create({
            userId,
            pluginId: input.pluginId,
            name: input.name,
            targetConfig: input.targetConfig,
            verified: false,
        });
        return this.channels.save(created);
    }

    async update(
        userId: string,
        id: string,
        input: UpdateChannelInput,
    ): Promise<NotificationChannel> {
        const row = await this.findOwnedOrThrow(userId, id);
        if (input.name) row.name = input.name;
        if (input.targetConfig) row.targetConfig = input.targetConfig;
        if (typeof input.disabled === 'boolean') row.disabledAt = input.disabled ? new Date() : null;
        return this.channels.save(row);
    }

    async remove(userId: string, id: string): Promise<void> {
        const row = await this.findOwnedOrThrow(userId, id);
        await this.channels.remove(row);
    }

    /**
     * Send a test message via the channel. Surfaces the result to the
     * UI "Test" button.
     */
    async sendTest(
        userId: string,
        id: string,
    ): Promise<{ status: string; error?: string; providerMessageId?: string }> {
        const row = await this.findOwnedOrThrow(userId, id);
        const result = await this.facade.sendDirect(
            row.id,
            {
                text: 'Ever Works notification channel test message ✓',
                messageRef: `test-${row.id}-${Date.now()}`,
            },
            { userId },
        );
        return {
            status: result.status,
            error: result.error,
            providerMessageId: result.providerMessageId,
        };
    }

    private async findOwnedOrThrow(userId: string, id: string): Promise<NotificationChannel> {
        const row = await this.channels.findOne({ where: { id } });
        if (!row) throw new NotFoundException('Channel not found');
        if (row.userId !== userId) throw new ForbiddenException('Not authorized');
        return row;
    }
}
