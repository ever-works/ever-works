import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredPublicOrigin, publicOriginFor, publicUrl } from './public-origin';

const INTERNAL = 'https://ever-works-web-7c47bf599d-dc74b:3000/api/github-app/callback?code=c';

describe('public-origin', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('configuredPublicOrigin', () => {
        it('prefers NEXT_PUBLIC_WEB_URL, then WEB_URL, and returns only the origin', () => {
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://app.ever.works/some/path');
            vi.stubEnv('WEB_URL', 'https://other.example');
            expect(configuredPublicOrigin()).toBe('https://app.ever.works');

            vi.stubEnv('NEXT_PUBLIC_WEB_URL', '');
            expect(configuredPublicOrigin()).toBe('https://other.example');
        });

        it('returns null when unset or malformed', () => {
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', '');
            vi.stubEnv('WEB_URL', '');
            expect(configuredPublicOrigin()).toBeNull();

            vi.stubEnv('WEB_URL', 'not a url');
            expect(configuredPublicOrigin()).toBeNull();
        });
    });

    describe('publicOriginFor / publicUrl', () => {
        it('ignores the internal request origin when a public origin is configured', () => {
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://app.ever.works');
            const request = new Request(INTERNAL);

            expect(publicOriginFor(request)).toBe('https://app.ever.works');
            expect(publicUrl('/auth/error?error=oauth_callback', request).toString()).toBe(
                'https://app.ever.works/auth/error?error=oauth_callback',
            );
        });

        it('falls back to the request origin only when nothing is configured', () => {
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', '');
            vi.stubEnv('WEB_URL', '');

            expect(publicOriginFor(new Request('http://localhost:3000/x'))).toBe(
                'http://localhost:3000',
            );
        });
    });
});
