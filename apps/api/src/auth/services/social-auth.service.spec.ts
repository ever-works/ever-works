jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    User: class User {},
    Work: class Work {},
}));

const ORIGINAL_ENV = { ...process.env };

const setProviderEnv = () => {
    process.env.WEB_URL = 'https://app.test';
    process.env.GH_CLIENT_ID = 'gh-id';
    process.env.GH_CLIENT_SECRET = 'gh-secret';
    process.env.GOOGLE_CLIENT_ID = 'google-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    process.env.FACEBOOK_CLIENT_ID = 'fb-id';
    process.env.FACEBOOK_CLIENT_SECRET = 'fb-secret';
    process.env.LINKEDIN_CLIENT_ID = 'li-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'li-secret';
};

beforeAll(() => {
    setProviderEnv();
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import { SocialAuthService } from './social-auth.service';
import type { AuthService } from './auth.service';
import { AuthProvider } from '../../config/constants';

describe('SocialAuthService', () => {
    let httpService: { get: jest.Mock; post: jest.Mock };
    let authService: { validateSocialUser: jest.Mock };
    let service: SocialAuthService;

    beforeEach(() => {
        setProviderEnv();
        httpService = {
            get: jest.fn(),
            post: jest.fn(),
        };
        authService = {
            validateSocialUser: jest.fn(),
        };
        service = new SocialAuthService(
            httpService as unknown as HttpService,
            authService as unknown as AuthService,
        );
    });

    describe('getAuthorizationUrl', () => {
        it('builds GitHub URL with default callback, scopes (space-separated), and no state', () => {
            const url = service.getAuthorizationUrl(AuthProvider.GITHUB);
            const parsed = new URL(url);

            expect(parsed.origin + parsed.pathname).toBe(
                'https://github.com/login/oauth/authorize',
            );
            expect(parsed.searchParams.get('client_id')).toBe('gh-id');
            expect(parsed.searchParams.get('redirect_uri')).toBe(
                'https://app.test/api/oauth/github/callback',
            );
            expect(parsed.searchParams.get('response_type')).toBe('code');
            expect(parsed.searchParams.get('state')).toBeNull();
            const scope = parsed.searchParams.get('scope') || '';
            expect(scope.split(' ')).toEqual(
                expect.arrayContaining(['user:email', 'read:user', 'repo']),
            );
            expect(parsed.searchParams.get('access_type')).toBeNull();
            expect(parsed.searchParams.get('prompt')).toBeNull();
        });

        it('uses caller-supplied callbackUrl and state when provided', () => {
            const url = service.getAuthorizationUrl(
                AuthProvider.GITHUB,
                'https://override.test/cb',
                'xyz-state',
            );
            const parsed = new URL(url);

            expect(parsed.searchParams.get('redirect_uri')).toBe('https://override.test/cb');
            expect(parsed.searchParams.get('state')).toBe('xyz-state');
        });

        it('appends Google offline access_type and consent prompt', () => {
            const url = service.getAuthorizationUrl(AuthProvider.GOOGLE);
            const parsed = new URL(url);

            expect(parsed.origin + parsed.pathname).toBe(
                'https://accounts.google.com/o/oauth2/v2/auth',
            );
            expect(parsed.searchParams.get('access_type')).toBe('offline');
            expect(parsed.searchParams.get('prompt')).toBe('consent');
        });

        it('uses comma scope separator for Facebook', () => {
            const url = service.getAuthorizationUrl(AuthProvider.FACEBOOK);
            const parsed = new URL(url);

            expect(parsed.searchParams.get('scope')).toBe('email,public_profile');
        });

        it('joins LinkedIn scopes with default space separator', () => {
            const url = service.getAuthorizationUrl(AuthProvider.LINKEDIN);
            const parsed = new URL(url);

            expect(parsed.searchParams.get('scope')).toBe('openid profile email');
        });

        it('throws BadRequestException for unknown provider id', () => {
            expect(() => service.getAuthorizationUrl('twitter')).toThrow(BadRequestException);
            expect(() => service.getAuthorizationUrl('twitter')).toThrow(
                'Unsupported OAuth provider: twitter',
            );
        });

        it('throws BadRequestException when client id is not configured', () => {
            delete process.env.GH_CLIENT_ID;
            expect(() => service.getAuthorizationUrl(AuthProvider.GITHUB)).toThrow(
                'github client id is not configured',
            );
        });
    });

    describe('getProviderDisplayName', () => {
        it.each([
            [AuthProvider.GITHUB, 'GitHub'],
            [AuthProvider.GOOGLE, 'Google'],
            [AuthProvider.FACEBOOK, 'Facebook'],
            [AuthProvider.LINKEDIN, 'LinkedIn'],
        ])('returns display name for %s', (provider, expected) => {
            expect(service.getProviderDisplayName(provider)).toBe(expected);
        });

        it('throws for unknown provider', () => {
            expect(() => service.getProviderDisplayName('unknown')).toThrow(BadRequestException);
        });
    });

    describe('getConfiguredProviders', () => {
        it('returns all four providers when env is fully configured', () => {
            const providers = service.getConfiguredProviders();
            expect(providers).toEqual(
                expect.arrayContaining([
                    AuthProvider.GITHUB,
                    AuthProvider.GOOGLE,
                    AuthProvider.FACEBOOK,
                    AuthProvider.LINKEDIN,
                ]),
            );
            expect(providers).toHaveLength(4);
        });

        it('omits providers missing client id', () => {
            delete process.env.FACEBOOK_CLIENT_ID;
            expect(service.getConfiguredProviders()).not.toContain(AuthProvider.FACEBOOK);
        });

        it('omits providers missing client secret', () => {
            delete process.env.LINKEDIN_CLIENT_SECRET;
            expect(service.getConfiguredProviders()).not.toContain(AuthProvider.LINKEDIN);
        });

        it('returns empty list when nothing is configured', () => {
            delete process.env.GH_CLIENT_ID;
            delete process.env.GH_CLIENT_SECRET;
            delete process.env.GOOGLE_CLIENT_ID;
            delete process.env.GOOGLE_CLIENT_SECRET;
            delete process.env.FACEBOOK_CLIENT_ID;
            delete process.env.FACEBOOK_CLIENT_SECRET;
            delete process.env.LINKEDIN_CLIENT_ID;
            delete process.env.LINKEDIN_CLIENT_SECRET;

            expect(service.getConfiguredProviders()).toEqual([]);
        });
    });

    describe('authenticate', () => {
        it('completes GitHub flow: token exchange + /user + /user/emails -> validateSocialUser', async () => {
            httpService.post.mockReturnValueOnce(
                of({
                    data: {
                        access_token: 'gh-access',
                        refresh_token: 'gh-refresh',
                        token_type: 'bearer',
                        scope: 'repo',
                    },
                }),
            );
            httpService.get
                .mockReturnValueOnce(
                    of({
                        data: {
                            id: 42,
                            login: 'octo',
                            name: 'Octo Cat',
                            email: 'octo@github.test',
                            avatar_url: 'https://avatars.test/octo.png',
                            node_id: 'NODE',
                            type: 'User',
                        },
                    }),
                )
                .mockReturnValueOnce(
                    of({
                        data: [
                            {
                                email: 'octo@github.test',
                                primary: true,
                                verified: true,
                            },
                        ],
                    }),
                );
            authService.validateSocialUser.mockResolvedValue({ user: { id: 'u1' } });

            const result = await service.authenticate(AuthProvider.GITHUB, 'auth-code');

            // POST request used the canonical GitHub token URL with form-encoded body
            const postCall = httpService.post.mock.calls[0];
            expect(postCall[0]).toBe('https://github.com/login/oauth/access_token');
            const postBody = postCall[1] as string;
            expect(postBody).toEqual(expect.stringContaining('client_id=gh-id'));
            expect(postBody).toEqual(expect.stringContaining('client_secret=gh-secret'));
            expect(postBody).toEqual(expect.stringContaining('code=auth-code'));
            expect(postBody).toEqual(
                expect.stringContaining(
                    `redirect_uri=${encodeURIComponent('https://app.test/api/oauth/github/callback')}`,
                ),
            );
            // GitHub explicitly OMITS grant_type
            expect(postBody).not.toEqual(expect.stringContaining('grant_type'));

            // GET headers carry GitHub OAuth bearer
            const getCalls = httpService.get.mock.calls;
            expect(getCalls[0][0]).toBe('https://api.github.com/user');
            expect(getCalls[0][1].headers.Authorization).toBe('Bearer gh-access');
            expect(getCalls[1][0]).toBe('https://api.github.com/user/emails');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: AuthProvider.GITHUB,
                    providerUserId: '42',
                    email: 'octo@github.test',
                    displayName: 'Octo Cat',
                    username: 'octo',
                    avatar: 'https://avatars.test/octo.png',
                    emailVerified: true,
                    accessToken: 'gh-access',
                    refreshToken: 'gh-refresh',
                    tokenType: 'bearer',
                    scope: 'repo',
                    expiresAt: null,
                    metadata: { login: 'octo', nodeId: 'NODE', type: 'User' },
                }),
            );
            expect(result).toEqual({ user: { id: 'u1' } });
        });

        it('uses callbackUrl override and computes expiresAt from expires_in', async () => {
            jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
            httpService.post.mockReturnValueOnce(
                of({
                    data: {
                        access_token: 'g-access',
                        expires_in: 3600,
                    },
                }),
            );
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        sub: 'g-sub',
                        email: 'g@google.test',
                        name: 'G User',
                        picture: 'https://g.test/pic.png',
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.GOOGLE, 'code', 'https://cb.test/google');

            const postBody = httpService.post.mock.calls[0][1] as string;
            expect(postBody).toEqual(expect.stringContaining('grant_type=authorization_code'));
            expect(postBody).toEqual(
                expect.stringContaining(
                    `redirect_uri=${encodeURIComponent('https://cb.test/google')}`,
                ),
            );

            const args = authService.validateSocialUser.mock.calls[0][0];
            expect(args.expiresAt).toBeInstanceOf(Date);
            expect((args.expiresAt as Date).getTime()).toBe(1_000_000 + 3600 * 1000);
            expect(args.refreshToken).toBeNull();
            expect(args.tokenType).toBeNull();
            expect(args.scope).toBeNull();
        });

        it('GitHub: throws when /user/emails returns no usable email and profile email is null', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'gh-access' } }));
            httpService.get
                .mockReturnValueOnce(
                    of({
                        data: {
                            id: 1,
                            login: 'no-mail',
                            email: null,
                            avatar_url: null,
                        },
                    }),
                )
                .mockReturnValueOnce(of({ data: [] }));

            await expect(service.authenticate(AuthProvider.GITHUB, 'c')).rejects.toThrow(
                'No email found in GitHub profile',
            );
            expect(authService.validateSocialUser).not.toHaveBeenCalled();
        });

        it('GitHub: falls back to login or email-local-part as displayName', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'a' } }));
            httpService.get
                .mockReturnValueOnce(
                    of({
                        data: {
                            id: 7,
                            login: 'octo',
                            name: null,
                            email: 'octo@github.test',
                            avatar_url: null,
                        },
                    }),
                )
                .mockReturnValueOnce(
                    of({
                        data: [{ email: 'octo@github.test', primary: true, verified: true }],
                    }),
                );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.GITHUB, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({ displayName: 'octo', username: 'octo' }),
            );
        });

        it('GitHub: when login also missing, displayName falls back to email local part', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'a' } }));
            httpService.get
                .mockReturnValueOnce(
                    of({
                        data: {
                            id: 9,
                            login: '',
                            name: null,
                            email: 'fallback@github.test',
                            avatar_url: null,
                        },
                    }),
                )
                .mockReturnValueOnce(
                    of({
                        data: [{ email: 'fallback@github.test', primary: true, verified: true }],
                    }),
                );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.GITHUB, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({ displayName: 'fallback', username: 'fallback' }),
            );
        });

        it('Google: throws when email missing', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'g' } }));
            httpService.get.mockReturnValueOnce(of({ data: { sub: 's', email: '' } }));

            await expect(service.authenticate(AuthProvider.GOOGLE, 'c')).rejects.toThrow(
                'No email found in Google profile',
            );
        });

        it('Google: emailVerified defaults to true unless explicitly false', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'g' } }));
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        sub: 'sub-1',
                        email: 'g@google.test',
                        // email_verified missing
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.GOOGLE, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    emailVerified: true,
                    providerUserId: 'sub-1',
                    username: 'g',
                    displayName: 'g',
                    avatar: null,
                    metadata: { sub: 'sub-1' },
                }),
            );
        });

        it('Google: explicit email_verified=false propagates', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'g' } }));
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        sub: 'sub-2',
                        email: 'g@google.test',
                        email_verified: false,
                        name: 'Real Name',
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.GOOGLE, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    emailVerified: false,
                    displayName: 'Real Name',
                }),
            );
        });

        it('Facebook: builds expected request and emailVerified is always false', async () => {
            httpService.post.mockReturnValueOnce(
                of({ data: { access_token: 'fb', token_type: 'bearer' } }),
            );
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        id: 'fb-123',
                        name: 'FB Name',
                        email: 'fb@fb.test',
                        picture: { data: { url: 'https://fb.test/pic.png' } },
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.FACEBOOK, 'c');

            const getCall = httpService.get.mock.calls[0];
            expect(getCall[0]).toBe('https://graph.facebook.com/me');
            expect(getCall[1].headers.Authorization).toBe('Bearer fb');
            expect(getCall[1].params).toEqual({
                fields: 'id,name,email,picture.type(large)',
            });

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: AuthProvider.FACEBOOK,
                    providerUserId: 'fb-123',
                    email: 'fb@fb.test',
                    displayName: 'FB Name',
                    username: 'FB Name',
                    avatar: 'https://fb.test/pic.png',
                    emailVerified: false,
                    metadata: { id: 'fb-123' },
                }),
            );
        });

        it('Facebook: throws BadRequestException when email missing', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'fb' } }));
            httpService.get.mockReturnValueOnce(of({ data: { id: 'fb-1' } }));

            await expect(service.authenticate(AuthProvider.FACEBOOK, 'c')).rejects.toThrow(
                'No email found in Facebook profile',
            );
        });

        it('Facebook: falls back to email local part when name missing, picture optional', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'fb' } }));
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        id: 'fb-77',
                        email: 'noname@fb.test',
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.FACEBOOK, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    displayName: 'noname',
                    username: 'noname',
                    avatar: null,
                }),
            );
        });

        it('LinkedIn: builds OIDC userinfo request and uses fallback name', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'li' } }));
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        sub: 'li-sub',
                        given_name: 'Jane',
                        family_name: 'Doe',
                        email: 'jane@li.test',
                        email_verified: true,
                        picture: 'https://li.test/jane.png',
                        locale: 'en-US',
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.LINKEDIN, 'c');

            expect(httpService.get.mock.calls[0][0]).toBe('https://api.linkedin.com/v2/userinfo');
            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: AuthProvider.LINKEDIN,
                    providerUserId: 'li-sub',
                    email: 'jane@li.test',
                    displayName: 'Jane Doe',
                    username: 'Jane Doe',
                    avatar: 'https://li.test/jane.png',
                    emailVerified: true,
                    metadata: { sub: 'li-sub', locale: 'en-US' },
                }),
            );
        });

        it('LinkedIn: prefers data.name over given/family name fallback', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'li' } }));
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        sub: 'li-sub-2',
                        name: 'Top Choice',
                        given_name: 'Ignored',
                        family_name: 'Ignored',
                        email: 'top@li.test',
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.LINKEDIN, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    displayName: 'Top Choice',
                    emailVerified: true,
                }),
            );
        });

        it('LinkedIn: falls back to email local part when no name fields, emailVerified=false honored', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'li' } }));
            httpService.get.mockReturnValueOnce(
                of({
                    data: {
                        sub: 'li-sub-3',
                        email: 'plain@li.test',
                        email_verified: false,
                    },
                }),
            );
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.LINKEDIN, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    displayName: 'plain',
                    username: 'plain',
                    emailVerified: false,
                    avatar: null,
                }),
            );
        });

        it('LinkedIn: throws when email missing', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { access_token: 'li' } }));
            httpService.get.mockReturnValueOnce(of({ data: { sub: 's' } }));

            await expect(service.authenticate(AuthProvider.LINKEDIN, 'c')).rejects.toThrow(
                'No email found in LinkedIn profile',
            );
        });

        it('throws BadRequestException when token response is missing access_token', async () => {
            httpService.post.mockReturnValueOnce(of({ data: { token_type: 'bearer' } }));

            await expect(service.authenticate(AuthProvider.GOOGLE, 'c')).rejects.toThrow(
                'Missing access_token from OAuth provider response',
            );
            expect(httpService.get).not.toHaveBeenCalled();
        });

        it('throws BadRequestException when client secret is not configured', async () => {
            delete process.env.GOOGLE_CLIENT_SECRET;

            await expect(service.authenticate(AuthProvider.GOOGLE, 'c')).rejects.toThrow(
                'google client secret is not configured',
            );
        });

        it('throws BadRequestException when client id is not configured', async () => {
            delete process.env.GOOGLE_CLIENT_ID;

            await expect(service.authenticate(AuthProvider.GOOGLE, 'c')).rejects.toThrow(
                'google client id is not configured',
            );
        });

        it('throws BadRequestException for unknown provider', async () => {
            await expect(service.authenticate('twitter', 'c')).rejects.toThrow(
                'Unsupported OAuth provider: twitter',
            );
        });

        it('readNumber: ignores non-number expires_in (string) -> expiresAt null', async () => {
            httpService.post.mockReturnValueOnce(
                of({
                    data: {
                        access_token: 'g',
                        expires_in: '3600', // string, not number
                    },
                }),
            );
            httpService.get.mockReturnValueOnce(of({ data: { sub: 's', email: 'g@google.test' } }));
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.GOOGLE, 'c');

            expect(authService.validateSocialUser).toHaveBeenCalledWith(
                expect.objectContaining({ expiresAt: null }),
            );
        });

        it('readOptionalString: ignores non-string token_type/scope', async () => {
            httpService.post.mockReturnValueOnce(
                of({
                    data: {
                        access_token: 'g',
                        token_type: 123,
                        scope: { unexpected: 'object' },
                        refresh_token: '',
                    },
                }),
            );
            httpService.get.mockReturnValueOnce(of({ data: { sub: 's', email: 'g@google.test' } }));
            authService.validateSocialUser.mockResolvedValue('ok');

            await service.authenticate(AuthProvider.GOOGLE, 'c');

            const args = authService.validateSocialUser.mock.calls[0][0];
            expect(args.tokenType).toBeNull();
            expect(args.scope).toBeNull();
            expect(args.refreshToken).toBeNull();
        });
    });
});
