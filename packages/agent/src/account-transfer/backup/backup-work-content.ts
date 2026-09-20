import { Injectable } from '@nestjs/common';
import { AccountExportService } from '../account-export.service';

/**
 * Workspace backup (AW-22) — the Work content port.
 *
 * A complete archive has to contain each Work's actual content — its items,
 * categories, tags, collections and comparisons — and not merely the database
 * rows that describe the Work. That content does not live in our database at
 * all: it lives in the Work's own data repository, and the only correct way to
 * read it is the clone-or-pull walk the account export has performed since it
 * shipped.
 *
 * So this is a PORT, not a second reader. `AccountExportWorkContentSource`
 * below is a delegation to `AccountExportService.readWorkRepoContent`, which
 * is itself a delegation to the private walk the existing
 * `GET /api/account/export` uses. One clone, one `DataRepository`, one
 * failure policy, two callers (Constitution III).
 *
 * The runner depends on this interface rather than on `AccountExportService`
 * so a backup can be unit-tested without git, a clone or a network, and so a
 * deployment that has no data repos at all simply leaves the token unbound and
 * gets Work rows without content rather than a failed archive.
 */

/** One Work whose content the archive wants. */
export interface BackupWorkRef {
    readonly id: string;
    readonly slug: string;
}

/**
 * One Work's content, flattened into the row groups the archive writes.
 *
 * Every group is an array of plain rows so the runner can stream each one into
 * its own `*.jsonl` entry without knowing what a Work item is.
 */
export interface BackupWorkContent {
    readonly items: Record<string, unknown>[];
    readonly categories: Record<string, unknown>[];
    readonly tags: Record<string, unknown>[];
    readonly collections: Record<string, unknown>[];
    readonly comparisons: Record<string, unknown>[];
    readonly siteConfig?: Record<string, unknown>;
    readonly markdownTemplate?: Record<string, unknown>;
}

/** Where a Work's content comes from. */
export interface BackupWorkContentSource {
    /**
     * Read one Work's content.
     *
     * Resolves with empty groups rather than rejecting when the REPO cannot
     * be reached: a Work whose data repo is gone must not cost the archive
     * its other fourteen domains, and the manifest records the shortfall.
     *
     * Rejects when the Work itself cannot be resolved, which is a different
     * thing and has to look different: "this Work has nothing" and "we could
     * not read this Work" must not both come back as five empty arrays, or
     * the manifest reports a complete domain over content it never saw.
     */
    readWorkContent(work: BackupWorkRef): Promise<BackupWorkContent>;
}

/** DI token for {@link BackupWorkContentSource}. Optional everywhere it is injected. */
export const BACKUP_WORK_CONTENT = Symbol('BACKUP_WORK_CONTENT');

/** The empty answer, used when no source is bound and when a repo will not read. */
export const EMPTY_BACKUP_WORK_CONTENT: BackupWorkContent = Object.freeze({
    items: [],
    categories: [],
    tags: [],
    collections: [],
    comparisons: [],
});

/**
 * The one implementation: the account export's own walk.
 *
 * Bound in `AccountTransferModule`, where `AccountExportService` already
 * lives, so no new module dependency is created in either direction.
 */
@Injectable()
export class AccountExportWorkContentSource implements BackupWorkContentSource {
    constructor(private readonly exportService: AccountExportService) {}

    async readWorkContent(work: BackupWorkRef): Promise<BackupWorkContent> {
        // By ID, not by ref. The export's walk resolves a Work's repository
        // coordinates through `Work.getRepoOwner()` / `Work.getDataRepo()`,
        // instance methods on the entity prototype — and a backup ref is a
        // plain `{ id, slug }` literal built from a raw row, which has
        // neither. Handing the ref straight over threw a `TypeError` inside
        // the walk's own try/catch, which logged and returned EMPTY content,
        // so every archive wrote five zero-line files per Work and called
        // the domain complete.
        const content = await this.exportService.readWorkRepoContentById(work.id);
        if (!content) {
            // A Work the archive was told about and cannot load is a gap,
            // not an empty Work. Rejecting is what makes `addWorkContent`
            // mark the domain `partial` with `work_content_unavailable`
            // instead of writing empty files and reporting success.
            throw new Error(`No Work found for backup content ref ${work.id}`);
        }
        return {
            items: asRows(content.items),
            categories: asRows(content.categories),
            tags: asRows(content.tags),
            collections: asRows(content.collections),
            comparisons: asRows(content.comparisons),
            ...(content.siteConfig ? { siteConfig: { ...content.siteConfig } } : {}),
            ...(content.markdownTemplate
                ? { markdownTemplate: { ...content.markdownTemplate } }
                : {}),
        };
    }
}

function asRows(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}
