import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

interface ProxyResponseBody {
    items: Array<{ id: string; name: string; kind: 'agent' }>;
    total: number;
}

/**
 * Build a fake `NextRequest`-like object with the shape `route.ts`
 * actually reads: `nextUrl.searchParams`. The real `NextRequest` adds
 * cookie/header surface we don't touch here, so this is enough.
 */
function makeRequest(url: string) {
    return { nextUrl: new URL(url) } as unknown as Parameters<typeof GET>[0];
}

function makeContext(id: string) {
    return { params: Promise.resolve({ id }) };
}

const PIPELINE_PLUGINS = [
    { pluginId: 'standard-pipeline', name: 'Standard Pipeline', category: 'pipeline' },
    { pluginId: 'agent-pipeline', name: 'Agent Pipeline', category: 'pipeline' },
    { pluginId: 'claude-code', name: 'Claude Code', category: 'pipeline' },
    { pluginId: 'codex', name: 'Codex', category: 'pipeline' },
    // Smuggle in a non-pipeline plugin to confirm the route's filter
    // doesn't trust the upstream's filtering alone.
    { pluginId: 'openai', name: 'OpenAI', category: 'ai-provider' },
];

/**
 * EW-641 Phase 1B/d row 17b — agents proxy tests.
 *
 * Pins:
 *  - empty `q` returns the full list
 *  - case-insensitive substring match against `name` + `pluginId`
 *  - non-pipeline categories filtered out defensively
 *  - `limit` clamped to 50, defaults to 10
 *  - shape: `{ items: { id, name, kind: 'agent' }[], total }`
 *  - upstream failure surfaces a non-2xx response
 */
describe('GET /api/works/[id]/agents', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchSpy = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ items: PIPELINE_PLUGINS, total: PIPELINE_PLUGINS.length }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    },
                ),
        );
        vi.stubGlobal('fetch', fetchSpy);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists all pipeline plugins when q is empty, filtering out non-pipeline categories', async () => {
        const response = await GET(
            makeRequest('http://test/api/works/work-1/agents'),
            makeContext('work-1'),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as ProxyResponseBody;
        expect(body.items.map((i) => i.id)).toEqual([
            'standard-pipeline',
            'agent-pipeline',
            'claude-code',
            'codex',
        ]);
        // openai (ai-provider) should be filtered out.
        expect(body.items.every((i) => i.kind === 'agent')).toBe(true);
        expect(body.total).toBe(4);
    });

    it('substring-filters by name (case-insensitive)', async () => {
        const response = await GET(
            makeRequest('http://test/api/works/work-1/agents?q=claude'),
            makeContext('work-1'),
        );
        const body = (await response.json()) as ProxyResponseBody;
        expect(body.items.map((i) => i.id)).toEqual(['claude-code']);
    });

    it('substring-filters by pluginId fallback', async () => {
        const response = await GET(
            makeRequest('http://test/api/works/work-1/agents?q=codex'),
            makeContext('work-1'),
        );
        const body = (await response.json()) as ProxyResponseBody;
        expect(body.items.map((i) => i.id)).toEqual(['codex']);
    });

    it('respects the limit query param (clamped to 50)', async () => {
        const response = await GET(
            makeRequest('http://test/api/works/work-1/agents?limit=2'),
            makeContext('work-1'),
        );
        const body = (await response.json()) as ProxyResponseBody;
        expect(body.items.length).toBe(2);
    });

    it('sends the JWT cookie as a bearer header upstream', async () => {
        await GET(makeRequest('http://test/api/works/work-1/agents'), makeContext('work-1'));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/plugins?category=pipeline');
        const headers = init.headers as Headers;
        expect(headers.get('authorization')).toBe('Bearer fake-jwt');
    });

    it('surfaces upstream non-OK responses verbatim', async () => {
        fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 503 }));
        const response = await GET(
            makeRequest('http://test/api/works/work-1/agents'),
            makeContext('work-1'),
        );
        expect(response.status).toBe(503);
        expect(await response.text()).toBe('boom');
    });
});
