import { Column, type ColumnOptions } from 'typeorm';

/**
 * Portable epoch-millis timestamp column. Stores as `bigint` (works
 * cross-DB; raw `Date` defaults to TIMESTAMP WITH TIME ZONE on
 * Postgres and INTEGER on SQLite, breaking parity). The transformer
 * turns the stored value back into a `Date` at read time so callers
 * see a normal `Date` either way.
 *
 * `name` override: TypeORM defaults the column name to the property
 * name verbatim, which means `extractionStartedAt` (camelCase) on
 * the entity tries to read column `"extractionStartedAt"` from
 * Postgres. If the migration created the column as
 * `extraction_started_at` (snake_case — the convention used by every
 * other `name:`-overridden column in the same entities), the query
 * fails with `column ... does not exist`. The fix landed in EW-639
 * after the 500 surfaced on the KB upload path in production: pass
 * the explicit snake_case column name from the call site.
 */
export const TimestampColumn = ({
    nullable = false,
    name,
}: { nullable?: boolean; name?: string } = {}) => {
    // DTS-emit gotcha (CLAUDE.md): conditional spreads like
    // `...(name && { name })` produce `string | false` and break
    // declaration generation. Build the options imperatively.
    const opts: ColumnOptions = {
        type: 'bigint',
        nullable,
        transformer: {
            to: (value?: Date) => (value ? value.getTime() : null),
            from: (value?: string | number) => (value ? new Date(Number(value)) : null),
        },
    };
    if (name) {
        opts.name = name;
    }
    return Column(opts);
};

export const PortableDateColumn = ({ nullable = false }: { nullable?: boolean } = {}) => {
    return Column({
        type: Date,
        nullable,
    });
};
