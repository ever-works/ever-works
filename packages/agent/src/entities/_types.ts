import { Column, type ColumnOptions } from 'typeorm';

/**
 * Polymorphic-owner discriminator for budgets and usage rows
 * (Missions/Ideas/Works spec §8.2).
 *
 * Defined in this leaf-types file (rather than next to `WorkBudget`)
 * because four entities use it as a column default (`@Column({
 * default: BudgetOwnerType.WORK })`). When the enum lived next to
 * `WorkBudget` the import cycle work-budget → work → user →
 * work-generation-history → work-schedule → usage-ledger-entry →
 * work-budget left `BudgetOwnerType` undefined at decorator-evaluation
 * time on the entities other than `WorkBudget` itself, breaking
 * module init. Moving it here breaks the cycle: `_types.ts` imports
 * nothing from entities, so it's always fully loaded before any
 * entity needs it.
 *
 * Re-exported from `work-budget.entity.ts` for back-compat with any
 * call site that imports `BudgetOwnerType` from there.
 */
export enum BudgetOwnerType {
    WORK = 'work',
    IDEA = 'idea',
    MISSION = 'mission',
    /**
     * Per-Agent budgets (Agents/Skills/Tasks spec — ADR-013 + agents/plan.md
     * §3.1). Owner = `agents.id`. Aggregator added in
     * `BudgetService.getCurrentPeriodStart/getNextPeriodStart` handling all
     * 5 `intervalUnit` values per operator N6 override.
     */
    AGENT = 'agent',
}

/**
 * AW-17 — which of the three meters a usage row belongs to. Stamped once,
 * when the row is written; a NULL column is a row recorded before meters
 * were separated and is reported under its own label, never guessed.
 *
 * Lives in this leaf file for the same decorator-evaluation cycle reason as
 * `BudgetOwnerType` above. Values mirror `UsageMeterId` in
 * `@ever-works/contracts`.
 */
export enum UsageMeter {
    /** Paid with a credential the Workspace owns — recorded, never charged. */
    MODEL = 'model',
    /** Paid by the platform — priced from the credit price list. */
    CREDITS = 'credits',
    /** A flat monthly line for a provisioned unit — never draws credits. */
    ADDON = 'addon',
}

/** AW-17 — who paid the provider for a call. Mirrors `UsagePayerId`. */
export enum UsagePayer {
    WORKSPACE = 'workspace',
    PLATFORM = 'platform',
    /** Could not be determined — billed as platform and flagged. */
    UNCONFIRMED = 'unconfirmed',
}

/** AW-17 — did the call do new work? Mirrors `UsageOutcomeId`. */
export enum UsageOutcome {
    OK = 'ok',
    /** Served from cache — zero-rated. */
    CACHED = 'cached',
    /** Reached (or tried to reach) the provider and failed — zero-rated. */
    FAILED = 'failed',
}

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
/**
 * The write half of {@link TimestampColumn}: a `Date`, an ISO-8601 string or epoch millis → epoch millis.
 *
 * A `Date` is what the entity types promise, but it is not what always arrives. A row written through the
 * isolated Trigger worker's RPC proxy (`POST /internal/trigger/remote/call`) is JSON, so every `Date` lands
 * as an ISO string, and some callers pass `toISOString()` themselves. The old `value.getTime()` threw
 * `TypeError: value.getTime is not a function` on those. On prod 2026-10-18 that 500'd the App runtime-state
 * write at the end of a READY deploy, so `currentDeploymentId` was never recorded and the App read
 * `not-deployed` while it served. An unparseable value throws a TypeError that names it instead of storing
 * garbage. Anything else (e.g. a TypeORM FindOperator) passes through untouched.
 */
export function timestampToEpochMillis(value: unknown): unknown {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') {
        // Unchanged contract: a non-finite number is "no timestamp".
        return Number.isFinite(value) ? inDateRange(value, value) : null;
    }
    if (typeof value === 'string') {
        const numeric = /^-?\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
        if (Number.isFinite(numeric)) return inDateRange(numeric, value);
        throw new TypeError(
            `TimestampColumn: "${value}" is not a date, an ISO-8601 string or epoch milliseconds.`,
        );
    }
    if (value instanceof Date || typeof (value as { getTime?: unknown }).getTime === 'function') {
        const millis = (value as { getTime: () => number }).getTime();
        if (!Number.isFinite(millis)) {
            throw new TypeError('TimestampColumn: refusing to store an Invalid Date.');
        }
        return inDateRange(millis, value);
    }
    return value;
}

/** ECMAScript's Date range (±8.64e15 ms): outside it the read half would produce an Invalid Date. */
const MAX_DATE_MILLIS = 8.64e15;

function inDateRange(millis: number, original: unknown): number {
    if (Math.abs(millis) > MAX_DATE_MILLIS) {
        throw new TypeError(
            `TimestampColumn: ${String(original)} is outside the representable date range.`,
        );
    }
    return millis;
}

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
            to: timestampToEpochMillis,
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
