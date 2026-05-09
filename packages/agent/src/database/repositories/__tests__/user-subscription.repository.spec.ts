import type { Repository } from 'typeorm';
import { UserSubscriptionRepository } from '../user-subscription.repository';
import { UserSubscription, SubscriptionStatus } from '@src/entities/user-subscription.entity';

type Mocked = jest.Mocked<
    Pick<Repository<UserSubscription>, 'findOne' | 'find' | 'update' | 'create' | 'save'>
>;

describe('UserSubscriptionRepository', () => {
    let repository: Mocked;
    let service: UserSubscriptionRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
        };
        service = new UserSubscriptionRepository(
            repository as unknown as Repository<UserSubscription>,
        );
    });

    describe('findActiveByUser', () => {
        it('queries by ACTIVE status with the plan relation joined', async () => {
            const row = { id: 's1' } as UserSubscription;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findActiveByUser('u1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { userId: 'u1', status: SubscriptionStatus.ACTIVE },
                relations: ['plan'],
            });
        });

        it('returns null when no active subscription exists', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findActiveByUser('u1')).resolves.toBeNull();
        });
    });

    describe('listByUser', () => {
        it('orders by createdAt DESC and joins the plan relation', async () => {
            const rows = [{ id: 's1' } as UserSubscription, { id: 's2' } as UserSubscription];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.listByUser('u1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: { userId: 'u1' },
                order: { createdAt: 'DESC' },
                relations: ['plan'],
            });
        });
    });

    describe('createOrUpdate', () => {
        it('updates the active subscription in place when one exists, then refetches with the plan', async () => {
            const existing = { id: 's1', userId: 'u1', status: SubscriptionStatus.ACTIVE } as UserSubscription;
            const updated = { id: 's1', userId: 'u1' } as UserSubscription;
            repository.findOne
                .mockResolvedValueOnce(existing) // findActiveByUser
                .mockResolvedValueOnce(updated); // refetch by id

            const result = await service.createOrUpdate('u1', { planId: 'p1' });

            expect(result).toBe(updated);
            expect(repository.update).toHaveBeenCalledWith(existing.id, { planId: 'p1' });
            expect(repository.findOne).toHaveBeenNthCalledWith(2, {
                where: { id: existing.id },
                relations: ['plan'],
            });
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('creates a new row with userId merged when no active subscription exists', async () => {
            const created = { userId: 'u1' } as UserSubscription;
            const saved = { id: 's2', userId: 'u1' } as UserSubscription;
            repository.findOne.mockResolvedValueOnce(null);
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.createOrUpdate('u1', { planId: 'p1' });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({ planId: 'p1', userId: 'u1' });
            expect(repository.save).toHaveBeenCalledWith(created);
        });

        it('caller-supplied userId in data is overridden by the userId argument (spread order pin)', async () => {
            // The spread `{ ...data, userId }` means a smuggled `data.userId` is overwritten.
            // This test pins that behavior so a future refactor that flips the spread order
            // (and would let callers spoof userId) breaks loudly.
            const created = {} as UserSubscription;
            const saved = { id: 's3' } as UserSubscription;
            repository.findOne.mockResolvedValueOnce(null);
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            await service.createOrUpdate('u1', { userId: 'attacker' } as Partial<UserSubscription>);

            expect(repository.create).toHaveBeenCalledWith({ userId: 'u1' });
        });
    });

    describe('cancel', () => {
        it('updates the row to CANCELED status', async () => {
            await service.cancel('s1');
            expect(repository.update).toHaveBeenCalledWith('s1', { status: SubscriptionStatus.CANCELED });
        });
    });
});
