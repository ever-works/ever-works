import { Injectable, Logger, Optional } from '@nestjs/common';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { KbDocumentStatus } from '../entities/kb-types';

/**
 * EW-643 Phase 3 slice 4b — wikilink rename rewriter.
 *
 * When a KB document is renamed (its `path` changes via
 * `KnowledgeBaseService.updateDocument`), every OTHER active document
 * in the same Work that references it via the Obsidian-style
 * `[[oldPath]]` wikilink syntax must be rewritten in-place to
 * `[[newPath]]` so cross-doc references don't go stale.
 *
 * Integration point — NOT wired here:
 *   The call-site lives in
 *   `KnowledgeBaseService.updateDocument(workId, docId, userId, input)`.
 *   That method does not currently accept a `path` field on its
 *   `UpdateDocumentInput`, so the wire-up belongs to whichever PR
 *   surfaces the rename affordance on the workbench. Once the rename
 *   lands there, the call shape is:
 *
 *     if (input.path !== undefined && input.path !== existing.path) {
 *         await this.wikilinkRewriter.rewriteReferences({
 *             workId,
 *             oldPath: existing.path,
 *             newPath: input.path,
 *             actorUserId: userId,
 *         });
 *     }
 *
 *   Run the rewriter AFTER the renamed document's own row has been
 *   persisted so the scan-and-exclude predicate (oldPath != renamed's
 *   new path) works on a consistent snapshot.
 *
 * Fault tolerance:
 *   - Activity-log emission is wrapped in catch-and-warn, matching the
 *     `recordUploadActivity` pattern in `KnowledgeBaseService` — a flaky
 *     activity-log write must NEVER bubble back to the user-facing
 *     rename. The rewrite itself, in contrast, IS surfaced: a partial
 *     rewrite would leave the KB in a half-broken state and is worth
 *     failing the request over.
 */

/**
 * Escape every regex metacharacter in `oldPath` so a path that
 * legitimately contains `.`, `+`, `(`, `)`, `[`, `]`, `*`, `?`, `|`,
 * `^`, `$`, `\\`, `{`, `}`, or `/` is matched LITERALLY rather than
 * as a regex pattern. Without this, a rename of `foo.bar` would
 * match `foo_bar` (and every other 7-character string with the
 * right delimiters around it), corrupting unrelated bodies.
 *
 * The returned RegExp matches `[[<escaped oldPath>]]` with the
 * global flag so `String.replace(regex, …)` rewrites every
 * occurrence in a single pass.
 *
 * Exported so callers (tests, ad-hoc reconcile tooling) can reuse
 * the exact same escape semantics the rewriter applies.
 */
export function buildWikilinkRegex(oldPath: string): RegExp {
    const escaped = oldPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(`\\[\\[${escaped}\\]\\]`, 'g');
}

export interface RewriteReferencesInput {
    readonly workId: string;
    readonly oldPath: string;
    readonly newPath: string;
    readonly actorUserId: string;
}

export interface RewriteReferencesResult {
    readonly documentsTouched: number;
}

@Injectable()
export class KnowledgeBaseWikilinkRewriterService {
    private readonly logger = new Logger(KnowledgeBaseWikilinkRewriterService.name);

    constructor(
        private readonly documents: WorkKnowledgeDocumentRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    /**
     * Scan every ACTIVE document in `workId`, rewrite `[[oldPath]]` →
     * `[[newPath]]` in any body that contains the wikilink, persist the
     * updated body via the document repository, and emit a single
     * `KB_WIKILINK_REWRITTEN` activity-log event with the touched count.
     *
     * The document that was JUST renamed (i.e. the one whose path is
     * now `newPath`) is excluded from the scan — its own body is owned
     * by its author, and rewriting self-references would mutate intent
     * the author may have set deliberately.
     *
     * No-op fast paths:
     *   - oldPath === newPath: nothing to do, returns `{ documentsTouched: 0 }`
     *     without even hitting the DB.
     *   - oldPath is empty: same.
     */
    async rewriteReferences(input: RewriteReferencesInput): Promise<RewriteReferencesResult> {
        if (!input.oldPath || input.oldPath === input.newPath) {
            return { documentsTouched: 0 };
        }

        const regex = buildWikilinkRegex(input.oldPath);

        // List all active docs in the Work. The default LIKE-q filter is
        // intentionally NOT used here — wikilinks live in the body
        // (`metadata.body`), and the body isn't indexed by the
        // title/description LIKE search, so a candidate-shortlist via
        // search would miss matches. The scan is bounded by Work size,
        // which is small in practice (spec §22 caps Work KBs at a few
        // thousand docs in v1) and the regex test below is O(body length)
        // — both cheap enough for an interactive rename.
        const { items } = await this.documents.list({
            workId: input.workId,
            statuses: [KbDocumentStatus.ACTIVE],
        });

        let touched = 0;
        for (const doc of items) {
            // Skip the renamed document itself. After the rename has
            // been persisted, its path matches `newPath`; before, it
            // still matched `oldPath`. Excluding by either keeps the
            // rewriter correct regardless of which order the caller
            // invokes us in, and means an author's deliberate
            // self-reference is never silently rewritten.
            if (doc.path === input.newPath || doc.path === input.oldPath) {
                continue;
            }

            const meta = (doc.metadata ?? {}) as Record<string, unknown>;
            const body = typeof meta.body === 'string' ? meta.body : '';
            if (body.length === 0) {
                continue;
            }

            // Reset `lastIndex` defensively — the regex carries the
            // `g` flag, so `.test()` advances it and a later iteration
            // could spuriously miss an early match in the next body.
            regex.lastIndex = 0;
            if (!regex.test(body)) {
                continue;
            }

            // `String.replace` with a global regex rewrites every match
            // in a single pass — equivalent to `String.replaceAll(re,…)`
            // without the Node 14 polyfill caveat. We reset `lastIndex`
            // again so the replace starts from offset 0 rather than
            // wherever `.test()` left it.
            regex.lastIndex = 0;
            const rewritten = body.replace(regex, `[[${input.newPath}]]`);
            if (rewritten === body) {
                continue;
            }

            await this.documents.update(doc.id, {
                updatedById: input.actorUserId,
                metadata: { ...meta, body: rewritten } as Record<string, unknown>,
            });
            touched += 1;
        }

        await this.recordRewriteActivity(input, touched);

        return { documentsTouched: touched };
    }

    /**
     * Fault-tolerant activity-log emit — mirrors the catch-and-warn
     * shape of `KnowledgeBaseService.recordUploadActivity`. A flaky
     * activity-log write (e.g. transient DB outage on the log table)
     * must not bubble back and fail the user-facing rename.
     */
    private async recordRewriteActivity(
        input: RewriteReferencesInput,
        documentsTouched: number,
    ): Promise<void> {
        if (!this.activityLog) {
            return;
        }
        try {
            await this.activityLog.log({
                userId: input.actorUserId,
                workId: input.workId,
                actionType: ActivityActionType.KB_WIKILINK_REWRITTEN,
                action: ActivityActionType.KB_WIKILINK_REWRITTEN,
                status: ActivityStatus.COMPLETED,
                summary: `Rewrote ${documentsTouched} wikilink reference${
                    documentsTouched === 1 ? '' : 's'
                } from [[${input.oldPath}]] to [[${input.newPath}]]`,
                details: {
                    oldPath: input.oldPath,
                    newPath: input.newPath,
                    documentsTouched,
                },
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record KB_WIKILINK_REWRITTEN activity for work=${input.workId}: ${
                    (error as Error).message
                }`,
            );
        }
    }
}
