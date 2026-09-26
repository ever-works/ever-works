/**
 * `src/pg.mjs` — the dependency-free PostgreSQL client, against the protocol stub.
 *
 * The stub is a real server socket speaking the v3 wire protocol (startup, SCRAM-SHA-256, the simple
 * and the extended query protocols, `ErrorResponse`), so these cases exercise the client's framing,
 * its authentication, its parameter encoding and its error handling — everything except the SQL itself,
 * which only a real PostgreSQL can judge. **No real-PostgreSQL run is recorded in this repository** — set `FIXTURE_TEST_DATABASE_URL` and run these cases against one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStubPostgres } from '../tools/dev-postgres.mjs';
import { PgClient, PgError, parseDatabaseUrl, redactUrl } from '../src/pg.mjs';

async function withStub(options, fn) {
	const stub = createStubPostgres({ log: () => {}, ...options });
	const port = await stub.listen(0);
	const url = `postgres://fixture${options?.password ? `:${options.password}` : ''}@127.0.0.1:${port}/app_fixture?sslmode=disable`;
	try {
		return await fn({ stub, port, url });
	} finally {
		await stub.close();
	}
}

test('parseDatabaseUrl reads a URL and falls back to the PG* variables', () => {
	const parsed = parseDatabaseUrl('postgres://user:p%40ss@db.example.test:6543/app?sslmode=require&application_name=x');
	assert.deepEqual(
		{ host: parsed.host, port: parsed.port, user: parsed.user, password: parsed.password, database: parsed.database, sslmode: parsed.sslmode, applicationName: parsed.applicationName },
		{ host: 'db.example.test', port: 6543, user: 'user', password: 'p@ss', database: 'app', sslmode: 'require', applicationName: 'x' }
	);
	assert.equal(parseDatabaseUrl('', {}), null);
	assert.equal(parseDatabaseUrl('', { PGHOST: 'h', PGDATABASE: 'd', PGUSER: 'u' }).database, 'd');
	assert.throws(() => parseDatabaseUrl('mysql://x'), /must start with postgres/);
	assert.throws(() => parseDatabaseUrl('not a url'), /not a URL/);
});

test('redactUrl hides the password', () => {
	assert.equal(redactUrl('postgres://user:secret@host:5432/db'), 'postgres://user:***@host:5432/db');
});

test('the client authenticates with SCRAM-SHA-256 and reports the server version', async () => {
	await withStub({ user: 'fixture', password: 'fixturepw' }, async ({ url }) => {
		const client = new PgClient({ url, connectTimeoutMs: 3_000, queryTimeoutMs: 3_000 });
		await client.connect();
		try {
			assert.equal(client.connected, true);
			assert.equal(client.serverParameters.server_version, '16.2');
		} finally {
			await client.end();
		}
	});
});

test('a wrong password is refused', async () => {
	await withStub({ user: 'fixture', password: 'the-right-one' }, async ({ url }) => {
		const wrong = url.replace('the-right-one', 'the-wrong-one');
		const client = new PgClient({ url: wrong, connectTimeoutMs: 3_000, queryTimeoutMs: 3_000 });
		await assert.rejects(() => client.connect(), /password authentication failed|SCRAM/);
	});
});

test('the extended protocol carries text parameters and decodes result types', async () => {
	await withStub({}, async ({ url }) => {
		const client = new PgClient({ url, connectTimeoutMs: 3_000, queryTimeoutMs: 3_000 });
		await client.connect();
		try {
			const { rows, rowCount, command } = await client.query('SELECT $1 AS name, $2 AS n', ['hello', 42]);
			assert.deepEqual(rows, [{ name: 'hello', n: 42 }]);
			assert.equal(rowCount, 1);
			assert.equal(command, 'SELECT 1');

			const nulls = await client.query('SELECT $1 AS nothing', [null]);
			assert.deepEqual(nulls.rows, [{ nothing: null }]);
		} finally {
			await client.end();
		}
	});
});

test('the simple protocol runs several statements and returns each result', async () => {
	await withStub({}, async ({ url }) => {
		const client = new PgClient({ url, connectTimeoutMs: 3_000, queryTimeoutMs: 3_000 });
		await client.connect();
		try {
			const result = await client.simpleQuery(
				"CREATE TABLE IF NOT EXISTS t (id int primary key, label text);\n" +
					"INSERT INTO t (id, label) VALUES (1, 'a(b)') ON CONFLICT (id) DO NOTHING;\n" +
					'SELECT count(*) AS c FROM t;'
			);
			assert.deepEqual(result.statements.map((statement) => statement.command), ['CREATE TABLE', 'INSERT 0 1', 'SELECT 1']);
			assert.deepEqual(result.rows, [{ c: 1 }]);
		} finally {
			await client.end();
		}
	});
});

test('an ErrorResponse becomes a PgError and the connection stays usable', async () => {
	await withStub({ strict: true }, async ({ url }) => {
		const client = new PgClient({ url, connectTimeoutMs: 3_000, queryTimeoutMs: 3_000 });
		await client.connect();
		try {
			await assert.rejects(
				() => client.simpleQuery('CREATE TABL broken (id int);'),
				(error) => {
					assert.ok(error instanceof PgError);
					assert.equal(error.code, '0A000');
					assert.match(error.message, /does not implement/);
					return true;
				}
			);
			// PostgreSQL puts the connection back in a usable state after a failed statement.
			const after = await client.query('SELECT $1 AS still_alive', ['yes']);
			assert.deepEqual(after.rows, [{ still_alive: 'yes' }]);
		} finally {
			await client.end();
		}
	});
});

test('a query against a client that is not connected fails instead of hanging', async () => {
	const client = new PgClient({ url: 'postgres://nobody@127.0.0.1:1/x' });
	await assert.rejects(() => client.query('SELECT 1'), /not connected/);
});

test('connecting to a port with nothing on it fails within the connect timeout', async () => {
	const client = new PgClient({ url: 'postgres://nobody@127.0.0.1:1/x', connectTimeoutMs: 1_000 });
	await assert.rejects(
		() => client.connect(),
		(error) => {
			assert.ok(error instanceof Error);
			return true;
		}
	);
});

test('end() is safe to call twice', async () => {
	await withStub({}, async ({ url }) => {
		const client = new PgClient({ url, connectTimeoutMs: 3_000, queryTimeoutMs: 3_000 });
		await client.connect();
		await client.end();
		await client.end();
		assert.equal(client.connected, false);
	});
});
