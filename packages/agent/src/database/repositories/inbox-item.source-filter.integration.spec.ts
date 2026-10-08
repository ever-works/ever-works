import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { InboxItem } from '../../entities/inbox-item.entity';
import { InboxItemRepository } from './inbox-item.repository';

/**
 * Self-build slice AU — the Inbox's "From your fleet" filter
 * (`listForUser({ sourceType })`) against a real SQL engine: only the
 * owner's items from that producer, in the active and archived views, and
 * the unfiltered call is unchanged.
 */
describe('InboxItemRepository — source filter (integration)', () => {
    let dataSource: DataSource;
    let items: Repository<InboxItem>;
    let repository: InboxItemRepository;
    let userId: string;
    let otherUserId: string;

    let clock = Date.parse('2026-10-01T00:00:00.000Z');
    const nextDate = () => new Date((clock += 60_000));

    async function seed(owner: string, overrides: Partial<InboxItem>): Promise<InboxItem> {
        return items.save(
            items.create({
                userId: owner,
                kind: 'question',
                title: 'A question',
                body: 'A question',
                sourceType: 'agent-run',
                status: 'open',
                unread: true,
                createdAt: nextDate(),
                ...overrides,
            } as Partial<InboxItem>),
        );
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        items = dataSource.getRepository(InboxItem);
        repository = new InboxItemRepository(items);
        const users = dataSource.getRepository(User);
        userId = (
            await users.save(
                users.create({
                    username: 'owner',
                    email: 'owner@example.com',
                    password: 'x',
                } as Partial<User>),
            )
        ).id;
        otherUserId = (
            await users.save(
                users.create({
                    username: 'stranger',
                    email: 'stranger@example.com',
                    password: 'x',
                } as Partial<User>),
            )
        ).id;

        await seed(userId, { title: 'cloud question' });
        await seed(userId, { title: 'fleet question', sourceType: 'fleet-run' });
        await seed(userId, {
            title: 'archived fleet',
            sourceType: 'fleet-run',
            status: 'archived',
        });
        await seed(userId, { title: 'notice', kind: 'notice', sourceType: 'system' });
        await seed(otherUserId, { title: 'foreign fleet', sourceType: 'fleet-run' });
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    it('returns only the owner’s fleet items in the active view', async () => {
        const { rows, total } = await repository.listForUser(userId, { sourceType: 'fleet-run' });
        expect(rows.map((row) => row.title)).toEqual(['fleet question']);
        expect(total).toBe(1);
    });

    it('applies to the archived view too', async () => {
        const { rows } = await repository.listForUser(userId, {
            sourceType: 'fleet-run',
            status: 'archived',
        });
        expect(rows.map((row) => row.title)).toEqual(['archived fleet']);
    });

    it('leaves the unfiltered list exactly as it was', async () => {
        const { rows } = await repository.listForUser(userId);
        expect(rows.map((row) => row.title)).toEqual([
            'notice',
            'fleet question',
            'cloud question',
        ]);
    });
});
