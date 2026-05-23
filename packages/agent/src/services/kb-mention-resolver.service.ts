import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { KbDocumentBodyDto } from '@ever-works/contracts';
import { KnowledgeBaseService } from './knowledge-base.service';
import type { KbMention } from './kb-mention-parser';

/**
 * EW-641 Phase 2/c row 34b — resolves parsed `@kb:` mentions
 * (from row 34a `parseKbMentions`) to concrete KB documents via
 * `KnowledgeBaseService.getDocument`.
 *
 * Surfaces:
 *  - row 34c (`OpenaiCompatService` injection) calls this once per
 *    user message to materialize the docs that need to land in the
 *    `<kb>...</kb>` system-prompt block (row 31 `formatKbContext`),
 *  - row 35 hover-card UI calls this against the assistant's
 *    response to confirm citation targets,
 *  - eval/test harnesses can drive it directly.
 *
 * Each `mention.reference` is interpreted by `KnowledgeBaseService.
 * getDocument` (which delegates to `documentRepository.findByWorkOrPath`)
 * — its existing heuristic already covers UUID ids and `class/slug`
 * paths. We additionally retry with a `.md` suffix when the first
 * lookup misses, because the wire format `@kb:brand/voice` typically
 * maps to the stored path `brand/voice.md` (row 17's mention picker
 * elides the extension for readability).
 *
 * Access gate. `getDocument` runs `ensureCanView` for `userId`, so a
 * user who can't see a doc gets a graceful `null` here rather than
 * a leak. That keeps the AI-conversation surface from exposing docs
 * the user isn't supposed to know exist.
 *
 * Dedup. Two mentions of the same document collapse to one resolved
 * entry — first textual occurrence wins (preserves the order row 34c
 * uses to render the `<kb>` block, and matches the conversational
 * intuition that the first reference is the most relevant).
 */

/**
 * Result row from `KbMentionResolverService.resolveMentions`.
 *
 * - `mention` is the originating parsed mention from row 34a.
 * - `document` is the resolved doc body DTO, or `null` if the
 *   reference didn't match any visible doc (404 / access denied /
 *   `.md`-suffix-retry-still-missed). Row 34c skips `null` entries
 *   when building the `<kb>` block; row 35 hover-card can show a
 *   "not found" affordance.
 */
export interface ResolvedKbMention {
    readonly mention: KbMention;
    readonly document: KbDocumentBodyDto | null;
}

@Injectable()
export class KbMentionResolverService {
    private readonly logger = new Logger(KbMentionResolverService.name);

    constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

    /**
     * Resolve every parsed mention to its KB document (or `null`
     * if the reference doesn't match any visible doc).
     *
     * @param workId - Work scope for the lookup.
     * @param userId - User performing the lookup; `getDocument`
     *   gates on `ensureCanView` for this user, so an unauthorized
     *   reference yields `null` instead of a leak.
     * @param mentions - Parsed mentions from row 34a's `parseKbMentions`.
     * @returns Resolved entries in mention order, deduplicated by
     *   `document.id` (first occurrence wins).
     */
    async resolveMentions(
        workId: string,
        userId: string,
        mentions: ReadonlyArray<KbMention>,
    ): Promise<ResolvedKbMention[]> {
        if (mentions.length === 0) return [];

        const out: ResolvedKbMention[] = [];
        const seenDocIds = new Set<string>();

        for (const mention of mentions) {
            const doc = await this.resolveOne(workId, userId, mention.reference);
            if (doc && seenDocIds.has(doc.id)) {
                // Same doc cited multiple times → collapse to the
                // first occurrence (preserves order + avoids duplicate
                // sections in the row 34c `<kb>` block).
                continue;
            }
            if (doc) seenDocIds.add(doc.id);
            out.push({ mention, document: doc });
        }
        return out;
    }

    /**
     * Resolve a single reference. Tries the reference as-is first,
     * then retries with `.md` appended when the first attempt is a
     * miss and the reference doesn't already carry an extension.
     */
    private async resolveOne(
        workId: string,
        userId: string,
        reference: string,
    ): Promise<KbDocumentBodyDto | null> {
        const direct = await this.tryGetDocument(workId, userId, reference);
        if (direct) return direct;

        // `getDocument` already handles UUIDs + path-with-slash via
        // `findByWorkOrPath`. The common miss is `@kb:brand/voice`
        // when the stored path is `brand/voice.md`. Retry once with
        // the suffix appended; skip the retry if the reference already
        // looks file-extensioned to avoid double-suffixing.
        if (reference.endsWith('.md') || reference.includes('.')) {
            return null;
        }
        return this.tryGetDocument(workId, userId, `${reference}.md`);
    }

    /**
     * Wrap `KnowledgeBaseService.getDocument` so a miss / forbidden
     * read becomes a graceful `null` (instead of bubbling
     * `NotFoundException` / `ForbiddenException`). Any other error
     * (e.g. DB outage) is logged + returns `null` so a flaky resolve
     * doesn't poison the entire conversation message.
     */
    private async tryGetDocument(
        workId: string,
        userId: string,
        reference: string,
    ): Promise<KbDocumentBodyDto | null> {
        try {
            const result = await this.knowledgeBaseService.getDocument(workId, reference, userId);
            // Defensively normalize undefined → null so callers can
            // distinguish "resolved nothing" from "service contract
            // returned a real doc". `getDocument` is documented to
            // throw on miss, but if a stub or future variant returns
            // undefined we still want a sane sentinel.
            return result ?? null;
        } catch (err) {
            if (err instanceof NotFoundException) return null;
            // Forbidden / unexpected error — treat as not-resolved.
            // The user sees their message go through; the LLM just
            // doesn't get that specific KB doc as context.
            this.logger.debug(
                `KB mention resolution skipped for "${reference}" (work=${workId}, user=${userId}): ${
                    (err as Error).message
                }`,
            );
            return null;
        }
    }
}
