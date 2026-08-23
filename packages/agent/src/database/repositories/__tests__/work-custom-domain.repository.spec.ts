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
            find: jest.fn().mockResolvedValue([]),
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
        it('returns the deterministic case-insensitive identity match', async () => {
            const row = { id: 'd1' } as WorkCustomDomain;
            repository.find.mockResolvedValueOnce([row]);

            await expect(service.findOne('work-1', 'example.com')).resolves.toBe(row);
        });

        it('returns null when no record exists', async () => {
            repository.find.mockResolvedValueOnce([]);
            await expect(service.findOne('work-1', 'missing.com')).resolves.toBeNull();
        });

        it('reuses the verified record first when legacy case variants already exist', async () => {
            const older = {
                id: 'd1',
                domain: 'EVER.WORKS',
                verified: false,
                createdAt: new Date('2026-01-01T00:00:00Z'),
            } as WorkCustomDomain;
            const verified = {
                id: 'd2',
                domain: 'Ever.Works',
                verified: true,
                createdAt: new Date('2026-02-01T00:00:00Z'),
            } as WorkCustomDomain;
            repository.find.mockResolvedValueOnce([verified, older]);

            await expect(service.findOne('work-1', 'ever.works')).resolves.toBe(verified);
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

        it('canonicalizes every new supported domain write', async () => {
            repository.find.mockResolvedValueOnce([]);
            repository.create.mockReturnValueOnce({} as WorkCustomDomain);
            repository.save.mockResolvedValueOnce({ domain: 'ever.works' } as WorkCustomDomain);

            await service.addDomain('work-1', '  Ever.Works  ', 'manual');

            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({ domain: 'ever.works' }),
            );
        });

        it('preserves and reuses a legacy mixed-case record', async () => {
            const existing = {
                id: 'd1',
                domain: 'Ever.Works',
                verified: true,
                provider: 'manual',
            } as WorkCustomDomain;
            repository.find.mockResolvedValueOnce([existing]);

            await expect(service.addDomain('work-1', 'ever.works')).resolves.toBe(existing);
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('recovers only an expected same-domain uniqueness race by rereading', async () => {
            const raced = {
                id: 'd1',
                workId: 'work-1',
                domain: 'ever.works',
                verified: false,
            } as WorkCustomDomain;
            repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([raced]);
            repository.create.mockReturnValueOnce({} as WorkCustomDomain);
            repository.save.mockRejectedValueOnce(
                Object.assign(
                    new Error(
                        'UNIQUE constraint failed: work_custom_domains.workId, work_custom_domains.domain',
                    ),
                    { code: 'SQLITE_CONSTRAINT_UNIQUE' },
                ),
            );

            await expect(service.addDomain('work-1', 'Ever.Works')).resolves.toBe(raced);
        });

        it('does not swallow an unrelated constraint failure', async () => {
            const error = Object.assign(
                new Error('UNIQUE constraint failed: work_custom_domains.id'),
                { code: 'SQLITE_CONSTRAINT_UNIQUE' },
            );
            repository.find.mockResolvedValueOnce([]);
            repository.create.mockReturnValueOnce({} as WorkCustomDomain);
            repository.save.mockRejectedValueOnce(error);

            await expect(service.addDomain('work-1', 'Ever.Works')).rejects.toBe(error);
        });

        it('rereads and retries a bounded SQLite BUSY write', async () => {
            const saved = { id: 'd1', domain: 'ever.works' } as WorkCustomDomain;
            Object.assign(repository, {
                manager: { connection: { options: { type: 'better-sqlite3' } } },
            });
            repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
            repository.create.mockReturnValueOnce({} as WorkCustomDomain);
            repository.save
                .mockRejectedValueOnce(
                    Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
                )
                .mockResolvedValueOnce(saved);

            await expect(service.addDomain('work-1', 'Ever.Works')).resolves.toBe(saved);
            expect(repository.save).toHaveBeenCalledTimes(2);
        });

        it('keeps the bounded retry when the post-BUSY reread is also locked', async () => {
            const saved = { id: 'd1', domain: 'ever.works' } as WorkCustomDomain;
            const busy = Object.assign(new Error('database is locked'), {
                code: 'SQLITE_BUSY',
            });
            Object.assign(repository, {
                manager: { connection: { options: { type: 'better-sqlite3' } } },
            });
            repository.find.mockResolvedValueOnce([]).mockRejectedValueOnce(busy);
            repository.create.mockReturnValueOnce({} as WorkCustomDomain);
            repository.save.mockRejectedValueOnce(busy).mockResolvedValueOnce(saved);

            await expect(service.addDomain('work-1', 'Ever.Works')).resolves.toBe(saved);
            expect(repository.save).toHaveBeenCalledTimes(2);
        });

        it('bounds SQLite BUSY retries and surfaces exhaustion', async () => {
            Object.assign(repository, {
                manager: { connection: { options: { type: 'better-sqlite3' } } },
            });
            const error = Object.assign(new Error('database is locked'), {
                code: 'SQLITE_LOCKED',
            });
            repository.find.mockResolvedValue([]);
            repository.create.mockReturnValueOnce({} as WorkCustomDomain);
            repository.save.mockRejectedValue(error);

            await expect(service.addDomain('work-1', 'Ever.Works')).rejects.toBe(error);
            expect(repository.save).toHaveBeenCalledTimes(6);
        });
    });

    describe('removeDomain', () => {
        it('returns true when at least one row was affected', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.delete.mockResolvedValueOnce({ affected: 1, raw: {} });

            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(true);

            expect(repository.delete).toHaveBeenCalledWith({
                id: 'd1',
            });
        });

        it('returns false when no rows were deleted', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.delete.mockResolvedValueOnce({ affected: 0, raw: {} });
            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(false);
        });

        it('coerces undefined affected to 0 (returns false)', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.delete.mockResolvedValueOnce({ affected: undefined, raw: {} });
            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(false);
        });

        it('coerces null affected to 0 (returns false)', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.delete.mockResolvedValueOnce({ affected: null, raw: {} } as never);
            await expect(service.removeDomain('work-1', 'example.com')).resolves.toBe(false);
        });

        it('does not issue a delete when no case-insensitive identity exists', async () => {
            repository.find.mockResolvedValueOnce([]);

            await expect(service.removeDomain('work-1', 'missing.com')).resolves.toBe(false);
            expect(repository.delete).not.toHaveBeenCalled();
        });
    });

    describe('updateVerified', () => {
        it('updates verified field on the (workId, domain) composite key', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await expect(
                service.updateVerified('work-1', 'example.com', true),
            ).resolves.toBeUndefined();

            expect(repository.update).toHaveBeenCalledWith({ id: 'd1' }, { verified: true });
        });

        it('forwards verified=false verbatim', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await service.updateVerified('work-1', 'example.com', false);

            expect(repository.update).toHaveBeenCalledWith({ id: 'd1' }, { verified: false });
        });
    });

    describe('updateProvider', () => {
        it('updates provider field on the (workId, domain) composite key', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await expect(
                service.updateProvider('work-1', 'example.com', 'vercel'),
            ).resolves.toBeUndefined();

            expect(repository.update).toHaveBeenCalledWith({ id: 'd1' }, { provider: 'vercel' });
        });

        it('forwards an arbitrary provider string verbatim', async () => {
            repository.find.mockResolvedValueOnce([{ id: 'd1' } as WorkCustomDomain]);
            repository.update.mockResolvedValueOnce({ affected: 1, raw: {}, generatedMaps: [] });

            await service.updateProvider('work-1', 'example.com', 'cloudflare');

            expect(repository.update).toHaveBeenCalledWith(
                { id: 'd1' },
                { provider: 'cloudflare' },
            );
        });
    });
});
