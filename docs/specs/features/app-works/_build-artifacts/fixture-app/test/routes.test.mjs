/**
 * The route table of the plan's §4.2 — the contract the blueprint README's feature table is read through.
 *
 * Every case here runs the real `src/server.mjs`; the database is the protocol stub of
 * `tools/dev-postgres.mjs` (or a real PostgreSQL when `FIXTURE_TEST_DATABASE_URL` is set).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { baseEnv, startDatabase, withServer } from './helpers/harness.mjs';
import { migrate } from '../src/migrate.mjs';
import { runWorker } from '../src/worker.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const migrationsDir = path.join(appRoot, 'migrations');

test('GET /healthz answers 200 with no database at all', async () => {
	await withServer(baseEnv({ DATABASE_URL: '' }), async ({ request }) => {
		const response = await request('/healthz');
		assert.equal(response.status, 200);
		assert.equal(response.text, 'ok');
	});
});

test('GET /readyz is 503 before migrating and 200 after', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const env = baseEnv({ DATABASE_URL: database.url });

	await withServer(env, async ({ request }) => {
		const before = await request('/readyz');
		assert.equal(before.status, 503, 'a component that has not migrated is not ready');
		assert.equal(before.json.ready, false);
		assert.deepEqual(before.json.pending, ['0001_init.sql', '0002_ticks.sql', '0003_bootstrap.sql']);

		await migrate({ databaseUrl: database.url, dir: migrationsDir, log: () => {} });

		const after = await request('/readyz');
		assert.equal(after.status, 200);
		assert.equal(after.json.ready, true);
		assert.deepEqual(after.json.applied, ['0001_init.sql', '0002_ticks.sql', '0003_bootstrap.sql']);
		assert.deepEqual(after.json.pending, []);
	});
});

test('GET /readyz reports a database that is not there', async () => {
	// Port 1 is never a Postgres; the readiness answer must say so instead of throwing.
	await withServer(baseEnv({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x', FIXTURE_DB_CONNECT_TIMEOUT_MS: '500' }), async ({ request }) => {
		const response = await request('/readyz');
		assert.equal(response.status, 503);
		assert.equal(response.json.ready, false);
		assert.ok(response.json.reason.length > 0);
	});
});

test('GET /marker reports the prompted marker, the build commit and the build label', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const env = baseEnv({ DATABASE_URL: database.url, FIXTURE_PUBLIC_URL: 'https://fixture.example.test/' });

	await withServer(env, async ({ request }) => {
		const response = await request('/marker');
		assert.equal(response.status, 200);
		assert.equal(response.json.marker, 'test-marker');
		assert.equal(response.json.sha, 'a'.repeat(40));
		assert.equal(response.json.buildLabel, 'fixture-blueprint-0.1.0');
		assert.equal(response.json.publicUrl, 'https://fixture.example.test', 'the trailing slash is normalised away');
		assert.equal(response.json.greeting, 'Hello from app-fixture-hello');
		assert.ok(!response.text.includes('localhost'), 'ACC-NEG-11: no local address in /marker');
	});
});

test('GET /marker falls back to the request host and never invents localhost', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await withServer(baseEnv({ DATABASE_URL: database.url, FIXTURE_PUBLIC_URL: '' }), async ({ request, base }) => {
		const response = await request('/marker');
		assert.equal(response.json.publicUrl, base);
		assert.ok(!response.json.publicUrl.includes('localhost:8080'), 'the fixture never bakes a local URL in');
	});
});

test('GET /state reports migrations, heartbeat, cron ticks, bootstrap, the volume and the fingerprint', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const env = baseEnv({ DATABASE_URL: database.url });
	await migrate({ databaseUrl: database.url, dir: migrationsDir, log: () => {} });
	await runWorker({ env, once: true, log: () => {} });

	await withServer(env, async ({ request }) => {
		const state = await request('/state');
		assert.equal(state.status, 200);
		assert.deepEqual(state.json.migrations, ['0001_init.sql', '0002_ticks.sql', '0003_bootstrap.sql']);
		assert.deepEqual(state.json.pendingMigrations, []);
		assert.equal(state.json.database.reachable, true);

		// worker heartbeat: the worker component is running (blueprint README: under 30 seconds old)
		assert.ok(state.json.workerHeartbeatAt, 'a worker heartbeat was recorded');
		assert.ok(state.json.workerHeartbeatAgeSeconds >= 0 && state.json.workerHeartbeatAgeSeconds < 30, `age ${state.json.workerHeartbeatAgeSeconds}s`);

		// volume
		assert.equal(state.json.uploadsWritable, true);

		// generated secret, never rotated: length and hash prefix only
		assert.equal(state.json.secretFingerprint.length, 32);
		assert.match(state.json.secretFingerprint.sha256Prefix8, /^[0-9a-f]{8}$/);
		assert.ok(!state.text.includes(env.FIXTURE_SESSION_SECRET), 'the session secret value is never returned');
		assert.ok(!state.text.includes(env.FIXTURE_CRON_TOKEN), 'the cron token is never returned');

		// cron counter and first-deploy observation exist even before the first tick
		assert.equal(state.json.cronTicks, 0);
		assert.equal(state.json.lastCronTickAt, null);
	});
});

test('the secret fingerprint is stable across restarts and changes only with the value', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const env = baseEnv({ DATABASE_URL: database.url });
	const first = await withServer(env, ({ request }) => request('/state'));
	const second = await withServer(env, ({ request }) => request('/state'));
	assert.deepEqual(first.json.secretFingerprint, second.json.secretFingerprint, 'ACC-NEG-12: identical across redeploys');

	const rotated = await withServer({ ...env, FIXTURE_SESSION_SECRET: 'z'.repeat(32) }, ({ request }) => request('/state'));
	assert.equal(rotated.json.secretFingerprint.length, 32);
	assert.notEqual(rotated.json.secretFingerprint.sha256Prefix8, first.json.secretFingerprint.sha256Prefix8);
});

test('GET /state reports a volume it cannot write to as false', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	// A path under a file can never be a directory, so the write fails the way a read-only volume does.
	const file = path.join(import.meta.dirname, 'helpers', 'harness.mjs');
	await withServer(baseEnv({ DATABASE_URL: database.url, FIXTURE_DATA_DIR: file }), async ({ request }) => {
		const state = await request('/state');
		assert.equal(state.json.uploadsWritable, false);
	});
});

test('POST /cron/tick refuses an anonymous call and counts an authorised one', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const env = baseEnv({ DATABASE_URL: database.url });
	await migrate({ databaseUrl: database.url, dir: migrationsDir, log: () => {} });

	await withServer(env, async ({ request }) => {
		const anonymous = await request('/cron/tick', { method: 'POST' });
		assert.equal(anonymous.status, 401, 'the smoke check cron-refuses-anonymous expects 401');

		const wrong = await request('/cron/tick', { method: 'POST', headers: { authorization: 'Bearer nope' } });
		assert.equal(wrong.status, 401);

		const raw = await request('/cron/tick', { method: 'POST', headers: { authorization: env.FIXTURE_CRON_TOKEN } });
		assert.equal(raw.status, 401, 'authScheme is bearer, so the raw form is refused');

		const ok = await request('/cron/tick', { method: 'POST', headers: { authorization: `Bearer ${env.FIXTURE_CRON_TOKEN}` } });
		assert.equal(ok.status, 204);

		const state = await request('/state');
		assert.equal(state.json.cronTicks, 1);
		assert.ok(state.json.lastCronTickAt, 'the tick is timestamped');

		await request('/cron/tick', { method: 'POST', headers: { authorization: `Bearer ${env.FIXTURE_CRON_TOKEN}` } });
		const after = await request('/state');
		assert.equal(after.json.cronTicks, 2, 'the counter increases');
	});
});

test('POST /cron/tick refuses every call when no token is configured', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await withServer(baseEnv({ DATABASE_URL: database.url, FIXTURE_CRON_TOKEN: '' }), async ({ request }) => {
		const response = await request('/cron/tick', { method: 'POST', headers: { authorization: 'Bearer ' } });
		assert.equal(response.status, 401);
	});
});

test('POST /mail/test answers 503 when the smtp dependency is missing', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await withServer(baseEnv({ DATABASE_URL: database.url, SMTP_HOST: '' }), async ({ request }) => {
		const response = await request('/mail/test', { method: 'POST' });
		assert.equal(response.status, 503);
		assert.match(response.json.detail, /SMTP_HOST/);
	});
});

test('GET /brand/logo.svg serves the protected branding asset', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await withServer(baseEnv({ DATABASE_URL: database.url }), async ({ request }) => {
		const response = await request('/brand/logo.svg');
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'image/svg+xml');
		assert.ok(response.text.includes('<svg'));
		assert.ok(fs.existsSync(path.join(appRoot, 'public', 'brand', 'logo.svg')), 'the protected path exists in the tree');
	});
});

test('unknown paths are 404 and wrong methods are 405', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await withServer(baseEnv({ DATABASE_URL: database.url }), async ({ request }) => {
		assert.equal((await request('/nope')).status, 404);
		assert.equal((await request('/brand/../package.json')).status, 404);
		const wrongMethod = await request('/marker', { method: 'POST' });
		assert.equal(wrongMethod.status, 405);
		assert.deepEqual(wrongMethod.json.allow, ['GET']);
	});
});

test('the fixture answers at all with no database configured', async () => {
	await withServer(baseEnv({ DATABASE_URL: '' }), async ({ request }) => {
		assert.equal((await request('/')).status, 200);
		assert.equal((await request('/marker')).status, 200);
		const state = await request('/state');
		assert.equal(state.status, 200);
		assert.equal(state.json.database.configured, false);
		assert.deepEqual(state.json.migrations, []);
	});
});
