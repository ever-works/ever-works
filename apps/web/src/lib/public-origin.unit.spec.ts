import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredPublicOrigin, publicOriginFor, publicUrl } from './public-origin';

const INTERNAL = 'https://ever-works-web-7c47bf599d-dc74b:3000/api/github-app/callback?code=c';

describe('public-origin', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
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
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', '');
            vi.stubEnv('WEB_URL', '');
            expect(configuredPublicOrigin()).toBeNull();
            expect(errorSpy).not.toHaveBeenCalled();

            vi.stubEnv('WEB_URL', 'not a url');
            expect(configuredPublicOrigin()).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WEB_URL is set but'));
        });

        it('a malformed NEXT_PUBLIC_WEB_URL does not hide a valid WEB_URL, and is reported by name', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'app.ever.works');
            vi.stubEnv('WEB_URL', 'https://app.ever.works');

            expect(configuredPublicOrigin()).toBe('https://app.ever.works');
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy.mock.calls[0][0]).toContain('NEXT_PUBLIC_WEB_URL is set but');
            // The value itself is never logged.
            expect(errorSpy.mock.calls[0][0]).not.toContain('app.ever.works');

            // Reported once per process, not on every request.
            configuredPublicOrigin();
            expect(errorSpy).toHaveBeenCalledTimes(1);
        });

        it('ignores a non-http(s) URL (its origin would be the opaque "null")', () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'javascript:alert(1)');
            vi.stubEnv('WEB_URL', '');

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
