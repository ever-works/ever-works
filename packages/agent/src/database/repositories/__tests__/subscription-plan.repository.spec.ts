import type { Repository } from 'typeorm';
import { SubscriptionPlanRepository } from '../subscription-plan.repository';
import { SubscriptionPlan, SubscriptionPlanCode } from '@src/entities';

type Mocked = jest.Mocked<
    Pick<Repository<SubscriptionPlan>, 'find' | 'findOne' | 'update' | 'create' | 'save'>
>;

describe('SubscriptionPlanRepository', () => {
    let repository: Mocked;
    let service: SubscriptionPlanRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
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
        it('updates by id and refetches when an existing plan with the same code is found', async () => {
            const existing = { id: 'p1', code: SubscriptionPlanCode.FREE } as SubscriptionPlan;
            const updated = {
                id: 'p1',
                code: SubscriptionPlanCode.FREE,
                maxWorks: 5,
            } as SubscriptionPlan;
            repository.findOne
                .mockResolvedValueOnce(existing) // findByCode lookup
                .mockResolvedValueOnce(updated); // refetch by id

            const result = await service.upsert({ code: SubscriptionPlanCode.FREE, maxWorks: 5 });

            expect(result).toBe(updated);
            expect(repository.update).toHaveBeenCalledWith(existing.id, {
                code: SubscriptionPlanCode.FREE,
                maxWorks: 5,
            });
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
            expect(repository.findOne).toHaveBeenNthCalledWith(2, { where: { id: existing.id } });
        });

        it('creates and saves when no plan with the code exists', async () => {
            const created = { code: SubscriptionPlanCode.PREMIUM } as SubscriptionPlan;
            const saved = { id: 'p2', code: SubscriptionPlanCode.PREMIUM } as SubscriptionPlan;
            repository.findOne.mockResolvedValueOnce(null);
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.upsert({
                code: SubscriptionPlanCode.PREMIUM,
                displayName: 'Premium',
            });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({
                code: SubscriptionPlanCode.PREMIUM,
                displayName: 'Premium',
            });
            expect(repository.save).toHaveBeenCalledWith(created);
            expect(repository.update).not.toHaveBeenCalled();
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
