#!/usr/bin/env node
/**
 * One-off diagnostic (not part of the fixture's deliverables): starts the stub, migrates, then runs the two
 * queries `/readyz` and `/state` use against the SAME connection and the same store, and prints both results.
 * Whichever way it comes out, it answers "is the /readyz-vs-/state disagreement in the app or in the stub?"
 */

import { createStubPostgres } from '../tools/dev-postgres.mjs';
import { connect, SQL } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';

const stub = createStubPostgres({ user: 'fixture', password: '', log: () => {} });
const port = await stub.listen(0);
const databaseUrl = `postgres://fixture@127.0.0.1:${port}/app_fixture?sslmode=disable`;
const env = { DATABASE_URL: databaseUrl };

await migrate({ databaseUrl, log: (line) => console.log(`  migrate: ${line}`) });

const client = await connect(env);

const QUERY = 'SELECT version FROM schema_migrations WHERE label = $1 ORDER BY version ASC';

// 1. The query readiness() issues, on a fresh connection.
const first = await client.query(QUERY, ['app']);
console.log(`\nreadiness query, connection A   → ${first.rows.length} row(s)`);

// 2. The query listAppliedMigrations issues, on the SAME connection.
const stateOnA = await client.query(SQL.listMigrations);
console.log(`state query,     connection A   → ${stateOnA.rows.length} row(s)`);

// 3. The readiness query again, on connection A, after the other statement ran.
const again = await client.query(QUERY, ['app']);
console.log(`readiness query, again on A     → ${again.rows.length} row(s)`);

// 4. The SAME readiness query on a SECOND connection — this is the server's situation, where
//    `readiness()` uses the cached `db()` connection and `/state` opens its own.
const second = await connect(env);
const onB = await second.query(QUERY, ['app']);
console.log(`readiness query, connection B   → ${onB.rows.length} row(s)`);

// 5. And the state query on connection B.
const stateOnB = await second.query(SQL.listMigrations);
console.log(`state query,     connection B   → ${stateOnB.rows.length} row(s)`);

console.log(`\nSQL.listMigrations = ${JSON.stringify(SQL.listMigrations)}`);

// Is the TABLE empty, or does the statement fail to parse? The stub keeps one shared store, so this is
// readable directly.
console.log(`\nstore.schema_migrations.rows.length = ${stub.store.schema_migrations.rows.length}`);
console.log(`store.schema_migrations.columns    = ${JSON.stringify(stub.store.schema_migrations.columns)}`);
console.log(`stub warnings                      = ${stub.warnings.length}`);
for (const warning of stub.warnings) console.log(`    ${warning}`);

// The two candidate causes, isolated: leading whitespace is the one thing the readiness text does not have
// and `SQL.listMigrations` does.
const trimmed = SQL.listMigrations.trim();
const onTrimmed = await second.query(trimmed);
console.log(`\nstate query, text TRIMMED       → ${onTrimmed.rows.length} row(s)`);

await second.end();

// And the leftover: everything the stub warned about, i.e. statements it did not recognise.
console.log(`\nstub warnings          → ${stub.warnings.length}`);
for (const warning of stub.warnings) console.log(`    ${warning}`);

await client.end();
await stub.close();
