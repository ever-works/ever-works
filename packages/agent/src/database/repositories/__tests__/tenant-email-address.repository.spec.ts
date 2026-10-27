import { DataSource } from 'typeorm';
import { TenantEmailAddress } from '../../../entities/tenant-email-address.entity';
import { User } from '../../../entities/user.entity';
import { ENTITIES } from '../../_entities-inventory';
import { TenantEmailAddressRepository } from '../tenant-email-address.repository';

/**
 * EW-P4-3 — the address repository against a real (in-memory
 * better-sqlite3) database: the confirmation-send compare-and-set and the
 * settings list that includes disabled addresses. A mock would not show
 * whether the SQL actually keeps the `verificationSentAt` condition.
 */
const OWNER = '11111111-1111-4111-8111-111111111111';

describe('TenantEmailAddressRepository (real database)', () => {
    let dataSource: DataSource;
    let addresses: TenantEmailAddressRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        addresses = new TenantEmailAddressRepository(dataSource.getRepository(TenantEmailAddress));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(TenantEmailAddress).clear();
        await dataSource.query('DELETE FROM "users"');
        await dataSource.query('PRAGMA foreign_keys = ON');
        await dataSource.getRepository(User).insert({
            id: OWNER,
            username: 'nova',
            slug: 'nova',
            email: 'nova@example.com',
            password: 'not-a-real-hash',
            registrationProvider: 'local',
            isActive: true,
        } as Partial<User>);
    });

    async function insertAddress(patch: Partial<TenantEmailAddress> = {}): Promise<string> {
        const saved = await dataSource.getRepository(TenantEmailAddress).save({
            userId: OWNER,
            address: `a${Math.random().toString(36).slice(2, 8)}@example.com`,
            direction: 'outbound',
            pluginId: 'postmark',
            providerSettings: {},
            verified: false,
            defaultForReplies: false,
            ...patch,
        } as TenantEmailAddress);
        return saved.id;
    }

    describe('claimVerificationSend — one email per cooldown', () => {
        const minute = 60_000;

        it('wins when no email was ever sent, and stamps the send time', async () => {
            const id = await insertAddress();
            const sentAt = new Date('2026-10-16T05:00:00Z');
            await expect(
                addresses.claimVerificationSend(id, new Date(sentAt.getTime() - minute), sentAt),
            ).resolves.toBe(true);
            const row = await dataSource.getRepository(TenantEmailAddress).findOneBy({ id });
            expect(new Date(row!.verificationSentAt as Date).getTime()).toBe(sentAt.getTime());
        });

        it('loses a second claim inside the cooldown (the condition is really in the SQL)', async () => {
            const id = await insertAddress();
            const first = new Date('2026-10-16T05:00:00Z');
            await addresses.claimVerificationSend(id, new Date(first.getTime() - minute), first);
            const retry = new Date(first.getTime() + 10_000);
            await expect(
                addresses.claimVerificationSend(id, new Date(retry.getTime() - minute), retry),
            ).resolves.toBe(false);
            const row = await dataSource.getRepository(TenantEmailAddress).findOneBy({ id });
            expect(new Date(row!.verificationSentAt as Date).getTime()).toBe(first.getTime());
        });

        it('concurrent claims: exactly one wins', async () => {
            const id = await insertAddress();
            const now = new Date('2026-10-16T05:00:00Z');
            const results = await Promise.all(
                [0, 1, 2, 3].map(() =>
                    addresses.claimVerificationSend(id, new Date(now.getTime() - minute), now),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
        });

        it('wins again once the cooldown has passed', async () => {
            const id = await insertAddress({
                verificationSentAt: new Date('2026-10-16T05:00:00Z'),
            });
            const later = new Date('2026-10-16T05:01:30Z');
            await expect(
                addresses.claimVerificationSend(id, new Date(later.getTime() - minute), later),
            ).resolves.toBe(true);
        });

        it('only touches the row it names', async () => {
            const target = await insertAddress();
            const other = await insertAddress();
            const now = new Date('2026-10-16T05:00:00Z');
            await addresses.claimVerificationSend(target, new Date(now.getTime() - minute), now);
            const untouched = await dataSource
                .getRepository(TenantEmailAddress)
                .findOneBy({ id: other });
            expect(untouched!.verificationSentAt ?? null).toBeNull();
        });
    });

    it('findEnabledInboundByAddress: enabled inbound/both rows of every user and plugin, case-insensitive, oldest first', async () => {
        const OTHER = '22222222-2222-4222-8222-222222222222';
        await dataSource.getRepository(User).insert({
            id: OTHER,
            username: 'orion',
            slug: 'orion',
            email: 'orion@example.com',
            password: 'not-a-real-hash',
            registrationProvider: 'local',
            isActive: true,
        } as Partial<User>);
        const oldest = await insertAddress({
            address: 'Agent@Ever.Email',
            direction: 'both',
            pluginId: 'postmark',
            createdAt: new Date('2026-10-01T00:00:00Z'),
        });
        const newer = await insertAddress({
            userId: OTHER,
            address: 'agent@ever.email',
            direction: 'inbound',
            pluginId: 'ever-email-router',
            createdAt: new Date('2026-10-02T00:00:00Z'),
        });
        // Not counted: disabled, outbound-only, another mailbox.
        await insertAddress({
            userId: OTHER,
            address: 'agent@ever.email',
            direction: 'outbound',
            pluginId: 'ever-email-router',
        });
        await insertAddress({
            address: 'agent@ever.email',
            direction: 'inbound',
            pluginId: 'ever-email-router',
            disabledAt: new Date('2026-10-03T00:00:00Z'),
        });
        await insertAddress({ address: 'agent2@ever.email', direction: 'inbound' });

        const rows = await addresses.findEnabledInboundByAddress(' AGENT@ever.email ');

        expect(rows.map((row) => row.id)).toEqual([oldest, newer]);
    });

    it('findAllByUser lists disabled addresses too; findActiveByUser does not', async () => {
        await insertAddress();
        await insertAddress({ disabledAt: new Date('2026-10-01T00:00:00Z') });
        await expect(addresses.findAllByUser(OWNER)).resolves.toHaveLength(2);
        await expect(addresses.findActiveByUser(OWNER)).resolves.toHaveLength(1);
    });
});
