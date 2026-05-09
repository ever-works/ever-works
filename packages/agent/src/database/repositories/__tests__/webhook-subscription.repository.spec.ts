import type { Repository } from 'typeorm';
import { WebhookSubscriptionRepository } from '../webhook-subscription.repository';
import { WebhookSubscription } from '../../../entities';

type Mocked = jest.Mocked<
    Pick<
        Repository<WebhookSubscription>,
        'create' | 'save' | 'find' | 'update' | 'increment' | 'findOne'
    >
>;

describe('WebhookSubscriptionRepository', () => {
    let repository: Mocked;
    let service: WebhookSubscriptionRepository;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            increment: jest.fn(),
            findOne: jest.fn(),
        };
        service = new WebhookSubscriptionRepository(
            repository as unknown as Repository<WebhookSubscription>,
        );
    });

    describe('createForAccount', () => {
        it('initializes status="active" and consecutiveFailures=0 on the new row', async () => {
            const created = {} as WebhookSubscription;
            const saved = { id: 'w1' } as WebhookSubscription;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.createForAccount({
                accountId: 'acc',
                workId: 'work',
                url: 'https://example.com/hook',
                secretEncrypted: 'sealed',
            });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({
                accountId: 'acc',
                workId: 'work',
                url: 'https://example.com/hook',
                secretEncrypted: 'sealed',
                status: 'active',
                consecutiveFailures: 0,
            });
            expect(repository.save).toHaveBeenCalledWith(created);
        });

        it('coerces undefined workId to null (account-wide subscription)', async () => {
            repository.create.mockReturnValueOnce({} as WebhookSubscription);
            repository.save.mockResolvedValueOnce({} as WebhookSubscription);

            await service.createForAccount({
                accountId: 'acc',
                url: 'https://x',
                secretEncrypted: 'sealed',
            });

            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({ workId: null }),
            );
        });

        it('coerces explicit-null workId to null (preserves the explicit clear)', async () => {
            repository.create.mockReturnValueOnce({} as WebhookSubscription);
            repository.save.mockResolvedValueOnce({} as WebhookSubscription);

            await service.createForAccount({
                accountId: 'acc',
                workId: null,
                url: 'https://x',
                secretEncrypted: 'sealed',
            });

            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({ workId: null }),
            );
        });
    });

    describe('listActiveForWork', () => {
        it('queries by [{workId, active}, {workId:null, active}] so account-wide subscriptions also match', async () => {
            const rows = [{ id: 'w1' } as WebhookSubscription];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.listActiveForWork('work-1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: [
                    { workId: 'work-1', status: 'active' },
                    { workId: null, status: 'active' },
                ],
            });
        });
    });

    describe('listActiveForAccount', () => {
        it('queries by accountId + active status', async () => {
            repository.find.mockResolvedValueOnce([]);
            await service.listActiveForAccount('acc');
            expect(repository.find).toHaveBeenCalledWith({
                where: { accountId: 'acc', status: 'active' },
            });
        });
    });

    describe('markSuccess', () => {
        it('zeros consecutiveFailures and sets lastDeliveryAt to a fresh Date', async () => {
            const before = Date.now();
            await service.markSuccess('w1');

            expect(repository.update).toHaveBeenCalledTimes(1);
            const [id, patch] = repository.update.mock.calls[0] as [string, { consecutiveFailures: number; lastDeliveryAt: Date }];
            expect(id).toBe('w1');
            expect(patch.consecutiveFailures).toBe(0);
            expect(patch.lastDeliveryAt).toBeInstanceOf(Date);
            expect(patch.lastDeliveryAt.getTime()).toBeGreaterThanOrEqual(before);
        });
    });

    describe('incrementFailure', () => {
        it('increments consecutiveFailures by 1 and returns the refreshed counter value', async () => {
            repository.findOne.mockResolvedValueOnce({
                id: 'w1',
                consecutiveFailures: 3,
            } as WebhookSubscription);

            await expect(service.incrementFailure('w1')).resolves.toBe(3);
            expect(repository.increment).toHaveBeenCalledWith({ id: 'w1' }, 'consecutiveFailures', 1);
            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'w1' } });
        });

        it('returns 0 when the row vanished between increment and refetch', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.incrementFailure('w1')).resolves.toBe(0);
        });

        it('returns 0 when the row exists but consecutiveFailures is undefined', async () => {
            repository.findOne.mockResolvedValueOnce({ id: 'w1' } as WebhookSubscription);
            await expect(service.incrementFailure('w1')).resolves.toBe(0);
        });
    });

    describe('markFailed', () => {
        it('sets status="failed" and lastDeliveryAt to a fresh Date', async () => {
            const before = Date.now();
            await service.markFailed('w1');

            const [id, patch] = repository.update.mock.calls[0] as [string, { status: string; lastDeliveryAt: Date }];
            expect(id).toBe('w1');
            expect(patch.status).toBe('failed');
            expect(patch.lastDeliveryAt.getTime()).toBeGreaterThanOrEqual(before);
        });
    });

    describe('pause', () => {
        it('sets status="paused" without touching lastDeliveryAt', async () => {
            await service.pause('w1');
            expect(repository.update).toHaveBeenCalledWith('w1', { status: 'paused' });
        });
    });

    describe('findById', () => {
        it('forwards id through findOne', async () => {
            const row = { id: 'w1' } as WebhookSubscription;
            repository.findOne.mockResolvedValueOnce(row);
            await expect(service.findById('w1')).resolves.toBe(row);
            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'w1' } });
        });

        it('returns null when the row is missing', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findById('missing')).resolves.toBeNull();
        });
    });
});
