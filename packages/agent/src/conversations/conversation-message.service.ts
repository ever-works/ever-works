import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { ConversationRepository } from '../database/repositories/conversation.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import type { Conversation } from '../entities/conversation.entity';
import type { ConversationMessage } from '../entities/conversation-message.entity';
import { isUniqueConstraintError } from '../utils/db-error.utils';
import { redactSecrets, scanForSecrets } from '../utils/secret-scan';
import { ConversationDispatchService } from './conversation-dispatch.service';
import { ConversationMentionService } from './conversation-mention.service';
import { ConversationService } from './conversation.service';
import {
    CONVERSATION_REACH_REASON_DISPATCH_FAILED,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_CONVERSATION_BODY_BYTES,
    conversationBodyBytes,
    type ConversationAttachmentRef,
    type ConversationFailureCode,
    type ConversationReach,
} from './conversation.types';

export interface SendConversationMessageInput {
    body: string;
    /** Client-generated id; sending the same id twice returns the first message. */
    clientMessageId?: string | null;
    attachments?: ConversationAttachmentRef[] | null;
    model?: string | null;
}

export interface ConversationSendOutcome {
    message: ConversationMessage;
    reach: ConversationReach[];
    duplicate: boolean;
}

export interface AppendAgentMessageInput {
    conversationId: string;
    agentId: string;
    body: string;
    replyToMessageId?: string | null;
    model?: string | null;
}

export interface ConversationReplyContext {
    conversation: Pick<
        Conversation,
        | 'id'
        | 'kind'
        | 'agentId'
        | 'title'
        | 'contextType'
        | 'contextId'
        | 'tenantId'
        | 'organizationId'
    >;
    triggering: ConversationMessage | null;
    /** Up to the last 20 messages, oldest first. */
    recent: ConversationMessage[];
}

/** Recent messages an Agent's reply context carries. */
const REPLY_CONTEXT_MESSAGES = 20;

/**
 * Sending, retrying and discarding messages in a named Conversation, and
 * recording an Agent's reply.
 *
 * A person's send runs, in order (nothing is stored until every check passed):
 *   1. the Conversation must be readable by the sender (404 otherwise);
 *   2. a repeated client id returns the stored message — no second row
 *      (FR-41), enforced finally by the partial unique index;
 *   3. body present, at most 16 KB (FR-37), no credential (FR-38), at most
 *      ten attachments (FR-35);
 *   4. mentions resolved against what the sender can see (FR-27, FR-96);
 *   5. the message is stored `sent`, then dispatched (the reply contract);
 *   6. if every dispatch failed for an unexpected reason the message is
 *      marked `failed` so the sender can Retry it (FR-42) — nothing retries
 *      on its own (FR-45).
 *
 * Refusals carry a stable `failureCode` so the composer can say why in plain
 * language and keep the text (FR-39, FR-46). No message body, mention or
 * attachment name is ever logged (FR-103).
 */
@Injectable()
export class ConversationMessageService {
    private readonly logger = new Logger(ConversationMessageService.name);

    constructor(
        private readonly conversations: ConversationRepository,
        private readonly conversationService: ConversationService,
        private readonly mentions: ConversationMentionService,
        private readonly dispatch: ConversationDispatchService,
    ) {}

