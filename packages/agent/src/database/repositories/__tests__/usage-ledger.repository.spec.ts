import type { Repository, SelectQueryBuilder, UpdateQueryBuilder } from 'typeorm';
import { UsageLedgerRepository } from '../usage-ledger.repository';
import {
    UsageLedgerEntry,
    UsageLedgerStatus,
    UsageLedgerTriggerType,
} from '@src/entities/usage-ledger-entry.entity';

type Mocked = jest.Mocked<
    Pick<Repository<UsageLedgerEntry>, 'create' | 'save' | 'find' | 'createQueryBuilder'>
>;

describe('UsageLedgerRepository', () => {
    let repository: Mocked;
    let service: UsageLedgerRepository;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            createQueryBuilder: jest.fn(),
        };
        service = new UsageLedgerRepository(repository as unknown as Repository<UsageLedgerEntry>);
    });

    describe('record', () => {
        it('creates and saves the entry', async () => {
            const created = { units: 1 } as UsageLedgerEntry;
            const saved = { id: 'l1', units: 1 } as UsageLedgerEntry;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.record({ units: 1, userId: 'u1' });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({ units: 1, userId: 'u1' });
            expect(repository.save).toHaveBeenCalledWith(created);
        });
    });

    describe('findPendingByUser', () => {
        it('queries PENDING entries ordered by createdAt ASC for FIFO settlement', async () => {
            const rows = [{ id: 'l1' } as UsageLedgerEntry];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findPendingByUser('u1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: { userId: 'u1', status: UsageLedgerStatus.PENDING },
                order: { createdAt: 'ASC' },
            });
        });
    });

    describe('markQueued', () => {
        it('returns early without touching the query builder when ids are empty', async () => {
            await service.markQueued([]);
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });

        it('builds the chained update via createQueryBuilder().update().set().whereInIds().execute()', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: 2 });
            const whereInIds = jest.fn(function (this: unknown) {
                return { execute } as unknown as UpdateQueryBuilder<UsageLedgerEntry>;
            });
            const set = jest.fn(function (this: unknown) {
                return { whereInIds } as unknown as UpdateQueryBuilder<UsageLedgerEntry>;
            });
            const update = jest.fn(function (this: unknown) {
                return { set } as unknown as UpdateQueryBuilder<UsageLedgerEntry>;
            });
            repository.createQueryBuilder.mockReturnValueOnce({
                update,
            } as unknown as SelectQueryBuilder<UsageLedgerEntry>);

            await service.markQueued(['l1', 'l2']);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith();
            expect(update).toHaveBeenCalledWith(UsageLedgerEntry);
            expect(set).toHaveBeenCalledWith({ status: UsageLedgerStatus.QUEUED_FOR_SETTLEMENT });
            expect(whereInIds).toHaveBeenCalledWith(['l1', 'l2']);
            expect(execute).toHaveBeenCalledTimes(1);
        });
    });

    describe('getUsageSummary', () => {
        it('selects only units + amountCents and reduces them into the totals envelope', async () => {
            repository.find.mockResolvedValueOnce([
                { units: 2, amountCents: 100 } as UsageLedgerEntry,
                { units: 5, amountCents: 250 } as UsageLedgerEntry,
            ]);

            await expect(
                service.getUsageSummary('u1', UsageLedgerTriggerType.SCHEDULED),
            ).resolves.toEqual({ totalUnits: 7, totalAmountCents: 350 });

            expect(repository.find).toHaveBeenCalledWith({
                where: { userId: 'u1', triggerType: UsageLedgerTriggerType.SCHEDULED },
                select: ['units', 'amountCents'],
            });
        });

        it('coerces missing units/amountCents to 0 via `entry.units || 0` short-circuit', async () => {
            repository.find.mockResolvedValueOnce([
                {} as UsageLedgerEntry,
                { units: null, amountCents: null } as unknown as UsageLedgerEntry,
                { units: 3, amountCents: 99 } as UsageLedgerEntry,
            ]);

            await expect(
                service.getUsageSummary('u1', UsageLedgerTriggerType.MANUAL),
            ).resolves.toEqual({ totalUnits: 3, totalAmountCents: 99 });
        });

        it('returns the zero envelope when no entries are found', async () => {
            repository.find.mockResolvedValueOnce([]);
            await expect(
                service.getUsageSummary('u1', UsageLedgerTriggerType.MANUAL),
            ).resolves.toEqual({ totalUnits: 0, totalAmountCents: 0 });
        });
    });
});
