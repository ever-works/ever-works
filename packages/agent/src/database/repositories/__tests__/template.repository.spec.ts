import type { Repository } from 'typeorm';
import { MoreThanOrEqual } from 'typeorm';
import { TemplateRepository } from '../template.repository';
import { Template } from '../../../entities/template.entity';

type Mocked = jest.Mocked<
    Pick<
        Repository<Template>,
        'find' | 'findOne' | 'findOneOrFail' | 'exists' | 'upsert' | 'update'
    >
>;

describe('TemplateRepository', () => {
    let repository: Mocked;
    let service: TemplateRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn(),
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            exists: jest.fn(),
            upsert: jest.fn(),
            update: jest.fn(),
        };
        service = new TemplateRepository(repository as unknown as Repository<Template>);
    });

    describe('findById', () => {
        it('queries by id', async () => {
            const row = { id: 't1' } as Template;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findById('t1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 't1' } });
        });

        it('returns null when missing', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findVisibleByKind', () => {
        it('returns built_in templates plus user-owned customs, sorted by sourceType DESC then name ASC', async () => {
            const rows = [
                { id: 't1', sourceType: 'custom', name: 'A' } as unknown as Template,
                { id: 't2', sourceType: 'built_in', name: 'B' } as unknown as Template,
            ];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findVisibleByKind('website', 'u1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: [
                    { kind: 'website', sourceType: 'built_in', isActive: true },
                    { kind: 'website', ownerUserId: 'u1', sourceType: 'custom', isActive: true },
                ],
                order: { sourceType: 'DESC', name: 'ASC' },
            });
        });

        it('forwards kind=work verbatim', async () => {
            repository.find.mockResolvedValueOnce([]);

            await service.findVisibleByKind('work', 'u1');

            expect(repository.find).toHaveBeenCalledWith({
                where: [
                    { kind: 'work', sourceType: 'built_in', isActive: true },
                    { kind: 'work', ownerUserId: 'u1', sourceType: 'custom', isActive: true },
                ],
                order: { sourceType: 'DESC', name: 'ASC' },
            });
        });
    });

    describe('findVisibleById', () => {
        it('queries by id with the same built_in OR owned-custom OR-array', async () => {
            const row = { id: 't1' } as Template;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findVisibleById('t1', 'u1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: [
                    { id: 't1', sourceType: 'built_in', isActive: true },
                    { id: 't1', ownerUserId: 'u1', sourceType: 'custom', isActive: true },
                ],
            });
        });

        it('returns null on miss', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findVisibleById('t1', 'u1')).resolves.toBeNull();
        });
    });

    describe('findOwnedCustomById', () => {
        it('queries with sourceType:custom + ownerUserId match (active filter omitted — archived rows still found by id)', async () => {
            const row = { id: 't1' } as Template;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findOwnedCustomById('t1', 'u1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 't1', ownerUserId: 'u1', sourceType: 'custom' },
            });
        });
    });

    describe('findOwnedCustomByRepositoryUrl', () => {
        it('queries with active+custom and the provided repositoryUrl', async () => {
            const row = { id: 't1' } as Template;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(
                service.findOwnedCustomByRepositoryUrl(
                    'website',
                    'u1',
                    'https://github.com/foo/bar',
                ),
            ).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: {
                    kind: 'website',
                    ownerUserId: 'u1',
                    sourceType: 'custom',
                    isActive: true,
                    repositoryUrl: 'https://github.com/foo/bar',
                },
            });
        });
    });

    describe('findOwnedCustomByRepositoryCoordinates', () => {
        it('queries by (kind, ownerUserId, repositoryOwner, repositoryName) tuple with isActive filter', async () => {
            const row = { id: 't1' } as Template;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(
                service.findOwnedCustomByRepositoryCoordinates('website', 'u1', 'foo', 'bar'),
            ).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: {
                    kind: 'website',
                    ownerUserId: 'u1',
                    sourceType: 'custom',
                    isActive: true,
                    repositoryOwner: 'foo',
                    repositoryName: 'bar',
                },
            });
        });
    });

    describe('findBuiltInByRepositoryCoordinates', () => {
        it('queries built_in rows ordered by id ASC for deterministic dedup when duplicates exist', async () => {
            const row = { id: 't1' } as Template;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(
                service.findBuiltInByRepositoryCoordinates('website', 'foo', 'bar'),
            ).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: {
                    kind: 'website',
                    sourceType: 'built_in',
                    repositoryOwner: 'foo',
                    repositoryName: 'bar',
                },
                order: { id: 'ASC' },
            });
        });
    });

    describe('hasRecentDiscoveredBuiltInTemplates', () => {
        it('uses MoreThanOrEqual on updatedAt and a Raw LIKE on metadata for the discoveredFromOrganization marker', async () => {
            repository.exists.mockResolvedValueOnce(true);
            const since = new Date('2026-01-01T00:00:00Z');

            await expect(
                service.hasRecentDiscoveredBuiltInTemplates('website', 'ever-works', since),
            ).resolves.toBe(true);

            expect(repository.exists).toHaveBeenCalledTimes(1);
            const call = (repository.exists as jest.Mock).mock.calls[0][0];
            expect(call.where.kind).toBe('website');
            expect(call.where.sourceType).toBe('built_in');
            expect(call.where.isActive).toBe(true);
            // MoreThanOrEqual returns a FindOperator — assert structurally via constructor.
            expect(call.where.updatedAt).toEqual(MoreThanOrEqual(since));
            // The Raw operator wraps a closure (different identity each call) and an opaque
            // params object; assert the params and the type tag, not closure identity.
            expect(call.where.metadata).toBeDefined();
            expect(call.where.metadata._type).toBe('raw');
            expect(call.where.metadata._objectLiteralParameters).toEqual({
                ownerMarker: '%"discoveredFromOrganization":"ever-works"%',
            });
        });

        it('returns false when no recent rows match', async () => {
            repository.exists.mockResolvedValueOnce(false);

            await expect(
                service.hasRecentDiscoveredBuiltInTemplates('work', 'ever-works', new Date(0)),
            ).resolves.toBe(false);
        });
    });

    describe('upsert', () => {
        it('upserts on conflictPaths:["id"] then refetches via findOneOrFail', async () => {
            const refetched = { id: 't1', name: 'fresh' } as Template;
            repository.upsert.mockResolvedValueOnce({
                identifiers: [],
                generatedMaps: [],
                raw: {},
            });
            repository.findOneOrFail.mockResolvedValueOnce(refetched);

            const result = await service.upsert({ id: 't1', name: 'fresh' });

            expect(result).toBe(refetched);
            expect(repository.upsert).toHaveBeenCalledWith(
                { id: 't1', name: 'fresh' },
                { conflictPaths: ['id'] },
            );
            expect(repository.findOneOrFail).toHaveBeenCalledWith({ where: { id: 't1' } });
        });

        it('propagates findOneOrFail rejection (e.g. EntityNotFoundError)', async () => {
            repository.upsert.mockResolvedValueOnce({
                identifiers: [],
                generatedMaps: [],
                raw: {},
            });
            const boom = new Error('not found after upsert');
            repository.findOneOrFail.mockRejectedValueOnce(boom);

            await expect(service.upsert({ id: 't1' })).rejects.toBe(boom);
        });
    });

    describe('updateById', () => {
        it('updates by id then refetches via findOneOrFail', async () => {
            const refetched = { id: 't1', name: 'updated' } as Template;
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });
            repository.findOneOrFail.mockResolvedValueOnce(refetched);

            const result = await service.updateById('t1', { name: 'updated' });

            expect(result).toBe(refetched);
            expect(repository.update).toHaveBeenCalledWith('t1', { name: 'updated' });
            expect(repository.findOneOrFail).toHaveBeenCalledWith({ where: { id: 't1' } });
        });

        it('propagates findOneOrFail rejection if the row was deleted concurrently', async () => {
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });
            const boom = new Error('row vanished');
            repository.findOneOrFail.mockRejectedValueOnce(boom);

            await expect(service.updateById('t1', {})).rejects.toBe(boom);
        });
    });
});
