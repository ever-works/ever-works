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

// Security (EW-718): the action's error mapper branches on `ApiResponseError`,
// so the spec provides a matching stand-in (the real one is `server-only`).
// Shape mirrors `lib/api/server-api.ts` (message + statusCode + optional
// code/details). Defined inside the factory because `vi.mock` is hoisted
// above top-level declarations — other sibling specs mock it the same way.
vi.mock('@/lib/api/server-api', () => ({
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
            public readonly details?: Record<string, unknown>,
        ) {
            super(message);
            this.name = 'ApiResponseError';
        }
    },
}));

import { overrideInheritedKbDocumentAction } from './kb-document';
// The pure error mapper lives in its own module (a `'use server'` file may
// only export async actions), so import it directly for unit testing.
import { toSafeActionError } from './kb-document-error';
// Pull the mocked class back out so the tests can construct instances that
// pass the `instanceof ApiResponseError` check inside `toSafeActionError`.
import { ApiResponseError } from '@/lib/api/server-api';

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
        // Security (EW-718): a plain Error is NOT an ApiResponseError, so its
        // raw message must NOT reach the client — the generic fallback is used.
        getInheritedDocumentMock.mockRejectedValueOnce(new Error('inherited 404 at /var/lib/db'));

        const result = await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/missing.md',
        });

        expect(result).toEqual({ success: false, error: 'Failed to override inherited document' });
        expect(createDocumentMock).not.toHaveBeenCalled();
        expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it('returns failure envelope when create throws (e.g. path collision)', async () => {
        getInheritedDocumentMock.mockResolvedValueOnce(INHERITED_DOC);
        // Security (EW-718): an ApiResponseError 409 maps to a curated,
        // business-safe collision message — not the raw backend string.
        createDocumentMock.mockRejectedValueOnce(
            new ApiResponseError('Internal: path already exists in shard pg-7', 409),
        );

        const result = await overrideInheritedKbDocumentAction({
            workId: 'work-1',
            orgId: 'org-uuid-1',
            idOrPath: 'legal/privacy.md',
        });

        expect(result).toEqual({
            success: false,
            error: 'A document already exists at this location.',
        });
        expect(result).not.toMatchObject({ error: expect.stringContaining('shard') });
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

describe('toSafeActionError (EW-718 info-leak guard)', () => {
    const RAW = 'Internal: connection to postgres://kb_user@10.0.3.4:5432 refused';
    const FALLBACK = 'Failed to save document';

    it('maps 5xx ApiResponseError to a generic message and NEVER echoes the raw string', () => {
        for (const status of [500, 502, 503, 504]) {
            const msg = toSafeActionError(new ApiResponseError(RAW, status), FALLBACK);
            expect(msg).toBe('Something went wrong, please try again.');
            expect(msg).not.toContain('postgres');
            expect(msg).not.toContain('10.0.3.4');
        }
    });

    it('maps unknown / unhandled 4xx codes to a generic "Request failed." (no raw leak)', () => {
        const msg = toSafeActionError(new ApiResponseError(RAW, 418), FALLBACK);
        expect(msg).toBe('Request failed.');
        expect(msg).not.toContain('postgres');
    });

    it('does NOT echo raw message for a plain Error — returns the action fallback', () => {
        const msg = toSafeActionError(new Error(RAW), FALLBACK);
        expect(msg).toBe(FALLBACK);
        expect(msg).not.toContain('postgres');
    });

    it('does NOT echo raw value for a non-Error throw — returns the action fallback', () => {
        expect(toSafeActionError('boom: /etc/passwd', FALLBACK)).toBe(FALLBACK);
        expect(toSafeActionError(null, FALLBACK)).toBe(FALLBACK);
        expect(toSafeActionError({ stack: 'secret' }, FALLBACK)).toBe(FALLBACK);
    });

    it('returns curated business-safe messages for the well-known 4xx codes (legit path)', () => {
        // These are intentionally hard-coded strings, NOT the raw backend
        // message — so a known 4xx still gives the user actionable copy.
        expect(toSafeActionError(new ApiResponseError(RAW, 401), FALLBACK)).toBe(
            'You must be signed in to do that.',
        );
        expect(toSafeActionError(new ApiResponseError(RAW, 403), FALLBACK)).toBe(
            'You do not have permission to do that.',
        );
        expect(toSafeActionError(new ApiResponseError(RAW, 404), FALLBACK)).toBe(
            'The requested document was not found.',
        );
        expect(toSafeActionError(new ApiResponseError(RAW, 409), FALLBACK)).toBe(
            'A document already exists at this location.',
        );
        expect(toSafeActionError(new ApiResponseError(RAW, 400), FALLBACK)).toBe(
            'Invalid request. Please check your input and try again.',
        );
        // None of the curated 4xx messages contain the raw backend detail.
        for (const status of [401, 403, 404, 409, 400]) {
            expect(toSafeActionError(new ApiResponseError(RAW, status), FALLBACK)).not.toContain(
                'postgres',
            );
        }
    });
});
