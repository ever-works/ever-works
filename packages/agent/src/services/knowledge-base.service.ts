import { createHash } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { IStoragePlugin } from '@ever-works/plugin';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { WorkOwnershipService } from './work-ownership.service';
import { KnowledgeBaseGitMirrorService } from './knowledge-base-git-mirror.service';
import { KnowledgeBaseBufferExtractorService } from './knowledge-base-buffer-extractor.service';
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { KbUploadExtractionStatus } from '../entities/kb-types';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { WorkKnowledgeTag } from '../entities/work-knowledge-tag.entity';
import {
    KB_ORG_INHERITABLE_CLASSES,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
} from '../entities/kb-types';
import { KB_MIRROR_DOCUMENT_DISPATCHER, type KbMirrorDocumentDispatcher } from '../tasks';
import type {
    CitationDto,
    KbDocumentBodyDto,
    KbDocumentClass as KbDocumentClassContract,
    KbDocumentDto,
    KbTagDto,
} from '@ever-works/contracts';

/**
 * DI token for the storage plugin used by the KB upload + ingest
 * pipeline. The API-side `KnowledgeBaseModule` binds it via
 * `getActiveStorageBackend()` — the same factory `UploadsService` uses
 * for the platform's general-purpose upload route. Declared as a string
 * token because `IStoragePlugin` is an interface (erased at runtime).
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §8 (storage).
 */
export const KB_STORAGE_PLUGIN = 'KB_STORAGE_PLUGIN';

interface CreateDocumentInput {
    workId: string;
    userId: string;
    path: string;
    title: string;
    class: KbDocumentClass;
    body: string;
    description?: string | null;
    tags?: string[];
    categories?: string[];
    language?: string;
    status?: KbDocumentStatus;
    source?: KbDocumentSource;
    sourceUrl?: string | null;
    sourceUploadId?: string | null;
    generatedByAgentRunId?: string | null;
}

interface UpdateDocumentInput {
    title?: string;
    description?: string | null;
    body?: string;
    tags?: string[];
    categories?: string[];
    language?: string;
    status?: KbDocumentStatus;
}

interface ListOptions {
    class?: KbDocumentClass;
    status?: KbDocumentStatus;
    tag?: string;
    locked?: boolean;
    language?: string;
    q?: string;
    limit?: number;
    offset?: number;
}

/**
 * KnowledgeBaseService — Phase 1A service layer for per-Work KB.
 *
 * Responsibilities in this phase:
 *  - CRUD on `WorkKnowledgeDocument`, `WorkKnowledgeTag`,
 *    `WorkKnowledgeUpload`, `WorkKnowledgeCitation`.
 *  - Permission gating via `WorkOwnershipService`.
 *  - Lexical search (Postgres LIKE for v1; Postgres FTS upgrade is
 *    Phase 2 alongside semantic retrieval).
 *  - Lock semantics (set / clear / read).
 *  - Restore-from-history exposed as a no-op stub here; the Git
 *    integration lands in the same PR that adds the Storage plugin
 *    bridge (Phase 1B).
 *
 * Out of scope for this file (lands later):
 *  - Two-layer DB ↔ Git sync. The body lives only in the DB row in
 *    this phase; the Git mirroring step is added when the Storage
 *    plugin abstraction is wired (Phase 1B).
 *  - Embedding generation + semantic retrieval (Phase 2).
 *  - Org overlay materialization fanout (Phase 2).
 *  - Ingest pipeline (Phase 1B).
 *
 * The service is intentionally Git-agnostic for now so the schema +
 * API contract can be reviewed and stabilized before the storage
 * abstraction lands.
 */
@Injectable()
export class KnowledgeBaseService {
    private readonly logger = new Logger(KnowledgeBaseService.name);

    constructor(
        private readonly documentRepository: WorkKnowledgeDocumentRepository,
        private readonly uploadRepository: WorkKnowledgeUploadRepository,
        private readonly tagRepository: WorkKnowledgeTagRepository,
        private readonly citationRepository: WorkKnowledgeCitationRepository,
        private readonly ownershipService: WorkOwnershipService,
        @Optional()
        @Inject(KB_MIRROR_DOCUMENT_DISPATCHER)
        private readonly mirrorDispatcher?: KbMirrorDocumentDispatcher,
        @Optional()
        private readonly mirrorService?: KnowledgeBaseGitMirrorService,
        // EW-641 1B/b — storage plugin used by the KB upload pipeline.
        // Wired by the API-side module to the same `IStoragePlugin`
        // selected via `STORAGE_BACKEND` env. Optional so deployments
        // and tests that don't exercise upload still construct.
        @Optional()
        @Inject(KB_STORAGE_PLUGIN)
        private readonly storage?: IStoragePlugin,
        @Optional() private readonly activityLog?: ActivityLogService,
        // EW-641 Phase 1B/c — extractor router for non-text MIME types
        // (HTML now, PDF/DOCX/XLSX/PPTX in follow-up commits). Optional
        // so isolated unit tests without DOM/Turndown plumbing still
        // construct; when absent, the service falls back to the
        // built-in text-passthrough check.
        @Optional() private readonly bufferExtractor?: KnowledgeBaseBufferExtractorService,
    ) {}

