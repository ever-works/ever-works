import { DataSource } from 'typeorm';
import { AddGoalMetricSampleCriterionId1795140000000 } from '../1795140000000-AddGoalMetricSampleCriterionId';

/**
 * EW-P2-2 — `goal_metric_samples.criterionId` on in-memory better-sqlite3:
 * nullable on every existing row, indexed with `(goalId, criterionId, sampledAt)`,
 * idempotent, a missing table skipped, and dropped by `down` with the rows kept.
 */
describe('AddGoalMetricSampleCriterionId1795140000000', () => {
    let dataSource: DataSource;
    const migration = new AddGoalMetricSampleCriterionId1795140000000();

    const columns = async (): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("goal_metric_samples")`);
    const indexNames = async (): Promise<string[]> =>
        (
            (await dataSource.query(`PRAGMA index_list("goal_metric_samples")`)) as Array<{
                name: string;
            }>
        ).map((row) => row.name);
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "goal_metric_samples" ("id" varchar PRIMARY KEY NOT NULL, "goalId" varchar NOT NULL, "sampledAt" datetime NOT NULL, "value" float NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "goal_metric_samples" ("id", "goalId", "sampledAt", "value") VALUES ('s1', 'g1', '2026-10-16 10:00:00', 4)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable criterionId and its index, idempotently', async () => {
        await run('up');
        await run('up');
        const criterion = (await columns()).find((column) => column.name === 'criterionId');
        expect(criterion?.notnull).toBe(0);
        expect(await indexNames()).toContain('idx_goal_metric_samples_goal_criterion_sampled');
        const [row] = await dataSource.query(`SELECT "criterionId" FROM "goal_metric_samples"`);
        expect(row.criterionId).toBeNull();
    });

    it('skips a missing table', async () => {
        await dataSource.query(`DROP TABLE "goal_metric_samples"`);
        await expect(run('up')).resolves.toBeUndefined();
    });

    it('down drops the index and the column and keeps the rows', async () => {
        await run('up');
        await run('down');
        expect((await columns()).map((column) => column.name)).not.toContain('criterionId');
        expect(await indexNames()).not.toContain('idx_goal_metric_samples_goal_criterion_sampled');
        expect(await dataSource.query(`SELECT "id" FROM "goal_metric_samples"`)).toHaveLength(1);
    });
});
