import { Injectable, Logger } from '@nestjs/common';
import { AgentRepository } from '../database/repositories/agent.repository';
import { ConversationRepository } from '../database/repositories/conversation.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import {
    MAX_MENTION_CANDIDATES,
    MAX_MENTIONS_PER_MESSAGE,
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
    /** Resolved mentions, de-duplicated, at most {@link MAX_MENTIONS_PER_MESSAGE}. */
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

/** Characters that continue a name or slug — a match must not be followed by one. */
const NAME_CONTINUATION_RE = /[\p{L}\p{N}_-]/u;
/** Characters that make an `@` part of a word (an email address, a handle) rather than a mention. */
const WORD_BEFORE_AT_RE = /[\p{L}\p{N}_.+-]/u;
/** The token an unresolved `@` mention covers. */
const UNRESOLVED_TOKEN_RE = /^[\p{L}\p{N}_-]{1,80}/u;
/** The existing document-reference syntax (`@kb:slug`) is not a mention and is left alone. */
const DOCUMENT_REFERENCE_PREFIX = 'kb:';
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
        const keys = candidates
            .flatMap((candidate) =>
                [candidate.name, candidate.slug]
                    .filter((key): key is string => typeof key === 'string' && key.trim() !== '')
                    .map((key) => ({ key: key.trim().toLowerCase(), candidate })),
            )
            .sort((a, b) => b.key.length - a.key.length);

        const mentions: ConversationMention[] = [];
        const agentIds: string[] = [];
        const spans: ResolvedMentionSpan[] = [];
        const strip: Array<{ start: number; end: number }> = [];
        const seen = new Set<string>();
        let overLimit = 0;
        const lower = body.toLowerCase();

        for (let at = body.indexOf('@'); at !== -1; at = body.indexOf('@', at + 1)) {
            if (at > 0 && WORD_BEFORE_AT_RE.test(body[at - 1])) continue;
            const restLower = lower.slice(at + 1);
            if (restLower.startsWith(DOCUMENT_REFERENCE_PREFIX)) continue;

            const hit = keys.find(
                ({ key }) =>
                    restLower.startsWith(key) &&
                    (restLower.length === key.length ||
                        !NAME_CONTINUATION_RE.test(restLower[key.length])),
            );

            if (!hit) {
                const token = UNRESOLVED_TOKEN_RE.exec(body.slice(at + 1));
                if (token) strip.push({ start: at, end: at + 1 + token[0].length });
                continue;
            }

            const { candidate, key } = hit;
            const span: ResolvedMentionSpan = {
                start: at,
                length: key.length + 1,
                type: candidate.type,
                id: candidate.id,
            };
            const identity = `${candidate.type}:${candidate.id}`;
            if (seen.has(identity)) {
                // A repeat of a mention that landed: it lands too (once).
                spans.push(span);
                continue;
            }
            if (mentions.length >= MAX_MENTIONS_PER_MESSAGE) {
                // Past the cap: plain text, and never highlighted — a
                // highlight must always mean the mention lands.
                overLimit += 1;
                continue;
            }
            seen.add(identity);
            spans.push(span);
            mentions.push({ type: candidate.type, id: candidate.id, slug: candidate.slug });
            if (candidate.type === 'agent') agentIds.push(candidate.id);
        }

        return {
            mentions,
            agentIds,
            agentVisibleBody: removeSpans(body, strip),
            spans,
            overLimit,
        };
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

function removeSpans(body: string, spans: Array<{ start: number; end: number }>): string {
    if (spans.length === 0) return body;
    let out = '';
    let cursor = 0;
    for (const span of spans) {
        out += body.slice(cursor, span.start);
        cursor = span.end;
    }
    out += body.slice(cursor);
    return (
        out
            .replace(/[ \t]{2,}/g, ' ')
            // A single space, not ` +`. The two are equivalent here because the
            // collapse on the line above already leaves no run of two or more —
            // and that equivalence is the whole point: ` +` IS quadratic when it
            // meets a long run with no punctuation to anchor on (measured: 20k
            // spaces 1.4s, 40k 5.8s, 80k 22s, 160k 85s), and the only thing
            // standing between an attacker-supplied body and that cost is one
            // earlier `.replace` that nothing forces to stay. Stated plainly:
            // this was NOT exploitable before, and the change is so that a later
            // edit to the collapse cannot make it so.
            .replace(/ ([,.;:!?])/g, '$1')
            .trim()
    );
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
