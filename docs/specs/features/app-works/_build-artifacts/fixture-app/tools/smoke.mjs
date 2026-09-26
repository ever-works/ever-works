/**
 * `npm run smoke` — boot the fixture the way a Deployment does, and read every route back.
 *
 * It starts the protocol stub of `tools/dev-postgres.mjs` on a random port, runs the same
 * `src/migrate.mjs` the pre-deploy job runs, starts the `web` component on a random port, records one
 * `worker` heartbeat, and then calls every route of the plan's §4.2 table and checks the answer.
 *
 * It is the fastest honest answer to "is this application actually wired up?" without a cluster, and it
 * is what `evidence/proof.txt` records (against the stub — **no real-PostgreSQL run is recorded in this repository**).
 *
 * Exit code 0 when every expectation holds, 1 otherwise.
 */

import { loadConfig } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { migrate } from '../src/migrate.mjs';
import { probeMarker } from '../src/bootstrap.mjs';
import { createStubPostgres } from './dev-postgres.mjs';
import { runWorker } from '../src/worker.mjs';
import { fingerprint } from '../src/fingerprint.mjs';

/** @type {Array<{name: string, ok: boolean, detail: string}>} */
const checks = [];
const check = (name, ok, detail) => {
	checks.push({ name, ok: Boolean(ok), detail });
	process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}\n`);
};

const stub = createStubPostgres({ user: 'fixture', password: 'fixturepw', log: () => {} });
const stubPort = await stub.listen(0);
const databaseUrl = `postgres://fixture:fixturepw@127.0.0.1:${stubPort}/app_fixture?sslmode=disable`;

