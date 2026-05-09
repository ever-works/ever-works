import type { Repository } from 'typeorm';
import { WorkCustomDomainRepository } from '../work-custom-domain.repository';
import { WorkCustomDomain } from '../../../entities/work-custom-domain.entity';

type Mocked = jest.Mocked<
    Pick<Repository<WorkCustomDomain>, 'find' | 'findOne' | 'create' | 'save' | 'delete' | 'update'>
>;

describe('WorkCustomDomainRepository', () => {
    let repository: Mocked;
    let service: WorkCustomDomainRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            update: jest.fn(),
        };
        service = new WorkCustomDomainRepository(
            repository as unknown as Repository<WorkCustomDomain>,
        );
    });

    describe('findByWork', () => {
        it('queries by workId ordered by createdAt ASC', async () => {
            const rows = [{ id: 'd1' } as WorkCustomDomain, { id: 'd2' } as WorkCustomDomain];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findByWork('work-1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: { workId: 'work-1' },
                order: { createdAt: 'ASC' },
            });
        });

        it('returns the empty array verbatim when no rows match', async () => {
            repository.find.mockResolvedValueOnce([]);
            await expect(service.findByWork('work-1')).resolves.toEqual([]);
        });
    });

    describe('findOne', () => {
        it('forwards the (workId, domain) composite key into the where clause', async () => {
            const row = { id: 'd1' } as WorkCustomDomain;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findOne('work-1', 'example.com')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { workId: 'work-1', domain: 'example.com' },
            });
        });

        it('returns null when no record exists', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findOne('work-1', 'missing.com')).resolves.toBeNull();
        });
    });

    describe('addDomain', () => {
        it('creates a record with verified=false and forwards provider', async () => {
            const created = {} as WorkCustomDomain;
            const saved = { id: 'd1' } as WorkCustomDomain;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.addDomain('work-1', 'example.com', 'vercel');

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({
                workId: 'work-1',
                domain: 'example.com',
                verified: false,
                provider: 'vercel',
            });
            expect(repository.save).toHaveBeenCalledWith(created);
        });

        it('passes provider as undefined when omitted (column defaults to null)', async () => {
            repository.create.mockReturnValueOnce({} as WorkCustomDomain);
            repository.save.mockResolvedValueOnce({} as WorkCustomDomain);

            await service.addDomain('work-1', 'example.com');

            expect(repository.create).toHaveBeenCalledWith({
                workId: 'work-1',
                domain: 'example.com',
                verified: false,
                provider: undefined,
            });
        });
    });

    describe('removeDomain', () => {
        it('returns true when at least one row was affected', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 1, raw: {} });

            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(true);

            expect(repository.delete).toHaveBeenCalledWith({
                workId: 'work-1',
                domain: 'example.com',
            });
        });

        it('returns false when no rows were deleted', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 0, raw: {} });
            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(false);
        });

        it('coerces undefined affected to 0 (returns false)', async () => {
            repository.delete.mockResolvedValueOnce({ affected: undefined, raw: {} });
            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(false);
        });

        it('coerces null affected to 0 (returns false)', async () => {
            repository.delete.mockResolvedValueOnce({ affected: null, raw: {} } as never);
            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(false);
        });
    });

    describe('updateVerified', () => {
        it('updates verified field on the (workId, domain) composite key', async () => {
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await expect(
                service.updateVerified('work-1', 'example.com', true),
            ).resolves.toBeUndefined();

            expect(repository.update).toHaveBeenCalledWith(
                { workId: 'work-1', domain: 'example.com' },
                { verified: true },
            );
        });

        it('forwards verified=false verbatim', async () => {
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await service.updateVerified('work-1', 'example.com', false);

            expect(repository.update).toHaveBeenCalledWith(
                { workId: 'work-1', domain: 'example.com' },
                { verified: false },
            );
        });
    });

    describe('updateProvider', () => {
        it('updates provider field on the (workId, domain) composite key', async () => {
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await expect(
                service.updateProvider('work-1', 'example.com', 'vercel'),
            ).resolves.toBeUndefined();

            expect(repository.update).toHaveBeenCalledWith(
                { workId: 'work-1', domain: 'example.com' },
                { provider: 'vercel' },
            );
        });

        it('forwards an arbitrary provider string verbatim', async () => {
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await service.updateProvider('work-1', 'example.com', 'cloudflare');

            expect(repository.update).toHaveBeenCalledWith(
                { workId: 'work-1', domain: 'example.com' },
                { provider: 'cloudflare' },
            );
        });
    });
});
