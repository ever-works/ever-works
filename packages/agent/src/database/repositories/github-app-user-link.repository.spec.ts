import { ConflictException } from '@nestjs/common';
import { GitHubAppUserLinkRepository } from './github-app-user-link.repository';

describe('GitHubAppUserLinkRepository', () => {
    let repository: {
        findOne: jest.Mock;
        findOneOrFail: jest.Mock;
        update: jest.Mock;
        save: jest.Mock;
        create: jest.Mock;
    };
    let userLinkRepository: GitHubAppUserLinkRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            update: jest.fn(),
            save: jest.fn(),
            create: jest.fn((value) => value),
        };

        userLinkRepository = new GitHubAppUserLinkRepository(repository as any);
    });

    it('updates an existing link for the same user', async () => {
        repository.findOne
            .mockResolvedValueOnce({
                id: 'link-1',
                userId: 'user-1',
                githubUserId: 'gh-1',
            })
            .mockResolvedValueOnce(null);
        repository.findOneOrFail.mockResolvedValue({
            id: 'link-1',
            userId: 'user-1',
            githubUserId: 'gh-1',
            githubLogin: 'octocat',
        });

        const result = await userLinkRepository.upsertLink({
            userId: 'user-1',
            githubUserId: 'gh-1',
            githubLogin: 'octocat',
        });

        expect(repository.update).toHaveBeenCalledWith(
            'link-1',
            expect.objectContaining({
                userId: 'user-1',
                githubUserId: 'gh-1',
            }),
        );
        expect(result).toEqual({
            id: 'link-1',
            userId: 'user-1',
            githubUserId: 'gh-1',
            githubLogin: 'octocat',
        });
    });

    it('recovers from a concurrent insert race by updating the persisted link', async () => {
        repository.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 'link-1',
                userId: 'user-1',
                githubUserId: 'gh-1',
            });
        repository.save.mockRejectedValue({ code: '23505' });
        repository.findOneOrFail.mockResolvedValue({
            id: 'link-1',
            userId: 'user-1',
            githubUserId: 'gh-1',
            githubLogin: 'octocat',
        });

        const result = await userLinkRepository.upsertLink({
            userId: 'user-1',
            githubUserId: 'gh-1',
            githubLogin: 'octocat',
        });

        expect(repository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                githubUserId: 'gh-1',
            }),
        );
        expect(repository.update).toHaveBeenCalledWith(
            'link-1',
            expect.objectContaining({
                userId: 'user-1',
                githubUserId: 'gh-1',
            }),
        );
        expect(result).toEqual({
            id: 'link-1',
            userId: 'user-1',
            githubUserId: 'gh-1',
            githubLogin: 'octocat',
        });
    });

    it('throws a conflict when the github identity belongs to another user after a race', async () => {
        repository.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 'link-user',
                userId: 'user-1',
                githubUserId: 'gh-2',
            })
            .mockResolvedValueOnce({
                id: 'link-github',
                userId: 'user-2',
                githubUserId: 'gh-1',
            });
        repository.save.mockRejectedValue({ code: '23505' });

        await expect(
            userLinkRepository.upsertLink({
                userId: 'user-1',
                githubUserId: 'gh-1',
                githubLogin: 'octocat',
            }),
        ).rejects.toBeInstanceOf(ConflictException);
    });
});
