import { describe, it, expect, vi } from 'vitest';
import { CloudflareApiZoneLister } from '../cloudflare-zone-lister';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('CloudflareApiZoneLister', () => {
    const baseConfig = {
        apiToken: 'token-xyz',
        zoneId: 'zone-abc',
        rootDomain: 'ever.works',
        apiBaseUrl: 'https://api.example.test/client/v4',
        perPage: 2,
    } as const;

    it('returns rootDomain from config', () => {
        const lister = new CloudflareApiZoneLister(baseConfig, vi.fn());
        expect(lister.rootDomain()).toBe('ever.works');
    });

    it('paginates until totalPages reached', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            const u = new URL(url);
            const page = Number(u.searchParams.get('page'));
            if (page === 1) {
                return jsonResponse({
                    success: true,
                    result: [
                        { id: 'r1', type: 'CNAME', name: 'dir.ever.works' },
                        { id: 'r2', type: 'CNAME', name: 'mcpserver.ever.works' },
                    ],
                    result_info: { total_pages: 2, page: 1 },
                });
            }
            if (page === 2) {
                return jsonResponse({
                    success: true,
                    result: [{ id: 'r3', type: 'A', name: 'foo.ever.works' }],
                    result_info: { total_pages: 2, page: 2 },
                });
            }
            return jsonResponse({ success: false }, 500);
        });

        const lister = new CloudflareApiZoneLister(
            baseConfig,
            fetchImpl as unknown as typeof fetch,
        );
        const records = await lister.listAllRecords();
        expect(records).toHaveLength(3);
        expect(records.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        // Confirm auth header & per_page passthrough.
        const firstCallInit = fetchImpl.mock.calls[0][1] as RequestInit;
        const headers = firstCallInit.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer token-xyz');
        expect(String(fetchImpl.mock.calls[0][0])).toContain('per_page=2');
    });

    it('throws CloudflareDnsError on non-OK response', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({ success: false, errors: [{ code: 9999, message: 'nope' }] }, 401),
        );
        const lister = new CloudflareApiZoneLister(
            baseConfig,
            fetchImpl as unknown as typeof fetch,
        );
        await expect(lister.listAllRecords()).rejects.toThrow(/Cloudflare API GET/);
    });

    it('stops paginating when the page returns an empty result array', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                success: true,
                result: [],
                result_info: { total_pages: 99, page: 1 },
            }),
        );
        const lister = new CloudflareApiZoneLister(
            baseConfig,
            fetchImpl as unknown as typeof fetch,
        );
        const records = await lister.listAllRecords();
        expect(records).toEqual([]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
