import { describe, expect, it } from 'vitest';
import { withUploadServeScope } from './upload-serve-url';

/**
 * The render-time half for the serve URL. The URL the API mints, the one in
 * chat text and the one in attachment lists stay scope-free; the tab's
 * workspace is added where an `<a href>` / `<img src>` is rendered.
 */
describe('withUploadServeScope', () => {
    const ORG = { kind: 'organization', slug: 'acme' } as const;

    it('appends the tab’s selector to an API-minted serve URL', () => {
        expect(withUploadServeScope('/api/uploads/u1/aaaa.png', ORG)).toBe(
            '/api/uploads/u1/aaaa.png?scope=org%3Aacme',
        );
    });

    it('keeps an existing workId next to the selector', () => {
        const url = new URL(
            withUploadServeScope('/api/uploads/u1/aaaa.png?workId=w-1', ORG),
            'http://n',
        );

        expect(url.searchParams.get('workId')).toBe('w-1');
        expect(url.searchParams.get('scope')).toBe('org:acme');
    });

    it('leaves the URL alone when there is no scope to add', () => {
        expect(withUploadServeScope('/api/uploads/u1/aaaa.png', null)).toBe(
            '/api/uploads/u1/aaaa.png',
        );
    });

    it.each([
        'blob:http://web.example/123',
        'https://cdn.example/x.png',
        '/api/works/w/kb/uploads/u/download',
    ])('never decorates %j — only the serve URL family carries this', (url) => {
        expect(withUploadServeScope(url, ORG)).toBe(url);
    });

    it('passes undefined through for an attachment with no URL yet', () => {
        expect(withUploadServeScope(undefined, ORG)).toBeUndefined();
    });
});
