import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { AgentRepository } from '../database/repositories/agent.repository';
import {
    ConversationRepository,
    type ConversationInitialParticipant,
    type ListConversationSummariesFilter,
} from '../database/repositories/conversation.repository';
import { ConversationParticipantRepository } from '../database/repositories/conversation-participant.repository';
import { ownershipStamp, type OwnershipScope } from '../database/ownership-scope';
import type { Conversation } from '../entities/conversation.entity';
import type { ConversationParticipant } from '../entities/conversation-participant.entity';
import { ConversationContextResolver } from './conversation-context.resolver';
import {
    CONVERSATION_LIST_DEFAULT_LIMIT,
    CONVERSATION_LIST_MAX_LIMIT,
    CONVERSATION_NAME_MAX,
    isConversationContextType,
    type ConversationContextType,
    type ConversationKind,
} from './conversation.types';

export interface CreateConversationRequest {
    kind?: ConversationKind;
    agentId?: string | null;
    title?: string;
    providerId?: string;
    model?: string;
    contextType?: ConversationContextType | null;
    contextId?: string | null;
}

export interface ConversationListRow {
    id: string;
    kind: ConversationKind;
    agentId: string | null;
    title: string | null;
    titleSource: Conversation['titleSource'];
    providerId: string | null;
    model: string | null;
    contextType: ConversationContextType | null;
    contextId: string | null;
    lastMessageAt: Date | null;
    unreadCount: number;
    /** The first message a person wrote, shortened; `null` before anyone wrote. */
    preview: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/** Kinds a person can open from the API in this release. */
const CREATABLE_KINDS: readonly ConversationKind[] = ['direct'];
/** Kinds whose name belongs to the product, not to one member (FR-8). */
const FIXED_NAME_KINDS: readonly ConversationKind[] = ['organization_channel', 'agent_pair'];

/**
 * Named Conversations — creation, naming, listing and read state.
 *
 * Every read and write goes through {@link assertParticipant}, which answers
 * a Conversation the caller may not read exactly like one that does not
 * exist: `NotFoundException`, never `Forbidden` (FR-95). Every list is scoped
 * to the caller's active Organization or personal scope (FR-97).
 *
 * The existing assistant thread is a `direct` Conversation with no Agent and
 * keeps working through the endpoints it always used (FR-11).
 */
@Injectable()
export class ConversationService {
    constructor(
        private readonly conversations: ConversationRepository,
        private readonly participants: ConversationParticipantRepository,
        private readonly agents: AgentRepository,
        @Optional() private readonly contexts?: ConversationContextResolver,
    ) {}

    /**
     * Open a Conversation. A `direct` Conversation may be addressed at one
     * Agent the caller can see; that address is fixed for its lifetime (FR-2).
     * A context object must exist in the caller's scope and is fixed too
     * (FR-9). The caller is seeded as `owner`, the Agent as `member`, in the
     * same transaction as the Conversation itself.
     */
    async create(
        userId: string,
        request: CreateConversationRequest,
        scope?: OwnershipScope,
    ): Promise<Conversation> {
        const kind = request.kind ?? 'direct';
        if (!CREATABLE_KINDS.includes(kind)) {
            throw new BadRequestException(
                `Conversations of kind "${kind}" cannot be created here.`,
            );
        }

        const agentId = request.agentId ?? null;
        if (agentId) {
            const agent = await this.agents.findByIdAndUser(agentId, userId, scope);
            if (!agent) throw new NotFoundException('Agent not found.');
        }

        const contextType = request.contextType ?? null;
        const contextId = request.contextId ?? null;
        if ((contextType === null) !== (contextId === null)) {
            throw new BadRequestException('contextType and contextId must be sent together.');
        }
        if (contextType !== null && contextId !== null) {
            if (!isConversationContextType(contextType)) {
                throw new BadRequestException('Unknown context type.');
            }
            const resolved = this.contexts
                ? await this.contexts.resolve(userId, contextType, contextId, scope)
                : null;
            if (!resolved) throw new NotFoundException('Context not found.');
        }

        const title = request.title?.trim() ? request.title.trim() : undefined;
        const initialParticipants: ConversationInitialParticipant[] = [
            { participantType: 'user', participantId: userId, role: 'owner' },
        ];
        if (agentId) {
            initialParticipants.push({
                participantType: 'agent',
                participantId: agentId,
                role: 'member',
            });
        }
        // One transaction: a participant that fails to insert leaves no
        // Conversation behind, so a retried create never finds a half-made one.
        return this.conversations.createWithParticipants(
            {
                userId,
                kind,
                agentId,
                contextType,
                contextId,
                ...(title ? { title, titleSource: 'user' as const } : {}),
                ...(request.providerId ? { providerId: request.providerId } : {}),
                ...(request.model ? { model: request.model } : {}),
                ...ownershipStamp(scope),
            },
            initialParticipants,
        );
    }

