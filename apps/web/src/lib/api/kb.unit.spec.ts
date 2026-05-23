import { describe, expect, it, vi, beforeEach } from 'vitest';

// `kb.ts` imports `next/headers`, `getAuthAccessCookie` (cookies()), and
// the API URL constants. Mock the whole `server-api` module so the
// helpers run as pure URL-construction code. The mocks must be defined
// inside `vi.hoisted` so they're available before vitest hoists the
// `vi.mock` factory to the top of the file.
const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));
vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
}));

import { kbAPI } from './kb';

describe('kbAPI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        serverFetchMock.mockResolvedValue([]);
    });

    describe('listInheritableDocuments (row 38b)', () => {
        it('returns [] without fetching when orgId is null', async () => {
            const result = await kbAPI.listInheritableDocuments('work-1', null);
            expect(result).toEqual([]);
            expect(serverFetchMock).not.toHaveBeenCalled();
        });

        it('returns [] without fetching when orgId is undefined', async () => {
            const result = await kbAPI.listInheritableDocuments('work-1', undefined);
            expect(result).toEqual([]);
            expect(serverFetchMock).not.toHaveBeenCalled();
        });

        it('returns [] without fetching when orgId is an empty string', async () => {
            // Saves a round-trip for Works whose row-37c `organizationId`
            // column hasn't been populated yet.
            const result = await kbAPI.listInheritableDocuments('work-1', '');
            expect(result).toEqual([]);
            expect(serverFetchMock).not.toHaveBeenCalled();
        });

        it('calls /works/:id/kb/inheritable?orgId=<uuid> when orgId is set', async () => {
            const sample = [
                {
                    id: 'org-doc-1',
                    workId: null,
                    organizationId: 'org-uuid-1',
                    path: 'legal/privacy.md',
                    slug: 'privacy',
                    class: 'legal',
                    title: 'Privacy',
                } as unknown,
            ];
            serverFetchMock.mockResolvedValueOnce(sample);

            const result = await kbAPI.listInheritableDocuments('work-1', 'org-uuid-1');

            expect(result).toEqual(sample);
            expect(serverFetchMock).toHaveBeenCalledTimes(1);
            expect(serverFetchMock).toHaveBeenCalledWith(
                '/works/work-1/kb/inheritable?orgId=org-uuid-1',
            );
        });

        it('URL-encodes the orgId so reserved characters survive the query string', async () => {
            // Defensive: org ids are server-issued UUIDs today, but the
            // wire format is `string` — if an alphanumeric+dash convention
            // ever changes, this guard keeps us correct.
            await kbAPI.listInheritableDocuments('work-1', 'org with spaces & symbols');
            expect(serverFetchMock).toHaveBeenCalledWith(
                '/works/work-1/kb/inheritable?orgId=org%20with%20spaces%20%26%20symbols',
            );
        });

        it('returns the raw array from the controller (no envelope unwrap)', async () => {
            // The `apps/api/src/works/org-kb.controller.ts` `resolveInheritable`
            // route returns `KbDocumentDto[]` directly — no `{ data: ... }` wrapper.
            const rows = [{ id: 'a' }, { id: 'b' }] as unknown[];
            serverFetchMock.mockResolvedValueOnce(rows);
            const result = await kbAPI.listInheritableDocuments('work-1', 'org-1');
            expect(result).toBe(rows);
        });
    });
});
