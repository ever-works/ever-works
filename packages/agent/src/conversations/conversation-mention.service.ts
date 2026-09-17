import { Injectable, Logger } from '@nestjs/common';
import { AgentRepository } from '../database/repositories/agent.repository';
import { ConversationRepository } from '../database/repositories/conversation.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import { parseConversationMentions } from '@ever-works/contracts';
import {
    MAX_MENTION_CANDIDATES,
    type ConversationMention,
    type ConversationMentionCandidate,
} from './conversation.types';

/** Someone the sender can address by name. */
export interface MentionCandidateSource {
    type: 'agent' | 'user';
    id: string;
    slug: string;
    name: string;
    status: string | null;
}

/** A resolved `@` token, by position in the stored body. */
export interface ResolvedMentionSpan {
    start: number;
    length: number;
    type: 'agent' | 'user';
    id: string;
}

export interface ParsedConversationMentions {
    /** Resolved mentions, de-duplicated, at most `MAX_MENTIONS_PER_MESSAGE`. */
    mentions: ConversationMention[];
    /** Agent ids among {@link mentions}, in first-mention order. */
    agentIds: string[];
    /**
     * The body an Agent receives: identical to the stored body except that
     * every `@` token that did not resolve is removed, so no Agent is ever
     * told about a participant that does not exist.
     */
    agentVisibleBody: string;
    /** Resolved spans in the stored body — what a composer may highlight. */
    spans: ResolvedMentionSpan[];
    /** Resolvable mentions past the cap; they stay plain text. */
    overLimit: number;
}

const MAX_QUERY_CHARS = 80;

/**
 * Mentions in Conversation messages.
 *
 * Built on the Task-comment parser in `tasks-domain/task-chat.service.ts` —
 * the same resolve-then-strip rule and the same stored mention shape — and
 * extended for Conversations, where people type the name they see:
 *
 *  - a mention matches an Agent's full display name (multi-word names
 *    included) or its full slug, case-insensitively, and NEVER a prefix
 *    (`@Nov` does not reach "Nova");
 *  - the longest name wins, so "Nova Prime" is not read as "Nova";
 *  - only candidates the sender can already see are ever matched, so an
 *    Agent hidden from them behaves exactly like a name that does not exist;
 *  - resolved mentions are capped at ten; the rest stay plain text.
 */
@Injectable()
export class ConversationMentionService {
    private readonly logger = new Logger(ConversationMentionService.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly conversations: ConversationRepository,
    ) {}

    /**
     * Pure parse of `body` against `candidates`. Exposed for tests and for the
     * send path, which loads candidates once per message.
     */
    parse(body: string, candidates: readonly MentionCandidateSource[]): ParsedConversationMentions {
        // The rule itself lives in `@ever-works/contracts`, so the composer
        // that highlights a mention and this send path can never disagree.
        return parseConversationMentions(body, candidates);
    }

    /**
     * Everyone the sender can address: the Agents visible in their active
     * scope, archived ones excluded. Best-effort — a lookup failure resolves
     * nothing rather than failing the send.
     */
    async loadCandidates(
        userId: string,
        scope?: OwnershipScope,
    ): Promise<MentionCandidateSource[]> {
        try {
            const { rows } = await this.agents.findByUserIdScoped(userId, { limit: 500 }, scope);
            return rows
                .filter((agent) => agent?.id && agent?.slug)
                .map((agent) => ({
                    type: 'agent' as const,
                    id: agent.id,
                    slug: agent.slug,
                    name: agent.name ?? agent.slug,
                    status: agent.status ?? null,
                }));
        } catch (err) {
            this.logger.warn(`Mention candidates could not be loaded: ${describe(err)}`);
            return [];
        }
    }

    /**
     * The picker's answer for `query`: at most eight candidates, ranked by the
     * Agents this person addressed most recently, then name prefix, then name
     * substring. An empty query lists the most relevant candidates.
     */
    async resolveCandidates(
        query: string,
        viewer: { userId: string; scope?: OwnershipScope },
    ): Promise<ConversationMentionCandidate[]> {
        const needle = (query ?? '').trim().toLowerCase().slice(0, MAX_QUERY_CHARS);
        const [candidates, recency] = await Promise.all([
            this.loadCandidates(viewer.userId, viewer.scope),
            this.recentAgentOrder(viewer.userId, viewer.scope),
        ]);

        const scored = candidates
            .map((candidate) => {
                const name = candidate.name.toLowerCase();
                const slug = candidate.slug.toLowerCase();
                const prefix = needle === '' || name.startsWith(needle) || slug.startsWith(needle);
                const substring = prefix || name.includes(needle) || slug.includes(needle);
                return { candidate, prefix, substring, recent: recency.get(candidate.id) };
            })
            .filter((entry) => entry.substring);

        scored.sort((a, b) => {
            const recentA = a.recent ?? Number.POSITIVE_INFINITY;
            const recentB = b.recent ?? Number.POSITIVE_INFINITY;
            if (recentA !== recentB) return recentA - recentB;
            if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
            return a.candidate.name.localeCompare(b.candidate.name);
        });

        return scored.slice(0, MAX_MENTION_CANDIDATES).map(({ candidate }) => ({
            type: candidate.type,
            id: candidate.id,
            slug: candidate.slug,
            name: candidate.name,
            status: candidate.status,
        }));
    }

    /** agentId → position in this person's most recent direct Conversations. */
    private async recentAgentOrder(
        userId: string,
        scope?: OwnershipScope,
    ): Promise<Map<string, number>> {
        const order = new Map<string, number>();
        try {
            const { conversations } = await this.conversations.findSummariesByUser(
                userId,
                { kind: 'direct', limit: 50 },
                scope,
            );
            for (const conversation of conversations) {
                if (conversation.agentId && !order.has(conversation.agentId)) {
                    order.set(conversation.agentId, order.size);
                }
            }
        } catch (err) {
            this.logger.warn(`Recent Agents could not be ranked: ${describe(err)}`);
        }
        return order;
    }
}

// The `removeSpans` helper that used to live here moved with the parse rule
// into `@ever-works/contracts` (`conversation-mentions.ts`), so the server and
// the composer can never disagree. Its ReDoS-hardened space collapse moved
// with it — see the ledger comment on `removeSpans` there.
function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