    async send(
        userId: string,
        conversationId: string,
        input: SendConversationMessageInput,
        scope?: OwnershipScope,
    ): Promise<ConversationSendOutcome> {
        const conversation = await this.conversationService.assertParticipant(
            conversationId,
            userId,
            scope,
        );

        const clientMessageId = input.clientMessageId?.trim() || null;
        if (clientMessageId) {
            const existing = await this.conversations.findByClientMessageId(
                conversation.id,
                clientMessageId,
            );
            if (existing) return { message: existing, reach: [], duplicate: true };
        }

        const body = typeof input.body === 'string' ? input.body : '';
        this.assertSendable(body, input.attachments);

        const candidates = body.includes('@')
            ? await this.mentions.loadCandidates(userId, scope)
            : [];
        const parsed = this.mentions.parse(body, candidates);

        let message: ConversationMessage;
        try {
            message = await this.conversations.insertMessage({
                conversationId: conversation.id,
                role: 'user',
                content: body,
                ...(input.model ? { model: input.model } : {}),
                authorType: 'user',
                authorId: userId,
                mentions: parsed.mentions.length > 0 ? parsed.mentions : null,
                attachments:
                    input.attachments && input.attachments.length > 0 ? input.attachments : null,
                status: 'sent',
                clientMessageId,
                tenantId: conversation.tenantId ?? null,
                organizationId: conversation.organizationId ?? null,
            });
        } catch (err) {
            // Two sends with one client id raced past the lookup above; the
            // unique index let exactly one land. Answer with that one.
            if (clientMessageId && isUniqueConstraintError(err)) {
                const winner = await this.conversations.findByClientMessageId(
                    conversation.id,
                    clientMessageId,
                );
                if (winner) return { message: winner, reach: [], duplicate: true };
            }
            throw err;
        }

        await this.conversationService
            .ensureOwner(conversation, userId)
            .catch((err) =>
                this.logger.warn(
                    `Conversation ${conversation.id}: owner participant not recorded: ${describe(err)}`,
                ),
            );

        const reach = await this.dispatchMessage(conversation, message, userId, parsed);
        return { message, reach, duplicate: false };
    }

    /**
     * Send a `failed` message again. Only a failed message can be retried —
     * anything else is a 409, which is also what makes a double-tapped Retry
     * safe: the first one moves the message out of `failed`.
     */
    async retry(
        userId: string,
        conversationId: string,
        messageId: string,
        scope?: OwnershipScope,
    ): Promise<ConversationSendOutcome> {
        const conversation = await this.conversationService.assertParticipant(
            conversationId,
            userId,
            scope,
        );
        const message = await this.ownFailedMessage(conversation, messageId, userId);
        await this.conversations.updateMessageStatus(message.id, 'sent', null);
        const sent = { ...message, status: 'sent', failureCode: null } as ConversationMessage;

        const candidates = sent.content.includes('@')
            ? await this.mentions.loadCandidates(userId, scope)
            : [];
        const parsed = this.mentions.parse(sent.content, candidates);
        const reach = await this.dispatchMessage(conversation, sent, userId, parsed);
        return { message: sent, reach, duplicate: false };
    }

    /** Remove a `failed` message for good. Anything else is a 409. */
    async discard(
        userId: string,
        conversationId: string,
        messageId: string,
        scope?: OwnershipScope,
    ): Promise<void> {
        const conversation = await this.conversationService.assertParticipant(
            conversationId,
            userId,
            scope,
        );
        const message = await this.ownFailedMessage(conversation, messageId, userId);
        await this.conversations.deleteMessages(conversation.id, [message.id]);
    }

    /** A page of messages, oldest first (`before` pages backwards). */
    async listMessages(
        userId: string,
        conversationId: string,
        options: { limit: number; before?: string },
        scope?: OwnershipScope,
    ): Promise<ConversationMessage[]> {
        const conversation = await this.conversationService.assertParticipant(
            conversationId,
            userId,
            scope,
        );
        return this.conversations.findMessagesPaged(conversation.id, options.limit, options.before);
    }

    /**
     * Record an Agent's reply. Called by the reply job once its run finished.
     * Credentials an Agent echoed are redacted before storage, never stored.
     */
    async appendAgentMessage(input: AppendAgentMessageInput): Promise<ConversationMessage> {
        const conversation = await this.conversations.findById(input.conversationId);
        if (!conversation) throw new NotFoundException();
        return this.conversations.insertMessage({
            conversationId: conversation.id,
            role: 'assistant',
            content: redactSecrets(input.body ?? '').cleaned,
            ...(input.model ? { model: input.model } : {}),
            authorType: 'agent',
            authorId: input.agentId,
            status: 'sent',
            replyToMessageId: input.replyToMessageId ?? null,
            tenantId: conversation.tenantId ?? null,
            organizationId: conversation.organizationId ?? null,
        });
    }

