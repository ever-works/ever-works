/**
 * Better Auth on better-sqlite3 shares TypeORM's ONE connection (see
 * `getSqliteDatabase` in `auth-runtime.instance.ts`).
 *
 * The regression this pins (round-5 stage e2e, after better-auth 1.6.25 →
 * 1.7.14): every `POST /api/auth/register` answered 500 with `cannot rollback
 * - no transaction is active`, and the domain event relay logged `near "-":
 * syntax error` once a second. Better Auth 1.7 opened its own transaction on
 * the raw handle; a TypeORM transaction that started inside it failed to
 * BEGIN, rolled the sign-up back on its way out, and left TypeORM's shared
 * query runner at depth -1, so every later TypeORM transaction issued
 * `SAVEPOINT typeorm_-1`.
 *
 * Jest cannot load Better Auth's ESM build, so `betterAuth` is mocked to
 * capture the options and `signUpAsBetterAuthDoes` replays, with the real
 * Kysely, what Better Auth 1.7.14 does with the `database` option it is
 * handed (`createKyselyAdapter` in `@better-auth/kysely-adapter`): a
 * `{ dialect }` option keeps its own `transaction` flag, while a raw
 * better-sqlite3 handle gets a `SqliteDialect` WITH transactions. The writes
 * have the shape of an email sign-up: the user, an `await` (the
 * `user.create.before` hook hashes a password, so the event loop runs other
 * work, here a relay tick), then the credential account. The relay and the
 * TypeORM DataSource are the real ones.
 */

const betterAuthMock = jest.fn().mockReturnValue({ __betterAuthInstance: true });

jest.mock('better-auth', () => ({
    betterAuth: betterAuthMock,
}));
jest.mock('better-auth/plugins', () => ({
    bearer: jest.fn().mockReturnValue({ __bearerPlugin: true }),
}));
jest.mock('terms-acceptance/better-auth', () => ({
    termsAcceptancePlugin: jest.fn().mockReturnValue({ __termsAcceptancePlugin: true }),
}));

import { randomUUID } from 'node:crypto';
import { Kysely, SqliteDialect, type Dialect } from 'kysely';
import { DataSource } from 'typeorm';
import {
    DomainEventRelayService,
    DomainEventRetentionService,
    newDomainEventId,
} from '@ever-works/agent/domain-events';
import { DomainEvent, DomainEventRelayState } from '@ever-works/agent/entities';
import { createAuthRuntimeInstance } from './auth-runtime.instance';

/**
 * The Kysely instance and transaction flag Better Auth 1.7.14 derives from
 * `database`. Never `destroy()` one: its SQLite driver would close TypeORM's
 * connection.
 */
function kyselyAsBetterAuthBuildsIt(database: unknown): { db: Kysely<any>; transaction: boolean } {
    const option = database as Record<string, unknown>;
    if ('dialect' in option) {
        return {
            db: new Kysely<any>({ dialect: option.dialect as Dialect }),
            transaction: Boolean(option.transaction),
        };
    }
    if ('aggregate' in option && !('createSession' in option)) {
        return {
            db: new Kysely<any>({ dialect: new SqliteDialect({ database: option as never }) }),
            transaction: true,
        };
    }
    throw new Error('unexpected Better Auth database option');
}

/**
 * An email sign-up's writes as Better Auth 1.7.14 issues them for `database`:
 * inside one Kysely transaction when the option turns transactions on, as
 * plain statements otherwise. `whileHashing` runs between the two inserts.
 */
async function signUpAsBetterAuthDoes(
    database: unknown,
    email: string,
    whileHashing: () => Promise<void>,
): Promise<string> {
    const { db, transaction } = kyselyAsBetterAuthBuildsIt(database);
    const writes = async (trx: Kysely<any>): Promise<string> => {
        const userId = randomUUID();
        await trx.insertInto('signup_users').values({ id: userId, email }).execute();
        await whileHashing();
        await trx.insertInto('signup_accounts').values({ id: randomUUID(), userId }).execute();
        return userId;
    };
    return transaction ? db.transaction().execute(writes) : writes(db);
}

