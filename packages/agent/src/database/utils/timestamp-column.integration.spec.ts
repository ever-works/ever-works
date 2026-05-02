import { Column, DataSource, Entity, PrimaryGeneratedColumn, Repository, LessThan } from 'typeorm';
import { TimestampColumn } from '../../entities/_types';

@Entity({ name: 'timestamp_column_test_records' })
class TimestampColumnTestRecord {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    label: string;

    @TimestampColumn({ nullable: true })
    expiresAt?: Date | null;

    @TimestampColumn({ nullable: true })
    nextRunAt?: Date | null;
}

describe('TimestampColumn', () => {
    let dataSource: DataSource;
    let repository: Repository<TimestampColumnTestRecord>;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [TimestampColumnTestRecord],
            synchronize: true,
        });

        await dataSource.initialize();
        repository = dataSource.getRepository(TimestampColumnTestRecord);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await repository.clear();
    });

    it('stores Date values as millisecond timestamps and hydrates them as Dates', async () => {
        const expiresAt = new Date('2026-04-11T15:55:12.034Z');

        const saved = await repository.save(
            repository.create({
                label: 'stored-date',
                expiresAt,
            }),
        );

        const rawRows = await dataSource.query(
            'SELECT expiresAt FROM timestamp_column_test_records WHERE id = ?',
            [saved.id],
        );
        const hydrated = await repository.findOneByOrFail({ id: saved.id });

        expect(Number(rawRows[0].expiresAt)).toBe(expiresAt.getTime());
        expect(hydrated.expiresAt).toBeInstanceOf(Date);
        expect(hydrated.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    });

    it('applies the transformer for repository find operators', async () => {
        const now = new Date('2026-04-11T15:55:12.034Z');
        const expiredAt = new Date(now.getTime() - 1_000);
        const futureAt = new Date(now.getTime() + 1_000);

        await repository.save([
            repository.create({ label: 'expired', expiresAt: expiredAt }),
            repository.create({ label: 'future', expiresAt: futureAt }),
        ]);

        const expired = await repository.find({
            where: {
                expiresAt: LessThan(now),
            },
            order: { label: 'ASC' },
        });

        expect(expired.map((record) => record.label)).toEqual(['expired']);
    });

    it('requires explicit millisecond values for raw query-builder predicates', async () => {
        const nextRunAt = new Date('2026-04-11T15:55:12.034Z');

        await repository.save(
            repository.create({
                label: 'scheduled',
                nextRunAt,
            }),
        );

        const matchedByDateParameter = await findByRawNextRunAtParameter(nextRunAt);
        const matchedByTimestampParameter = await findByRawNextRunAtParameter(nextRunAt.getTime());

        expect(matchedByDateParameter).toBeNull();
        expect(matchedByTimestampParameter?.label).toBe('scheduled');
    });

    async function findByRawNextRunAtParameter(
        nextRunAt: Date | number,
    ): Promise<TimestampColumnTestRecord | null> {
        try {
            return await repository
                .createQueryBuilder('record')
                .where('record.nextRunAt = :nextRunAt', { nextRunAt })
                .getOne();
        } catch {
            return null;
        }
    }
});
