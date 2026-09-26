/**
 * `src/bootstrap.mjs` — the `first-deploy` job that runs **before the ingress is published**.
 *
 * The decision under test is the one the plan spells out: `sawPublicApp` requires `200` **and** this
 * App Work's own marker, so an ingress controller's default 404, or any other application answering on
 * the public address, is "not this app" (ACC-13-03). No server and no database are needed for the
 * decision itself: the fetch is injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { baseEnv, startDatabase, tempDir } from './helpers/harness.mjs';
import { bootstrap, probeMarker } from '../src/bootstrap.mjs';
import { migrate } from '../src/migrate.mjs';
import { connect, readBootstrap } from '../src/db.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const marker = 'run-unique-marker';

/** A fetch that answers the way a given address does. */
function fakeFetch(routes) {
	return async (url) => {
		const match = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
		const answer = match ? match[1] : { status: 404, body: '' };
		return {
			status: answer.status,
			async text() {
				return typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
			}
		};
	};
}

const jsonMarker = (value) => ({ status: 200, body: { marker: value } });

test('an internal 200 with this marker is "saw the app"', async () => {
	const result = await probeMarker('http://web.internal:8080', marker, { fetchImpl: fakeFetch({ 'http://web.internal:8080': jsonMarker(marker) }) });
	assert.equal(result.sawApp, true);
	assert.equal(result.status, 200);
});

test('a 404 from the ingress is not this app', async () => {
	const result = await probeMarker('https://fixture.example.test', marker, { fetchImpl: fakeFetch({ 'https://fixture.example.test': { status: 404, body: 'default backend - 404' } }) });
	assert.equal(result.sawApp, false);
	assert.match(result.reason, /404/);
});

test('a different marker answering on the public address is not this app', async () => {
	const result = await probeMarker('https://fixture.example.test', marker, { fetchImpl: fakeFetch({ 'https://fixture.example.test': jsonMarker('somebody-elses-marker') }) });
	assert.equal(result.sawApp, false);
	assert.match(result.reason, /different marker/);
});

test('a 200 that is not this app\'s JSON is not this app', async () => {
	const result = await probeMarker('https://fixture.example.test', marker, { fetchImpl: fakeFetch({ 'https://fixture.example.test': { status: 200, body: '<html>hello</html>' } }) });
	assert.equal(result.sawApp, false);
	assert.match(result.reason, /not this app's \/marker JSON/);
});

test('a network failure is an observation, not an exception', async () => {
	const result = await probeMarker('https://fixture.example.test', marker, {
		fetchImpl: async () => {
			throw Object.assign(new Error('getaddrinfo ENOTFOUND fixture.example.test'), { name: 'TypeError' });
		}
	});
	assert.equal(result.sawApp, false);
	assert.match(result.reason, /ENOTFOUND/);
});

test('an unconfigured address is reported, not fetched', async () => {
	const result = await probeMarker('', marker, { fetchImpl: async () => assert.fail('must not be called') });
	assert.equal(result.sawApp, false);
	assert.match(result.reason, /no address configured/);
});

test('the job records internal-not-public, and fails when the internal address is silent', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await migrate({ databaseUrl: database.url, dir: path.join(appRoot, 'migrations'), log: () => {} });

	const env = baseEnv({
		DATABASE_URL: database.url,
		FIXTURE_INTERNAL_URL: 'http://web.internal:8080',
		FIXTURE_PUBLIC_URL: 'https://fixture.example.test',
		FIXTURE_MARKER: marker,
		FIXTURE_DATA_DIR: tempDir()
	});
	const fetchImpl = fakeFetch({
		'http://web.internal:8080': jsonMarker(marker),
		'https://fixture.example.test': { status: 404, body: 'default backend - 404' }
	});

	const result = await bootstrap({ env, fetchImpl, log: () => {} });
	assert.equal(result.sawInternalApp, true);
	assert.equal(result.sawPublicApp, false, 'the ingress is not published yet');

	const client = await connect({ DATABASE_URL: database.url });
	try {
		const stored = await readBootstrap(client);
		assert.equal(stored.sawInternalApp, true);
		assert.equal(stored.sawPublicApp, false);
		assert.equal(stored.marker, marker);
		assert.ok(stored.ranAt.endsWith('Z'));
	} finally {
		await client.end();
	}
});

test('the job fails (exit 1) when the app does not answer internally', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await migrate({ databaseUrl: database.url, dir: path.join(appRoot, 'migrations'), log: () => {} });

	const env = baseEnv({
		DATABASE_URL: database.url,
		FIXTURE_INTERNAL_URL: 'http://web.internal:8080',
		FIXTURE_PUBLIC_URL: 'https://fixture.example.test',
		FIXTURE_MARKER: marker
	});

	await assert.rejects(
		() => bootstrap({ env, fetchImpl: fakeFetch({}), log: () => {} }),
		(error) => {
			assert.equal(error.exitCode, 1);
			assert.match(error.message, /did not answer on its internal address/);
			return true;
		}
	);
});

test('a public address equal to the internal one is not a public observation', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await migrate({ databaseUrl: database.url, dir: path.join(appRoot, 'migrations'), log: () => {} });

	const env = baseEnv({
		DATABASE_URL: database.url,
		FIXTURE_INTERNAL_URL: 'http://web.internal:8080',
		FIXTURE_PUBLIC_URL: 'http://web.internal:8080',
		FIXTURE_MARKER: marker
	});
	const result = await bootstrap({ env, fetchImpl: fakeFetch({ 'http://web.internal:8080': jsonMarker(marker) }), log: () => {} });
	assert.equal(result.sawInternalApp, true);
	assert.equal(result.sawPublicApp, false, 'the same address cannot prove the ingress published the app');
});

test('a missing FIXTURE_INTERNAL_URL is a configuration error', async () => {
	await assert.rejects(
		() => bootstrap({ env: baseEnv({ FIXTURE_INTERNAL_URL: '' }), fetchImpl: fakeFetch({}), log: () => {} }),
		(error) => {
			assert.equal(error.exitCode, 2);
			assert.match(error.message, /FIXTURE_INTERNAL_URL is not set/);
			return true;
		}
	);
});

test('a missing marker is a configuration error', async () => {
	await assert.rejects(
		() => bootstrap({ env: baseEnv({ FIXTURE_INTERNAL_URL: 'http://web.internal:8080', FIXTURE_MARKER: '' }), fetchImpl: fakeFetch({}), log: () => {} }),
		(error) => {
			assert.equal(error.exitCode, 2);
			assert.match(error.message, /FIXTURE_MARKER is not set/);
			return true;
		}
	);
});

test('--dry-run observes without recording', async (t) => {
	const database = await startDatabase();
	t.after(() => database.close());
	await migrate({ databaseUrl: database.url, dir: path.join(appRoot, 'migrations'), log: () => {} });

	const env = baseEnv({
		DATABASE_URL: database.url,
		FIXTURE_INTERNAL_URL: 'http://web.internal:8080',
		FIXTURE_PUBLIC_URL: '',
		FIXTURE_MARKER: marker
	});
	const result = await bootstrap({ env, dryRun: true, fetchImpl: fakeFetch({ 'http://web.internal:8080': jsonMarker(marker) }), log: () => {} });
	assert.equal(result.sawInternalApp, true);

	const client = await connect({ DATABASE_URL: database.url });
	try {
		assert.equal(await readBootstrap(client), null, 'nothing was written');
	} finally {
		await client.end();
	}
});
