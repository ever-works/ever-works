import { DataSource } from 'typeorm';
import { BACKUP_DOMAINS } from '@ever-works/contracts';
import { ENTITIES } from '../../database/_entities-inventory';
import { TypeOrmBackupRowSource } from './backup-row-source';
import { BACKUP_COLLECTORS } from './collectors';
import { referencedEntities } from './collectors/domain-specs';
import type { BackupCollectContext, BackupScope } from './collectors/collector.types';

/**
 * Workspace backup (AW-22) — the row source against a real database, the
 * in-memory better-sqlite3 driver CI and the e2e stack run.
 *
 * Every collector spec in this directory drives a fixture source that
 * IGNORES the query, so until this file existed no test in the suite had
 * ever evaluated a backup predicate or prepared a backup statement. Two
 * defects lived in that gap:
 *
 *  1. An `organization`-scoped file in a personal workspace asked for
 *     `organizationId IS NULL`, and got every other account's rows out of
 *     the four tables whose `organizationId` is nullable.
 *  2. `ORDER BY entity.id` was hard-coded for entities that have no `id`
 *     column, so the statement never prepared at all: the three files keyed
 *     on `userId` / `organizationId` came out empty on every backup and
 *     every archive settled `ready_with_gaps`.
 *
 * Both are invisible to a mock and obvious to a driver, which is the whole
 * argument for this file.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const STRANGER_TENANT = '44444444-4444-4444-8444-444444444444';
const OWNER_AGENT = '55555555-5555-4555-8555-555555555555';
const STRANGER_AGENT = '66666666-6666-4666-8666-666666666666';

const PERSONAL: BackupScope = { userId: OWNER, organizationId: null, tenantId: TENANT };

/** Every literal a stranger's row carries, so one search finds any of them. */
const STRANGER_MARKERS = [
    'stranger@example.invalid',
    'https://strangers.example.invalid/hook',
    'stranger-org-login',
    'stranger-thread-key',
];

