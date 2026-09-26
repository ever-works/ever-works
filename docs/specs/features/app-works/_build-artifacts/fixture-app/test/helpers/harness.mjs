/**
 * Shared test harness: an in-process Postgres stub on a random port, and a fixture server on a random
 * port. Nothing here is a mock of the fixture — the real `src/server.mjs`, `src/migrate.mjs`,
 * `src/worker.mjs` and `src/db.mjs` run; only the database server is a stub (`tools/dev-postgres.mjs`).
 *
 * Tests that want a real PostgreSQL set `FIXTURE_TEST_DATABASE_URL`, and the same cases then run against
 * it unchanged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStubPostgres } from '../../tools/dev-postgres.mjs';
import { createServer } from '../../src/server.mjs';
import { loadConfig } from '../../src/config.mjs';

/** The database every test uses unless `FIXTURE_TEST_DATABASE_URL` names a real one. */
export async function startDatabase({ password = '', strict = false, useReal = null } = {}) {
	const real = useReal ?? process.env.FIXTURE_TEST_DATABASE_URL;
	if (real) return { url: real, stub: null, real: true, close: async () => undefined };

	const stub = createStubPostgres({ user: 'fixture', password, strict, log: () => {} });
	const port = await stub.listen(0);
	const url = `postgres://fixture${password ? `:${password}` : ''}@127.0.0.1:${port}/app_fixture?sslmode=disable`;
	return { url, stub, real: false, close: () => stub.close() };
}

export function tempDir(prefix = 'fixture-test-') {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function baseEnv(overrides = {}) {
	return {
		DATABASE_URL: '',
		FIXTURE_MARKER: 'test-marker',
		FIXTURE_GIT_SHA: 'a'.repeat(40),
		FIXTURE_BUILD_LABEL: 'fixture-blueprint-0.1.0',
		FIXTURE_SESSION_SECRET: 's'.repeat(32),
		FIXTURE_CRON_TOKEN: 'cron-token-for-tests',
		FIXTURE_MAIL_TO: 'sink@example.invalid',
		FIXTURE_DATA_DIR: tempDir(),
		FIXTURE_DEPENDENCY_CACHE_MS: '0',
		FIXTURE_MAIL_RATE_LIMIT_MS: '0',
		...overrides
	};
}

/** Boot `createServer` on a random port and hand the test a `request()` helper. */
export async function withServer(env, fn) {
	const config = loadConfig(env);
	const app = createServer(config, { env });
	const address = await app.listen(0, '127.0.0.1');
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (route, init) => {
		const response = await fetch(`${base}${route}`, { redirect: 'manual', ...init });
		const text = await response.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: response.status, text, json, headers: response.headers };
	};
	try {
		return await fn({ base, request, app, config });
	} finally {
		await app.close();
	}
}

/** Write `files` (name → contents) into a fresh directory and return its path. */
export function writeMigrations(files) {
	const dir = tempDir('fixture-migrations-');
	for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
	return dir;
}
