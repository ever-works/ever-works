import { InvoiceRepository } from './invoice.repository';
import { InvoiceStatus } from '@src/entities/invoice.entity';

/**
 * The invoice mirror is written only by the signature-verified webhook
 * and read only through an owner filter. These specs pin both halves:
 * re-delivery UPDATES (never duplicates), and no read path can reach
 * another account's rows.
 */

function makeHarness(options: { existing?: any; rows?: any[]; total?: number } = {}) {
    const repo: any = {
        findOne: jest.fn().mockResolvedValue(options.existing ?? null),
        create: jest.fn((value: any) => value),
        save: jest.fn(async (value: any) => ({ id: 'inv-1', ...value })),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        findAndCount: jest.fn().mockResolvedValue([options.rows ?? [], options.total ?? 0]),
    };
    return { repository: new InvoiceRepository(repo), repo };
}

const WRITE = {
    userId: 'u1',
    provider: 'stripe',
    providerInvoiceId: 'in_1',
    status: InvoiceStatus.PAID,
    subtotalCents: 5000,
    totalCents: 5000,
    currency: 'usd',
};

describe('InvoiceRepository', () => {
    it('inserts a new invoice on first delivery', async () => {
        const { repository, repo } = makeHarness();

        const invoice = await repository.mirror(WRITE);

        expect(repo.save).toHaveBeenCalled();
        expect(invoice).toEqual(
            expect.objectContaining({ providerInvoiceId: 'in_1', totalCents: 5000 }),
        );
    });

    it('UPDATES on re-delivery instead of inserting a duplicate', async () => {
        const existing = { id: 'inv-1', providerInvoiceId: 'in_1' };
        const { repository, repo } = makeHarness({ existing });
        repo.findOne.mockResolvedValue(existing);

        await repository.mirror({ ...WRITE, status: InvoiceStatus.REFUNDED });

        expect(repo.save).not.toHaveBeenCalled();
        expect(repo.update).toHaveBeenCalledWith(
            { id: 'inv-1' },
            expect.objectContaining({ status: InvoiceStatus.REFUNDED }),
        );
    });

    it('keys the upsert on (provider, providerInvoiceId)', async () => {
        const { repository, repo } = makeHarness();

        await repository.mirror(WRITE);

        expect(repo.findOne).toHaveBeenCalledWith({
            where: { provider: 'stripe', providerInvoiceId: 'in_1' },
        });
    });

    it('defaults optional columns rather than writing undefined', async () => {
        const { repository, repo } = makeHarness();

        await repository.mirror(WRITE);

        const saved = repo.save.mock.calls[0][0];
        expect(saved.amountPaidCents).toBe(0);
        expect(saved.number).toBeNull();
        expect(saved.lineItems).toBeNull();
        expect(saved.organizationId).toBeNull();
    });

    it('scopes the list to the owner, newest-first', async () => {
        const { repository, repo } = makeHarness({ rows: [{ id: 'inv-1' }], total: 1 });

        const page = await repository.findForUser('u1', { skip: 10, take: 5 });

        expect(repo.findAndCount).toHaveBeenCalledWith({
            where: { userId: 'u1' },
            order: { issuedAt: 'DESC', createdAt: 'DESC' },
            skip: 10,
            take: 5,
        });
        expect(page).toEqual({ invoices: [{ id: 'inv-1' }], total: 1 });
    });

    it('scopes the single read to the owner too — no unfiltered find-by-id exists', async () => {
        const { repository, repo } = makeHarness();

        await repository.findOneForUser('u1', 'inv-1');

        expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'inv-1', userId: 'u1' } });
        // Guard against a future "convenience" lookup that skips the owner.
        expect(Object.getOwnPropertyNames(InvoiceRepository.prototype)).toEqual([
            'constructor',
            'mirror',
            'findForUser',
            'findOneForUser',
        ]);
    });
});
