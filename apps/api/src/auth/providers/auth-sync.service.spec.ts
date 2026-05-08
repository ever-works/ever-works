jest.mock('@ever-works/agent/entities', () => ({
    AuthAccount: class AuthAccount {},
}));

import { AuthSyncService } from './auth-sync.service';
import { AuthAccount } from '@ever-works/agent/entities';

type RepoMock = {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
};

function createService() {
    const repository: RepoMock = {
        findOne: jest.fn(),
        save: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    };
    const dataSource = {
        getRepository: jest.fn().mockReturnValue(repository),
    } as any;

    const service = new AuthSyncService(dataSource);
    return { service, repository, dataSource };
}

describe('AuthSyncService', () => {
    describe('findCredentialAccount', () => {
        it('queries the AuthAccount repository with `userId` + `providerId: "credential"`', async () => {
            const { service, repository, dataSource } = createService();
            const stored = { id: 'a1', userId: 'u1', providerId: 'credential', password: 'h' };
            repository.findOne.mockResolvedValue(stored);

            const result = await service.findCredentialAccount('u1');

            expect(dataSource.getRepository).toHaveBeenCalledWith(AuthAccount);
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { userId: 'u1', providerId: 'credential' },
            });
            expect(result).toBe(stored);
        });

        it('returns null when no row exists for the user', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue(null);

            const result = await service.findCredentialAccount('missing');

            expect(result).toBeNull();
        });
    });

    describe('ensureCredentialAccount', () => {
        it('returns the existing credential row WITHOUT writing when one exists', async () => {
            const { service, repository } = createService();
            const existing = {
                id: 'a1',
                userId: 'u1',
                providerId: 'credential',
                password: 'oldHash',
            };
            repository.findOne.mockResolvedValue(existing);

            const result = await service.ensureCredentialAccount('u1', 'newHash');

            expect(result).toBe(existing);
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('creates and saves a new credential row when none exists', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue(null);

            const draft = {
                id: 'generated-uuid',
                userId: 'u1',
                providerId: 'credential',
                accountId: 'u1',
                password: 'h',
            };
            repository.create.mockReturnValue(draft);
            const saved = { ...draft, id: 'persisted' };
            repository.save.mockResolvedValue(saved);

            const result = await service.ensureCredentialAccount('u1', 'h');

            expect(repository.create).toHaveBeenCalledTimes(1);
            const createArg = repository.create.mock.calls[0][0];
            expect(createArg).toMatchObject({
                userId: 'u1',
                providerId: 'credential',
                accountId: 'u1',
                password: 'h',
            });
            // `id` is generated via crypto.randomUUID(); we just assert it's a non-empty string.
            expect(typeof createArg.id).toBe('string');
            expect(createArg.id.length).toBeGreaterThan(0);

            expect(repository.save).toHaveBeenCalledWith(draft);
            expect(result).toBe(saved);
        });

        it('uses `userId` for BOTH `userId` and `accountId` on the new row', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue(null);
            repository.create.mockImplementation((d) => d);
            repository.save.mockImplementation(async (d) => d);

            await service.ensureCredentialAccount('user-123', 'hash');

            const createArg = repository.create.mock.calls[0][0];
            expect(createArg.userId).toBe('user-123');
            expect(createArg.accountId).toBe('user-123');
        });

        it('generates a fresh UUID per call', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue(null);
            repository.create.mockImplementation((d) => d);
            repository.save.mockImplementation(async (d) => d);

            await service.ensureCredentialAccount('u1', 'h');
            await service.ensureCredentialAccount('u2', 'h');

            const id1 = repository.create.mock.calls[0][0].id;
            const id2 = repository.create.mock.calls[1][0].id;
            expect(id1).not.toBe(id2);
        });
    });

    describe('syncCredentialPassword', () => {
        it('falls through to `ensureCredentialAccount` when no row exists', async () => {
            const { service, repository } = createService();
            // findOne returns null on the first lookup (sync) AND on the second (ensure).
            repository.findOne.mockResolvedValue(null);
            repository.create.mockImplementation((d) => d);
            repository.save.mockImplementation(async (d) => d);

            await service.syncCredentialPassword('u1', 'newHash');

            // Ensure path was taken — create+save fired, update did NOT.
            expect(repository.create).toHaveBeenCalledTimes(1);
            expect(repository.save).toHaveBeenCalledTimes(1);
            expect(repository.update).not.toHaveBeenCalled();
        });

        it('updates the existing row by id when a credential account exists', async () => {
            const { service, repository } = createService();
            const existing = {
                id: 'a1',
                userId: 'u1',
                providerId: 'credential',
                password: 'oldHash',
            };
            repository.findOne.mockResolvedValue(existing);

            await service.syncCredentialPassword('u1', 'newHash');

            expect(repository.update).toHaveBeenCalledWith('a1', { password: 'newHash' });
            // No `create`/`save` on the update path.
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('writes ONLY the password field on update (no other columns touched)', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue({ id: 'a1', password: 'oldHash' });

            await service.syncCredentialPassword('u1', 'h');

            const [, partial] = repository.update.mock.calls[0];
            expect(Object.keys(partial)).toEqual(['password']);
            expect(partial.password).toBe('h');
        });
    });

    describe('getCredentialPasswordHash', () => {
        it('returns the password hash when a credential account exists', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue({ id: 'a1', password: 'theHash' });

            const result = await service.getCredentialPasswordHash('u1');

            expect(result).toBe('theHash');
        });

        it('returns null when no credential account exists', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue(null);

            const result = await service.getCredentialPasswordHash('missing');

            expect(result).toBeNull();
        });

        it('returns null when the credential account has no password (null)', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue({ id: 'a1', password: null });

            const result = await service.getCredentialPasswordHash('u1');

            expect(result).toBeNull();
        });

        it('returns null when the credential account has an empty-string password (falsy)', async () => {
            const { service, repository } = createService();
            repository.findOne.mockResolvedValue({ id: 'a1', password: '' });

            const result = await service.getCredentialPasswordHash('u1');

            // `account?.password || null` collapses '' → null.
            expect(result).toBeNull();
        });
    });
});
