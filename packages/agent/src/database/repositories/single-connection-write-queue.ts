/**
 * Reviewer agent stage (slice AD, EW-811) — one write queue per DataSource
 * on the TypeORM drivers that funnel a whole DataSource through ONE
 * connection.
 *
 * ## Why this exists
 *
 * TypeORM 0.3's `BetterSqlite3Driver.createQueryRunner` hands every caller
 * the SAME query runner, and `transactionDepth` / `isTransactionActive` live
 * on that runner. So on better-sqlite3 — the DEFAULT `DATABASE_TYPE`, i.e.
 * every local and self-hosted install that does not configure Postgres, as
 * well as CI and the e2e stack — an ordinary autocommit statement issued
 * while some `manager.transaction` is open does not run on its own: it runs
 * INSIDE that transaction, commits with it, and is erased if it rolls back.
 * Two `manager.transaction` calls that overlap either collide ("cannot start
 * a transaction within a transaction") or nest as savepoints of each other.
 *
 * The review ledger opens exactly one transaction (the verdict write,
 * `TaskAgentReviewRepository.recordVerdict`). Every write the review stage
 * makes to its two tables — the claim INSERT, the run binding, the
 * settlements, the verdict, and the approver reset / restore — goes through
 * {@link serializeOnSingleConnection}, so on these drivers none of them can
 * land inside another one's transaction: a claim can no longer be rolled
 * back by an unrelated verdict's rollback after `claim()` reported it won
 * (review of Greptile P1-B on PR #2419).
 *
 * What it cannot do is order statements issued by code OUTSIDE the review
 * stage (another repository's `manager.transaction`, a task status CAS):
 * that is a property of every transaction on these drivers in this
 * repository, and closing it would mean serializing every write the
 * platform makes. Every such interaction with the verdict transaction fails
 * closed — see `recordVerdict`.
 *
 * A pooled driver (Postgres) runs the work immediately: each transaction
 * there has its own connection and the database's row locks do the
 * ordering.
 *
 * The queued work must NEVER itself call {@link serializeOnSingleConnection}
 * on the same DataSource — it would wait on its own tail forever. Queue
 * single statements (or one self-contained transaction), never a method that
 * queues.
 */

/** Drivers whose TypeORM runner is shared by a whole DataSource. */
export const SINGLE_CONNECTION_DRIVERS: ReadonlySet<string> = new Set([
    'better-sqlite3',
    'sqlite',
    'sqljs',
    'capacitor',
    'cordova',
    'expo',
    'nativescript',
    'react-native',
]);

/** Per-DataSource tail of the write queue on those drivers. */
const writeQueues = new WeakMap<object, Promise<void>>();

/** The slice of an `EntityManager` this helper reads. */
export interface ManagerLike {
    connection?: { options?: { type?: unknown } } | null;
}

/**
 * Run `work` after every earlier call queued on the same DataSource has
 * settled — on a single-connection driver. Immediately otherwise, and
 * immediately when no DataSource can be identified (a unit-test double).
 */
export function serializeOnSingleConnection<T>(
    manager: ManagerLike | null | undefined,
    work: () => Promise<T>,
): Promise<T> {
    const connection = manager?.connection;
    if (!connection || !SINGLE_CONNECTION_DRIVERS.has(String(connection.options?.type))) {
        return work();
    }
    const previous = writeQueues.get(connection) ?? Promise.resolve();
    const run = previous.then(
        () => work(),
        () => work(),
    );
    writeQueues.set(
        connection,
        run.then(
            () => undefined,
            () => undefined,
        ),
    );
    return run;
}
