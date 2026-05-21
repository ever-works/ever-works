import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { WorkOwnershipService } from './work-ownership.service';
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
import type {
    CitationDto,
    KbDocumentBodyDto,
    KbDocumentClass as KbDocumentClassContract,
    KbDocumentDto,
    KbTagDto,
} from '@ever-works/contracts';

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
    ) {}

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
     * Phase 1A stub. The Git integration that surfaces prior commits
     * lands alongside the Storage plugin bridge in Phase 1B; this
     * endpoint exists in the API surface so the contract is fixed but
     * returns a 501-like error until the Git side is ready.
     */
    async restoreDocumentFromHistory(): Promise<KbDocumentBodyDto> {
        throw new BadRequestException(
            'restore-from-history is not yet available — Git integration lands in Phase 1B (EW-641)',
        );
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
