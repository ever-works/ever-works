import { AxiosError } from 'axios';
import { resolveGitHubAccountEmail } from './github-email.utils';
import { of, throwError } from 'rxjs';

describe('resolveGitHubAccountEmail', () => {
    const createHttpService = (
        emails: Array<{ email: string; primary?: boolean; verified?: boolean }>,
    ) =>
        ({
            get: jest.fn().mockReturnValue(
                of({
                    data: emails,
                }),
            ),
        }) as any;

    it('prefers a verified email from /user/emails over an unverified public profile email', async () => {
        const httpService = createHttpService([
            {
                email: 'public@example.com',
                primary: false,
                verified: false,
            },
            {
                email: 'verified@example.com',
                primary: true,
                verified: true,
            },
        ]);

        const result = await resolveGitHubAccountEmail(httpService, 'token', 'public@example.com');

        expect(result).toEqual({
            email: 'verified@example.com',
            emailVerified: true,
        });
    });

    it('keeps the profile email but marks it unverified when no verified GitHub email exists', async () => {
        const httpService = createHttpService([
            {
                email: 'public@example.com',
                primary: true,
                verified: false,
            },
        ]);

        const result = await resolveGitHubAccountEmail(httpService, 'token', 'public@example.com');

        expect(result).toEqual({
            email: 'public@example.com',
            emailVerified: false,
        });
    });

    it('returns the verified primary email when the profile endpoint has no email', async () => {
        const httpService = createHttpService([
            {
                email: 'primary@example.com',
                primary: true,
                verified: true,
            },
        ]);

        const result = await resolveGitHubAccountEmail(httpService, 'token', null);

        expect(result).toEqual({
            email: 'primary@example.com',
            emailVerified: true,
        });
    });

    // Prod 2026-10-09: a GitHub *App* user-to-server token may only read
    // /user/emails when the App requests the account permission "Email
    // addresses: read". Without it GitHub answers 403/404 and the whole
    // installation callback failed (installation left unclaimed).
    describe('when /user/emails is not readable (missing "Email addresses: read")', () => {
        const axiosHttpError = (status: number, headers: Record<string, string> = {}) =>
            new AxiosError(
                `Request failed with status code ${status}`,
                status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
                { headers: {} } as never,
                {},
                {
                    status,
                    statusText: 'error',
                    data: { message: 'Resource not accessible by integration' },
                    headers,
                    config: { headers: {} } as never,
                },
            );
        const failingHttpService = (error: unknown) =>
            ({
                get: jest.fn().mockReturnValue(throwError(() => error)),
            }) as any;

        it.each([403, 404])(
            'GitHub App path: %i falls back to the profile email, marked UNVERIFIED, and warns naming the permission',
            async (status) => {
                const logger = { warn: jest.fn() };
                const httpService = failingHttpService(axiosHttpError(status));

                const result = await resolveGitHubAccountEmail(
                    httpService,
                    'ghu_SECRET_USER_TOKEN',
                    '  owner@example.com ',
                    { allowMissingEmailPermission: true, logger },
                );

                expect(result).toEqual({ email: 'owner@example.com', emailVerified: false });
                expect(httpService.get).toHaveBeenCalledWith(
                    'https://api.github.com/user/emails',
                    expect.anything(),
                );
                expect(logger.warn).toHaveBeenCalledTimes(1);
                expect(logger.warn.mock.calls[0][0]).toContain('Email addresses: read');
                expect(logger.warn.mock.calls[0][0]).toContain(String(status));
                // Names-never-values: the warning never carries the token or the email.
                expect(logger.warn.mock.calls[0][0]).not.toContain('ghu_SECRET_USER_TOKEN');
                expect(logger.warn.mock.calls[0][0]).not.toContain('owner@example.com');
            },
        );

        it('GitHub App path: no public profile email -> email null, unverified (caller synthesises a placeholder)', async () => {
            const result = await resolveGitHubAccountEmail(
                failingHttpService(axiosHttpError(403)),
                'token',
                null,
                { allowMissingEmailPermission: true },
            );

            expect(result).toEqual({ email: null, emailVerified: false });
        });

        it.each([401, 500, 502])(
            'GitHub App path: %i is NOT a missing permission and still throws',
            async (status) => {
                const error = axiosHttpError(status);

                await expect(
                    resolveGitHubAccountEmail(
                        failingHttpService(error),
                        'token',
                        'owner@example.com',
                        { allowMissingEmailPermission: true },
                    ),
                ).rejects.toBe(error);
            },
        );

        it.each([
            ['primary rate limit', { 'x-ratelimit-remaining': '0' }],
            ['secondary rate limit', { 'retry-after': '60' }],
        ])(
            'GitHub App path: a 403 %s is throttling, not a missing permission, and still throws',
            async (_label, headers) => {
                const error = axiosHttpError(403, headers);

                await expect(
                    resolveGitHubAccountEmail(
                        failingHttpService(error),
                        'token',
                        'owner@example.com',
                        { allowMissingEmailPermission: true },
                    ),
                ).rejects.toBe(error);
            },
        );

        it('GitHub App path: a non-HTTP error (network, programming) still throws', async () => {
            const networkError = new AxiosError('read ECONNRESET', 'ECONNRESET');
            const bug = new TypeError('bug');

            await expect(
                resolveGitHubAccountEmail(failingHttpService(networkError), 'token', 'a@b.co', {
                    allowMissingEmailPermission: true,
                }),
            ).rejects.toBe(networkError);
            await expect(
                resolveGitHubAccountEmail(failingHttpService(bug), 'token', 'a@b.co', {
                    allowMissingEmailPermission: true,
                }),
            ).rejects.toBe(bug);
        });

        it('the opt-in does not change a readable /user/emails: verified emails still win', async () => {
            const result = await resolveGitHubAccountEmail(
                createHttpService([
                    { email: 'public@example.com', primary: false, verified: false },
                    { email: 'verified@example.com', primary: true, verified: true },
                ]),
                'token',
                'public@example.com',
                { allowMissingEmailPermission: true },
            );

            expect(result).toEqual({ email: 'verified@example.com', emailVerified: true });
        });

        it.each([403, 404])(
            'OAuth-App sign-in path (default options): %i keeps throwing, unchanged',
            async (status) => {
                const error = axiosHttpError(status);

                await expect(
                    resolveGitHubAccountEmail(failingHttpService(error), 'token', 'a@b.co'),
                ).rejects.toBe(error);
            },
        );
    });
});
