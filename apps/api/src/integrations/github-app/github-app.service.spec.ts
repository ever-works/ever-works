import { of } from 'rxjs';
import { GitHubAppService } from './github-app.service';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

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
