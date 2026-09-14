import { describe, expect, it } from 'vitest';
import type { KbLibraryDocumentDto } from '@/lib/api/knowledge-library-types';
import { shelfBlockReason } from './shelf-block-reason';

const row = (canEdit: boolean) => ({ id: 'doc-1', canEdit }) as unknown as KbLibraryDocumentDto;

describe('shelfBlockReason', () => {
    it('blocks File and Export outside an Organization, but never Archive or Restore', () => {
        expect(shelfBlockReason('file', 'unavailable', null)).toBe('needsOrganization');
        expect(shelfBlockReason('export', 'unavailable', null)).toBe('needsOrganization');
        expect(shelfBlockReason('archive', 'unavailable', null)).toBeNull();
        expect(shelfBlockReason('restore', 'unavailable', null)).toBeNull();
    });

    it('holds File and Export while the library row loads', () => {
        expect(shelfBlockReason('file', 'loading', null)).toBe('loading');
        expect(shelfBlockReason('export', 'idle', null)).toBe('loading');
        expect(shelfBlockReason('archive', 'loading', null)).toBeNull();
    });

    it('explains every edit control to a view-only member, and lets them export', () => {
        expect(shelfBlockReason('file', 'ready', row(false))).toBe('noEditAccessFile');
        expect(shelfBlockReason('archive', 'ready', row(false))).toBe('noEditAccessArchive');
        expect(shelfBlockReason('restore', 'ready', row(false))).toBe('noEditAccessRestore');
        expect(shelfBlockReason('export', 'ready', row(false))).toBeNull();
    });

    it('blocks nothing for an editor', () => {
        for (const control of ['file', 'export', 'archive', 'restore'] as const) {
            expect(shelfBlockReason(control, 'ready', row(true))).toBeNull();
        }
    });
});