    /**
     * Enqueue a Trigger.dev `kb-mirror-document` run for one document
     * mutation. When the Trigger.dev dispatcher is not registered (older
     * deployments, isolated unit tests), the call is skipped — the DB
     * row still persists and the Phase 3 reconciliation job catches the
     * drift. Errors from the dispatcher are logged but do not bubble up:
     * the user-facing API write must succeed even if the background
     * sync queue is offline.
     */
    private async enqueueMirror(
        workId: string,
        documentId: string,
        operation: 'upsert' | 'delete',
        docPath: string,
        docClass: string,
    ): Promise<void> {
        if (!this.mirrorDispatcher) {
            return;
        }
        try {
            await this.mirrorDispatcher.dispatchKbMirrorDocument({
                workId,
                documentId,
                operation,
                path: docPath,
                class: docClass,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to enqueue KB mirror for ${operation} ${docPath} (work=${workId}): ${(error as Error).message}`,
            );
        }
    }

    // ─── DOCUMENTS — Work scope ───────────────────────────────────────────────

    async listDocuments(workId: string, userId: string, opts: ListOptions = {}) {
        await this.ownershipService.ensureCanView(workId, userId);

        const { items, total } = await this.documentRepository.list({
            workId,
            classes: opts.class ? [opts.class] : undefined,
            statuses: opts.status ? [opts.status] : undefined,
            tag: opts.tag,
            locked: opts.locked,
            language: opts.language,
            q: opts.q,
            limit: opts.limit,
            offset: opts.offset,
        });

        return { items: items.map((d) => this.toDto(d)), total };
    }

    async getDocument(
        workId: string,
        idOrPath: string,
        userId: string,
    ): Promise<KbDocumentBodyDto> {
        await this.ownershipService.ensureCanView(workId, userId);

        const doc = await this.documentRepository.findByWorkOrPath(workId, idOrPath);
        if (!doc) {
            throw new NotFoundException(`KB document not found: ${idOrPath}`);
        }

        return this.toBodyDto(doc);
    }

    async createDocument(input: CreateDocumentInput): Promise<KbDocumentBodyDto> {
        await this.ownershipService.ensureCanEdit(input.workId, input.userId);

        // EW-641 — reject traversal / absolute / unknown-class paths at the
        // input boundary so a bad row never lands in the DB. The mirror
        // service repeats the check defense-in-depth.
        KnowledgeBaseGitMirrorService.validateRelativeKbPath(input.path);

        const slug = this.slugFromPath(input.path);
        const path = await this.resolvePathCollision(input.workId, input.path);

        const body = input.body ?? '';
        const wordCount = this.countWords(body);
        const tokenCount = this.estimateTokens(body);

        const doc = await this.documentRepository.create({
            workId: input.workId,
            organizationId: null,
            path,
            slug,
            title: input.title,
            description: input.description ?? null,
            kbDocumentClass: input.class,
            tags: input.tags ?? null,
            categories: input.categories ?? null,
            status: input.status ?? ('active' as KbDocumentStatus),
            locked: false,
            lockMode: null,
            language: input.language ?? 'en',
            wordCount,
            tokenCount,
            source: input.source ?? ('user' as KbDocumentSource),
            sourceUploadId: input.sourceUploadId ?? null,
            sourceUrl: input.sourceUrl ?? null,
            generatedByAgentRunId: input.generatedByAgentRunId ?? null,
            createdById: input.userId,
            updatedById: input.userId,
            metadata: { body } as Record<string, unknown>,
        });

        // Ensure any new tag slugs are in the tag catalog (create-on-first-use).
        if (input.tags?.length) {
            await this.ensureTagsExist(input.workId, input.tags);
        }

        await this.enqueueMirror(input.workId, doc.id, 'upsert', doc.path, doc.kbDocumentClass);

        return this.toBodyDto(doc);
    }

    async updateDocument(
        workId: string,
        docId: string,
        userId: string,
        input: UpdateDocumentInput,
    ): Promise<KbDocumentBodyDto> {
        await this.ownershipService.ensureCanEdit(workId, userId);

        const existing = await this.documentRepository.findById(workId, docId);
        if (!existing) {
            throw new NotFoundException(`KB document not found: ${docId}`);
        }
        this.assertNotLockedFull(existing);

        const patch: Partial<WorkKnowledgeDocument> = { updatedById: userId };
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.tags !== undefined) patch.tags = input.tags;
        if (input.categories !== undefined) patch.categories = input.categories;
        if (input.language !== undefined) patch.language = input.language;
        if (input.status !== undefined) patch.status = input.status;

        if (input.body !== undefined) {
            patch.wordCount = this.countWords(input.body);
            patch.tokenCount = this.estimateTokens(input.body);
            patch.metadata = {
                ...(existing.metadata ?? {}),
                body: input.body,
            } as Record<string, unknown>;
        }

        const updated = await this.documentRepository.update(docId, patch);
        if (!updated) {
            throw new NotFoundException(`KB document not found after update: ${docId}`);
        }

        if (input.tags?.length) {
            await this.ensureTagsExist(workId, input.tags);
        }

        await this.enqueueMirror(
            workId,
            updated.id,
            'upsert',
            updated.path,
            updated.kbDocumentClass,
        );

        return this.toBodyDto(updated);
    }

    async deleteDocument(workId: string, docId: string, userId: string): Promise<void> {
        await this.ownershipService.ensureCanEdit(workId, userId);

        const existing = await this.documentRepository.findById(workId, docId);
        if (!existing) {
            throw new NotFoundException(`KB document not found: ${docId}`);
        }
        this.assertNotLockedFull(existing);

        await this.documentRepository.delete(docId);

        // After the hard delete, the row is gone but the Git mirror task
        // still needs the path + class to remove the right files — pass
        // them through the payload.
        await this.enqueueMirror(
            workId,
            existing.id,
            'delete',
            existing.path,
            existing.kbDocumentClass,
        );
    }

    async lockDocument(
        workId: string,
        docId: string,
        userId: string,
        mode: KbLockMode,
    ): Promise<KbDocumentBodyDto> {
        const access = await this.ownershipService.ensureCanEdit(workId, userId);
        // Lock toggles require at least manager role per spec §20.
        if (access.role !== 'owner' && access.role !== 'manager') {
            throw new ForbiddenException('Locking a KB document requires manager+ role');
        }

        const existing = await this.documentRepository.findById(workId, docId);
        if (!existing) {
            throw new NotFoundException(`KB document not found: ${docId}`);
        }

        const updated = await this.documentRepository.setLock(docId, true, mode);
        if (!updated) {
            throw new NotFoundException(`KB document not found after lock: ${docId}`);
        }
        return this.toBodyDto(updated);
    }

    async unlockDocument(
        workId: string,
        docId: string,
        userId: string,
    ): Promise<KbDocumentBodyDto> {
        const access = await this.ownershipService.ensureCanEdit(workId, userId);
        if (access.role !== 'owner' && access.role !== 'manager') {
            throw new ForbiddenException('Unlocking a KB document requires manager+ role');
        }

        const existing = await this.documentRepository.findById(workId, docId);
        if (!existing) {
            throw new NotFoundException(`KB document not found: ${docId}`);
        }

        const updated = await this.documentRepository.setLock(docId, false, null);
        if (!updated) {
            throw new NotFoundException(`KB document not found after unlock: ${docId}`);
        }
        return this.toBodyDto(updated);
    }

    /**
     * Restore a document body from a prior Git commit. Reads the body
     * `.md` at the supplied commit SHA via the configured Git provider's
     * `getFileContent` capability, applies it back to the DB row, and
     * enqueues a fresh mirror so the head commit moves forward with the
     * restored content.
     *
     * Requires `KnowledgeBaseGitMirrorService` to be wired into the
     * module graph (it is in `apps/api`); deployments without the
     * mirror service get a clear 503 rather than a 500.
     */
    async restoreDocumentFromHistory(
        workId: string,
        docId: string,
        userId: string,
        commitSha: string,
    ): Promise<KbDocumentBodyDto> {
        const access = await this.ownershipService.ensureCanEdit(workId, userId);
        if (access.role !== 'owner' && access.role !== 'manager') {
            throw new ForbiddenException('Restoring KB history requires manager+ role');
        }

        if (!this.mirrorService) {
            // Greptile P1: a missing server-side dependency is a server
            // problem, not a client error. 503 is the right code so
            // clients implementing retry-on-503 know to back off and
            // retry rather than treating a valid request as malformed.
            throw new ServiceUnavailableException(
                'restore-from-history requires the KB Git mirror service — not configured in this deployment',
            );
        }

        const existing = await this.documentRepository.findById(workId, docId);
        if (!existing) {
            throw new NotFoundException(`KB document not found: ${docId}`);
        }
        this.assertNotLockedFull(existing);

        const result = await this.mirrorService.restoreDocumentFromGit(workId, docId, commitSha);
        if (!result.restored) {
            throw new NotFoundException(
                `KB document body not found at commit ${commitSha} for ${existing.path}`,
            );
        }

        const updated = await this.documentRepository.findById(workId, docId);
        if (!updated) {
            throw new NotFoundException(`KB document vanished mid-restore: ${docId}`);
        }

        await this.enqueueMirror(
            workId,
            updated.id,
            'upsert',
            updated.path,
            updated.kbDocumentClass,
        );

        return this.toBodyDto(updated);
    }

    // ─── DOCUMENTS — Organization scope (inheritable: legal/style/seo) ───────

    async createOrgDocument(
        organizationId: string,
        userId: string,
        input: Omit<CreateDocumentInput, 'workId' | 'userId'>,
    ): Promise<KbDocumentBodyDto> {
        // Org-admin guard happens at the controller layer.
        if (!(KB_ORG_INHERITABLE_CLASSES as ReadonlyArray<KbDocumentClass>).includes(input.class)) {
            throw new BadRequestException(
                `Organization-scoped KB documents must have class in [${KB_ORG_INHERITABLE_CLASSES.join(', ')}], got '${input.class}'`,
            );
        }

        const slug = this.slugFromPath(input.path);
        const body = input.body ?? '';
        const wordCount = this.countWords(body);
        const tokenCount = this.estimateTokens(body);

        const doc = await this.documentRepository.create({
            workId: null,
            organizationId,
            path: input.path,
            slug,
            title: input.title,
            description: input.description ?? null,
            kbDocumentClass: input.class,
            tags: input.tags ?? null,
            categories: input.categories ?? null,
            status: input.status ?? ('active' as KbDocumentStatus),
            locked: false,
            lockMode: null,
            language: input.language ?? 'en',
            wordCount,
            tokenCount,
            source: 'user' as KbDocumentSource,
            createdById: userId,
            updatedById: userId,
            metadata: { body } as Record<string, unknown>,
        });

        return this.toBodyDto(doc);
    }

    async listOrgDocuments(
        organizationId: string,
        opts: { class?: KbDocumentClass } = {},
    ): Promise<{ items: KbDocumentDto[]; total: number }> {
        const { items, total } = await this.documentRepository.list({
            organizationId,
            classes: opts.class ? [opts.class] : undefined,
        });
        return { items: items.map((d) => this.toDto(d)), total };
    }

    async resolveInheritableDocuments(
        workId: string,
        organizationId: string | null,
        classes?: KbDocumentClass[],
    ): Promise<KbDocumentDto[]> {
        const targetClasses = (classes ?? [...KB_ORG_INHERITABLE_CLASSES]).filter((c) =>
            (KB_ORG_INHERITABLE_CLASSES as ReadonlyArray<KbDocumentClass>).includes(c),
        );

        if (targetClasses.length === 0) {
            return [];
        }

        const orgDocs = organizationId
            ? await this.documentRepository.listInheritableForOrg(organizationId, targetClasses)
            : [];

        const workOverrides = await this.documentRepository.listWorkOverridesForClasses(
            workId,
            targetClasses,
        );

        // Build a map keyed by path with Work overriding org.
        const byPath = new Map<string, WorkKnowledgeDocument>();
        for (const d of orgDocs) {
            byPath.set(d.path, d);
        }
        for (const d of workOverrides) {
            byPath.set(d.path, d);
        }

        return [...byPath.values()].map((d) => this.toDto(d));
    }

    // ─── TAGS ────────────────────────────────────────────────────────────────

    async listTags(workId: string, userId: string): Promise<KbTagDto[]> {
        await this.ownershipService.ensureCanView(workId, userId);
        const tags = await this.tagRepository.list(workId);
        return tags.map(toTagDto);
    }

    async createTag(
        workId: string,
        userId: string,
        input: { slug: string; name: string; color?: string | null; description?: string | null },
    ): Promise<KbTagDto> {
        await this.ownershipService.ensureCanEdit(workId, userId);

        const existing = await this.tagRepository.findBySlug(workId, input.slug);
        if (existing) {
            throw new BadRequestException(`Tag with slug '${input.slug}' already exists`);
        }

        const tag = await this.tagRepository.create({
            workId,
            slug: input.slug,
            name: input.name,
            color: input.color ?? null,
            description: input.description ?? null,
        });
        return toTagDto(tag);
    }

    async updateTag(
        workId: string,
        tagId: string,
        userId: string,
        patch: { name?: string; color?: string | null; description?: string | null },
    ): Promise<KbTagDto> {
        await this.ownershipService.ensureCanEdit(workId, userId);
        const existing = await this.tagRepository.findById(workId, tagId);
        if (!existing) {
            throw new NotFoundException(`Tag not found: ${tagId}`);
        }
        const updated = await this.tagRepository.update(tagId, patch);
        if (!updated) {
            throw new NotFoundException(`Tag not found after update: ${tagId}`);
        }
        return toTagDto(updated);
    }

    async deleteTag(workId: string, tagId: string, userId: string): Promise<void> {
        await this.ownershipService.ensureCanEdit(workId, userId);
        const existing = await this.tagRepository.findById(workId, tagId);
        if (!existing) {
            throw new NotFoundException(`Tag not found: ${tagId}`);
        }
        await this.tagRepository.delete(tagId);
    }

    // ─── CITATIONS ───────────────────────────────────────────────────────────

    async listCitationsForDocument(
        workId: string,
        docId: string,
        userId: string,
    ): Promise<CitationDto[]> {
        await this.ownershipService.ensureCanView(workId, userId);
        const existing = await this.documentRepository.findById(workId, docId);
        if (!existing) {
            throw new NotFoundException(`KB document not found: ${docId}`);
        }
        const citations = await this.citationRepository.listForDocument(docId);
        return citations.map((c) => ({
            id: c.id,
            documentId: c.documentId,
            consumerType: c.consumerType,
            consumerId: c.consumerId,
            chunkRange: c.chunkRange ?? null,
            relevanceScore: c.relevanceScore ?? null,
            createdAt: c.createdAt.toISOString(),
        }));
    }

    // ─── UPLOADS (EW-641 1B/b ingest) ────────────────────────────────────────

    async listUploads(
        workId: string,
        userId: string,
        opts: { status?: KbUploadExtractionStatus; limit?: number; offset?: number } = {},
    ): Promise<{ items: WorkKnowledgeUpload[]; total: number }> {
        await this.ownershipService.ensureCanView(workId, userId);
        return this.uploadRepository.listPaged({ workId, ...opts });
    }

    async getUpload(
        workId: string,
        uploadId: string,
        userId: string,
    ): Promise<WorkKnowledgeUpload> {
        await this.ownershipService.ensureCanView(workId, userId);
        const upload = await this.uploadRepository.findById(workId, uploadId);
        if (!upload) {
            throw new NotFoundException(`KB upload not found: ${uploadId}`);
        }
        return upload;
    }

    /**
     * Receive a multipart upload and run the synchronous slice of the
     * ingest pipeline (spec §9.1–§9.4). The file bytes are already in
     * memory from `FileInterceptor` so the API handler can extract +
     * materialize without a Trigger.dev round-trip.
     *
     * Flow:
     *  1. Permission check (editor+).
     *  2. SHA-256 dedup against `(workId, sha256)`. On a hit, no
     *     storage write, no new KB doc — re-classification of an
     *     existing upload comes via a separate dedicated endpoint.
     *  3. Persist bytes via `IStoragePlugin.putObject` under
     *     `kb-originals/{class}/{sha256}.{ext}`.
     *  4. Create the `WorkKnowledgeUpload` row.
     *  5. If MIME is text-passthrough (markdown/plain): build the KB
     *     document body directly from the bytes and create a doc via
     *     `createDocument` (which already enqueues the Git mirror).
     *  6. Otherwise: mark `extractionStatus='skipped'` — the per-MIME
     *     extractor routing (PDF/DOCX/HTML/etc.) lands in Phase 1B/c.
     *  7. Emit the activity-log kinds per spec §19.1.
     */
    async createUpload(input: {
        workId: string;
        userId: string;
        file: { buffer: Buffer; originalFilename: string; mimeType: string; size: number };
        targetClass?: KbDocumentClass;
        tags?: string[];
        description?: string | null;
        title?: string;
    }): Promise<{ upload: WorkKnowledgeUpload; document: WorkKnowledgeDocument | null }> {
        await this.ownershipService.ensureCanEdit(input.workId, input.userId);

        if (!this.storage) {
            throw new ServiceUnavailableException(
                'KB uploads require a storage plugin — not configured in this deployment',
            );
        }

        const sha256 = createHash('sha256').update(input.file.buffer).digest('hex');

        const existing = await this.uploadRepository.findBySha256(input.workId, sha256);
        if (existing) {
            await this.recordUploadActivity(
                input.workId,
                input.userId,
                ActivityActionType.KB_UPLOAD_DEDUPED,
                `Skipped duplicate upload ${input.file.originalFilename}`,
                {
                    uploadId: existing.id,
                    originalFilename: input.file.originalFilename,
                    sha256,
                },
            );
            return { upload: existing, document: null };
        }

        const klass = (input.targetClass ?? ('freeform' as KbDocumentClass)) as KbDocumentClass;
        const storageKey = await this.persistUploadToStorage(
            input.workId,
            input.userId,
            input.file,
            sha256,
            klass,
        );

        const upload = await this.uploadRepository.create({
            workId: input.workId,
            storageProvider: this.storage.providerName,
            storagePath: storageKey,
            originalFilename: input.file.originalFilename,
            mimeType: input.file.mimeType,
            fileSize: input.file.size,
            sha256,
            extractionStatus: KbUploadExtractionStatus.RUNNING,
            extractionStartedAt: new Date(),
            uploadedById: input.userId,
            tags: input.tags ?? null,
        });

        await this.recordUploadActivity(
            input.workId,
            input.userId,
            ActivityActionType.KB_UPLOAD_CREATED,
            `Uploaded ${input.file.originalFilename}`,
            {
                uploadId: upload.id,
                originalFilename: input.file.originalFilename,
                mimeType: input.file.mimeType,
                fileSize: input.file.size,
                sha256,
            },
        );

        const document = await this.extractAndMaterialize(upload, input);
        return { upload, document };
    }

    /**
     * Re-run the extract+materialize step for a previously-failed or
     * previously-skipped upload. Owner / manager only. Returns the
     * (re-)created document or null if the upload's MIME still falls
     * into the "skipped — pending extractor routing" bucket.
     */
    async retryUploadExtraction(
        workId: string,
        uploadId: string,
        userId: string,
    ): Promise<{ upload: WorkKnowledgeUpload; document: WorkKnowledgeDocument | null }> {
        const access = await this.ownershipService.ensureCanEdit(workId, userId);
        if (access.role !== 'owner' && access.role !== 'manager') {
            throw new ForbiddenException('Retrying KB extraction requires manager+ role');
        }
        if (!this.storage) {
            throw new ServiceUnavailableException(
                'KB uploads require a storage plugin — not configured in this deployment',
            );
        }

        const upload = await this.uploadRepository.findById(workId, uploadId);
        if (!upload) {
            throw new NotFoundException(`KB upload not found: ${uploadId}`);
        }
        if (upload.extractedDocumentId) {
            throw new ConflictException(
                `Upload ${uploadId} already produced a KB document (${upload.extractedDocumentId})`,
            );
        }

        const fetched = await this.storage.getObject(upload.storagePath);

        const refreshed = await this.uploadRepository.update(upload.id, {
            extractionStatus: KbUploadExtractionStatus.RUNNING,
            extractionStartedAt: new Date(),
            extractionError: null,
        });
        const current = refreshed ?? upload;

        const document = await this.extractAndMaterialize(current, {
            workId,
            userId,
            file: {
                buffer: fetched.buffer,
                originalFilename: upload.originalFilename,
                mimeType: fetched.mimeType ?? upload.mimeType,
            },
            targetClass: undefined,
            tags: upload.tags ?? undefined,
            description: null,
            title: undefined,
        });
        return { upload: current, document };
    }

    /**
     * Pick a deterministic storage key under the `kb-originals/` prefix
     * (spec §8.2). Avoids storage backends that haven't implemented
     * `deriveKey` by hard-coding the `<class>/<sha256>.<ext>` layout
     * here — the platform owns the convention, not the plugin.
     */
    private async persistUploadToStorage(
        workId: string,
        userId: string,
        file: { buffer: Buffer; originalFilename: string; mimeType: string; size: number },
        sha256: string,
        klass: KbDocumentClass,
    ): Promise<string> {
        if (!this.storage) {
            throw new ServiceUnavailableException('KB storage plugin not configured');
        }
        const ext = this.fileExtension(file.originalFilename);
        const filename = `${sha256}${ext ? `.${ext}` : ''}`;
        const { key } = await this.storage.putObject({
            buffer: file.buffer,
            filename: `kb-originals/${klass}/${filename}`,
            mimeType: file.mimeType,
            size: file.size,
            ownerId: workId,
        });
        return key;
    }

    /**
     * Synchronous extract + materialize. Text-passthrough MIMEs only in
     * Phase 1B/b — PDF/DOCX/HTML extractor routing lands in Phase 1B/c.
     */
    private async extractAndMaterialize(
        upload: WorkKnowledgeUpload,
        input: {
            workId: string;
            userId: string;
            file: { buffer: Buffer; mimeType: string; originalFilename: string };
            targetClass?: KbDocumentClass;
            tags?: string[];
            description?: string | null;
            title?: string;
        },
    ): Promise<WorkKnowledgeDocument | null> {
        let body: string | null = null;
        let extractedVia: string | null = null;

        if (this.bufferExtractor) {
            try {
                const extracted = this.bufferExtractor.extract(
                    input.file.buffer,
                    input.file.mimeType,
                );
                if (extracted) {
                    body = extracted.markdown;
                    extractedVia = extracted.via;
                }
            } catch (error) {
                // The extractor selected a route but failed mid-extract
                // (e.g. malformed HTML). Mark the upload failed so the
                // operator sees the error in the row + activity log;
                // retry-extraction is the recovery path.
                const reason = (error as Error).message;
                await this.uploadRepository.update(upload.id, {
                    extractionStatus: KbUploadExtractionStatus.FAILED,
                    extractionFinishedAt: new Date(),
                    extractionError: reason,
                });
                await this.recordUploadActivity(
                    input.workId,
                    input.userId,
                    ActivityActionType.KB_UPLOAD_EXTRACTION_FAILED,
                    `Extraction failed for ${input.file.originalFilename}`,
                    {
                        uploadId: upload.id,
                        mimeType: input.file.mimeType,
                        error: reason,
                    },
                    ActivityStatus.FAILED,
                );
                throw error;
            }
        }

        // Built-in text passthrough is the fallback when the buffer
        // extractor service is not wired (unit tests, isolated deploys).
        if (body === null) {
            body = this.bodyForTextMimeType(input.file.buffer, input.file.mimeType);
            if (body !== null) {
                extractedVia = 'text-passthrough-fallback';
            }
        }

        if (body === null) {
            await this.uploadRepository.update(upload.id, {
                extractionStatus: KbUploadExtractionStatus.SKIPPED,
                extractionFinishedAt: new Date(),
                extractionError: `No extractor route for ${input.file.mimeType} yet (PDF/DOCX/XLSX/PPTX/Notion arrive in follow-up Phase 1B/c commits)`,
            });
            await this.recordUploadActivity(
                input.workId,
                input.userId,
                ActivityActionType.KB_UPLOAD_EXTRACTION_SKIPPED,
                `Extraction skipped for ${input.file.originalFilename}`,
                { uploadId: upload.id, mimeType: input.file.mimeType },
            );
            return null;
        }

        const klass = (input.targetClass ?? ('freeform' as KbDocumentClass)) as KbDocumentClass;
        const baseName = this.slugFromFilename(input.file.originalFilename);
        const slug = baseName || 'document';
        const path = `${klass}/${slug}.md`;
        const title = input.title?.trim() || this.humanizeFilename(input.file.originalFilename);

        try {
            const doc = await this.createDocument({
                workId: input.workId,
                userId: input.userId,
                path,
                title,
                class: klass,
                body,
                description: input.description ?? null,
                tags: input.tags,
                source: 'imported' as KbDocumentSource,
                sourceUploadId: upload.id,
            });

            const docRow = await this.documentRepository.findById(input.workId, doc.id);
            if (!docRow) {
                throw new NotFoundException(`KB document vanished mid-ingest: ${doc.id}`);
            }

            await this.uploadRepository.update(upload.id, {
                extractionStatus: KbUploadExtractionStatus.SUCCEEDED,
                extractionFinishedAt: new Date(),
                extractedDocumentId: docRow.id,
            });

            await this.recordUploadActivity(
                input.workId,
                input.userId,
                ActivityActionType.KB_UPLOAD_EXTRACTED,
                `Extracted ${input.file.originalFilename}`,
                {
                    uploadId: upload.id,
                    documentId: docRow.id,
                    extractedVia,
                    mimeType: input.file.mimeType,
                },
            );
            await this.recordUploadActivity(
                input.workId,
                input.userId,
                ActivityActionType.KB_DOCUMENT_CREATED,
                `Created KB document ${path}`,
                {
                    documentId: docRow.id,
                    path,
                    class: klass,
                    source: 'imported',
                },
            );
            return docRow;
        } catch (error) {
            const reason = (error as Error).message;
            await this.uploadRepository.update(upload.id, {
                extractionStatus: KbUploadExtractionStatus.FAILED,
                extractionFinishedAt: new Date(),
                extractionError: reason,
            });
            await this.recordUploadActivity(
                input.workId,
                input.userId,
                ActivityActionType.KB_UPLOAD_EXTRACTION_FAILED,
                `Extraction failed for ${input.file.originalFilename}`,
                { uploadId: upload.id, mimeType: input.file.mimeType, error: reason },
                ActivityStatus.FAILED,
            );
            throw error;
        }
    }

    /**
     * Returns the Markdown body for upload bytes whose MIME type the
     * platform passes through directly (text/markdown, text/plain,
     * text/x-markdown, application/x-markdown). Anything else returns
     * `null` and the caller marks the upload as skipped.
     *
     * Per spec §22 we hard-cap inline body extraction at 1 MiB — over
     * the cap, the bytes still live in storage but the row only carries
     * a truncation marker; full extraction comes in Phase 1B/c.
     */
    private bodyForTextMimeType(buffer: Buffer, mimeType: string): string | null {
        const TEXT_PASSTHROUGH = new Set([
            'text/markdown',
            'text/x-markdown',
            'application/x-markdown',
            'text/plain',
        ]);
        const normalized = mimeType.split(';')[0].trim().toLowerCase();
        if (!TEXT_PASSTHROUGH.has(normalized)) {
            return null;
        }
        const MAX_INLINE_BYTES = 1_048_576;
        if (buffer.length > MAX_INLINE_BYTES) {
            return (
                buffer.slice(0, MAX_INLINE_BYTES).toString('utf-8') +
                '\n\n<!-- truncated: original exceeded 1 MiB -->'
            );
        }
        return buffer.toString('utf-8');
    }

    private async recordUploadActivity(
        workId: string,
        userId: string,
        actionType: ActivityActionType,
        summary: string,
        details: Record<string, unknown>,
        status: ActivityStatus = ActivityStatus.COMPLETED,
    ): Promise<void> {
        if (!this.activityLog) {
            return;
        }
        try {
            await this.activityLog.log({
                userId,
                workId,
                actionType,
                action: actionType,
                status,
                summary,
                details: details as Record<string, unknown> as Record<string, any>,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record activity ${actionType} for work=${workId}: ${(error as Error).message}`,
            );
        }
    }

    private slugFromFilename(filename: string): string {
        const base = filename.replace(/\.[^.]+$/, '');
        return base
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 96);
    }

