/**
 * `src/migrate.mjs` — the `pre-deploy` job, and the file `variant/bad-migration` breaks.
 *
 * Covers ordering, one-transaction-per-file, checksums, idempotency, the `--label` that makes
 * ACC-05-12 readable, and the failure that must stop a rollout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startDatabase, writeMigrations } from './helpers/harness.mjs';
import { migrate } from '../src/migrate.mjs';
import { appliedVersions, connect, listAppliedMigrations } from '../src/db.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const realMigrations = path.join(appRoot, 'migrations');

test('the application\'s own migrations apply in order and are recorded', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const lines = [];
	const result = await migrate({ databaseUrl: database.url, dir: realMigrations, log: (line) => lines.push(line) });

	assert.deepEqual(result.applied, ['0001_init.sql', '0002_ticks.sql', '0003_bootstrap.sql']);
	assert.deepEqual(result.skipped, []);
	assert.equal(result.label, 'app');
	assert.ok(lines.some((line) => line.includes('applied 0001_init.sql')));

	const client = await connect({ DATABASE_URL: database.url });
	try {
		const rows = await listAppliedMigrations(client);
		assert.deepEqual(rows.map((row) => row.file), ['0001_init.sql', '0002_ticks.sql', '0003_bootstrap.sql']);
		assert.ok(rows.every((row) => row.label === 'app'));
		assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)));
		assert.ok(rows.every((row) => typeof row.appliedAt === 'string' && row.appliedAt.endsWith('Z')));
	} finally {
		await client.end();
	}
});

test('a second run applies nothing and changes nothing', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await migrate({ databaseUrl: database.url, dir: realMigrations, log: () => {} });
	const again = await migrate({ databaseUrl: database.url, dir: realMigrations, log: () => {} });
	assert.deepEqual(again.applied, []);
	assert.deepEqual(again.skipped, ['0001_init.sql', '0002_ticks.sql', '0003_bootstrap.sql']);
});

test('a migration that changed after it was applied is refused, not re-run', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const dir = writeMigrations({ '0001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int primary key);' });
	await migrate({ databaseUrl: database.url, dir, log: () => {} });

	fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS t_a (id int primary key, extra text);');
	await assert.rejects(() => migrate({ databaseUrl: database.url, dir, log: () => {} }), /refusing to apply a changed migration/);
});

test('a failing migration exits non-zero and leaves nothing behind (variant/bad-migration)', async (t) => {
	// `strict` makes the stub refuse a statement it does not implement, which is how a syntax error
	// behaves against a real server.
	const database = await startDatabase({ strict: true });
	t.after(() => database.close());
	const dir = writeMigrations({
		'0001_init.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int primary key);',
		'0002_ticks.sql': 'CREATE TABL t_b (id int primry key);'
	});

	await assert.rejects(
		() => migrate({ databaseUrl: database.url, dir, log: () => {} }),
		(error) => {
			assert.equal(error.exitCode, 1, 'the job must exit non-zero so the rollout never starts');
			assert.match(error.message, /0002_ticks\.sql failed/);
			return true;
		}
	);

	const client = await connect({ DATABASE_URL: database.url });
	try {
		assert.deepEqual(await appliedVersions(client, 'app'), ['0001_init.sql'], 'the failing file is not recorded');
	} finally {
		await client.end();
	}
});

test('--label build-time records a separate set (ACC-05-12 observable)', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const dir = writeMigrations({
		'0001_init.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int primary key);',
		'0002_ticks.sql': 'CREATE TABLE IF NOT EXISTS t_b (id int primary key);'
	});

	// The build stage of variant/services-postgres migrates a throwaway database with this label.
	const build = await migrate({ databaseUrl: database.url, dir, label: 'build-time', log: () => {} });
	assert.deepEqual(build.applied, ['0001_init.sql', '0002_ticks.sql']);

	const client = await connect({ DATABASE_URL: database.url });
	try {
		assert.deepEqual(await appliedVersions(client, 'app'), [], 'no application migration has been applied yet');
		assert.deepEqual(await appliedVersions(client, 'build-time'), ['0001_init.sql', '0002_ticks.sql']);
		const detail = await listAppliedMigrations(client);
		assert.ok(detail.every((row) => row.label === 'build-time'), 'GET /state.migrationDetails would show the build-time rows');
	} finally {
		await client.end();
	}

	// The App Work's own migrate job then runs with the default label and still applies everything.
	const app = await migrate({ databaseUrl: database.url, dir, log: () => {} });
	assert.deepEqual(app.applied, ['0001_init.sql', '0002_ticks.sql']);
	const after = await connect({ DATABASE_URL: database.url });
	try {
		assert.deepEqual(await appliedVersions(after, 'app'), ['0001_init.sql', '0002_ticks.sql']);
	} finally {
		await after.end();
	}
});

test('a missing DATABASE_URL is a configuration error, not a crash', async () => {
	await assert.rejects(
		() => migrate({ databaseUrl: '', dir: realMigrations, log: () => {} }),
		(error) => {
			assert.equal(error.exitCode, 2);
			assert.match(error.message, /DATABASE_URL is not set/);
			return true;
		}
	);
});

test('an empty migrations directory is a configuration error', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const dir = writeMigrations({ 'README.md': 'not a migration' });
	await assert.rejects(
		() => migrate({ databaseUrl: database.url, dir, log: () => {} }),
		(error) => {
			assert.equal(error.exitCode, 2);
			assert.match(error.message, /no \*\.sql files/);
			return true;
		}
	);
});
