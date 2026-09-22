import { DataSource } from 'typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { User } from '../user.entity';
import { Work } from '../work.entity';
import { WorkDeployment, DeploymentEnvironment } from '../work-deployment.entity';

/**
 * APW-06 T16 — the six App columns on `WorkDeployment`, and the two new
 * terminal states.
 *
 * This table backs **every Work kind**, which is why the cases below are about
 * what did NOT change as much as what did. A `NOT NULL` among the six, or a
 * default, or an altered pre-existing column, would break every website
 * Deployment the moment the migration ran — and a unit test that only checked
 * the new columns would not notice.
 *
 * The schema half runs against a real in-memory better-sqlite3 DataSource with
 * `synchronize: true`, so the assertions are about the schema TypeORM actually
 * emits from the decorators, not about the decorators' arguments.
 */
describe('WorkDeployment — APW-06 T16', () => {
    const APP_COLUMNS = [
        'buildId',
        'appTarget',
        'appTrigger',
        'componentStatuses',
        'smokeResult',
        'appRender',
    ] as const;

    describe('isTerminal()', () => {
        function at(state: string): boolean {
            const row = new WorkDeployment();
            row.state = state;
            return row.isTerminal();
        }

        it('keeps the four states it already had', () => {
            expect(at('READY')).toBe(true);
            expect(at('ERROR')).toBe(true);
            expect(at('CANCELED')).toBe(true);
            expect(at('TIMEOUT')).toBe(true);
        });

        it('adds ROLLED_BACK and SUPERSEDED — both are ENDINGS', () => {
            // A row that was rolled back or replaced in the latest-wins queue
            // never changes again. Left out, both would poll forever and hold a
            // deploy lock nothing releases.
            expect(at('ROLLED_BACK')).toBe(true);
            expect(at('SUPERSEDED')).toBe(true);
        });

        it('does NOT treat the two in-flight App states as terminal', () => {
            expect(at('DEPLOYING')).toBe(false);
            expect(at('VERIFYING')).toBe(false);
            expect(at('INITIALIZING')).toBe(false);
        });
    });

    describe('the schema TypeORM emits', () => {
        let dataSource: DataSource;

        beforeAll(async () => {
            dataSource = new DataSource({
                type: 'better-sqlite3',
                database: ':memory:',
                // The whole inventory, not `[WorkDeployment]`: the entity has a
                // `@ManyToOne(() => Work)` and TypeORM refuses to build metadata
                // for a relation whose target is not registered
                // (`Entity metadata for WorkDeployment#work was not found`). An
                // earlier draft of this file registered the one entity and every
                // schema case failed at `initialize()`.
                entities: ENTITIES,
                synchronize: true,
                logging: false,
            });
            await dataSource.initialize();
        }, 60_000);

        afterAll(async () => {
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        const OWNER = 'ffffffff-6666-4666-8666-ffffffffffff';

        /**
         * The owning User and Work.
         *
         * Both, because the foreign keys are real and better-sqlite3 enforces
         * them: `work_deployments.workId` → `works.id` → `works.userId` →
         * `users.id`. Seeding only the Work fails on the second one, which is
         * how this helper grew its first half.
         *
         * `username` and `slug` are `users`' NOT NULL columns; `name`, `slug`,
         * `userId` and `description` are `works`' (`work.entity.ts:167-173,
         * 275`). Nothing else about either row matters here, so nothing else is
         * invented.
         */
        async function seedWork(id: string): Promise<void> {
            const users = dataSource.getRepository(User);
            if (!(await users.findOneBy({ id: OWNER }))) {
                await users.save(
                    users.create({ id: OWNER, username: 'fixture-owner', slug: 'fixture-owner' }),
                );
            }

            const works = dataSource.getRepository(Work);
            await works.save(
                works.create({
                    id,
                    name: `fixture-${id}`,
                    slug: `fixture-${id}`,
                    userId: OWNER,
                    description: 'A Work fixture for the deployment row.',
                }),
            );
        }

        function column(name: string) {
            return dataSource.getMetadata(WorkDeployment).findColumnWithPropertyName(name);
        }

        it('declares all six App columns', () => {
            for (const name of APP_COLUMNS) expect(column(name)).toBeDefined();
        });

        it('every one is nullable with NO default', () => {
            for (const name of APP_COLUMNS) {
                const meta = column(name)!;
                expect(meta.isNullable).toBe(true);
                expect(meta.default).toBeUndefined();
            }
        });

        it('leaves every pre-existing column exactly as it was', () => {
            // Spot-checked against the columns other Work kinds depend on. A
            // change to any of these is a production outage for all of them.
            expect(column('state')!.default).toBe('INITIALIZING');
            expect(column('state')!.isNullable).toBe(false);
            expect(column('branch')!.default).toBe('main');
            expect(column('environment')!.default).toBe(DeploymentEnvironment.PRODUCTION);
            expect(column('provider')!.isNullable).toBe(false);
            expect(column('commitSha')!.isNullable).toBe(true);
        });

        it('stores and reads back an App Deployment row', async () => {
            await seedWork('w-1');
            const repository = dataSource.getRepository(WorkDeployment);
            const saved = await repository.save(
                repository.create({
                    workId: 'w-1',
                    provider: 'k8s',
                    state: 'INITIALIZING',
                    buildId: 'b-1',
                    appTarget: 'your-cluster',
                    appTrigger: 'build',
                    appRender: { specCommitSha: 'abc', namespace: 'ew-app-demo' },
                    componentStatuses: [{ name: 'web', ready: 1, desired: 1 }],
                    smokeResult: { classification: 'pass' },
                }),
            );

            const read = await repository.findOneByOrFail({ id: saved.id });
            expect(read.buildId).toBe('b-1');
            expect(read.appTarget).toBe('your-cluster');
            expect(read.appTrigger).toBe('build');
            // `simple-json` round-trips the document, not a string.
            expect(read.appRender).toEqual({ specCommitSha: 'abc', namespace: 'ew-app-demo' });
            expect(read.componentStatuses).toEqual([{ name: 'web', ready: 1, desired: 1 }]);
        });

        it('stores a website Deployment that sets none of the six', async () => {
            // The regression that matters most: the row every other Work kind
            // writes must still insert, with six nulls.
            await seedWork('w-2');
            const repository = dataSource.getRepository(WorkDeployment);
            const saved = await repository.save(
                repository.create({ workId: 'w-2', provider: 'vercel', state: 'INITIALIZING' }),
            );

            const read = await repository.findOneByOrFail({ id: saved.id });
            for (const name of APP_COLUMNS) {
                expect(read[name as 'buildId']).toBeNull();
            }
        });
    });
});
