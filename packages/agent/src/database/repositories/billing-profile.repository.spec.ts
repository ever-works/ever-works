import { BillingProfileRepository } from './billing-profile.repository';
import { BillingProfile } from '@src/entities/billing-profile.entity';

/**
 * The billing profile is where the auto-recharge in-flight guard lives
 * (the PRD's `credit_accounts` was designed away — see the entity
 * header). These specs pin the compare-and-set shape of that claim: the
 * `UPDATE … WHERE autoRechargeInFlightKey IS NULL` predicate is the whole
 * "fire at most once per crossing" guarantee, so it must not drift.
 */

function makeQb(affected: number) {
    const qb: any = {};
    qb.update = jest.fn().mockReturnValue(qb);
    qb.set = jest.fn().mockReturnValue(qb);
    qb.where = jest.fn().mockReturnValue(qb);
    qb.andWhere = jest.fn().mockReturnValue(qb);
    qb.execute = jest.fn().mockResolvedValue({ affected });
    return qb;
}

function makeHarness(options: { existing?: any; affected?: number } = {}) {
    const qb = makeQb(options.affected ?? 1);
    const repo: any = {
        findOne: jest.fn().mockResolvedValue(options.existing ?? null),
        create: jest.fn((value: any) => value),
        save: jest.fn(async (value: any) => ({ id: 'bp-1', ...value })),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        increment: jest.fn().mockResolvedValue({ affected: 1 }),
        createQueryBuilder: jest.fn(() => qb),
    };
    return { repository: new BillingProfileRepository(repo), repo, qb };
}

describe('BillingProfileRepository', () => {
    it('creates a profile lazily on first checkout', async () => {
        const { repository, repo } = makeHarness();

        const profile = await repository.ensure({
            userId: 'u1',
            provider: 'stripe',
            providerCustomerId: 'cus_1',
        });

        expect(profile).toEqual(
            expect.objectContaining({
                userId: 'u1',
                provider: 'stripe',
                providerCustomerId: 'cus_1',
                autoRechargeEnabled: false,
            }),
        );
        expect(repo.save).toHaveBeenCalled();
    });

    it('never overwrites an existing customer mapping', async () => {
        const existing = { id: 'bp-1', userId: 'u1', providerCustomerId: 'cus_old' };
        const { repository, repo } = makeHarness({ existing });

        const profile = await repository.ensure({
            userId: 'u1',
            provider: 'stripe',
            providerCustomerId: 'cus_new',
        });

        expect(profile).toBe(existing);
        expect(repo.save).not.toHaveBeenCalled();
    });

    it('resolves a concurrent first-checkout race to the surviving row', async () => {
        const survivor = { id: 'bp-1', userId: 'u1', providerCustomerId: 'cus_1' };
        const { repository, repo } = makeHarness();
        repo.findOne
            .mockResolvedValueOnce(null) // pre-insert lookup
            .mockResolvedValueOnce(survivor); // post-conflict lookup
        repo.save.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));

        await expect(
            repository.ensure({ userId: 'u1', provider: 'stripe', providerCustomerId: 'cus_1' }),
        ).resolves.toBe(survivor);
    });

    it('claims the auto-recharge slot only when it is free (compare-and-set)', async () => {
        const { repository, qb } = makeHarness({ affected: 1 });
        const now = new Date('2026-07-26T00:00:00Z');

        const claimed = await repository.claimAutoRechargeSlot('u1', 'auto:u1:p:1', now);

        expect(claimed).toBe(true);
        expect(qb.update).toHaveBeenCalledWith(BillingProfile);
        expect(qb.set).toHaveBeenCalledWith({
            autoRechargeInFlightKey: 'auto:u1:p:1',
            autoRechargeInFlightAt: now,
        });
        // THE guard: only rows with a free slot are updated.
        expect(qb.andWhere).toHaveBeenCalledWith('autoRechargeInFlightKey IS NULL');
    });

    it('loses the claim when another writer already holds the slot', async () => {
        const { repository } = makeHarness({ affected: 0 });

        await expect(
            repository.claimAutoRechargeSlot('u1', 'auto:u1:p:2', new Date()),
        ).resolves.toBe(false);
    });

    it('stores only payment-method display metadata', async () => {
        const { repository, repo } = makeHarness();

        await repository.updatePaymentMethod('u1', {
            defaultPaymentMethodRef: 'pm_1',
            paymentMethodBrand: 'visa',
            paymentMethodLast4: '4242',
            paymentMethodExpMonth: 4,
            paymentMethodExpYear: 2031,
        });

        const [, values] = repo.update.mock.calls[0];
        expect(Object.keys(values).sort()).toEqual([
            'defaultPaymentMethodRef',
            'paymentMethodBrand',
            'paymentMethodExpMonth',
            'paymentMethodExpYear',
            'paymentMethodLast4',
        ]);
    });

    it('releases the slot and counts the failure on a declined charge', async () => {
        const { repository, repo } = makeHarness();
        const now = new Date();

        await repository.recordAutoRechargeFailure('u1', now);

        expect(repo.increment).toHaveBeenCalledWith(
            { userId: 'u1' },
            'autoRechargeFailureCount',
            1,
        );
        expect(repo.update).toHaveBeenCalledWith(
            { userId: 'u1' },
            expect.objectContaining({
                autoRechargeInFlightKey: null,
                autoRechargeLastFailureAt: now,
            }),
        );
    });

    it('looks a profile up by provider customer id (the webhook attribution path)', async () => {
        const { repository, repo } = makeHarness({ existing: { id: 'bp-1' } });

        await repository.findByCustomerId('stripe', 'cus_1');

        expect(repo.findOne).toHaveBeenCalledWith({
            where: { provider: 'stripe', providerCustomerId: 'cus_1' },
        });
    });
});
