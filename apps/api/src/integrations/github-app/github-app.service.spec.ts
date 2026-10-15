import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { GitHubAppService } from './github-app.service';
import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';

describe('GitHubAppService', () => {
    const createService = () => {
        const httpService = {
            get: jest.fn(),
            post: jest.fn(),
        };

        const service = new GitHubAppService(httpService as any);

        return {
            service,
            httpService,
        };
    };

    describe('exchangeUserCode', () => {
        it('throws when GitHub returns an OAuth error payload', async () => {
            const { service, httpService } = createService();
            httpService.post.mockReturnValue(
                of({
                    data: {
                        error: 'bad_verification_code',
                        error_description: 'The code passed is incorrect or expired.',
                    },
                }),
            );

            await expect(service.exchangeUserCode('bad-code')).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
        });

        it('throws when GitHub does not return an access token', async () => {
            const { service, httpService } = createService();
            httpService.post.mockReturnValue(
                of({
                    data: {
                        token_type: 'bearer',
                    },
                }),
            );

            await expect(service.exchangeUserCode('bad-code')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    // Prod 2026-10-09: the App was installed without the account permission
    // "Email addresses: read", GET /user/emails answered 403, and the whole
    // installation callback failed — the installation stayed unclaimed.
    describe('getAuthenticatedGithubUser', () => {
        const axiosHttpError = (status: number) =>
            new AxiosError(
                `Request failed with status code ${status}`,
                AxiosError.ERR_BAD_REQUEST,
                { headers: {} } as never,
                {},
                {
                    status,
                    statusText: 'error',
                    data: { message: 'Resource not accessible by integration' },
                    headers: {},
                    config: { headers: {} } as never,
                },
            );
        const githubProfile = {
            id: 4242,
            login: 'octo-owner',
            name: 'Octo Owner',
            email: 'owner@example.com',
            avatar_url: 'https://avatars.example.com/u/4242',
            node_id: 'MDQ6VXNlcjQyNDI=',
        };

        let warnSpy: jest.SpyInstance;

        beforeEach(() => {
            warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        });

        afterEach(() => {
            warnSpy.mockRestore();
        });

        it.each([403, 404])(
            'degrades a %i from /user/emails to the UNVERIFIED profile email instead of failing',
            async (status) => {
                const { service, httpService } = createService();
                httpService.get
                    .mockReturnValueOnce(of({ data: githubProfile }))
                    .mockReturnValueOnce(throwError(() => axiosHttpError(status)));

                const user = await service.getAuthenticatedGithubUser('ghu_user_token');

                expect(user).toEqual(
                    expect.objectContaining({
                        githubUserId: '4242',
                        login: 'octo-owner',
                        email: 'owner@example.com',
                        emailVerified: false,
                    }),
                );
                expect(httpService.get).toHaveBeenNthCalledWith(
                    2,
                    'https://api.github.com/user/emails',
                    expect.anything(),
                );
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Email addresses: read'),
                );
            },
        );

        it('still fails on a 5xx from /user/emails (a broken upstream is not a missing permission)', async () => {
            const { service, httpService } = createService();
            const upstream = new AxiosError(
                'boom',
                AxiosError.ERR_BAD_RESPONSE,
                undefined,
                {},
                {
                    status: 502,
                    statusText: 'error',
                    data: {},
                    headers: {},
                    config: { headers: {} } as never,
                },
            );
            httpService.get
                .mockReturnValueOnce(of({ data: githubProfile }))
                .mockReturnValueOnce(throwError(() => upstream));

            await expect(service.getAuthenticatedGithubUser('ghu_user_token')).rejects.toBe(
                upstream,
            );
        });

        it('returns the verified email when the App can read /user/emails', async () => {
            const { service, httpService } = createService();
            httpService.get.mockReturnValueOnce(of({ data: githubProfile })).mockReturnValueOnce(
                of({
                    data: [{ email: 'owner@example.com', primary: true, verified: true }],
                }),
            );

            const user = await service.getAuthenticatedGithubUser('ghu_user_token');

            expect(user.email).toBe('owner@example.com');
            expect(user.emailVerified).toBe(true);
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    // Claim authority for an Organization installation (review on #2578):
    // only an ACTIVE org ADMIN could have installed the App there.
    describe('isActiveOrgAdmin', () => {
        const membership = (state: string, role: string) => of({ data: { state, role } });
        const httpError = (status: number) =>
            new AxiosError(
                `Request failed with status code ${status}`,
                status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
                undefined,
                {},
                {
                    status,
                    statusText: 'error',
                    data: {},
                    headers: {},
                    config: { headers: {} } as never,
                },
            );

        let warnSpy: jest.SpyInstance;

        beforeEach(() => {
            warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        });

        afterEach(() => {
            warnSpy.mockRestore();
        });

        it('is true for an active admin, asking GitHub about the token user only', async () => {
            const { service, httpService } = createService();
            httpService.get.mockReturnValueOnce(membership('active', 'admin'));

            await expect(service.isActiveOrgAdmin('ghu_token', 'ever-co')).resolves.toBe(true);
            expect(httpService.get).toHaveBeenCalledWith(
                'https://api.github.com/user/memberships/orgs/ever-co',
                expect.objectContaining({
                    headers: expect.objectContaining({ Authorization: expect.any(String) }),
                }),
            );
        });

        it('is false for an active member who is not an admin', async () => {
            const { service, httpService } = createService();
            httpService.get.mockReturnValueOnce(membership('active', 'member'));

            await expect(service.isActiveOrgAdmin('ghu_token', 'ever-co')).resolves.toBe(false);
        });

        it('is false for a pending (not yet accepted) admin invitation', async () => {
            const { service, httpService } = createService();
            httpService.get.mockReturnValueOnce(membership('pending', 'admin'));

            await expect(service.isActiveOrgAdmin('ghu_token', 'ever-co')).resolves.toBe(false);
        });

        it('is false for an outside collaborator (GitHub answers 404: not a member)', async () => {
            const { service, httpService } = createService();
            httpService.get.mockReturnValueOnce(throwError(() => httpError(404)));

            await expect(service.isActiveOrgAdmin('ghu_token', 'ever-co')).resolves.toBe(false);
        });

        it.each([403, 500, 502])(
            'fails closed on a membership API error (%i) and warns, status only',
            async (status) => {
                const { service, httpService } = createService();
                httpService.get.mockReturnValueOnce(throwError(() => httpError(status)));

                await expect(service.isActiveOrgAdmin('ghu_SECRET', 'ever-co')).resolves.toBe(
                    false,
                );
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`status=${status}`));
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Members: read'));
                expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('ghu_SECRET'));
            },
        );

        it('is false for a malformed org login without calling GitHub', async () => {
            const { service, httpService } = createService();

            await expect(service.isActiveOrgAdmin('ghu_token', '../user')).resolves.toBe(false);
            await expect(service.isActiveOrgAdmin('ghu_token', '')).resolves.toBe(false);
            expect(httpService.get).not.toHaveBeenCalled();
        });
    });

    describe('listInstallationRepositories', () => {
        it('fetches all installation repositories across paginated responses', async () => {
            const { service, httpService } = createService();
            jest.spyOn(service, 'createInstallationAccessToken').mockResolvedValue(
                'installation-token',
            );

            httpService.get
                .mockReturnValueOnce(
                    of({
                        data: {
                            total_count: 101,
                            repositories: Array.from({ length: 100 }, (_, index) => ({
                                id: index + 1,
                                name: `repo-${index + 1}`,
                                full_name: `acme/repo-${index + 1}`,
                                private: false,
                            })),
                        },
                    }),
                )
                .mockReturnValueOnce(
                    of({
                        data: {
                            total_count: 101,
                            repositories: [
                                {
                                    id: 101,
                                    name: 'repo-101',
                                    full_name: 'acme/repo-101',
                                    private: false,
                                },
                            ],
                        },
                    }),
                );

            const repositories = await service.listInstallationRepositories('12345');

            expect(repositories).toHaveLength(101);
            expect(httpService.get).toHaveBeenNthCalledWith(
                1,
                'https://api.github.com/installation/repositories',
                expect.objectContaining({
                    params: {
                        per_page: 100,
                        page: 1,
                    },
                }),
            );
            expect(httpService.get).toHaveBeenNthCalledWith(
                2,
                'https://api.github.com/installation/repositories',
                expect.objectContaining({
                    params: {
                        per_page: 100,
                        page: 2,
                    },
                }),
            );
        });
    });
});
