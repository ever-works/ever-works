import type { KbLibraryDocumentDto } from '@/lib/api/knowledge-library-types';
import type { LibraryDocumentState } from './use-library-document';

/** A curation control on a document outside the Library view. */
export type ShelfControl = 'file' | 'export' | 'archive' | 'restore';

/** The copy keys a disabled shelf control can explain itself with. */
export type ShelfBlockKey =
    | 'needsOrganization'
    | 'loading'
    | 'noEditAccessFile'
    | 'noEditAccessArchive'
    | 'noEditAccessRestore';

/**
 * Why a shelf control is disabled (an i18n key under
 * `dashboard.memoryPage.library`), or `null` when it is usable.
 *
 * File and Export need the Organization's library row; Archive and Restore
 * use the Work's own endpoints and are only blocked when the row says the
 * person cannot edit — the API still enforces access either way.
 */
export function shelfBlockReason(
    control: ShelfControl,
    state: LibraryDocumentState,
    row: KbLibraryDocumentDto | null,
): ShelfBlockKey | null {
    if (control === 'file' || control === 'export') {
        if (state === 'unavailable') return 'needsOrganization';
        if (state !== 'ready' || !row) return 'loading';
    }
    if (state === 'ready' && row && !row.canEdit) {
        if (control === 'file') return 'noEditAccessFile';
        if (control === 'archive') return 'noEditAccessArchive';
        if (control === 'restore') return 'noEditAccessRestore';
    }
    return null;
}
