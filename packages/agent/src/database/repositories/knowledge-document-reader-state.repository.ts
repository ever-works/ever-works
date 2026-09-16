import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { KnowledgeDocumentReaderState } from '../../entities/knowledge-document-reader-state.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentStatus } from '../../entities/kb-types';

/** The documents a rollup is computed over: the library's scope. */
export interface ReaderStateScope {
    workIds: string[];
    organizationId?: string;
}

/** One folder's rollup: does anything in it read as unread for the person? */
export interface ReaderStateFolderRollup {
    /** `null` = the Unfiled group. */
    folderId: string | null;
    hasUnread: boolean;
    unreadCount: number;
}

/**
 * Knowledge library — persistence for per-person read state and pins.
 *
 * Every read and write is keyed by `userId`: nothing here can see or change
 * another person's row. Rows are written lazily — the first read or pin
 * creates one — so an absent row means "never opened".
 *
 * Writes are find-then-save with one retry on the `(userId, documentId)`
 * unique index, which works identically on Postgres and better-sqlite3
 * (a driver-specific `ON CONFLICT` upsert would not preserve
 * `lastOpenedAt` on both). A read on an existing row is applied with
 * conditional UPDATEs instead (see {@link upsertRead}), so the monotonic
 * read revision holds under concurrent reads.
 */
@Injectable()
export class KnowledgeDocumentReaderStateRepository {
    constructor(
        @InjectRepository(KnowledgeDocumentReaderState)
        private readonly repo: Repository<KnowledgeDocumentReaderState>,
    ) {}

    /** The person's rows for the given documents (absent = never opened). */
    async findForUser(
        userId: string,
        documentIds: string[],
    ): Promise<KnowledgeDocumentReaderState[]> {
        if (documentIds.length === 0) return [];
        return this.repo.find({ where: { userId, documentId: In(documentIds) } });
    }

    /**
     * Record that the person read `revision` of the document. `lastOpenedAt`
     * is set once, the first time; `lastReadRevision` never moves backwards,
     * so a stale read (made against an older revision) cannot un-read a
     * newer one.
     *
     * On an existing row both columns move through conditional UPDATEs the
     * database evaluates against the row as it is at write time
     * (`lastReadRevision < :revision`, `lastOpenedAt IS NULL`), never through
     * a value read earlier in this call — so two reads racing on the same
     * row always leave the higher revision, whichever commits last.
     */
    async upsertRead(
        userId: string,
        documentId: string,
        revision: number,
        now: Date = new Date(),
    ): Promise<KnowledgeDocumentReaderState> {
        return this.writeAtomically(
            userId,
            documentId,
            (row) => {
                row.lastOpenedAt = now;
                row.lastReadRevision = Math.max(revision, 0);
            },
            async () => {
                await this.repo.update(
                    { userId, documentId, lastOpenedAt: IsNull() },
                    { lastOpenedAt: now },
                );
                await this.repo.update(
                    { userId, documentId, lastReadRevision: LessThan(revision) },
                    { lastReadRevision: revision },
                );
            },
        );
    }

    /**
     * Mark a document unread for the person: `lastReadRevision = 0` while
     * `lastOpenedAt` is kept (or set), so it reads as UPDATED, never NEW.
     *
     * Deliberately unconditional on the read revision. On an existing row
     * it writes only the columns it owns, so it can never put back a pin (or
     * an un-pin) that a concurrent write changed meanwhile.
     */
    async markUnread(
        userId: string,
        documentId: string,
        now: Date = new Date(),
    ): Promise<KnowledgeDocumentReaderState> {
        return this.writeAtomically(
            userId,
            documentId,
            (row) => {
                row.lastOpenedAt = now;
                row.lastReadRevision = 0;
            },
            async () => {
                await this.repo.update(
                    { userId, documentId, lastOpenedAt: IsNull() },
                    { lastOpenedAt: now },
                );
                await this.repo.update({ userId, documentId }, { lastReadRevision: 0 });
            },
        );
    }

