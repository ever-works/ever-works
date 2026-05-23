import { Injectable, Logger } from '@nestjs/common';
import type {
    KbDocumentBodyDto,
    KbDocumentClass,
    KbDocumentDto,
    KbDocumentStatus,
    KbLockMode,
} from '@ever-works/contracts';
import { KnowledgeBaseService } from './knowledge-base.service';
import type {
    KbDocumentClass as KbDocumentClassEnum,
    KbDocumentSource as KbDocumentSourceEnum,
    KbDocumentStatus as KbDocumentStatusEnum,
    KbLockMode as KbLockModeEnum,
} from '../entities/kb-types';

/**
 * EW-641 Phase 2/d row 36 — `KbAgentToolsService`: tool-shaped wrapper
 * around `KnowledgeBaseService` that the agent-pipeline plugin family
 * (row 36b) will register as LLM-callable tool definitions
 * (`kb_search` / `kb_read` / `kb_write` / `kb_lock` / `kb_unlock`).
 *
 * Why a separate service:
 *  - LLM tool inputs are narrower than the service's full CRUD shape
 *    (no `userId` per call — it's bound to the agent run's user; no
 *    `source` / `generatedByAgentRunId` — the wrapper stamps those
 *    to `'agent'` / the current run id when caller passes it).
 *  - Tool callers want upsert-by-path semantics for writes (the LLM
 *    doesn't think in terms of "did this doc id exist yet?"). The
 *    wrapper does an existence probe and dispatches to create vs
 *    update accordingly.
 *  - Errors should map to compact tool-error strings instead of
 *    throwing HttpException subclasses (which the pipeline runner
 *    can't easily surface back to the LLM). Each method returns a
 *    discriminated `{ ok: true, ... } | { ok: false, error: string }`
 *    so the pipeline can pass-through to a tool response.
 *
 * Permission gates are inherited from `KnowledgeBaseService` —
 * `ensureCanView` for read/search, `ensureCanEdit` for write/lock/
 * unlock. Forbidden / NotFound errors bubble up as `ok: false`.
 *
 * The actual Vercel-AI-SDK tool registration (the `tools: { kb_search,
 * kb_read, ... }` map handed to `streamText`) lives in row 36b under
 * `packages/plugins/agent-pipeline/` — keeping it out of this row
 * holds the diff to one focused PR.
 */

// ─── Input / output shapes ─────────────────────────────────────────

export interface KbSearchToolInput {
    /** Free-text query. Empty/whitespace → pure-list path. */
    readonly q?: string;
    /** Optional class filter (`brand` / `legal` / …). */
    readonly class?: KbDocumentClass;
    /** Optional status filter; defaults to `active` upstream. */
    readonly status?: KbDocumentStatus;
    /** Page size; default 20, clamped to ≤50. */
    readonly limit?: number;
}

export interface KbWriteToolInput {
    /** Canonical `<class>/<slug>.md`-style path. Used as the upsert key. */
    readonly path: string;
    /** Document title (required on create; ignored on update if absent). */
    readonly title: string;
    /** KB class — required on create; ignored on update. */
    readonly class: KbDocumentClass;
    /** Markdown body. */
    readonly body: string;
    /** Optional metadata. */
    readonly description?: string | null;
    readonly tags?: string[];
    readonly categories?: string[];
    readonly language?: string;
    /** When supplied, stamped onto the row so the audit trail credits
     *  the originating agent run. */
    readonly generatedByAgentRunId?: string | null;
}

/** Discriminated tool result so the pipeline doesn't have to catch. */
export type KbToolResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface KbSearchToolResult {
    readonly items: ReadonlyArray<KbDocumentDto>;
    readonly total: number;
}

export interface KbWriteToolResult {
    readonly document: KbDocumentBodyDto;
    readonly action: 'created' | 'updated';
}

/** Maximum results the LLM can request from `kb_search` per call.
 *  Mirrors the row 15 search-palette cap so the search surface is
 *  consistent across user/agent callers. */
const SEARCH_LIMIT_CAP = 50;

@Injectable()
export class KbAgentToolsService {
    private readonly logger = new Logger(KbAgentToolsService.name);

    constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

    /**
     * `kb_search` — query the KB for docs matching `q` (RRF-blended
     * lexical + semantic per row 30c), optionally filtered by class /
     * status. Returns metadata-only DTOs (no body) so the LLM doesn't
     * pay token cost for full doc bodies before deciding which to read.
     */
    async kbSearch(
        workId: string,
        userId: string,
        input: KbSearchToolInput = {},
    ): Promise<KbToolResult<KbSearchToolResult>> {
        try {
            const limit = this.clampLimit(input.limit, SEARCH_LIMIT_CAP);
            const result = await this.knowledgeBaseService.listDocuments(workId, userId, {
                q: input.q,
                class: input.class as KbDocumentClassEnum | undefined,
                status: input.status as KbDocumentStatusEnum | undefined,
                limit,
            });
            return { ok: true, data: { items: result.items, total: result.total } };
        } catch (err) {
            return this.toErrorResult(err, 'kb_search');
        }
    }

