import { describe, expect, it } from 'vitest';
import { buildEndpoint } from './endpoint';

describe('buildEndpoint', () => {
    it('strips the leading /api prefix', () => {
        expect(buildEndpoint({ path: '/api/agents' })).toBe('/agents');
    });

    it('substitutes a path param and URL-encodes it', () => {
        expect(buildEndpoint({ path: '/api/works/{id}/items', pathParams: { id: 'a b/c' } })).toBe(
            '/works/a%20b%2Fc/items',
        );
    });

    it('substitutes multiple path params', () => {
        expect(
            buildEndpoint({
                path: '/api/works/{workId}/members/{memberId}',
                pathParams: { workId: 'w1', memberId: 'm2' },
            }),
        ).toBe('/works/w1/members/m2');
    });

    it('appends query params and skips empty/null/undefined', () => {
        expect(
            buildEndpoint({
                path: '/api/tasks',
                query: { status: 'open', q: '', n: undefined, x: null, page: 2 },
            }),
        ).toBe('/tasks?status=open&page=2');
    });

    it('leaves non-/api paths intact (e.g. /admin)', () => {
        expect(buildEndpoint({ path: '/admin/usage' })).toBe('/admin/usage');
    });

    it('produces no trailing ? when the query object is empty', () => {
        expect(buildEndpoint({ path: '/api/works', query: {} })).toBe('/works');
    });
});
