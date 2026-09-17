import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { PATCH } from './route';

const DOC = '6f1c2a4e-3b7d-4c9a-8e21-0000000000d1';
const FOLDER = '6f1c2a4e-3b7d-4c9a-8e21-0000000000f1';

function request(body: string, selector?: string) {
    const headers = new Headers({
        [API_SCOPE_HEADER]: 'attacker-supplied-org',
        'content-type': 'application/json',
    });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/knowledge/documents/file', {
        method: 'PATCH',
        headers,
        body,
    });
}

/**
 * Filing only accepts a folder of the Organization in scope, so an unscoped
 * hop would turn every File click into a 404 upstream.
 */
describe('PATCH /api/knowledge/documents/file', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ filed: 1, folderId: FOLDER }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('forwards the JSON body with the per-tab Organization scope', async () => {
        const body = JSON.stringify({ documentIds: [DOC], folderId: FOLDER });

        const response = await PATCH(request(body, 'org:ever'));

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/knowledge/documents/file');
        expect(init.method).toBe('PATCH');
        expect(init.body).toBe(body);
        const headers = new Headers(init.headers);
        expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(await response.json()).toEqual({ filed: 1, folderId: FOLDER });
    });

    it('relays the over-limit refusal with its code so the panel can show the copy', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ status: 'error', code: 'FileBatchLimit' }), {
                status: 422,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const response = await PATCH(request('{}', 'org:ever'));

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ status: 'error', code: 'FileBatchLimit' });
    });

    it('fails closed before upstream when the selector is absent', async () => {
        const response = await PATCH(request('{}'));

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
