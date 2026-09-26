import type { Repository } from 'typeorm';
import { UserTemplatePreferenceRepository } from '../user-template-preference.repository';
import { UserTemplatePreference } from '../../../entities/user-template-preference.entity';
import type { TemplateKind } from '../../../entities/template.entity';

type Mocked = jest.Mocked<
    Pick<
        Repository<UserTemplatePreference>,
        'findOne' | 'findOneOrFail' | 'upsert' | 'delete' | 'find'
    >
>;

describe('UserTemplatePreferenceRepository', () => {
    let repository: Mocked;
    let service: UserTemplatePreferenceRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn(),
            find: jest.fn(),
        };
        service = new UserTemplatePreferenceRepository(
            repository as unknown as Repository<UserTemplatePreference>,
        );
    });

    describe('findByUserAndKind', () => {
        it.each<[TemplateKind]>([['website'], ['work']])(
            'forwards userId + kind into the where clause for kind=%s',
            async (kind) => {
                const row = { userId: 'u1', kind } as UserTemplatePreference;
                repository.findOne.mockResolvedValueOnce(row);

                await expect(service.findByUserAndKind('u1', kind)).resolves.toBe(row);
                expect(repository.findOne).toHaveBeenCalledWith({ where: { userId: 'u1', kind } });
            },
        );

        it('returns null when no preference exists', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(
                service.findByUserAndKind('u1', 'website' as TemplateKind),
            ).resolves.toBeNull();
        });
    });

    describe('upsertDefault', () => {
        it('uses TypeORM upsert with the (userId, kind) conflict path then refetches', async () => {
            const fetched = {
                userId: 'u1',
                kind: 'website',
                templateId: 't1',
            } as UserTemplatePreference;
            repository.findOneOrFail.mockResolvedValueOnce(fetched);

            const result = await service.upsertDefault('u1', 'website' as TemplateKind, 't1');

            expect(result).toBe(fetched);
            expect(repository.upsert).toHaveBeenCalledWith(
                { userId: 'u1', kind: 'website', templateId: 't1' },
                { conflictPaths: ['userId', 'kind'] },
            );
            expect(repository.findOneOrFail).toHaveBeenCalledWith({
                where: { userId: 'u1', kind: 'website' },
            });
        });

        it('propagates findOneOrFail rejection (refetch could not locate the just-upserted row)', async () => {
            const boom = new Error('not found');
            repository.findOneOrFail.mockRejectedValueOnce(boom);

            await expect(service.upsertDefault('u1', 'work' as TemplateKind, 't2')).rejects.toBe(
                boom,
            );
        });
    });

    describe('findUserIdsByKindAndTemplateId', () => {
        it('returns the ids of every user whose default for the kind is that template', async () => {
            repository.find.mockResolvedValueOnce([
                { userId: 'u1' } as UserTemplatePreference,
                { userId: 'u2' } as UserTemplatePreference,
            ]);

            await expect(
                service.findUserIdsByKindAndTemplateId('website' as TemplateKind, 'cal-template'),
            ).resolves.toEqual(['u1', 'u2']);

            expect(repository.find).toHaveBeenCalledWith({
                where: { kind: 'website', templateId: 'cal-template' },
                select: { userId: true },
            });
        });

        it('returns an empty list when nobody prefers the template', async () => {
            repository.find.mockResolvedValueOnce([]);

            await expect(
                service.findUserIdsByKindAndTemplateId('website' as TemplateKind, 'cal-template'),
            ).resolves.toEqual([]);
        });
    });

    describe('deleteByUserKindAndTemplateId', () => {
        it('forwards the composite key into delete', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 1, raw: {} });

            await expect(
                service.deleteByUserKindAndTemplateId('u1', 'website' as TemplateKind, 't1'),
            ).resolves.toBeUndefined();

            expect(repository.delete).toHaveBeenCalledWith({
                userId: 'u1',
                kind: 'website',
                templateId: 't1',
            });
        });

        it('does not throw when no rows matched (delete is silent)', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 0, raw: {} });
            await expect(
                service.deleteByUserKindAndTemplateId('u1', 'work' as TemplateKind, 't1'),
            ).resolves.toBeUndefined();
        });
    });
});
