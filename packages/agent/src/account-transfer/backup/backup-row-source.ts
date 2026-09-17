import type { DataSource, SelectQueryBuilder } from 'typeorm';
import type { BackupEntityQuery, BackupRowSource } from './collectors/collector.types';

/**
 * Workspace backup (AW-22) — the only place a backup touches the database.
 *
 * One query builder, built from one query shape, for all fifteen domains.
 * Everything a collector can ask for goes through `applyPredicate` below,
 * which means the "does this row belong to this workspace?" decision exists
 * in exactly one function rather than in a hundred hand-written walks.
 *
 * Reads only. There is no write path on this class, and there is no code
 * path that widens a predicate: a query with no `equals` and no `within`
 * would select a whole table, so `page` refuses it outright rather than
 * trusting every future caller to remember.
 */

/** How many ids one `IN (...)` carries before it is split. Postgres tolerates far more; this is polite. */
const ID_CHUNK = 500;

export class TypeOrmBackupRowSource implements BackupRowSource {
    constructor(private readonly dataSource: DataSource) {}

    hasEntity(entity: string): boolean {
        return this.dataSource.hasMetadata(entity);
    }

    hasColumn(entity: string, column: string): boolean {
        if (!this.hasEntity(entity)) {
            return false;
        }
        return this.dataSource
            .getMetadata(entity)
            .columns.some((candidate) => candidate.propertyName === column);
    }

    async page(
        query: BackupEntityQuery,
        offset: number,
        limit: number,
    ): Promise<Record<string, unknown>[]> {
        if (query.within && query.within.ids.length === 0) {
            return [];
        }
        // Paging across chunked id lists would interleave two orderings, so
        // a `within` query pages inside one chunk at a time: the chunks are
        // concatenated in a stable order and the offset walks the whole
        // concatenation.
        if (query.within && query.within.ids.length > ID_CHUNK) {
            return this.pageChunked(query, query.within.ids, offset, limit);
        }

        const builder = this.builderFor(query);
        const rows = await builder.skip(offset).take(limit).getRawMany();
        return rows.map((row) => this.strip(row));
    }

    async countTrimmed(query: BackupEntityQuery): Promise<number> {
        if (!query.trim) {
            return 0;
        }
        if (query.within && query.within.ids.length === 0) {
            return 0;
        }

        // Same predicate, inverted trim: how many rows the cutoff left out.
        const inverted: BackupEntityQuery = { ...query, trim: undefined };
        let total = 0;
        const chunks = query.within
            ? this.chunk(query.within.ids)
            : [undefined as readonly string[] | undefined];

        for (const ids of chunks) {
            const builder = this.builderFor(
                ids && query.within ? { ...inverted, within: { ...query.within, ids } } : inverted,
            );
            builder.andWhere(`entity.${this.safeColumn(query.trim.field)} < :trimCutoff`, {
                trimCutoff: query.trim.cutoff,
            });
            total += await builder.getCount();
        }
        return total;
    }

    private async pageChunked(
        query: BackupEntityQuery,
        ids: readonly string[],
        offset: number,
        limit: number,
    ): Promise<Record<string, unknown>[]> {
        const out: Record<string, unknown>[] = [];
        let skipped = 0;

        for (const chunk of this.chunk(ids)) {
            if (out.length >= limit) {
                break;
            }
            const scoped: BackupEntityQuery = {
                ...query,
                within: { column: query.within!.column, ids: chunk },
            };
            const builder = this.builderFor(scoped);
            const available = await builder.getCount();

            if (skipped + available <= offset) {
                skipped += available;
                continue;
            }

            const localOffset = Math.max(0, offset - skipped);
            const rows = await this.builderFor(scoped)
                .skip(localOffset)
                .take(limit - out.length)
                .getRawMany();
            out.push(...rows.map((row) => this.strip(row)));
            skipped += available;
        }

        return out;
    }

    private builderFor(query: BackupEntityQuery): SelectQueryBuilder<Record<string, unknown>> {
        const metadata = this.dataSource.getMetadata(query.entity);
        const builder = this.dataSource
            .createQueryBuilder()
            .select('entity')
            .from(metadata.target, 'entity') as SelectQueryBuilder<Record<string, unknown>>;

        this.applyPredicate(builder, query);

        // A stable order is what makes two archives of unchanged data differ
        // only in their timestamps (spec FR-22): oldest first, ties broken by
        // the primary key so the order is total.
        const hasCreatedAt = metadata.columns.some((column) => column.propertyName === 'createdAt');
        if (hasCreatedAt) {
            builder.orderBy('entity.createdAt', 'ASC');
            builder.addOrderBy('entity.id', 'ASC');
        } else {
            builder.orderBy('entity.id', 'ASC');
        }

        return builder;
    }

    /**
     * THE scope predicate. Every row in every archive passed through here.
     *
     * A query that narrows nothing is refused rather than executed: a bug
     * that dropped an `equals` clause would otherwise export the whole
     * table, and "it returned rows" is not a signal anyone would notice.
     */
    private applyPredicate(
        builder: SelectQueryBuilder<Record<string, unknown>>,
        query: BackupEntityQuery,
    ): void {
        const equalsEntries = Object.entries(query.equals);
        if (equalsEntries.length === 0 && !query.within) {
            throw new Error(
                `Refusing an unscoped backup query for ${query.entity}: every query must name a workspace`,
            );
        }

        let index = 0;
        for (const [column, value] of equalsEntries) {
            const safe = this.safeColumn(column);
            if (value === null) {
                builder.andWhere(`entity.${safe} IS NULL`);
                continue;
            }
            const parameter = `p${index++}`;
            builder.andWhere(`entity.${safe} = :${parameter}`, { [parameter]: value });
        }

        if (query.within) {
            builder.andWhere(`entity.${this.safeColumn(query.within.column)} IN (:...withinIds)`, {
                withinIds: [...query.within.ids],
            });
        }

        if (query.trim) {
            builder.andWhere(`entity.${this.safeColumn(query.trim.field)} >= :trimCutoff`, {
                trimCutoff: query.trim.cutoff,
            });
        }
    }

    /**
     * Column names come from a frozen table in this repository, never from a
     * request — but they are interpolated into SQL, so they are checked
     * anyway. A defence that only holds while nobody changes the caller is
     * not a defence.
     */
    private safeColumn(column: string): string {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
            throw new Error(`Refusing an unsafe column name in a backup query: ${column}`);
        }
        return column;
    }

    private chunk(ids: readonly string[]): string[][] {
        const out: string[][] = [];
        for (let i = 0; i < ids.length; i += ID_CHUNK) {
            out.push([...ids.slice(i, i + ID_CHUNK)]);
        }
        return out;
    }

    /**
     * `getRawMany` prefixes every column with the alias. Strip it so the
     * archive's JSONL carries the entity's own field names and nothing about
     * how we happened to query for them.
     */
    private strip(row: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
            out[key.startsWith('entity_') ? key.slice('entity_'.length) : key] = value;
        }
        return out;
    }
}
