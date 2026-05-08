import { BadRequestException } from '@nestjs/common';
import {
    SOCIAL_AUTH_PROVIDERS,
    getSocialAuthProviderConfig,
} from './social-auth.providers';
import { GITHUB_SCOPES } from './github-scopes.config';
import { AuthProvider } from '../../config/constants';

describe('social-auth.providers', () => {
    describe('SOCIAL_AUTH_PROVIDERS registry shape', () => {
        it('exposes exactly the four documented OAuth providers', () => {
            expect(Object.keys(SOCIAL_AUTH_PROVIDERS).sort()).toEqual(
                [
                    AuthProvider.FACEBOOK,
                    AuthProvider.GITHUB,
                    AuthProvider.GOOGLE,
                    AuthProvider.LINKEDIN,
                ].sort(),
            );
        });

        it('matches each registry key to the provider entry id (no drift between key and id)', () => {
            for (const [key, provider] of Object.entries(SOCIAL_AUTH_PROVIDERS)) {
                expect(provider.id).toBe(key);
            }
        });

        it.each(Object.values(SOCIAL_AUTH_PROVIDERS))(
            'exposes lazy getter functions on $id (callbackUrl/clientId/clientSecret)',
            (provider) => {
                expect(typeof provider.callbackUrl).toBe('function');
                expect(typeof provider.clientId).toBe('function');
                expect(typeof provider.clientSecret).toBe('function');
            },
        );

        it.each(Object.values(SOCIAL_AUTH_PROVIDERS))(
            'exposes string authorizationUrl/tokenUrl/displayName on $id',
            (provider) => {
                expect(typeof provider.authorizationUrl).toBe('string');
                expect(provider.authorizationUrl).toMatch(/^https:\/\//);
                expect(typeof provider.tokenUrl).toBe('string');
                expect(provider.tokenUrl).toMatch(/^https:\/\//);
                expect(typeof provider.displayName).toBe('string');
                expect(provider.displayName.length).toBeGreaterThan(0);
            },
        );

        it.each(Object.values(SOCIAL_AUTH_PROVIDERS))(
            'declares a non-empty scopes[] of strings on $id',
            (provider) => {
                expect(Array.isArray(provider.scopes)).toBe(true);
                expect(provider.scopes.length).toBeGreaterThan(0);
                for (const scope of provider.scopes) {
                    expect(typeof scope).toBe('string');
                    expect(scope.length).toBeGreaterThan(0);
                }
            },
        );
    });

    describe('GitHub provider', () => {
        const provider = SOCIAL_AUTH_PROVIDERS[AuthProvider.GITHUB];

        it('uses GitHub OAuth URLs and "GitHub" display name', () => {
            expect(provider.id).toBe(AuthProvider.GITHUB);
            expect(provider.displayName).toBe('GitHub');
            expect(provider.authorizationUrl).toBe(
                'https://github.com/login/oauth/authorize',
            );
            expect(provider.tokenUrl).toBe(
                'https://github.com/login/oauth/access_token',
            );
        });

        it('mirrors the shared GITHUB_SCOPES list (preserves order)', () => {
            expect(provider.scopes).toEqual([...GITHUB_SCOPES]);
        });

        it('owns its own copy of scopes (mutating SOCIAL_AUTH_PROVIDERS does not leak into GITHUB_SCOPES)', () => {
            // The registry spreads the readonly tuple via [...GITHUB_SCOPES], so the
            // registry's array MUST NOT be the same reference as GITHUB_SCOPES.
            expect(provider.scopes).not.toBe(GITHUB_SCOPES);
        });

        it('omits scopeSeparator (defaults to space at the call site)', () => {
            expect(provider.scopeSeparator).toBeUndefined();
        });

        it('reads GH_CLIENT_ID / GH_CLIENT_SECRET via lazy getters', () => {
            const originalId = process.env.GH_CLIENT_ID;
            const originalSecret = process.env.GH_CLIENT_SECRET;
            try {
                process.env.GH_CLIENT_ID = 'gh-id';
                process.env.GH_CLIENT_SECRET = 'gh-secret';
                expect(provider.clientId()).toBe('gh-id');
                expect(provider.clientSecret()).toBe('gh-secret');

                delete process.env.GH_CLIENT_ID;
                delete process.env.GH_CLIENT_SECRET;
                expect(provider.clientId()).toBeUndefined();
                expect(provider.clientSecret()).toBeUndefined();
            } finally {
                if (originalId === undefined) delete process.env.GH_CLIENT_ID;
                else process.env.GH_CLIENT_ID = originalId;
                if (originalSecret === undefined) delete process.env.GH_CLIENT_SECRET;
                else process.env.GH_CLIENT_SECRET = originalSecret;
            }
        });

        it('honors GH_CALLBACK_URL override on callbackUrl()', () => {
            const original = process.env.GH_CALLBACK_URL;
            try {
                process.env.GH_CALLBACK_URL = 'https://example.test/cb';
                expect(provider.callbackUrl()).toBe('https://example.test/cb');
            } finally {
                if (original === undefined) delete process.env.GH_CALLBACK_URL;
                else process.env.GH_CALLBACK_URL = original;
            }
        });
    });

    describe('Google provider', () => {
        const provider = SOCIAL_AUTH_PROVIDERS[AuthProvider.GOOGLE];

        it('uses Google OAuth URLs and "Google" display name', () => {
            expect(provider.id).toBe(AuthProvider.GOOGLE);
            expect(provider.displayName).toBe('Google');
            expect(provider.authorizationUrl).toBe(
                'https://accounts.google.com/o/oauth2/v2/auth',
            );
            expect(provider.tokenUrl).toBe('https://oauth2.googleapis.com/token');
        });

        it('declares scopes [openid, email, profile] (in order)', () => {
            expect(provider.scopes).toEqual(['openid', 'email', 'profile']);
        });

        it('omits scopeSeparator (defaults to space at the call site)', () => {
            expect(provider.scopeSeparator).toBeUndefined();
        });

        it('reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET via lazy getters', () => {
            const originalId = process.env.GOOGLE_CLIENT_ID;
            const originalSecret = process.env.GOOGLE_CLIENT_SECRET;
            try {
                process.env.GOOGLE_CLIENT_ID = 'google-id';
                process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
                expect(provider.clientId()).toBe('google-id');
                expect(provider.clientSecret()).toBe('google-secret');
            } finally {
                if (originalId === undefined) delete process.env.GOOGLE_CLIENT_ID;
                else process.env.GOOGLE_CLIENT_ID = originalId;
                if (originalSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
                else process.env.GOOGLE_CLIENT_SECRET = originalSecret;
            }
        });
    });

    describe('Facebook provider', () => {
        const provider = SOCIAL_AUTH_PROVIDERS[AuthProvider.FACEBOOK];

        it('uses Facebook v23.0 OAuth URLs and "Facebook" display name', () => {
            expect(provider.id).toBe(AuthProvider.FACEBOOK);
            expect(provider.displayName).toBe('Facebook');
            expect(provider.authorizationUrl).toBe(
                'https://www.facebook.com/v23.0/dialog/oauth',
            );
            expect(provider.tokenUrl).toBe(
                'https://graph.facebook.com/v23.0/oauth/access_token',
            );
        });

        it('declares scopes [email, public_profile] (in order)', () => {
            expect(provider.scopes).toEqual(['email', 'public_profile']);
        });

        it('uses comma scopeSeparator (Facebook-specific)', () => {
            // Facebook is the only provider that joins scopes with "," instead of " ".
            expect(provider.scopeSeparator).toBe(',');
        });

        it('reads FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET via lazy getters', () => {
            const originalId = process.env.FACEBOOK_CLIENT_ID;
            const originalSecret = process.env.FACEBOOK_CLIENT_SECRET;
            try {
                process.env.FACEBOOK_CLIENT_ID = 'fb-id';
                process.env.FACEBOOK_CLIENT_SECRET = 'fb-secret';
                expect(provider.clientId()).toBe('fb-id');
                expect(provider.clientSecret()).toBe('fb-secret');
            } finally {
                if (originalId === undefined) delete process.env.FACEBOOK_CLIENT_ID;
                else process.env.FACEBOOK_CLIENT_ID = originalId;
                if (originalSecret === undefined) delete process.env.FACEBOOK_CLIENT_SECRET;
                else process.env.FACEBOOK_CLIENT_SECRET = originalSecret;
            }
        });
    });

    describe('LinkedIn provider', () => {
        const provider = SOCIAL_AUTH_PROVIDERS[AuthProvider.LINKEDIN];

        it('uses LinkedIn v2 OAuth URLs and "LinkedIn" display name', () => {
            expect(provider.id).toBe(AuthProvider.LINKEDIN);
            expect(provider.displayName).toBe('LinkedIn');
            expect(provider.authorizationUrl).toBe(
                'https://www.linkedin.com/oauth/v2/authorization',
            );
            expect(provider.tokenUrl).toBe(
                'https://www.linkedin.com/oauth/v2/accessToken',
            );
        });

        it('declares scopes [openid, profile, email] (in order)', () => {
            expect(provider.scopes).toEqual(['openid', 'profile', 'email']);
        });

        it('omits scopeSeparator (defaults to space at the call site)', () => {
            expect(provider.scopeSeparator).toBeUndefined();
        });

        it('reads LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET via lazy getters', () => {
            const originalId = process.env.LINKEDIN_CLIENT_ID;
            const originalSecret = process.env.LINKEDIN_CLIENT_SECRET;
            try {
                process.env.LINKEDIN_CLIENT_ID = 'li-id';
                process.env.LINKEDIN_CLIENT_SECRET = 'li-secret';
                expect(provider.clientId()).toBe('li-id');
                expect(provider.clientSecret()).toBe('li-secret');
            } finally {
                if (originalId === undefined) delete process.env.LINKEDIN_CLIENT_ID;
                else process.env.LINKEDIN_CLIENT_ID = originalId;
                if (originalSecret === undefined) delete process.env.LINKEDIN_CLIENT_SECRET;
                else process.env.LINKEDIN_CLIENT_SECRET = originalSecret;
            }
        });
    });

    describe('getSocialAuthProviderConfig', () => {
        it.each([
            [AuthProvider.GITHUB],
            [AuthProvider.GOOGLE],
            [AuthProvider.FACEBOOK],
            [AuthProvider.LINKEDIN],
        ])(
            'returns the registry entry for %s and the entry id matches the requested id',
            (providerId) => {
                const provider = getSocialAuthProviderConfig(providerId);
                expect(provider).toBe(SOCIAL_AUTH_PROVIDERS[providerId]);
                expect(provider.id).toBe(providerId);
            },
        );

        it.each(['discord', 'apple', 'unknown', '', 'GITHUB', 'github '])(
            'throws BadRequestException with the requested id interpolated for %s',
            (providerId) => {
                let caught: unknown;
                try {
                    getSocialAuthProviderConfig(providerId);
                } catch (err) {
                    caught = err;
                }
                expect(caught).toBeInstanceOf(BadRequestException);
                expect((caught as BadRequestException).message).toBe(
                    `Unsupported OAuth provider: ${providerId}`,
                );
            },
        );

        it('rejects the four-tier git provider "github-app" identifier (NOT a social-auth registry key)', () => {
            // "github-app" is the GitHub App OAuth flow (apps/api/src/integrations/github-app),
            // NOT the social-auth registry. Pin the rejection so a future "consolidate the
            // two flows" refactor breaks loudly here instead of silently aliasing.
            expect(() => getSocialAuthProviderConfig('github-app')).toThrow(
                BadRequestException,
            );
        });
    });
});
