import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Ever ID back-channel logout on the web host: the provider's notice is handed
 * to the API route unchanged and its status answered, never cached; nothing of
 * the browser travels; an oversized body and an unreachable API are answered
 * without passing anything on.
 */

vi.mock('@/lib/constants', () => ({ API_URL: 'https://api.works.example.test/api' }));

const NOTICE = 'logout_token=eyJhbGciOiJSUzI1NiJ9.e30.sig';

function notice(body = NOTICE, headers: Record<string, string> = {}) {
    return new NextRequest('https://works.example.test/api/auth/ever-id/backchannel-logout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
    });
}

describe('POST /api/auth/ever-id/backchannel-logout (web)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("hands the notice to the API and answers the API's status, never cached", async () => {
        const { POST } = await import('./route');
        const res = await POST(notice(NOTICE, { cookie: 'session=secret' }));

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.works.example.test/api/auth/ever-id/backchannel-logout');
        expect(init.method).toBe('POST');
        expect(init.body).toBe(NOTICE);
        expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    });

    it('answers a refused notice with the API status', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
        const { POST } = await import('./route');
        expect((await POST(notice())).status).toBe(400);
    });

    it('refuses an oversized body without passing it on', async () => {
        const { POST } = await import('./route');
        const res = await POST(notice(`logout_token=${'a'.repeat(17 * 1024)}`));
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 502 when the API cannot be reached', async () => {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const { POST } = await import('./route');
        expect((await POST(notice())).status).toBe(502);
    });
});