    /**
     * The Conversation, or `NotFoundException` when it does not exist OR the
     * caller may not read it. The two are deliberately indistinguishable.
     */
    async assertParticipant(
        conversationId: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<Conversation> {
        const conversation = await this.conversations.findByIdForUser(
            conversationId,
            userId,
            scope,
        );
        if (!conversation) throw new NotFoundException();
        return conversation;
    }

    async get(
        conversationId: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<{ conversation: Conversation; participants: ConversationParticipant[] }> {
        const conversation = await this.assertParticipant(conversationId, userId, scope);
        const participants = await this.participants.listForConversation(conversation.id);
        return { conversation, participants };
    }

    async listParticipants(
        conversationId: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<ConversationParticipant[]> {
        const conversation = await this.assertParticipant(conversationId, userId, scope);
        return this.participants.listForConversation(conversation.id);
    }

    /** One page of the caller's Conversations with unread counts (FR-12, FR-24). */
    async list(
        userId: string,
        filter: ListConversationSummariesFilter,
        scope?: OwnershipScope,
    ): Promise<{ conversations: ConversationListRow[]; total: number }> {
        const limit = clampLimit(filter.limit);
        const offset = Math.max(0, Math.trunc(filter.offset ?? 0)) || 0;
        const { conversations, total } = await this.conversations.findSummariesByUser(
            userId,
            { ...filter, limit, offset },
            scope,
        );
        const ids = conversations.map((conversation) => conversation.id);
        const [unread, previews] = await Promise.all([
            this.conversations.unreadCountsFor(userId, ids),
            this.conversations.firstMessagePreviews(ids),
        ]);
        return {
            total,
            conversations: conversations.map((conversation) => ({
                id: conversation.id,
                kind: conversation.kind ?? 'direct',
                agentId: conversation.agentId ?? null,
                title: conversation.title ?? null,
                titleSource: conversation.titleSource ?? null,
                providerId: conversation.providerId ?? null,
                model: conversation.model ?? null,
                contextType: conversation.contextType ?? null,
                contextId: conversation.contextId ?? null,
                lastMessageAt: conversation.lastMessageAt ?? null,
                unreadCount: unread.get(conversation.id) ?? 0,
                preview: previews.get(conversation.id) ?? null,
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
            })),
        };
    }

    /**
     * Set (`string`) or clear (`null`) the name. A set name stops automatic
     * titling for good (FR-6); clearing it lets automatic titling run again.
     * The organization channel and Agent pairs keep their own names (FR-8).
     */
    async rename(
        conversationId: string,
        userId: string,
        name: string | null,
        scope?: OwnershipScope,
    ): Promise<Conversation> {
        const conversation = await this.assertParticipant(conversationId, userId, scope);
        if (FIXED_NAME_KINDS.includes(conversation.kind)) {
            throw new ConflictException('This conversation keeps its own name.');
        }
        let next: string | null = null;
        if (name !== null) {
            const trimmed = name.trim();
            if (trimmed.length === 0) {
                throw new BadRequestException('A name cannot be blank. Send null to clear it.');
            }
            if (trimmed.length > CONVERSATION_NAME_MAX) {
                throw new BadRequestException(
                    `Names are at most ${CONVERSATION_NAME_MAX} characters. This one is ${trimmed.length}.`,
                );
            }
            next = trimmed;
        }
        await this.conversations.setName(conversation.id, conversation.userId, next);
        return {
            ...conversation,
            title: next ?? undefined,
            titleSource: next === null ? null : 'user',
        } as Conversation;
    }

    /**
     * Move the caller's read position to `messageId` (FR-24). The owner row is
     * created on first use for Conversations that predate participants.
     */
    async markRead(
        conversationId: string,
        userId: string,
        messageId: string,
        scope?: OwnershipScope,
    ): Promise<void> {
        const conversation = await this.assertParticipant(conversationId, userId, scope);
        const message = await this.conversations.findMessageById(conversation.id, messageId);
        if (!message) throw new NotFoundException();
        await this.ensureOwner(conversation, userId);
        // The read position is the message's own time, not "now": a reply that
        // landed while the person was reading stays unread.
        await this.participants.markRead(
            conversation.id,
            'user',
            userId,
            message.id,
            message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt),
        );
    }

    /** Idempotent: the caller's `owner` row for a Conversation they own. */
    async ensureOwner(conversation: Conversation, userId: string): Promise<void> {
        await this.participants.addIfAbsent({
            conversationId: conversation.id,
            participantType: 'user',
            participantId: userId,
            role: conversation.userId === userId ? 'owner' : 'member',
            ...scopeStampOf(conversation),
        });
    }
}

function clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return CONVERSATION_LIST_DEFAULT_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), CONVERSATION_LIST_MAX_LIMIT);
}

function scopeStampOf(row: { tenantId?: string | null; organizationId?: string | null }): {
    tenantId: string | null;
    organizationId: string | null;
} {
    return { tenantId: row.tenantId ?? null, organizationId: row.organizationId ?? null };
}
