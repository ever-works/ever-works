import { beforeEach, describe, expect, it, vi } from 'vitest';
import { helpBodyUrl, loadHelpArticleBody, resetHelpBodyCache } from './help-body';

const body = { version: 1, id: 'missions', blocks: [{ kind: 'paragraph', content: [] }] };

function respond(status: number, json: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
}

beforeEach(() => resetHelpBodyCache());

describe('loadHelpArticleBody', () => {
    it('loads from this deployment, never from another origin (spec FR-1)', async () => {
        const fetcher = vi.fn(async () => respond(200, body));
        await expect(loadHelpArticleBody('missions', fetcher)).resolves.toEqual(body);
        const [url] = fetcher.mock.calls[0] as unknown as [string];
        expect(url.startsWith('/help-content/missions.json?v=')).toBe(true);
        expect(helpBodyUrl('missions')).toBe(url);
    });

    it('caches a loaded body for the life of the page', async () => {
        const fetcher = vi.fn(async () => respond(200, body));
        await loadHelpArticleBody('missions', fetcher);
        await loadHelpArticleBody('missions', fetcher);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a missing body', () => respond(404, null)],
        ['a malformed body', () => respond(200, { version: 2, id: 'missions', blocks: [] })],
        ['a body for another article', () => respond(200, { ...body, id: 'tasks' })],
    ])('resolves null for %s and retries next time', async (_label, reply) => {
        const fetcher = vi.fn(async () => reply());
        await expect(loadHelpArticleBody('missions', fetcher)).resolves.toBeNull();
        await loadHelpArticleBody('missions', fetcher);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('resolves null when the request itself fails, synchronously or not', async () => {
        await expect(
            loadHelpArticleBody(
                'missions',
                vi.fn(async () => Promise.reject(new Error('offline'))),
            ),
        ).resolves.toBeNull();
        await expect(
            loadHelpArticleBody(
                'missions',
                vi.fn(() => {
                    throw new Error('boom');
                }),
            ),
        ).resolves.toBeNull();
    });
});