const env = {
	...process.env,
	DATABASE_URL: databaseUrl,
	FIXTURE_MARKER: 'smoke-marker-1',
	FIXTURE_GIT_SHA: '0123456789abcdef0123456789abcdef01234567',
	FIXTURE_BUILD_LABEL: 'fixture-blueprint-0.1.0',
	FIXTURE_SESSION_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
	FIXTURE_CRON_TOKEN: 'cron-token-for-the-smoke-run',
	FIXTURE_MAIL_TO: 'nobody@example.invalid',
	FIXTURE_DATA_DIR: new URL('../.data/smoke', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
	FIXTURE_DEPENDENCY_CACHE_MS: '0',
	FIXTURE_MAIL_RATE_LIMIT_MS: '0'
};

process.stdout.write(`smoke: stub postgres on 127.0.0.1:${stubPort}\n`);
await migrate({ databaseUrl, log: (line) => process.stdout.write(`  ${line}\n`) });

const config = loadConfig(env);
config.port = 0;
const app = createServer(config, { env });
const address = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${address.port}`;

await runWorker({ env, once: true, log: () => {} });

const get = async (path, init) => {
	const response = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
	const text = await response.text();
	return { status: response.status, text, json: safeJson(text), headers: response.headers };
};

const home = await get('/');
check('GET / renders the greeting', home.status === 200 && home.text.includes('<h1 data-testid="greeting">Hello from app-fixture-hello</h1>'), `HTTP ${home.status}, ${home.text.length} bytes`);

const healthz = await get('/healthz');
check('GET /healthz is 200 without the db', healthz.status === 200 && healthz.text === 'ok', `HTTP ${healthz.status} body=${JSON.stringify(healthz.text)}`);

const readyz = await get('/readyz');
check('GET /readyz is 200 after migrating', readyz.status === 200 && readyz.json?.ready === true, `HTTP ${readyz.status} pending=[${readyz.json?.pending ?? '?'}]`);

const marker = await get('/marker');
check(
	'GET /marker reports marker, sha, build label',
	marker.status === 200 && marker.json.marker === 'smoke-marker-1' && marker.json.sha === env.FIXTURE_GIT_SHA && marker.json.buildLabel === 'fixture-blueprint-0.1.0',
	`marker=${marker.json?.marker} sha=${marker.json?.sha?.slice(0, 8)}… buildLabel=${marker.json?.buildLabel}`
);
check('GET /marker carries no localhost', !marker.text.includes('localhost'), `publicUrl=${JSON.stringify(marker.json?.publicUrl)}`);

const state = await get('/state');
check(
	'GET /state lists every applied migration',
	state.status === 200 && Array.isArray(state.json.migrations) && state.json.migrations.join(',') === '0001_init.sql,0002_ticks.sql,0003_bootstrap.sql',
	`migrations=[${state.json?.migrations?.join(', ')}]`
);
check('GET /state reports a fresh worker heartbeat', state.json?.workerHeartbeatAgeSeconds != null && state.json.workerHeartbeatAgeSeconds < 30, `workerHeartbeatAt=${state.json?.workerHeartbeatAt} age=${state.json?.workerHeartbeatAgeSeconds}s beats=${state.json?.workerBeats}`);
check('GET /state reports the volume writable', state.json?.uploadsWritable === true, `uploadsPath=${state.json?.uploadsPath}`);
check(
	'GET /state publishes only the secret fingerprint',
	state.json?.secretFingerprint?.length === 32 && /^[0-9a-f]{8}$/.test(state.json?.secretFingerprint?.sha256Prefix8) && !state.text.includes(env.FIXTURE_SESSION_SECRET),
	`length=${state.json?.secretFingerprint?.length} sha256Prefix8=${state.json?.secretFingerprint?.sha256Prefix8}`
);
check('GET /state carries no secret value', !state.text.includes(env.FIXTURE_CRON_TOKEN) && !state.text.includes(env.FIXTURE_SESSION_SECRET), 'searched the whole body for both secrets');

const anonymousTick = await get('/cron/tick', { method: 'POST' });
check('POST /cron/tick refuses an anonymous call', anonymousTick.status === 401, `HTTP ${anonymousTick.status}`);

const wrongTick = await get('/cron/tick', { method: 'POST', headers: { authorization: 'Bearer not-the-token' } });
check('POST /cron/tick refuses a wrong token', wrongTick.status === 401, `HTTP ${wrongTick.status}`);

const tick = await get('/cron/tick', { method: 'POST', headers: { authorization: `Bearer ${env.FIXTURE_CRON_TOKEN}` } });
const afterTick = await get('/state');
check(
	'POST /cron/tick counts the tick',
	tick.status === 204 && afterTick.json?.cronTicks === 1 && Boolean(afterTick.json?.lastCronTickAt),
	`HTTP ${tick.status} cronTicks=${afterTick.json?.cronTicks} lastCronTickAt=${afterTick.json?.lastCronTickAt}`
);

const mail = await get('/mail/test', { method: 'POST' });
check('POST /mail/test is 503 without SMTP', mail.status === 503, `HTTP ${mail.status} ${mail.json?.detail ?? ''}`);

const logo = await get('/brand/logo.svg');
check('GET /brand/logo.svg serves the protected asset', logo.status === 200 && logo.text.includes('<svg'), `HTTP ${logo.status} ${logo.headers.get('content-type')}`);

const missing = await get('/nope');
check('GET /nope is 404', missing.status === 404, `HTTP ${missing.status}`);

const wrongMethod = await get('/marker', { method: 'POST' });
check('POST /marker is 405', wrongMethod.status === 405, `HTTP ${wrongMethod.status}`);

const bootstrap = await probeMarker(base, 'smoke-marker-1', {});
check('the bootstrap probe accepts the internal address', bootstrap.sawApp === true, bootstrap.reason);

await app.close();
await stub.close();

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\nsmoke: ${checks.length - failed.length}/${checks.length} checks passed (fingerprint ${JSON.stringify(fingerprint(env.FIXTURE_SESSION_SECRET))})\n`);
if (stub.warnings.length) process.stdout.write(`smoke: stub warnings: ${stub.warnings.length}\n`);
process.exit(failed.length ? 1 : 0);

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