    private humanizeFilename(filename: string): string {
        return (
            filename
                .replace(/\.[^.]+$/, '')
                .replace(/[-_]+/g, ' ')
                .trim() || filename
        );
    }

    private fileExtension(filename: string): string {
        const idx = filename.lastIndexOf('.');
        if (idx <= 0 || idx === filename.length - 1) {
            return '';
        }
        return filename.slice(idx + 1).toLowerCase();
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    private slugFromPath(path: string): string {
        const last = path.split('/').pop() ?? path;
        return last.replace(/\.md$/i, '').toLowerCase();
    }

    private async resolvePathCollision(workId: string, path: string): Promise<string> {
        let candidate = path;
        let n = 2;
        while (await this.documentRepository.pathExists(workId, candidate)) {
            const dot = path.lastIndexOf('.');
            const stem = dot >= 0 ? path.slice(0, dot) : path;
            const ext = dot >= 0 ? path.slice(dot) : '';
            candidate = `${stem}-${n}${ext}`;
            n += 1;
            if (n > 100) {
                throw new BadRequestException(
                    `Too many path collisions for '${path}'; refusing to suffix further`,
                );
            }
        }
        return candidate;
    }

    private assertNotLockedFull(doc: WorkKnowledgeDocument): void {
        if (doc.locked && doc.lockMode === ('full' as KbLockMode)) {
            throw new ForbiddenException(
                `KB document is locked (mode=full); unlock before editing: ${doc.path}`,
            );
        }
    }

    private async ensureTagsExist(workId: string, slugs: string[]): Promise<void> {
        const uniq = [...new Set(slugs)];
        await Promise.all(uniq.map((slug) => this.tagRepository.upsertBySlug(workId, slug, slug)));
    }

    private countWords(body: string): number {
        if (!body) return 0;
        return body.split(/\s+/).filter(Boolean).length;
    }

    /**
     * Cheap heuristic — ~1 token per 4 chars, English-biased. The
     * authoritative token count for budget enforcement comes from the
     * configured embedding provider (Phase 2).
     */
    private estimateTokens(body: string): number {
        if (!body) return 0;
        return Math.ceil(body.length / 4);
    }

    private toDto(doc: WorkKnowledgeDocument): KbDocumentDto {
        return {
            id: doc.id,
            workId: doc.workId ?? null,
            organizationId: doc.organizationId ?? null,
            path: doc.path,
            slug: doc.slug,
            title: doc.title,
            description: doc.description ?? null,
            class: doc.kbDocumentClass as KbDocumentClassContract,
            tags: doc.tags ?? [],
            categories: doc.categories ?? [],
            status: doc.status,
            locked: doc.locked,
            lockMode: (doc.lockMode ?? null) as KbDocumentDto['lockMode'],
            language: doc.language,
            wordCount: doc.wordCount ?? null,
            tokenCount: doc.tokenCount ?? null,
            source: doc.source,
            sourceUploadId: doc.sourceUploadId ?? null,
            sourceUrl: doc.sourceUrl ?? null,
            generatedByAgentRunId: doc.generatedByAgentRunId ?? null,
            createdById: doc.createdById ?? null,
            updatedById: doc.updatedById ?? null,
            createdAt: doc.createdAt.toISOString(),
            updatedAt: doc.updatedAt.toISOString(),
            lastCommitSha: doc.lastCommitSha ?? null,
            lastIndexedAt: doc.lastIndexedAt ? doc.lastIndexedAt.toISOString() : null,
        };
    }

    private toBodyDto(doc: WorkKnowledgeDocument): KbDocumentBodyDto {
        const meta = (doc.metadata ?? {}) as { body?: string };
        return {
            ...this.toDto(doc),
            body: meta.body ?? '',
            assets: [],
        };
    }
}

function toTagDto(tag: WorkKnowledgeTag): KbTagDto {
    return {
        id: tag.id,
        workId: tag.workId,
        slug: tag.slug,
        name: tag.name,
        color: tag.color ?? null,
        description: tag.description ?? null,
        createdAt: tag.createdAt.toISOString(),
        updatedAt: tag.updatedAt.toISOString(),
    };
}
