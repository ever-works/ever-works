import { LicencePurchaseRepository } from '../licence-purchase.repository';

const write = {
    userId: 'u1',
    planCode: 'selfhosted_pro',
    provider: 'stripe',
    providerPaymentId: 'pi_1',
    amountCents: 9900,
    currency: 'usd',
};

function build() {
    const repository = {
        findOne: jest.fn(),
        find: jest.fn(),
        count: jest.fn(),
        create: jest.fn((value) => value),
        save: jest.fn(),
    } as any;
    return { service: new LicencePurchaseRepository(repository), repository };
}

describe('LicencePurchaseRepository', () => {
    it('returns the provider-correlated winner on webhook replay', async () => {
        const { service, repository } = build();
        const existing = { id: 'licence-1', ...write, status: 'active' };
        repository.findOne.mockResolvedValue(existing);

        await expect(service.recordPurchase(write)).resolves.toBe(existing);
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('converges when webhook and return-route inserts race', async () => {
        const { service, repository } = build();
        const winner = { id: 'licence-1', ...write, status: 'active' };
        repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
        repository.save.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));

        await expect(service.recordPurchase(write)).resolves.toBe(winner);
        expect(repository.findOne).toHaveBeenCalledTimes(2);
    });

    it('does not swallow an unrelated persistence failure', async () => {
        const { service, repository } = build();
        const failure = new Error('database unavailable');
        repository.findOne.mockResolvedValue(null);
        repository.save.mockRejectedValue(failure);

        await expect(service.recordPurchase(write)).rejects.toBe(failure);
    });
});
