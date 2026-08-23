import { describe, expect, it } from 'vitest';
import {
    API_SCOPE_HEADER,
    BROWSER_WORKSPACE_SCOPE_HEADER,
    PERSONAL_SCOPE_SENTINEL,
} from '../workspace-scope';
import { applyBffWorkspaceScope } from './bff-scope';

function request(selector?: string, referer?: string): Request {
    const headers = new Headers({
        [API_SCOPE_HEADER]: 'attacker-supplied-yo',
    });
    if (selector !== undefined) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    if (referer !== undefined) headers.set('referer', referer);
    return new Request('https://app.example/api/missions', { method: 'POST', headers });
}

describe('BFF workspace scope boundary', () => {
    it('accepts an explicit Organization selector without Referer and overwrites the API header', () => {
        const upstream = applyBffWorkspaceScope(request('org:ever'), {
            Authorization: 'Bearer test',
        });

        expect(upstream.get(API_SCOPE_HEADER)).toBe('ever');
        expect(upstream.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
        expect(upstream.get('authorization')).toBe('Bearer test');
    });

    it('accepts explicit personal only with an unprefixed same-origin Referer', () => {
        const upstream = applyBffWorkspaceScope(
            request('personal', 'https://app.example/missions/new'),
            {},
        );

        expect(upstream.get(API_SCOPE_HEADER)).toBe(PERSONAL_SCOPE_SENTINEL);
    });

    it.each([
        ['missing selector', request(undefined, 'https://app.example/org/ever/missions')],
        ['invalid selector', request('org:@personal', 'https://app.example/org/ever/missions')],
        ['stale tab selector', request('org:ever', 'https://app.example/org/yo/missions')],
        ['personal downgrade', request('personal', 'https://app.example/org/ever/missions')],
        ['cross-origin Referer', request('org:ever', 'https://evil.example/org/ever/missions')],
    ] as const)('fails closed for %s', (_label, input) => {
        expect(() => applyBffWorkspaceScope(input, {})).toThrow('Invalid workspace scope');
    });
});
