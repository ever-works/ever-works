import { LessThan, type Repository } from 'typeorm';
import { RefreshTokenRepository } from '../refresh-token.repository';
import { RefreshToken } from '../../../entities/refresh-token.entity';

type Mocked = jest.Mocked<
    Pick<Repository<RefreshToken>, 'create' | 'save' | 'findOne' | 'find' | 'update' | 'delete'>
>;

describe('RefreshTokenRepository', () => {
    let repository: Mocked;
    let service: RefreshTokenRepository;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        };
        service = new RefreshTokenRepository(repository as unknown as Repository<RefreshToken>);
    });

    describe('create', () => {
        it('creates the row and saves it', async () => {
            const created = { token: 't1' } as RefreshToken;
            const saved = { id: 'r1', token: 't1' } as RefreshToken;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.create({ token: 't1', userId: 'u1' });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({ token: 't1', userId: 'u1' });
            expect(repository.save).toHaveBeenCalledWith(created);
        });
    });

    describe('findByToken', () => {
        it('queries by token + revoked:false and joins the user relation', async () => {
            const row = { token: 't1' } as RefreshToken;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByToken('t1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { token: 't1', revoked: false },
                relations: ['user'],
            });
        });

        it('returns null when no matching token exists', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findByToken('missing')).resolves.toBeNull();
        });
    });

    describe('findByUserId', () => {
        it('queries by userId + revoked:false (active tokens only)', async () => {
            const rows = [{ id: 'r1' } as RefreshToken];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findByUserId('u1')).resolves.toBe(rows);
            expect(repository.find).toHaveBeenCalledWith({
                where: { userId: 'u1', revoked: false },
            });
        });
    });

    describe('findByFamily', () => {
        it('returns ALL tokens in the family (revoked or not) ordered by createdAt DESC', async () => {
            const rows = [{ id: 'r1' } as RefreshToken];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findByFamily('fam1')).resolves.toBe(rows);
            expect(repository.find).toHaveBeenCalledWith({
                where: { family: 'fam1' },
                order: { createdAt: 'DESC' },
            });
        });
    });

    describe('revokeToken', () => {
        it('flags revoked + sets revokedAt + revokedReason', async () => {
            const before = Date.now();
            await service.revokeToken('t1', 'user-logout');

            const [where, patch] = repository.update.mock.calls[0] as [
                { token: string },
                { revoked: boolean; revokedAt: Date; revokedReason: string },
            ];
            expect(where).toEqual({ token: 't1' });
            expect(patch.revoked).toBe(true);
            expect(patch.revokedAt.getTime()).toBeGreaterThanOrEqual(before);
            expect(patch.revokedReason).toBe('user-logout');
        });
    });

    describe('revokeAllUserTokens', () => {
        it('updates only the still-active tokens for the user', async () => {
            await service.revokeAllUserTokens('u1', 'password-changed');

            const [where, patch] = repository.update.mock.calls[0] as [
                { userId: string; revoked: boolean },
                { revoked: boolean; revokedReason: string },
            ];
            expect(where).toEqual({ userId: 'u1', revoked: false });
            expect(patch.revoked).toBe(true);
            expect(patch.revokedReason).toBe('password-changed');
        });
    });

    describe('revokeTokenFamily', () => {
        it('updates only still-active tokens in the family (rotation reuse detection)', async () => {
            await service.revokeTokenFamily('fam1', 'rotation-reuse');

            const [where, patch] = repository.update.mock.calls[0] as [
                { family: string; revoked: boolean },
                { revoked: boolean; revokedReason: string },
            ];
            expect(where).toEqual({ family: 'fam1', revoked: false });
            expect(patch.revoked).toBe(true);
            expect(patch.revokedReason).toBe('rotation-reuse');
        });
    });

    describe('deleteExpiredTokens', () => {
        it('deletes rows where expiresAt < now and returns affected count', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 4, raw: {} });

            await expect(service.deleteExpiredTokens()).resolves.toBe(4);

            const where = repository.delete.mock.calls[0][0] as {
                expiresAt: ReturnType<typeof LessThan>;
            };
            // class-validator-style operator instances expose `_value` for assertion. The
            // shape (`LessThan(Date)`) is exercised here so a future swap to a different
            // operator (e.g. `BeforeDate`) breaks loudly.
            expect(where.expiresAt).toEqual(LessThan(expect.any(Date)));
        });

        it('coerces missing affected to 0', async () => {
            repository.delete.mockResolvedValueOnce({ raw: {} } as never);
            await expect(service.deleteExpiredTokens()).resolves.toBe(0);
        });
    });

    describe('deleteRevokedTokensOlderThan', () => {
        it('deletes only revoked rows whose revokedAt is older than the cutoff and returns affected', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 9, raw: {} });
            const cutoff = new Date('2025-01-01T00:00:00Z');

            await expect(service.deleteRevokedTokensOlderThan(cutoff)).resolves.toBe(9);

            const where = repository.delete.mock.calls[0][0] as {
                revoked: boolean;
                revokedAt: ReturnType<typeof LessThan>;
            };
            expect(where.revoked).toBe(true);
            expect(where.revokedAt).toEqual(LessThan(cutoff));
        });

        it('coerces missing affected to 0', async () => {
            repository.delete.mockResolvedValueOnce({ raw: {} } as never);
            await expect(service.deleteRevokedTokensOlderThan(new Date())).resolves.toBe(0);
        });
    });
});