describe('TypeOrmBackupRowSource (better-sqlite3)', () => {
    let dataSource: DataSource;
    let source: TypeOrmBackupRowSource;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            // The whole inventory: these entities' relations reach most of
            // the schema, so TypeORM's metadata builder refuses a partial
            // list — the same reason the activity-feed integration spec
            // loads it.
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // Seeding a valid user / organization / agent graph behind every
        // fixture would dwarf what is under test, and none of these reads
        // joins.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        source = new TypeOrmBackupRowSource(dataSource);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    /**
     * Driven off the spec table rather than a sample: the three entities that
     * broke have nothing in common except "no `id` column", which is not a
     * property anyone samples for.
     */
    describe('the ORDER BY every page depends on', () => {
        it('names entities the spec table actually references', () => {
            expect([...referencedEntities()].length).toBeGreaterThan(100);
        });

        it.each([
            ['UserNotificationPreference', 'userId'],
            ['OrganizationOnboardingProfile', 'organizationId'],
            ['OrganizationNotificationDefault', 'organizationId'],
        ])('pages %s, which is keyed on %s and has no id column', async (entity, key) => {
            const metadata = dataSource.getMetadata(entity);
            // The premise: if one of these grows an `id` or a `createdAt`,
            // this case stops testing what it was written for and should be
            // re-pointed rather than silently passing.
            expect(metadata.columns.map((column) => column.propertyName)).not.toContain('id');
            expect(metadata.columns.map((column) => column.propertyName)).not.toContain(
                'createdAt',
            );
            expect(metadata.primaryColumns.map((column) => column.propertyName)).toEqual([key]);

            await expect(source.page({ entity, equals: { [key]: OWNER } }, 0, 10)).resolves.toEqual(
                [],
            );
        });

        it('prepares a runnable page query for every entity the spec table names', async () => {
            const failures: string[] = [];
            for (const entity of referencedEntities()) {
                if (!source.hasEntity(entity)) continue;
                const metadata = dataSource.getMetadata(entity);
                const key = metadata.primaryColumns[0]?.propertyName;
                if (!key) continue;
                try {
                    await source.page({ entity, equals: { [key]: OWNER } }, 0, 1);
                } catch (error) {
                    failures.push(
                        `${entity}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
            // A failure here is a statement the driver refused to prepare,
            // which empties that file on every backup of every workspace.
            expect(failures).toEqual([]);
        });

        it('orders by createdAt then the real primary key when both exist', async () => {
            const rows = dataSource.getRepository('ActivityLog');
            await rows.query('DELETE FROM activity_log');
            await rows.insert([
                {
                    id: idOf('a'),
                    userId: OWNER,
                    actionType: 'work.create',
                    action: 'a',
                    status: 'completed',
                    summary: 'a',
                },
                {
                    id: idOf('b'),
                    userId: OWNER,
                    actionType: 'work.create',
                    action: 'b',
                    status: 'completed',
                    summary: 'b',
                },
            ] as never);

            const page = await source.page(
                { entity: 'ActivityLog', equals: { userId: OWNER } },
                0,
                10,
            );
            expect(page).toHaveLength(2);
            expect(page.map((row) => row.action)).toEqual(['a', 'b']);
        });
    });

    describe('the scope predicate refuses a query that narrows nothing', () => {
        it('refuses an empty equals map', async () => {
            await expect(
                source.page({ entity: 'WebhookSubscription', equals: {} }, 0, 10),
            ).rejects.toThrow(/Refusing an unscoped backup query for WebhookSubscription/);
        });

        it('refuses a predicate whose only clause is IS NULL', async () => {
            // This is the query the `organization` rule used to build for a
            // personal workspace. One clause, so the old length check passed
            // it; no narrowing at all, so it selected every unassigned row
            // in the table.
            await expect(
                source.page(
                    { entity: 'WebhookSubscription', equals: { organizationId: null } },
                    0,
                    10,
                ),
            ).rejects.toThrow(/Refusing an unscoped backup query for WebhookSubscription/);
        });

        it('refuses a predicate whose only clause is an empty string', async () => {
            await expect(
                source.page({ entity: 'WebhookSubscription', equals: { accountId: '' } }, 0, 10),
            ).rejects.toThrow(/Refusing an unscoped backup query for WebhookSubscription/);
        });

        it('still runs a query narrowed by an identity alongside an IS NULL', async () => {
            // The `workspace` rule's normal shape — `userId = :id AND
            // organizationId IS NULL` — must keep working: the null clause
            // is a legitimate NARROWING there, it just cannot be the only one.
            await expect(
                source.page(
                    { entity: 'Agent', equals: { userId: OWNER, organizationId: null } },
                    0,
                    10,
                ),
            ).resolves.toEqual([]);
        });
    });

    describe('a personal workspace never sees a stranger’s rows', () => {
        beforeAll(async () => {
            // Four tables whose `organizationId` is nullable and whose NULL
            // state is the documented default until the owner creates their
            // first organization. Every row here belongs to STRANGER, and
            // every one of them was exported into the OWNER's archive.
            await dataSource.getRepository('OnboardingRequest').insert([
                {
                    id: idOf('on1'),
                    githubIdentityHash: 'hash-stranger',
                    repoUrlCanonical: 'https://code.example.invalid/stranger/repo',
                    contactEmail: 'stranger@example.invalid',
                    accountId: STRANGER,
                    status: 'pending',
                    tenantId: STRANGER_TENANT,
                    organizationId: null,
                },
            ] as never);
            await dataSource.getRepository('EmailConversation').insert([
                {
                    id: idOf('ec1'),
                    agentId: STRANGER_AGENT,
                    threadKey: 'stranger-thread-key',
                    participants: [{ address: 'stranger@example.invalid' }],
                    tenantId: STRANGER_TENANT,
                    organizationId: null,
                },
            ] as never);
            await dataSource.getRepository('GitHubAppInstallation').insert([
                {
                    id: idOf('gh1'),
                    installationId: '99999',
                    accountLogin: 'stranger-org-login',
                    accountType: 'Organization',
                    targetType: 'Organization',
                    createdByUserId: STRANGER,
                    tenantId: STRANGER_TENANT,
                    organizationId: null,
                },
            ] as never);
            await dataSource.getRepository('WebhookSubscription').insert([
                {
                    id: idOf('wh1'),
                    accountId: STRANGER,
                    url: 'https://strangers.example.invalid/hook',
                    secretEncrypted: 'enc::v1::stranger',
                    events: ['work.created'],
                    tenantId: STRANGER_TENANT,
                    organizationId: null,
                },
            ] as never);
        });

        it('seeded rows a leak would find (a silent zero would make this test useless)', async () => {
            for (const entity of [
                'OnboardingRequest',
                'EmailConversation',
                'GitHubAppInstallation',
                'WebhookSubscription',
            ]) {
                await expect(dataSource.getRepository(entity).count()).resolves.toBeGreaterThan(0);
            }
        });

        it('emits nothing from any domain that belongs to another account', async () => {
            const emitted: Array<{ file: string; row: Record<string, unknown> }> = [];
            const unreadable: string[] = [];
            const context = contextFor(source);

            for (const domain of BACKUP_DOMAINS) {
                const collector = BACKUP_COLLECTORS.get(domain.key);
                expect(collector).toBeDefined();
                for (const plan of await collector!.plan(context)) {
                    // A file whose query will not run is the runner's own
                    // per-domain failure path, recorded rather than thrown
                    // so one broken statement cannot hide a leak in a later
                    // domain.
                    try {
                        for await (const row of collector!.rows(context, plan)) {
                            emitted.push({ file: `${domain.dataDir}/${plan.file}`, row });
                        }
                    } catch (error) {
                        unreadable.push(
                            `${domain.dataDir}/${plan.file}: ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                        );
                    }
                }
            }

            const leaked = emitted
                .filter(({ row }) => {
                    const text = JSON.stringify(row);
                    return (
                        STRANGER_MARKERS.some((marker) => text.includes(marker)) ||
                        text.includes(STRANGER) ||
                        text.includes(STRANGER_TENANT)
                    );
                })
                .map(({ file, row }) => `${file}: ${JSON.stringify(row)}`);

            // Every entry here is a row from somebody else's workspace in
            // this workspace's downloadable archive.
            expect(leaked).toEqual([]);
            expect(unreadable).toEqual([]);
        });

        it('still emits this workspace’s own rows', async () => {
            // The other half of the property: the fix must narrow, not
            // silence. A `workspace`-scoped table with a row of the owner's
            // still has to come out.
            await dataSource.getRepository('Agent').insert([
                {
                    id: OWNER_AGENT,
                    userId: OWNER,
                    name: 'Owner agent',
                    slug: 'owner-agent',
                    scope: 'personal',
                    status: 'active',
                    permissions: {},
                    tenantId: TENANT,
                    organizationId: null,
                },
            ] as never);
            await dataSource.getRepository('Agent').insert([
                {
                    id: STRANGER_AGENT,
                    userId: STRANGER,
                    name: 'Stranger agent',
                    slug: 'stranger-agent',
                    scope: 'personal',
                    status: 'active',
                    permissions: {},
                    tenantId: STRANGER_TENANT,
                    organizationId: null,
                },
            ] as never);

            const rows = await source.page(
                { entity: 'Agent', equals: { userId: OWNER, organizationId: null } },
                0,
                10,
            );
            expect(rows.map((row) => row.id)).toEqual([OWNER_AGENT]);
        });
    });
});

/** A deterministic uuid-shaped id from a short label. */
function idOf(label: string): string {
    const hex = Buffer.from(label).toString('hex').padEnd(12, '0').slice(0, 12);
    return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
}

function contextFor(source: TypeOrmBackupRowSource): BackupCollectContext {
    const ids = new Map<string, readonly string[]>();
    return {
        scope: PERSONAL,
        includeFullHistory: false,
        now: new Date('2026-09-17T00:00:00.000Z'),
        source,
        pageSize: 100,
        enqueueFile: () => undefined,
        registerIds: (name, value) => ids.set(name, value),
        idsFor: (name) => ids.get(name) ?? [],
        shouldStop: () => false,
        heartbeat: async () => undefined,
    };
}
