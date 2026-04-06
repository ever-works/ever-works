import {
    cloneFreshRepository,
    isFreshRepositoryCloneRetryable,
} from '../fresh-repository-clone.utils';

describe('fresh-repository-clone.utils', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('retries when a freshly created repository returns 404 before becoming available', async () => {
        const gitFacade = {
            cloneOrPull: jest
                .fn()
                .mockRejectedValueOnce(new Error('HTTP Error: 404 Not Found'))
                .mockRejectedValueOnce(new Error('Could not find repository'))
                .mockResolvedValue('/tmp/fresh-repo'),
        };
        const logger = { warn: jest.fn() };

        const promise = cloneFreshRepository(
            gitFacade,
            {
                owner: 'paradoxe35',
                repo: 'ml-datasets',
                committer: { name: 'Test User', email: 'test@example.com' },
                userId: 'user-1',
                providerId: 'github',
            },
            logger,
        );

        await jest.runAllTimersAsync();

        await expect(promise).resolves.toBe('/tmp/fresh-repo');
        expect(gitFacade.cloneOrPull).toHaveBeenCalledTimes(3);
        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-retryable clone failures', async () => {
        const gitFacade = {
            cloneOrPull: jest.fn().mockRejectedValue(new Error('401 Unauthorized')),
        };
        const logger = { warn: jest.fn() };

        const promise = cloneFreshRepository(
            gitFacade,
            {
                owner: 'paradoxe35',
                repo: 'ml-datasets',
                committer: { name: 'Test User', email: 'test@example.com' },
                userId: 'user-1',
                providerId: 'github',
            },
            logger,
        );

        await expect(promise).rejects.toThrow('401 Unauthorized');
        expect(gitFacade.cloneOrPull).toHaveBeenCalledTimes(1);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('classifies transient fresh-repository clone errors correctly', () => {
        expect(isFreshRepositoryCloneRetryable(new Error('HTTP Error: 404 Not Found'))).toBe(true);
        expect(isFreshRepositoryCloneRetryable(new Error('ECONNRESET while cloning'))).toBe(true);
        expect(isFreshRepositoryCloneRetryable(new Error('401 Unauthorized'))).toBe(false);
    });
});