    /**
     * `kb_read` — fetch a single doc by id or `<class>/<slug>[.md]`
     * path. Returns the full body DTO so the LLM can quote/cite.
     */
    async kbRead(
        workId: string,
        userId: string,
        idOrPath: string,
    ): Promise<KbToolResult<KbDocumentBodyDto>> {
        try {
            const doc = await this.knowledgeBaseService.getDocument(workId, idOrPath, userId);
            return { ok: true, data: doc };
        } catch (err) {
            return this.toErrorResult(err, 'kb_read');
        }
    }

    /**
     * `kb_write` — upsert by path. If a doc with the same path already
     * exists, applies the update patch (title/body/tags/etc.); otherwise
     * creates a new doc. Source is stamped `'agent'` so the activity
     * log + budget integration can distinguish agent-authored content.
     */
    async kbWrite(
        workId: string,
        userId: string,
        input: KbWriteToolInput,
    ): Promise<KbToolResult<KbWriteToolResult>> {
        try {
            const existing = await this.tryFindByPath(workId, input.path, userId);

            if (existing) {
                const patch: Parameters<KnowledgeBaseService['updateDocument']>[3] = {
                    title: input.title,
                    body: input.body,
                };
                if (input.description !== undefined) patch.description = input.description;
                if (input.tags !== undefined) patch.tags = input.tags;
                if (input.categories !== undefined) patch.categories = input.categories;
                if (input.language !== undefined) patch.language = input.language;
                const updated = await this.knowledgeBaseService.updateDocument(
                    workId,
                    existing.id,
                    userId,
                    patch,
                );
                return { ok: true, data: { document: updated, action: 'updated' } };
            }

            // Contracts ship class/source as string-unions; the agent's
            // internal entities use enums. Cast at the boundary per the
            // operator's standing rule for KB controller→service hops
            // (KbDocumentClass + KbDocumentSource).
            const created = await this.knowledgeBaseService.createDocument({
                workId,
                userId,
                path: input.path,
                title: input.title,
                class: input.class as KbDocumentClassEnum,
                body: input.body,
                description: input.description ?? null,
                tags: input.tags,
                categories: input.categories,
                language: input.language,
                source: 'agent' as KbDocumentSourceEnum,
                generatedByAgentRunId: input.generatedByAgentRunId ?? null,
            });
            return { ok: true, data: { document: created, action: 'created' } };
        } catch (err) {
            return this.toErrorResult(err, 'kb_write');
        }
    }

    /**
     * `kb_lock` — set the lock mode (`full` / `additions-only`) on a
     * doc. Requires manager+ role (gate enforced in
     * `KnowledgeBaseService.lockDocument`).
     */
    async kbLock(
        workId: string,
        userId: string,
        docId: string,
        mode: KbLockMode,
    ): Promise<KbToolResult<KbDocumentBodyDto>> {
        try {
            const updated = await this.knowledgeBaseService.lockDocument(
                workId,
                docId,
                userId,
                mode as KbLockModeEnum,
            );
            return { ok: true, data: updated };
        } catch (err) {
            return this.toErrorResult(err, 'kb_lock');
        }
    }

    /**
     * `kb_unlock` — clear the lock on a doc. Requires manager+ role
     * (gate enforced in `KnowledgeBaseService.unlockDocument`).
     */
    async kbUnlock(
        workId: string,
        userId: string,
        docId: string,
    ): Promise<KbToolResult<KbDocumentBodyDto>> {
        try {
            const updated = await this.knowledgeBaseService.unlockDocument(workId, docId, userId);
            return { ok: true, data: updated };
        } catch (err) {
            return this.toErrorResult(err, 'kb_unlock');
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────

    /** Clamp `limit` to [1, cap] with a default of 20 when omitted. */
    private clampLimit(raw: number | undefined, cap: number): number {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return 20;
        const clamped = Math.max(1, Math.min(Math.floor(raw), cap));
        return clamped;
    }

    /**
     * Look up a doc by path WITHOUT throwing — returns null on miss so
     * `kb_write` can choose between create vs update without catching
     * a NotFoundException inside happy-path code.
     */
    private async tryFindByPath(
        workId: string,
        path: string,
        userId: string,
    ): Promise<KbDocumentBodyDto | null> {
        try {
            const doc = await this.knowledgeBaseService.getDocument(workId, path, userId);
            return doc;
        } catch (err) {
            // NotFoundException is the expected "create" path; let any
            // other exception bubble so kbWrite's outer catch surfaces
            // it as a tool error.
            if ((err as Error)?.name === 'NotFoundException') return null;
            if ((err as { status?: number })?.status === 404) return null;
            throw err;
        }
    }

    /**
     * Convert any thrown error into a `{ ok: false, error }` result.
     * Logs the original at debug level so a flaky tool call doesn't
     * spam warn-level logs, but the trace is recoverable when needed.
     */
    private toErrorResult<T>(err: unknown, tool: string): KbToolResult<T> {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`KB tool ${tool} failed: ${message}`);
        return { ok: false, error: message };
    }
}
