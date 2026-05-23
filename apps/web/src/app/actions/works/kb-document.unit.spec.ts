import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the server-only kbAPI helpers + the next/cache revalidator so
// the server action runs as a pure unit. Mocks live in `vi.hoisted`
// so they're available before vitest hoists the `vi.mock` factories.
const { getInheritedDocumentMock, createDocumentMock, revalidatePathMock } = vi.hoisted(() => ({
    getInheritedDocumentMock: vi.fn(),
    createDocumentMock: vi.fn(),
    revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/api/kb', () => ({
    kbAPI: {
        getInheritedDocument: getInheritedDocumentMock,
        createDocument: createDocumentMock,
    },
}));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));

import { overrideInheritedKbDocumentAction } from './kb-document';

const INHERITED_DOC = {
    id: 'org-doc-1',
    workId: null,
    organizationId: 'org-uuid-1',
    path: 'legal/privacy.md',
    slug: 'privacy',
    title: 'Privacy',
    description: 'Org privacy boilerplate',
    class: 'legal',
    tags: ['gdpr', 'compliance'],
    categories: ['policies'],
    status: 'active',
    locked: false,
    lockMode: null,
    language: 'fr',
    body: '# Privacy\n\nOrg-owned verbatim text.',
    assets: [],
} as unknown;

describe('overrideInheritedKbDocumentAction (row 38d)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('forks the inherited doc into a Work-scope row with the org doc payload', async () => {
        getInheritedDocumentMock.mockResolvedValueOnce(INHERITED_DOC);
        createDocumentMock.mockResolvedValueOnce({
            id: 'work-doc-99',
            path: 'legal/privacy.md',
            class: 'legal',
        });

        const result = await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/privacy.md',
        });

        expect(getInheritedDocumentMock).toHaveBeenCalledWith(
            'work-1',
            'org-uuid-1',
            'legal/privacy.md',
        );
        expect(createDocumentMock).toHaveBeenCalledTimes(1);
        const payload = createDocumentMock.mock.calls[0] as unknown[];
        expect(payload[0]).toBe('work-1');
        expect(payload[1]).toMatchObject({
            path: 'legal/privacy.md',
            title: 'Privacy',
            class: 'legal',
            body: '# Privacy\n\nOrg-owned verbatim text.',
            description: 'Org privacy boilerplate',
            tags: ['gdpr', 'compliance'],
            categories: ['policies'],
            language: 'fr',
        });

        expect(result).toEqual({
            success: true,
            data: { id: 'work-doc-99', path: 'legal/privacy.md' },
        });

        // Cache invalidation hits both the KB index and the new doc detail.
        expect(revalidatePathMock).toHaveBeenCalledWith('/works/work-1/kb');
        expect(revalidatePathMock).toHaveBeenCalledWith('/works/work-1/kb/legal/privacy.md');
    });

    it('falls back to the path when the org doc has no title', async () => {
        getInheritedDocumentMock.mockResolvedValueOnce({
            ...(INHERITED_DOC as Record<string, unknown>),
            title: '',
        });
        createDocumentMock.mockResolvedValueOnce({
            id: 'work-doc-100',
            path: 'legal/privacy.md',
        });

        await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/privacy.md',
        });

        expect(createDocumentMock.mock.calls[0][1].title).toBe('legal/privacy.md');
    });

    it('handles null body / description / tags / categories gracefully', async () => {
        getInheritedDocumentMock.mockResolvedValueOnce({
            ...(INHERITED_DOC as Record<string, unknown>),
            body: null,
            description: null,
            tags: null,
            categories: null,
            language: '',
        });
        createDocumentMock.mockResolvedValueOnce({
            id: 'work-doc-101',
            path: 'legal/privacy.md',
        });

        await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/privacy.md',
        });

        const payload = createDocumentMock.mock.calls[0][1] as Record<string, unknown>;
        expect(payload.body).toBe('');
        expect(payload.description).toBeNull();
        // Null tags/categories become `undefined` so the API uses its
        // own defaults rather than persisting an explicit empty array.
        expect(payload.tags).toBeUndefined();
        expect(payload.categories).toBeUndefined();
        // Empty/falsy language falls back to 'en' to keep the new row
        // queryable by the existing language filter.
        expect(payload.language).toBe('en');
    });

    it('returns failure envelope and skips create + revalidate when fetch throws', async () => {
        getInheritedDocumentMock.mockRejectedValueOnce(new Error('inherited 404'));

        const result = await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/missing.md',
        });

        expect(result).toEqual({ success: false, error: 'inherited 404' });
        expect(createDocumentMock).not.toHaveBeenCalled();
        expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it('returns failure envelope when create throws (e.g. path collision)', async () => {
        getInheritedDocumentMock.mockResolvedValueOnce(INHERITED_DOC);
        createDocumentMock.mockRejectedValueOnce(new Error('path already exists'));

        const result = await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/privacy.md',
        });

        expect(result).toEqual({ success: false, error: 'path already exists' });
        expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it('uses a generic message when the thrown value is not an Error', async () => {
        getInheritedDocumentMock.mockRejectedValueOnce('some opaque rejection');

        const result = await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/privacy.md',
        });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBe('Failed to override inherited document');
        }
    });
});
