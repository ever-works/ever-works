import type { Repository } from 'typeorm';
import { SubscriptionPlanRepository } from '../subscription-plan.repository';
import { SubscriptionPlan } from '@src/entities/subscription-plan.entity';
import { SubscriptionPlanCode } from '@src/entities/types';
type Mocked = jest.Mocked<
    Pick<Repository<SubscriptionPlan>, 'find' | 'findOne' | 'update' | 'upsert' | 'create' | 'save'>
>;

describe('SubscriptionPlanRepository', () => {
    let repository: Mocked;
    let service: SubscriptionPlanRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            upsert: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
        };
        service = new SubscriptionPlanRepository(
            repository as unknown as Repository<SubscriptionPlan>,
        );
    });

    describe('findAllActive', () => {
        it('queries for active plans only', async () => {
            const rows = [{ id: 'p1' } as SubscriptionPlan];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findAllActive()).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({ where: { active: true } });
        });

        it('returns the empty array verbatim when no rows match', async () => {
            repository.find.mockResolvedValueOnce([]);
            await expect(service.findAllActive()).resolves.toEqual([]);
        });
    });

    describe('findByCode', () => {
        it('forwards the code into the where clause', async () => {
            const row = { id: 'p1', code: SubscriptionPlanCode.STANDARD } as SubscriptionPlan;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByCode(SubscriptionPlanCode.STANDARD)).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { code: SubscriptionPlanCode.STANDARD },
            });
        });

        it('returns null when no plan exists for the code', async () => {
            repository.findOne.mockResolvedValueOnce(null);

            await expect(service.findByCode(SubscriptionPlanCode.PREMIUM)).resolves.toBeNull();
        });
    });

    describe('upsert', () => {
        it('uses one database-atomic conflict operation for a coded plan', async () => {
            const persisted = {
                id: 'p1',
                code: SubscriptionPlanCode.FREE,
                maxWorks: 5,
            } as SubscriptionPlan;
            repository.upsert.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(persisted);

            await expect(
                service.upsert({ code: SubscriptionPlanCode.FREE, maxWorks: 5 }),
            ).resolves.toBe(persisted);

            expect(repository.upsert).toHaveBeenCalledWith(
                { code: SubscriptionPlanCode.FREE, maxWorks: 5 },
                { conflictPaths: ['code'] },
            );
            expect(repository.update).not.toHaveBeenCalled();
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('atomically updates and refetches when a plan with the same code exists', async () => {
            const updated = {
                id: 'p1',
                code: SubscriptionPlanCode.FREE,
                maxWorks: 5,
            } as SubscriptionPlan;
            repository.upsert.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(updated);

            const result = await service.upsert({ code: SubscriptionPlanCode.FREE, maxWorks: 5 });

            expect(result).toBe(updated);
            expect(repository.upsert).toHaveBeenCalledWith(
                { code: SubscriptionPlanCode.FREE, maxWorks: 5 },
                { conflictPaths: ['code'] },
            );
            expect(repository.update).not.toHaveBeenCalled();
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { code: SubscriptionPlanCode.FREE },
            });
        });

        it('atomically inserts and refetches when no plan with the code exists', async () => {
            const saved = { id: 'p2', code: SubscriptionPlanCode.PREMIUM } as SubscriptionPlan;
            repository.upsert.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(saved);

            const result = await service.upsert({
                code: SubscriptionPlanCode.PREMIUM,
                displayName: 'Premium',
            });

            expect(result).toBe(saved);
            expect(repository.upsert).toHaveBeenCalledWith(
                {
                    code: SubscriptionPlanCode.PREMIUM,
                    displayName: 'Premium',
                },
                { conflictPaths: ['code'] },
            );
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
            expect(repository.update).not.toHaveBeenCalled();
        });

        it('fails loudly if the coded row cannot be read after the atomic write', async () => {
            repository.upsert.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(null);

            await expect(
                service.upsert({ code: SubscriptionPlanCode.STANDARD, displayName: 'Standard' }),
            ).rejects.toThrow('Subscription plan standard missing after upsert');
        });

        it('skips the findByCode lookup entirely when the partial has no code', async () => {
            const created = {} as SubscriptionPlan;
            const saved = { id: 'p3' } as SubscriptionPlan;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.upsert({ displayName: 'Anonymous' });

            expect(result).toBe(saved);
            expect(repository.findOne).not.toHaveBeenCalled();
            expect(repository.create).toHaveBeenCalledWith({ displayName: 'Anonymous' });
            expect(repository.save).toHaveBeenCalledWith(created);
        });
    });
});
