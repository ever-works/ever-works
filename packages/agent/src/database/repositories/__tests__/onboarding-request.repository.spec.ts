import type { Repository, SelectQueryBuilder, UpdateQueryBuilder } from 'typeorm';
import { OnboardingRequestRepository } from '../onboarding-request.repository';
import { OnboardingRequest } from '../../../entities';
import type { OnboardingStatus } from '../../../entities/onboarding-request.entity';

type Mocked = jest.Mocked<
    Pick<
        Repository<OnboardingRequest>,
        'findOne' | 'create' | 'save' | 'update' | 'createQueryBuilder'
    >
>;

describe('OnboardingRequestRepository', () => {
    let repository: Mocked;
    let service: OnboardingRequestRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn(),
        };
        service = new OnboardingRequestRepository(
            repository as unknown as Repository<OnboardingRequest>,
        );
    });

    describe('findByIdentityAndRepo', () => {
        it('forwards both keys into the where clause', async () => {
            const row = { id: 'o1' } as OnboardingRequest;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(
                service.findByIdentityAndRepo('hash', 'https://github.com/foo/bar'),
            ).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: {
                    githubIdentityHash: 'hash',
                    repoUrlCanonical: 'https://github.com/foo/bar',
                },
            });
        });

        it('returns null when no row exists', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findByIdentityAndRepo('h', 'r')).resolves.toBeNull();
        });
    });

    describe('findByRepo', () => {
        it('queries only on repoUrlCanonical', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await service.findByRepo('https://github.com/foo/bar');
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { repoUrlCanonical: 'https://github.com/foo/bar' },
            });
        });
    });

    describe('findById', () => {
        it('queries by id', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await service.findById('o1');
            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'o1' } });
        });
    });

    describe('create', () => {
        it('creates and saves the row', async () => {
            const created = {} as OnboardingRequest;
            const saved = { id: 'o1' } as OnboardingRequest;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.create({ repoUrlCanonical: 'r' });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({ repoUrlCanonical: 'r' });
            expect(repository.save).toHaveBeenCalledWith(created);
        });
    });

    describe('tryTransition', () => {
        it('returns true when the conditional update affected at least one row', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: 1 });
            const where = jest.fn(function (this: unknown) {
                return { execute } as unknown as UpdateQueryBuilder<OnboardingRequest>;
            });
            const set = jest.fn(function (this: unknown) {
                return { where } as unknown as UpdateQueryBuilder<OnboardingRequest>;
            });
            const update = jest.fn(function (this: unknown) {
                return { set } as unknown as UpdateQueryBuilder<OnboardingRequest>;
            });
            repository.createQueryBuilder.mockReturnValueOnce({
                update,
            } as unknown as SelectQueryBuilder<OnboardingRequest>);

            const result = await service.tryTransition('o1', 'received' as OnboardingStatus, 'validating' as OnboardingStatus, { workId: 'w1' });

            expect(result).toBe(true);
            expect(update).toHaveBeenCalledTimes(1);
            expect(set).toHaveBeenCalledWith({ status: 'validating', workId: 'w1' });
            expect(where).toHaveBeenCalledWith('id = :id AND status = :from', {
                id: 'o1',
                from: 'received',
            });
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('returns false when affected is 0 (someone else won the race)', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: 0 });
            const where = jest.fn().mockReturnValueOnce({ execute });
            const set = jest.fn().mockReturnValueOnce({ where });
            const update = jest.fn().mockReturnValueOnce({ set });
            repository.createQueryBuilder.mockReturnValueOnce({
                update,
            } as unknown as SelectQueryBuilder<OnboardingRequest>);

            const result = await service.tryTransition('o1', 'received' as OnboardingStatus, 'validating' as OnboardingStatus);

            expect(result).toBe(false);
            // No `extra` argument → set() called with just the status patch
            expect(set).toHaveBeenCalledWith({ status: 'validating' });
        });

        it('coerces undefined affected to 0 (returns false)', async () => {
            const execute = jest.fn().mockResolvedValueOnce({});
            const where = jest.fn().mockReturnValueOnce({ execute });
            const set = jest.fn().mockReturnValueOnce({ where });
            const update = jest.fn().mockReturnValueOnce({ set });
            repository.createQueryBuilder.mockReturnValueOnce({
                update,
            } as unknown as SelectQueryBuilder<OnboardingRequest>);

            await expect(service.tryTransition('o1', 'received' as OnboardingStatus, 'validating' as OnboardingStatus)).resolves.toBe(false);
        });
    });

    describe('markFailure', () => {
        it('writes status="failed" + failureCode + failureDetail', async () => {
            await service.markFailure('o1', 'invalid_repo', { hint: 'private' });
            expect(repository.update).toHaveBeenCalledWith('o1', {
                status: 'failed',
                failureCode: 'invalid_repo',
                failureDetail: { hint: 'private' },
            });
        });

        it('passes undefined failureDetail through verbatim (no defensive coercion)', async () => {
            await service.markFailure('o1', 'invalid_repo');
            expect(repository.update).toHaveBeenCalledWith('o1', {
                status: 'failed',
                failureCode: 'invalid_repo',
                failureDetail: undefined,
            });
        });
    });

    describe('setWorkId', () => {
        it('updates only the workId column', async () => {
            await service.setWorkId('o1', 'w1');
            expect(repository.update).toHaveBeenCalledWith('o1', { workId: 'w1' });
        });
    });

    describe('setAccountId', () => {
        it('updates only the accountId column', async () => {
            await service.setAccountId('o1', 'acc-1');
            expect(repository.update).toHaveBeenCalledWith('o1', { accountId: 'acc-1' });
        });
    });
});
