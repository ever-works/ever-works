import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { browserApiFetchMock } = vi.hoisted(() => ({ browserApiFetchMock: vi.fn() }));
vi.mock('@/lib/api/browser-api', () => ({ browserApiFetch: browserApiFetchMock }));

import {
    LibraryRequestError,
    filenameFromDisposition,
    folderErrorKey,
    knowledgeLibraryClient,
} from './library-client';

function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('knowledgeLibraryClient', () => {
    beforeEach(() => browserApiFetchMock.mockReset());

    it('goes through the scoped browser transport, never a bare fetch', async () => {
        browserApiFetchMock.mockResolvedValue(
            json(200, { documents: [], nextCursor: null, total: 0, unreadCount: 0 }),
        );

        await knowledgeLibraryClient.list({ folderId: 'unfiled' });

        const [url, init] = browserApiFetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/knowledge/library?folderId=unfiled');
        expect(init.cache).toBe('no-store');
    });

    it('files with a JSON body of ids and the folder', async () => {
        browserApiFetchMock.mockResolvedValue(json(200, { filed: 2, folderId: 'f1' }));

        await expect(knowledgeLibraryClient.file(['a', 'b'], 'f1')).resolves.toEqual({
            filed: 2,
            folderId: 'f1',
        });

        const [url, init] = browserApiFetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/knowledge/documents/file');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(String(init.body))).toEqual({ documentIds: ['a', 'b'], folderId: 'f1' });
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('creates a shared folder with the organization scope, omitting a top-level parent', async () => {
        browserApiFetchMock.mockImplementation(async () =>
            json(201, { id: 'f1', name: 'X', path: '/X' }),
        );

        await knowledgeLibraryClient.createFolder('X', null);
        await knowledgeLibraryClient.createFolder('Y', 'f1');

        const bodies = browserApiFetchMock.mock.calls.map(([, init]) =>
            JSON.parse(String((init as RequestInit).body)),
        );
        expect(bodies).toEqual([
            { name: 'X', scope: 'organization' },
            { name: 'Y', scope: 'organization', parentId: 'f1' },
        ]);
    });

    it('renames and deletes a shared folder through the scope-marked folder route', async () => {
        browserApiFetchMock.mockImplementation(async () => json(200, {}));

        await knowledgeLibraryClient.renameFolder('f1', 'Runbooks');
        await knowledgeLibraryClient.deleteFolder('f1');

        expect(browserApiFetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
            ['/api/memory/files/folders/f1?scope=organization', 'PATCH'],
            ['/api/memory/files/folders/f1?scope=organization', 'DELETE'],
        ]);
    });

    it('turns an error response into a LibraryRequestError with the API code', async () => {
        browserApiFetchMock.mockResolvedValue(
            json(422, { status: 'error', code: 'FolderDepthLimit', message: 'Too deep' }),
        );

        const error = await knowledgeLibraryClient.createFolder('X', 'f5').catch((e) => e);

        expect(error).toBeInstanceOf(LibraryRequestError);
        expect(error).toMatchObject({ status: 422, code: 'FolderDepthLimit', message: 'Too deep' });
    });

    it('keeps a status-only message for a non-JSON error body', async () => {
        browserApiFetchMock.mockResolvedValue(new Response('gateway down', { status: 502 }));

        const error = await knowledgeLibraryClient.tree().catch((e) => e);

        expect(error).toMatchObject({ status: 502, code: null, message: 'HTTP 502' });
    });

    describe('exportMarkdown', () => {
        let click: ReturnType<typeof vi.fn<(this: HTMLAnchorElement) => void>>;

        beforeEach(() => {
            click = vi.fn<(this: HTMLAnchorElement) => void>();
            vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
                this: HTMLAnchorElement,
            ) {
                click.call(this);
            });
            URL.createObjectURL = vi.fn(() => 'blob:x');
            URL.revokeObjectURL = vi.fn();
        });

        afterEach(() => vi.restoreAllMocks());

        it('downloads under the filename the API chose', async () => {
            browserApiFetchMock.mockResolvedValue(
                new Response('# Voice', {
                    status: 200,
                    headers: { 'content-disposition': 'attachment; filename="voice.md"' },
                }),
            );
            let downloaded = '';
            click.mockImplementation(function (this: HTMLAnchorElement) {
                downloaded = this.download;
            });

            await knowledgeLibraryClient.exportMarkdown('doc-1', 'fallback.md');

            expect(browserApiFetchMock.mock.calls[0][0]).toBe(
                '/api/knowledge/documents/doc-1/export?format=md',
            );
            expect(click).toHaveBeenCalledTimes(1);
            expect(downloaded).toBe('voice.md');
        });

        it('throws on a failed export and starts no download', async () => {
            browserApiFetchMock.mockResolvedValue(json(404, { message: 'Document not found' }));

            await expect(knowledgeLibraryClient.exportMarkdown('doc-1')).rejects.toBeInstanceOf(
                LibraryRequestError,
            );
            expect(click).not.toHaveBeenCalled();
        });
    });
});

describe('filenameFromDisposition', () => {
    it('reads quoted, bare and RFC 5987 filenames', () => {
        expect(filenameFromDisposition('attachment; filename="voice.md"', 'x.md')).toBe('voice.md');
        expect(filenameFromDisposition('attachment; filename=voice.md', 'x.md')).toBe('voice.md');
        expect(filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.md", 'x.md')).toBe(
            'café.md',
        );
    });

    it('drops the optional RFC 5987 language tag instead of keeping it in the name', () => {
        expect(filenameFromDisposition("attachment; filename*=UTF-8'en'caf%C3%A9.md", 'x.md')).toBe(
            'café.md',
        );
        expect(
            filenameFromDisposition("attachment; filename*=ISO-8859-1'de'gru%DFe.md", 'x.md'),
        ).toBe('gru%DFe.md');
    });

    it('strips path separators and falls back when the header is missing', () => {
        expect(filenameFromDisposition('attachment; filename="../../etc.md"', 'x.md')).toBe(
            '.._.._etc.md',
        );
        expect(filenameFromDisposition(null, 'fallback.md')).toBe('fallback.md');
    });
});

describe('folderErrorKey', () => {
    it.each([
        ['FolderDepthLimit', 422, 'folderDepthLimit'],
        ['FolderNameDuplicate', 409, 'folderNameDuplicate'],
        ['FolderCycle', 422, 'folderCycleRejected'],
        ['FolderLimitReached', 422, 'folderLimitReached'],
    ])('maps %s to its copy', (code, status, key) => {
        expect(folderErrorKey(new LibraryRequestError(status, code, 'x'))).toBe(key);
    });

    it('maps the uncoded refusals by status', () => {
        expect(folderErrorKey(new LibraryRequestError(409, null, 'exists'))).toBe(
            'folderNameDuplicate',
        );
        expect(folderErrorKey(new LibraryRequestError(403, null, 'no'))).toBe('noManageFolders');
        expect(
            folderErrorKey(new LibraryRequestError(400, null, 'Folder name must be 1-120')),
        ).toBe('folderNameLength');
    });

    it('falls back to the generic failure', () => {
        expect(folderErrorKey(new Error('offline'))).toBe('folderFailed');
        expect(folderErrorKey(new LibraryRequestError(500, null, 'boom'))).toBe('folderFailed');
    });
});