    /**
     * Pin a document for the person; an already-pinned document keeps its
     * original `pinnedAt`. Writes only `pinnedAt` on an existing row, so a
     * pin can never move the read revision.
     */
    async upsertPin(
        userId: string,
        documentId: string,
        pinnedAt: Date = new Date(),
    ): Promise<KnowledgeDocumentReaderState> {
        return this.writeAtomically(
            userId,
            documentId,
            (row) => {
                row.pinnedAt = pinnedAt;
            },
            async () => {
                await this.repo.update({ userId, documentId, pinnedAt: IsNull() }, { pinnedAt });
            },
        );
    }

    async deletePin(userId: string, documentId: string): Promise<void> {
        await this.repo.update({ userId, documentId }, { pinnedAt: null });
    }

    async countPins(userId: string): Promise<number> {
        return this.repo.count({ where: { userId, pinnedAt: Not(IsNull()) } });
    }

    /** Mark many documents read at their given revisions, for one person. */
    async bulkMarkRead(
        userId: string,
        entries: Array<{ documentId: string; revision: number }>,
        now: Date = new Date(),
    ): Promise<void> {
        for (const entry of entries) {
            await this.upsertRead(userId, entry.documentId, entry.revision, now);
        }
    }

    /**
     * Per-folder unread rollups for one person, in ONE grouped query: every
     * non-archived document in scope, left-joined to the person's row, is
     * unread when there is no row (NEW) or its read revision is behind the
     * document's (UPDATED). Folder subtrees are folded by the caller from
     * these direct-folder rows.
     */
    async rollupsForUser(
        userId: string,
        scope: ReaderStateScope,
    ): Promise<ReaderStateFolderRollup[]> {
        const hasWorkIds = scope.workIds.length > 0;
        if (!hasWorkIds && !scope.organizationId) return [];

        const unread =
            'CASE WHEN rs.id IS NULL OR rs.lastReadRevision < doc.revision THEN 1 ELSE 0 END';
        const rows = await this.repo.manager
            .createQueryBuilder(WorkKnowledgeDocument, 'doc')
            .leftJoin(
                KnowledgeDocumentReaderState,
                'rs',
                'rs.documentId = doc.id AND rs.userId = :userId',
                { userId },
            )
            .select('doc.folderId', 'folderId')
            .addSelect(`SUM(${unread})`, 'unreadCount')
            .where(
                new Brackets((w) => {
                    if (hasWorkIds) {
                        w.orWhere('doc.workId IN (:...rollupWorkIds)', {
                            rollupWorkIds: scope.workIds,
                        });
                    }
                    if (scope.organizationId) {
                        w.orWhere('(doc.organizationId = :rollupOrgId AND doc.workId IS NULL)', {
                            rollupOrgId: scope.organizationId,
                        });
                    }
                }),
            )
            .andWhere('doc.status != :archived', { archived: KbDocumentStatus.ARCHIVED })
            .groupBy('doc.folderId')
            .getRawMany<{ folderId: string | null; unreadCount: string | number | null }>();

        return rows.map((row) => {
            const unreadCount = Number(row.unreadCount ?? 0);
            return { folderId: row.folderId ?? null, hasUnread: unreadCount > 0, unreadCount };
        });
    }

    /**
     * Insert the person's first row, or — when a row already exists (or a
     * concurrent first write just created one) — apply `update`, a set of
     * conditional UPDATEs that never write back a value read before them.
     * Returns the row as the database holds it afterwards.
     */
    private async writeAtomically(
        userId: string,
        documentId: string,
        initialize: (row: KnowledgeDocumentReaderState) => void,
        update: () => Promise<void>,
    ): Promise<KnowledgeDocumentReaderState> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const existing = await this.repo.findOne({ where: { userId, documentId } });
            if (!existing) {
                const row = this.repo.create({ userId, documentId, lastReadRevision: 0 });
                initialize(row);
                try {
                    return await this.repo.save(row);
                } catch (error) {
                    // A concurrent first write won the unique index; re-read
                    // and apply the update to the row that now exists.
                    if (attempt > 0) throw error;
                    continue;
                }
            }
            await update();
            return (await this.repo.findOne({ where: { userId, documentId } })) ?? existing;
        }
        throw new Error('unreachable');
    }
}
