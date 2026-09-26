/**
 * The two facts that must be true without anyone watching: the fingerprint of the generated secret, and
 * the worker's heartbeat.
 *
 * `secretFingerprint` is the whole of ACC-NEG-12's positive half — a generated value that is identical
 * across redeploys while its value never leaves the environment — and `workerHeartbeatAt` is how the
 * blueprint README observes the `worker` component at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fingerprint, safeEqual } from '../src/fingerprint.mjs';
import { ageSeconds, checkUploadsWritable } from '../src/state.mjs';
import { baseEnv, startDatabase, tempDir } from './helpers/harness.mjs';
import { runWorker } from '../src/worker.mjs';
import { connect, readHeartbeat } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const migrationsDir = path.join(appRoot, 'migrations');

test('the fingerprint publishes a length and a hash prefix, never the value', () => {
	const value = 'abcdefghijklmnopqrstuvwxyz012345';
	const print = fingerprint(value);
	assert.equal(print.length, 32);
	assert.equal(print.set, true);
	assert.match(print.sha256Prefix8, /^[0-9a-f]{8}$/);
	assert.ok(!JSON.stringify(print).includes(value));
	assert.equal(print.sha256Prefix8, fingerprint(value).sha256Prefix8, 'stable for the same value');
	assert.notEqual(print.sha256Prefix8, fingerprint('another-value-of-the-same-length!').sha256Prefix8);
	assert.equal(fingerprint('').sha256Prefix8, '', 'an unset secret has no fingerprint');
});

test('safeEqual compares without leaking a length', () => {
	assert.equal(safeEqual('token', 'token'), true);
	assert.equal(safeEqual('token', 'toke'), false);
	assert.equal(safeEqual('token', ''), false);
	assert.equal(safeEqual('', ''), false, 'an empty configured token never matches');
});

test('ageSeconds reports the age of an ISO timestamp and survives rubbish', () => {
	assert.equal(ageSeconds('2026-09-17T10:00:00.000Z', '2026-09-17T10:00:10.000Z'), 10);
	assert.equal(ageSeconds(null, '2026-09-17T10:00:10.000Z'), null);
	assert.equal(ageSeconds('not a time', '2026-09-17T10:00:10.000Z'), null);
});

test('checkUploadsWritable writes and removes its probe', () => {
	const dir = tempDir('fixture-uploads-');
	assert.equal(checkUploadsWritable(dir), true);
	assert.equal(checkUploadsWritable(path.join(dir, 'deeper', 'still')), true, 'the volume may not exist yet');
	assert.deepEqual(fs.readdirSync(dir), ['deeper'], 'the probe files are removed');
	assert.equal(checkUploadsWritable(path.join(import.meta.filename)), false, 'a file cannot be a directory');
});

test('the worker writes a heartbeat that gets fresher with every beat', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	const env = baseEnv({ DATABASE_URL: database.url });
	await migrate({ databaseUrl: database.url, dir: migrationsDir, log: () => {} });

	const lines = [];
	const first = await runWorker({ env, once: true, log: (line) => lines.push(line) });
	assert.equal(first.beats, 1);
	const second = await runWorker({ env, once: true, log: (line) => lines.push(line) });
	assert.equal(second.beats, 1);

	// `writeHeartbeat` bumps `beat_count` on one row per name (`db.mjs:149-152`: UPDATE, then INSERT … ON
	// CONFLICT DO NOTHING), and both `runWorker` calls beat in THIS process under the same name — so the row
	// carries 2, not 1. An earlier version of this test expected 1 and commented that "the name is per
	// process", which the implementation never did.
	const client = await connect({ DATABASE_URL: database.url });
	try {
		const heartbeat = await readHeartbeat(client, 'worker');
		assert.ok(heartbeat, 'a heartbeat row exists');
		assert.equal(Number(heartbeat.beat_count), 2, 'both beats increment the same row, keyed by name');
		assert.ok(String(heartbeat.beat_at).endsWith('Z'));
	} finally {
		await client.end();
	}
	assert.ok(lines.some((line) => line.event === 'worker.heartbeat'));
});

test('the worker exits with a configuration error when it has no database', async () => {
	await assert.rejects(
		() => runWorker({ env: baseEnv({ DATABASE_URL: '' }), once: true, log: () => {} }),
		(error) => {
			assert.equal(error.exitCode, 2);
			assert.match(error.message, /DATABASE_URL is not set/);
			return true;
		}
	);
});

test('the worker keeps beating while the database is unreachable, then gives up on abort', async () => {
	const abort = new AbortController();
	const lines = [];
	const running = runWorker({
		env: baseEnv({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x', FIXTURE_DB_CONNECT_TIMEOUT_MS: '300' }),
		intervalMs: 50,
		log: (line) => lines.push(line),
		signal: abort.signal
	});
	await new Promise((resolve) => setTimeout(resolve, 700));
	abort.abort();
	const result = await running;
	assert.equal(result.ok, true);
	assert.ok(lines.some((line) => line.event === 'worker.heartbeat-failed'), 'the failure is logged, not thrown');
	assert.ok(lines.some((line) => line.event === 'worker.stopped'));
});
