#!/usr/bin/env node
/**
 * One-off diagnostic: boots the server exactly the way `tools/smoke.mjs` does and prints the RAW bodies of
 * `/readyz` and `/state`, so the two routes' disagreement can be read off rather than inferred.
 */

import { createStubPostgres } from '../tools/dev-postgres.mjs';
import { migrate } from '../src/migrate.mjs';
import { loadConfig } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

const stub = createStubPostgres({ user: 'fixture', password: '', log: () => {} });
const port = await stub.listen(0);
const databaseUrl = `postgres://fixture@127.0.0.1:${port}/app_fixture?sslmode=disable`;

const env = {
	DATABASE_URL: databaseUrl,
	FIXTURE_MARKER: 'diag',
	FIXTURE_GIT_SHA: 'a'.repeat(40),
	FIXTURE_BUILD_LABEL: 'diag',
	FIXTURE_SESSION_SECRET: 's'.repeat(32),
	FIXTURE_CRON_TOKEN: 'cron-token',
	FIXTURE_MAIL_TO: 'sink@example.invalid'
};

await migrate({ databaseUrl, log: () => {} });

const app = createServer(loadConfig(env), { env });
const address = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${address.port}`;

for (const route of ['/readyz', '/state']) {
	const response = await fetch(`${base}${route}`);
	const text = await response.text();
	console.log(`\n=== GET ${route} → HTTP ${response.status}`);
	console.log(text.length > 900 ? `${text.slice(0, 900)}…` : text);
}

await app.close();
await stub.close();
