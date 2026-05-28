import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
    EmailConversationRepository,
} from '@src/database';
import type { EmailMessage } from '@src/entities/email-message.entity';
import type { EmailConversation } from '@src/entities/email-conversation.entity';
import {
    AGENT_INBOUND_EMAIL_DISPATCHER,
    INBOUND_EMAIL_TASK_SPAWNER,
    deriveThreadKey,
    type AgentInboundEmailDispatcher,
    type AgentInboundEmailDispatchPayload,
    type AgentInboundEmailDispatchResult,
    type InboundEmailTaskSpawner,
} from './agent-inbound-email-dispatcher';

/**
 * Default binding for {@link AGENT_INBOUND_EMAIL_DISPATCHER} (EW-670 / T25).
 *
 * Resolves the recipient → tenant address → inbound agent assignment,
 * persists the inbound `email_messages` row, and branches on the
 * assignment's `dispatchMode`:
 *  - `task-spawn` (default): delegate Task creation + agent-task-execute
 *    enqueue to the optional {@link INBOUND_EMAIL_TASK_SPAWNER} adapter.
 *  - `conversation`: find/create the per-agent `email_conversations`
 *    thread, link the message, and bump `lastMessageAt` (the agent's
 *    chat-reply path consumes the thread).
 *
 * Mirrors `task-dispatcher.ts` — heavy downstream side-effects live
 * behind optional injected adapters so this stays free of the
 * tasks-domain + Trigger.dev cycle.
 */
@Injectable()
export class DefaultInboundEmailDispatcher implements AgentInboundEmailDispatcher {
    private readonly logger = new Logger(DefaultInboundEmailDispatcher.name);

    constructor(
        private readonly addresses: TenantEmailAddressRepository,
        private readonly assignments: AgentEmailAssignmentRepository,
        private readonly messages: EmailMessageRepository,
        private readonly conversations: EmailConversationRepository,
        @Optional()
        @Inject(INBOUND_EMAIL_TASK_SPAWNER)
        private readonly taskSpawner?: InboundEmailTaskSpawner,
    ) {}

    async dispatch(
        payload: AgentInboundEmailDispatchPayload,
    ): Promise<AgentInboundEmailDispatchResult> {
        // 1. Resolve recipient → tenant address (first inbound/both match).
        let address = null as Awaited<ReturnType<TenantEmailAddressRepository['findByAddress']>>;
        for (const to of payload.to) {
            address = await this.addresses.findByAddress(to);
            if (address) break;
        }
        if (!address) {
            return { handled: false, reason: 'no matching inbound address' };
        }

        // 2. Resolve the inbound assignment (lowest priority first).
        const assignments = await this.assignments.findByEmailAddress(address.id, 'inbound');
        const assignment = assignments[0];
        if (!assignment) {
            return { handled: false, reason: 'address has no inbound agent assignment' };
        }
        const agentId = assignment.agentId;
        const mode = assignment.dispatchMode === 'conversation' ? 'conversation' : 'task-spawn';

        if (mode === 'conversation') {
            return this.dispatchConversation(payload, address.id, address.userId, agentId);
        }
        return this.dispatchTaskSpawn(payload, address.id, address.userId, agentId);
    }

    private async dispatchTaskSpawn(
        payload: AgentInboundEmailDispatchPayload,
        emailAddressId: string,
        userId: string,
        agentId: string,
    ): Promise<AgentInboundEmailDispatchResult> {
        const message = await this.persistMessage(payload, emailAddressId, userId, agentId, null);

        let taskId: string | undefined;
        if (this.taskSpawner) {
            const spawned = await this.taskSpawner.spawnTaskForInboundEmail({
                agentId,
                userId,
                emailMessageId: message.id,
                subject: payload.subject,
                bodyText: payload.bodyText,
                from: payload.from,
            });
            taskId = spawned?.taskId;
            if (taskId) {
                await this.messages.updateDeliveryStatus(message.id, 'delivered').catch(() => {});
            }
        } else {
            this.logger.debug(
                `INBOUND_EMAIL_TASK_SPAWNER unbound; persisted inbound message ${message.id} for agent ${agentId} without spawning a task`,
            );
        }

        return { handled: true, agentId, mode: 'task-spawn', emailMessageId: message.id, taskId };
    }

    private async dispatchConversation(
        payload: AgentInboundEmailDispatchPayload,
        emailAddressId: string,
        userId: string,
        agentId: string,
    ): Promise<AgentInboundEmailDispatchResult> {
        const threadKey = deriveThreadKey(payload.subject);
        let conversation = await this.conversations.findByThreadKey(agentId, threadKey);
        if (!conversation) {
            conversation = await this.conversations.save({
                agentId,
                threadKey,
                participants: [{ address: payload.from }],
                lastMessageAt: payload.receivedAt,
            } as EmailConversation);
        }

        const message = await this.persistMessage(
            payload,
            emailAddressId,
            userId,
            agentId,
            conversation.id,
        );
        await this.conversations
            .touchLastMessageAt(conversation.id, payload.receivedAt)
            .catch(() => {});

        return {
            handled: true,
            agentId,
            mode: 'conversation',
            emailMessageId: message.id,
            conversationId: conversation.id,
        };
    }

    private async persistMessage(
        payload: AgentInboundEmailDispatchPayload,
        emailAddressId: string,
        userId: string,
        agentId: string,
        conversationId: string | null,
    ): Promise<EmailMessage> {
        return this.messages.save({
            userId,
            agentId,
            taskId: null,
            conversationId,
            emailAddressId,
            direction: 'inbound',
            pluginId: payload.pluginId,
            providerMessageId: payload.providerMessageId,
            from: payload.from,
            toAddresses: payload.to,
            subject: payload.subject,
            bodyText: payload.bodyText,
            bodyHtml: payload.bodyHtml ?? null,
            receivedAt: payload.receivedAt,
            deliveryStatus: 'delivered',
        } as Parameters<EmailMessageRepository['save']>[0]);
    }
}

export const DEFAULT_INBOUND_EMAIL_DISPATCHER_PROVIDER = {
    provide: AGENT_INBOUND_EMAIL_DISPATCHER,
    useClass: DefaultInboundEmailDispatcher,
};