    /**
     * Everything the reply job needs to brief the Agent, loaded for the user
     * the job was dispatched for. `null` when the Conversation is gone or no
     * longer theirs.
     */
    async loadReplyContext(
        userId: string,
        conversationId: string,
        triggeringMessageId: string,
    ): Promise<ConversationReplyContext | null> {
        const conversation = await this.conversations.findByIdForUser(conversationId, userId);
        if (!conversation) return null;
        const [triggering, recent] = await Promise.all([
            this.conversations.findMessageById(conversation.id, triggeringMessageId),
            this.conversations.findMessagesPaged(conversation.id, REPLY_CONTEXT_MESSAGES),
        ]);
        return {
            conversation: {
                id: conversation.id,
                kind: conversation.kind,
                agentId: conversation.agentId ?? null,
                title: conversation.title,
                contextType: conversation.contextType ?? null,
                contextId: conversation.contextId ?? null,
                tenantId: conversation.tenantId ?? null,
                organizationId: conversation.organizationId ?? null,
            },
            triggering,
            recent,
        };
    }

    /** The resolve-then-strip body an Agent receives for a stored message. */
    async agentVisibleBody(userId: string, body: string, scope?: OwnershipScope): Promise<string> {
        if (!body.includes('@')) return body;
        const candidates = await this.mentions.loadCandidates(userId, scope);
        return this.mentions.parse(body, candidates).agentVisibleBody;
    }

    // ── internals ──────────────────────────────────────────────────────

    private async dispatchMessage(
        conversation: Conversation,
        message: ConversationMessage,
        userId: string,
        parsed: { agentIds: string[]; agentVisibleBody: string },
    ): Promise<ConversationReach[]> {
        let reach: ConversationReach[];
        try {
            reach = await this.dispatch.dispatch({
                conversation,
                message,
                userId,
                agentVisibleBody: parsed.agentVisibleBody,
                mentionedAgentIds: parsed.agentIds,
            });
        } catch (err) {
            this.logger.warn(
                `Conversation ${conversation.id}: dispatch for message ${message.id} failed: ${describe(err)}`,
            );
            reach = [];
            await this.markFailed(message, 'provider_unavailable');
            message.status = 'failed';
            message.failureCode = 'provider_unavailable';
            return reach;
        }

        const failed =
            reach.length > 0 &&
            reach.every(
                (entry) =>
                    entry.outcome === 'refused' &&
                    entry.reason === CONVERSATION_REACH_REASON_DISPATCH_FAILED,
            );
        if (failed) {
            await this.markFailed(message, 'provider_unavailable');
            message.status = 'failed';
            message.failureCode = 'provider_unavailable';
        }
        return reach;
    }

    private async markFailed(
        message: ConversationMessage,
        failureCode: ConversationFailureCode,
    ): Promise<void> {
        try {
            await this.conversations.updateMessageStatus(message.id, 'failed', failureCode);
        } catch (err) {
            this.logger.warn(`Message ${message.id} could not be marked failed: ${describe(err)}`);
        }
    }

    private async ownFailedMessage(
        conversation: Conversation,
        messageId: string,
        userId: string,
    ): Promise<ConversationMessage> {
        const message = await this.conversations.findMessageById(conversation.id, messageId);
        if (!message || message.authorType !== 'user' || message.authorId !== userId) {
            throw new NotFoundException();
        }
        if (message.status !== 'failed') {
            throw new ConflictException({
                message: 'Only a message that failed to send can be retried or discarded.',
                status: message.status,
            });
        }
        return message;
    }

    private assertSendable(
        body: string,
        attachments: ConversationAttachmentRef[] | null | undefined,
    ): void {
        if (body.trim().length === 0) {
            throw refusal(400, 'A message needs a body.', null);
        }
        const size = conversationBodyBytes(body);
        if (size > MAX_CONVERSATION_BODY_BYTES) {
            throw refusal(
                400,
                `This message is too long (${size} of ${MAX_CONVERSATION_BODY_BYTES} bytes). Attach it as a file instead.`,
                'too_large',
                { size, max: MAX_CONVERSATION_BODY_BYTES },
            );
        }
        if (scanForSecrets(body).length > 0) {
            // Fixed wording, and never the matched text: the value must not be
            // echoed back into a response, a log line or a toast.
            throw refusal(
                400,
                'This message looks like it contains a credential. Store it in the connection settings instead.',
                'secret_detected',
            );
        }
        if (attachments && attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
            throw refusal(
                400,
                `A message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`,
                'too_large',
            );
        }
    }
}

function refusal(
    status: 400,
    message: string,
    failureCode: ConversationFailureCode | null,
    extra: Record<string, unknown> = {},
): HttpException {
    return new BadRequestException({ statusCode: status, message, failureCode, ...extra });
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
