import type { Repository } from 'typeorm';
import { UserRepository } from '../user.repository';
import { User } from '../../../entities/user.entity';

jest.mock('node:crypto', () => ({
    randomUUID: jest.fn(() => 'fixed-uuid-1234'),
}));

type Mocked = jest.Mocked<
    Pick<Repository<User>, 'create' | 'save' | 'findOne' | 'update' | 'createQueryBuilder'>
>;

describe('UserRepository', () => {
    let repository: Mocked;
    let service: UserRepository;
    const ORIGINAL_ENV = { ...process.env };

    const mockUserQueryBuilder = (result: User | null) => {
        const queryBuilder = {
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(result),
        };
        repository.createQueryBuilder.mockReturnValue(queryBuilder as any);
        return queryBuilder;
    };

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn(),
        };
        service = new UserRepository(repository as unknown as Repository<User>);
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.clearAllMocks();
    });

    describe('create', () => {
        it('forwards partial userData through create() then save()', async () => {
            const created = { username: 'alice' } as User;
            const saved = { id: 'u1', username: 'alice' } as User;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.create({ username: 'alice', email: 'a@b.com' });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({
                username: 'alice',
                email: 'a@b.com',
            });
            expect(repository.save).toHaveBeenCalledWith(created);
        });
    });

    describe('findOne', () => {
        it('forwards FindOneOptions verbatim', async () => {
            const row = { id: 'u1' } as User;
            repository.findOne.mockResolvedValueOnce(row);

            const opts = { where: { id: 'u1' }, relations: ['accounts'] };
            await expect(service.findOne(opts)).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith(opts);
        });

        it('returns null when no row matches', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findOne({ where: { id: 'missing' } })).resolves.toBeNull();
        });
    });

    describe('findByUsername', () => {
        it('queries by username', async () => {
            const row = { id: 'u1', username: 'alice' } as User;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByUsername('alice')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({ where: { username: 'alice' } });
        });

        it('returns null on miss', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findByUsername('missing')).resolves.toBeNull();
        });
    });

    describe('findByEmail', () => {
        it('queries by email', async () => {
            const row = { id: 'u1' } as User;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByEmail('a@b.com')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
        });

        it('returns null on miss', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findByEmail('none@b.com')).resolves.toBeNull();
        });
    });

    describe('findByEmailForSocialAuth', () => {
        it('uses a narrow social-auth projection by email', async () => {
            const row = { id: 'u1', email: 'a@b.com' } as User;
            const queryBuilder = mockUserQueryBuilder(row);

            await expect(service.findByEmailForSocialAuth('a@b.com')).resolves.toBe(row);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('user');
            expect(queryBuilder.select).toHaveBeenCalledWith(
                expect.arrayContaining(['user.id', 'user.email', 'user.isActive']),
            );
            expect(queryBuilder.select.mock.calls[0][0]).not.toContain('user.failedLoginAttempts');
            expect(queryBuilder.select.mock.calls[0][0]).not.toContain('user.lockedUntil');
            expect(queryBuilder.where).toHaveBeenCalledWith({ email: 'a@b.com' });
        });
    });

    describe('findById', () => {
        it('queries by id', async () => {
            const row = { id: 'u1' } as User;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findById('u1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'u1' } });
        });

        it('returns null on miss', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findByIdForSocialAuth', () => {
        it('uses the same narrow social-auth projection by id', async () => {
            const row = { id: 'u1' } as User;
            const queryBuilder = mockUserQueryBuilder(row);

            await expect(service.findByIdForSocialAuth('u1')).resolves.toBe(row);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('user');
            expect(queryBuilder.select).toHaveBeenCalledWith(
                expect.arrayContaining(['user.id', 'user.email', 'user.isActive']),
            );
            expect(queryBuilder.select.mock.calls[0][0]).not.toContain('user.failedLoginAttempts');
            expect(queryBuilder.select.mock.calls[0][0]).not.toContain('user.lockedUntil');
            expect(queryBuilder.where).toHaveBeenCalledWith({ id: 'u1' });
        });
    });

    describe('update', () => {
        it('updates by id then refetches via findById', async () => {
            const refetched = { id: 'u1', username: 'alice' } as User;
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });
            repository.findOne.mockResolvedValueOnce(refetched);

            const result = await service.update('u1', { username: 'alice' });

            expect(result).toBe(refetched);
            expect(repository.update).toHaveBeenCalledWith('u1', { username: 'alice' });
            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'u1' } });
        });

        it('still returns the (possibly null) refetched row after update', async () => {
            repository.update.mockResolvedValueOnce({ affected: 0, raw: {}, generatedMaps: [] });
            repository.findOne.mockResolvedValueOnce(null);

            await expect(service.update('missing', { username: 'x' })).resolves.toBeNull();
        });
    });

    describe('updateForSocialAuth', () => {
        it('updates by id then refetches with the narrow social-auth projection', async () => {
            const refetched = { id: 'u1', email: 'a@b.com' } as User;
            const queryBuilder = mockUserQueryBuilder(refetched);
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            const result = await service.updateForSocialAuth('u1', {
                registrationProvider: 'github',
            });

            expect(result).toBe(refetched);
            expect(repository.update).toHaveBeenCalledWith('u1', {
                registrationProvider: 'github',
            });
            expect(queryBuilder.where).toHaveBeenCalledWith({ id: 'u1' });
        });
    });

    describe('clearPasswordResetToken', () => {
        it('clears both token and expiry on (id, token) match and returns true on hit', async () => {
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await expect(service.clearPasswordResetToken('u1', 'tok-abc')).resolves.toBe(true);

            expect(repository.update).toHaveBeenCalledWith(
                { id: 'u1', passwordResetToken: 'tok-abc' },
                { passwordResetToken: null, passwordResetExpires: null },
            );
        });

        it('returns false when no row was affected', async () => {
            repository.update.mockResolvedValueOnce({ affected: 0, raw: {}, generatedMaps: [] });
            await expect(service.clearPasswordResetToken('u1', 'tok-abc')).resolves.toBe(false);
        });

        it('coerces undefined affected to 0 (returns false)', async () => {
            repository.update.mockResolvedValueOnce({
                affected: undefined,
                raw: {},
                generatedMaps: [],
            });
            await expect(service.clearPasswordResetToken('u1', 'tok-abc')).resolves.toBe(false);
        });
    });

    describe('createOrGetLocalUser', () => {
        beforeEach(() => {
            delete process.env.GH_OWNER;
            delete process.env.GIT_NAME;
            delete process.env.GIT_EMAIL;
        });

        it('throws TypeError when both GH_OWNER and GIT_NAME are unset (current behaviour: username is undefined and `.trim()` crashes BEFORE the documented guard runs — pinned so a future "guard against undefined first" fix is a deliberate change)', async () => {
            process.env.GIT_EMAIL = 'g@b.com';

            await expect(service.createOrGetLocalUser()).rejects.toThrow(TypeError);
            expect(repository.findOne).not.toHaveBeenCalled();
        });

        it('throws TypeError when GIT_EMAIL is unset (current behaviour: email is undefined and `.trim()` crashes BEFORE the documented guard runs)', async () => {
            process.env.GH_OWNER = 'alice';

            await expect(service.createOrGetLocalUser()).rejects.toThrow(TypeError);
            expect(repository.findOne).not.toHaveBeenCalled();
        });

        it('throws the documented "username or Git name cannot both be empty" error when GH_OWNER and GIT_NAME are BOTH whitespace strings (i.e. defined but empty after trim)', async () => {
            process.env.GH_OWNER = '   ';
            process.env.GIT_NAME = '   ';
            process.env.GIT_EMAIL = 'g@b.com';

            await expect(service.createOrGetLocalUser()).rejects.toThrow(
                /username or Git name cannot both be empty/,
            );
            expect(repository.findOne).not.toHaveBeenCalled();
        });

        it('throws the documented "Git email cannot be empty" error when email is whitespace-only (defined but empty after trim)', async () => {
            process.env.GH_OWNER = 'alice';
            process.env.GIT_EMAIL = '   ';

            await expect(service.createOrGetLocalUser()).rejects.toThrow(
                /Git email cannot be empty/,
            );
            expect(repository.findOne).not.toHaveBeenCalled();
        });

        it('returns the existing user with local=true when one matches by username OR email', async () => {
            process.env.GH_OWNER = 'alice';
            process.env.GIT_EMAIL = 'a@b.com';
            const existing = { id: 'u1', username: 'alice', email: 'a@b.com' } as User;
            repository.findOne.mockResolvedValueOnce(existing);

            const result = await service.createOrGetLocalUser();

            expect(result).toBe(existing);
            expect(result.local).toBe(true);
            expect(repository.findOne).toHaveBeenCalledWith({
                where: [{ email: 'a@b.com' }, { username: 'alice' }],
            });
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('falls back to GIT_NAME when GH_OWNER is unset', async () => {
            process.env.GIT_NAME = 'alice-from-git';
            process.env.GIT_EMAIL = 'a@b.com';
            const existing = { id: 'u1' } as User;
            repository.findOne.mockResolvedValueOnce(existing);

            await service.createOrGetLocalUser();

            expect(repository.findOne).toHaveBeenCalledWith({
                where: [{ email: 'a@b.com' }, { username: 'alice-from-git' }],
            });
        });

        it('creates a new user with a randomUUID password and emailVerified:true when no row matches', async () => {
            process.env.GH_OWNER = 'alice';
            process.env.GIT_EMAIL = 'a@b.com';
            repository.findOne.mockResolvedValueOnce(null); // initial lookup
            const created = { username: 'alice' } as User;
            const saved = { id: 'u1', username: 'alice', email: 'a@b.com' } as User;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.createOrGetLocalUser();

            expect(result).toBe(saved);
            expect(result.local).toBe(true);
            expect(repository.create).toHaveBeenCalledWith({
                username: 'alice',
                email: 'a@b.com',
                password: 'fixed-uuid-1234',
                emailVerified: true,
            });
            expect(repository.save).toHaveBeenCalledWith(created);
        });

        it('mutates the resolved user.local in-place (no defensive copy)', async () => {
            process.env.GH_OWNER = 'alice';
            process.env.GIT_EMAIL = 'a@b.com';
            const existing = { id: 'u1', local: false } as User;
            repository.findOne.mockResolvedValueOnce(existing);

            const result = await service.createOrGetLocalUser();

            expect(result).toBe(existing); // identity, not just equality
            expect(existing.local).toBe(true);
        });
    });
});
