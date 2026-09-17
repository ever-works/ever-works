import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

const ctx = { params: Promise.resolve({ docId: 'doc-1' }) };

function request(selector?: string) {
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-org' });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/knowledge/documents/doc-1/export?format=md', {
        headers,
    });
}

describe('GET /api/knowledge/documents/[docId]/export', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response('---\ntitle: Voice\n---\n\nBody\n', {
                    status: 200,
                    headers: {
                        'content-type': 'text/markdown; charset=utf-8',
                        'content-disposition': 'attachment; filename="voice.md"',
                    },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('relays the Markdown attachment with its filename, scoped to the tab', async () => {
        const response = await GET(request('org:ever'), ctx);

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/knowledge/documents/doc-1/export?format=md');
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('ever');
        expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="voice.md"');
        expect(await response.text()).toBe('---\ntitle: Voice\n---\n\nBody\n');
    });

    it('fails closed before upstream when the selector is absent', async () => {
        const response = await GET(request(), ctx);

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
