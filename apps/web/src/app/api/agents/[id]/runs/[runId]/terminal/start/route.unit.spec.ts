import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { POST } from './route';

const AGENT = '11111111-2222-4333-8444-555555555555';
const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';

function request(selector?: string) {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (selector) headers.set('x-ever-workspace', selector);
    return new Request('http://web.example/api/agents/a/runs/r/terminal/start', {
        method: 'POST',
        headers,
    }) as Parameters<typeof POST>[0];
}

function context() {
    return { params: Promise.resolve({ id: AGENT, runId: RUN }) };
}

describe('POST Agent terminal start workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('overwrites spoofing and forwards the explicit per-tab Organization selector', async () => {
        const response = await POST(request('org:ever'), context());

        expect(response.status).toBe(200);
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('x-scope-slug')).toBe('ever');
        expect(new Headers(init.headers).get('x-ever-workspace')).toBeNull();
    });

    it('fails closed before upstream when the browser selector is absent', async () => {
        const response = await POST(request(), context());

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
