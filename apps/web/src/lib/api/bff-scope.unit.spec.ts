import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    API_SCOPE_HEADER,
    BROWSER_WORKSPACE_SCOPE_HEADER,
    PERSONAL_SCOPE_SENTINEL,
} from '../workspace-scope';
import { applyBffWorkspaceScope } from './bff-scope';

/**
 * The browser-facing origin, as the deployment configures it.
 */
const PUBLIC_ORIGIN = 'https://app.example';

/**
 * The origin a Next server reports for its OWN requests. This is deliberately
 * different from PUBLIC_ORIGIN, because in every real deployment it is: Next
 * builds `request.url` from the bind hostname and port, so behind an ingress it
 * is the pod address, and under `next start` with no `-H` it is not even
 * absolute. An earlier version of this guard compared the Referer against
 * `new URL(request.url).origin` and therefore rejected every browser call to
 * every guarded route in production and in e2e. These fixtures exist to make
 * that class of mistake impossible to reintroduce: nothing here may pass by
 * virtue of the request's own URL.
 */
const SERVER_SELF_ORIGIN = 'http://0.0.0.0:3000';

function request(selector?: string, referer?: string): Request {
    const headers = new Headers({
        [API_SCOPE_HEADER]: 'attacker-supplied-yo',
    });
    if (selector !== undefined) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    if (referer !== undefined) headers.set('referer', referer);
    return new Request(`${SERVER_SELF_ORIGIN}/api/missions`, { method: 'POST', headers });
}

describe('BFF workspace scope boundary', () => {
    const previous = process.env.NEXT_PUBLIC_WEB_URL;

    beforeEach(() => {
        process.env.NEXT_PUBLIC_WEB_URL = PUBLIC_ORIGIN;
    });

    afterEach(() => {
        if (previous === undefined) delete process.env.NEXT_PUBLIC_WEB_URL;
        else process.env.NEXT_PUBLIC_WEB_URL = previous;
    });

    it('accepts an explicit Organization selector without Referer and overwrites the API header', () => {
        const upstream = applyBffWorkspaceScope(request('org:ever'), {
            Authorization: 'Bearer test',
        });

        expect(upstream.get(API_SCOPE_HEADER)).toBe('ever');
        expect(upstream.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
        expect(upstream.get('authorization')).toBe('Bearer test');
    });

    it('accepts explicit personal only with an unprefixed Referer from the public origin', () => {
        const upstream = applyBffWorkspaceScope(
            request('personal', `${PUBLIC_ORIGIN}/missions/new`),
            {},
        );

        expect(upstream.get(API_SCOPE_HEADER)).toBe(PERSONAL_SCOPE_SENTINEL);
    });

    it('accepts a Referer from the configured public origin even though the request URL is the server address', () => {
        // The regression pin. The Referer's origin and the request's own origin
        // disagree here exactly as they do in production; only the configured
        // public origin decides.
        const upstream = applyBffWorkspaceScope(
            request('org:ever', `${PUBLIC_ORIGIN}/org/ever/missions`),
            {},
        );

        expect(upstream.get(API_SCOPE_HEADER)).toBe('ever');
    });

    it("rejects a Referer that matches the server's own address but not the public origin", () => {
        expect(() =>
            applyBffWorkspaceScope(
                request('org:ever', `${SERVER_SELF_ORIGIN}/org/ever/missions`),
                {},
            ),
        ).toThrow('Invalid workspace scope');
    });

    it('still enforces the selector when no public origin is configured', () => {
        delete process.env.NEXT_PUBLIC_WEB_URL;
        delete process.env.WEB_URL;

        // Unverifiable origin: the Referer's path must still agree with the
        // selector, so a stale tab is caught even without the origin leg.
        expect(() =>
            applyBffWorkspaceScope(
                request('org:ever', 'https://anywhere.example/org/yo/missions'),
                {},
            ),
        ).toThrow('Invalid workspace scope');
    });

    it.each([
        ['missing selector', () => request(undefined, `${PUBLIC_ORIGIN}/org/ever/missions`)],
        ['invalid selector', () => request('org:@personal', `${PUBLIC_ORIGIN}/org/ever/missions`)],
        ['stale tab selector', () => request('org:ever', `${PUBLIC_ORIGIN}/org/yo/missions`)],
        ['personal downgrade', () => request('personal', `${PUBLIC_ORIGIN}/org/ever/missions`)],
        [
            'cross-origin Referer',
            () => request('org:ever', 'https://evil.example/org/ever/missions'),
        ],
    ] as const)('fails closed for %s', (_label, build) => {
        expect(() => applyBffWorkspaceScope(build(), {})).toThrow('Invalid workspace scope');
    });
});