/** A pending (undispatched) outbox row, inserted without a TypeORM transaction. */
async function insertPendingEvent(dataSource: DataSource): Promise<void> {
    const id = randomUUID();
    await dataSource.getRepository(DomainEvent).insert({
        id: newDomainEventId(),
        type: 'task.updated',
        version: 1,
        tenantId: null,
        organizationId: null,
        aggregateType: 'task',
        aggregateId: id,
        aggregateVersion: 2,
        visibility: null,
        actorType: 'user',
        actorId: randomUUID(),
        actorLabel: null,
        originTag: null,
        integrationKeyId: null,
        changedFields: ['title'],
        data: { id, title: 'Ship it' },
        previous: { title: 'Ship' },
        occurredAt: new Date(),
        dispatchedAt: null,
        seq: null,
        correlationId: null,
    });
}

describe('Better Auth on better-sqlite3 next to TypeORM transactions', () => {
    const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
    let dataSource: DataSource;
    let relay: DomainEventRelayService;

    beforeAll(() => {
        // `config.auth.secret()` requires at least 32 characters.
        process.env.AUTH_SECRET = 'a'.repeat(32);
    });

    afterAll(() => {
        if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
    });

    const betterAuthDatabase = (): unknown => {
        createAuthRuntimeInstance(dataSource);
        expect(betterAuthMock).toHaveBeenCalledTimes(1);
        return betterAuthMock.mock.calls[0][0].database;
    };

    beforeEach(async () => {
        betterAuthMock.mockClear();
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [DomainEvent, DomainEventRelayState],
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            'CREATE TABLE "signup_users" ("id" varchar PRIMARY KEY, "email" varchar NOT NULL UNIQUE)',
        );
        await dataSource.query(
            'CREATE TABLE "signup_accounts" ("id" varchar PRIMARY KEY, "userId" varchar NOT NULL)',
        );
        relay = new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
        );
        // Take the relay lease up front, so every later tick goes straight to its batch transaction.
        await expect(relay.tick()).resolves.toEqual({ leader: true, dispatched: 0 });
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it("hands Better Auth a SQLite dialect over TypeORM's own connection, with its transactions off", async () => {
        const database = betterAuthDatabase();

        expect(database).toEqual({
            dialect: expect.any(SqliteDialect),
            type: 'sqlite',
            transaction: false,
        });

        // Same connection, not a second one: an in-memory database exists only on
        // the connection that created it, so a write through the dialect must be
        // visible to TypeORM.
        const { db } = kyselyAsBetterAuthBuildsIt(database);
        await db
            .insertInto('signup_users')
            .values({ id: 'u-1', email: 'one@example.com' })
            .execute();
        await expect(dataSource.query('SELECT "email" FROM "signup_users"')).resolves.toEqual([
            { email: 'one@example.com' },
        ]);
    });

    it('commits a sign-up whose writes straddle a relay tick, and the tick dispatches', async () => {
        const database = betterAuthDatabase();
        await insertPendingEvent(dataSource);

        let tickDuringSignUp: unknown;
        const userId = await signUpAsBetterAuthDoes(database, 'straddle@example.com', async () => {
            tickDuringSignUp = await relay.tick().catch((error: unknown) => error);
        });

        expect(tickDuringSignUp).toEqual({ leader: true, dispatched: 1 });
        await expect(
            dataSource.query('SELECT "email" FROM "signup_users" WHERE "id" = ?', [userId]),
        ).resolves.toEqual([{ email: 'straddle@example.com' }]);
        await expect(
            dataSource.query('SELECT COUNT(*) AS "n" FROM "signup_accounts" WHERE "userId" = ?', [
                userId,
            ]),
        ).resolves.toEqual([{ n: 1 }]);
        expect(dataSource.createQueryRunner().isTransactionActive).toBe(false);
    });

    it('keeps the relay dispatching after a sign-up overlapped one of its ticks', async () => {
        const database = betterAuthDatabase();
        await insertPendingEvent(dataSource);
        await signUpAsBetterAuthDoes(database, 'overlap@example.com', async () => {
            await relay.tick().catch(() => undefined);
        }).catch(() => undefined);

        await insertPendingEvent(dataSource);

        // Before the fix this rejected with `near "-": syntax error`
        // (`SAVEPOINT typeorm_-1`), the line the e2e API log repeated every second.
        await expect(relay.tick()).resolves.toEqual({ leader: true, dispatched: 1 });
        await expect(dataSource.transaction(async () => 'ok')).resolves.toBe('ok');
    });
});
